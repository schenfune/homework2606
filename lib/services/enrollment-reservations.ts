import { redis } from "@/lib/db/redis";

export type ReservationKind = "ACTIVE" | "WAITLIST";

export type ReservationStatus =
  | "ACTIVE_RESERVED"
  | "WAITLIST_RESERVED"
  | "CONFIRMED_ACTIVE"
  | "CONFIRMED_WAITLIST"
  | "FAILED";

export type ReservationResultCode =
  | "RESERVED"
  | "COURSE_FULL"
  | "SEAT_AVAILABLE"
  | "DUPLICATE";

export type ReservationResult = {
  code: ReservationResultCode;
  status?: ReservationStatus;
  waitlistPosition?: number | null;
};

export type StudentReservation = {
  key: string;
  profileId: string;
  offeringId: string;
  status: ReservationStatus;
  kind: ReservationKind;
  waitlistPosition: number | null;
};

export type EnrollmentReservationRecord = {
  key: string;
  profileId: string;
  offeringId: string;
  status: ReservationStatus;
  kind: ReservationKind | null;
  waitlistPosition: number | null;
  createdAt: string | null;
  streamId: string | null;
};

export const reservationConfig = {
  reservationTtlSeconds: 30 * 60,
  streamKey: "enrollment:writeback:stream",
  streamGroup: "enrollment-writeback",
};

const reserveActiveScript = `
-- KEYS[1]：开课班容量闸门，保存容量、已预占正式名额和候补序号。
local gateKey = KEYS[1]
-- KEYS[2]：某个学生在某个开课班上的预占记录。
local reservationKey = KEYS[2]
-- KEYS[3]：写回任务队列，Worker会从这里读取任务写入PostgreSQL。
local streamKey = KEYS[3]
-- ARGV[1]：课程容量。
local capacity = tonumber(ARGV[1])
-- ARGV[2]：数据库中当前已选人数，用于初始化Redis闸门。
local enrolledCount = tonumber(ARGV[2])
-- ARGV[3]：学生档案ID。
local profileId = ARGV[3]
-- ARGV[4]：开课班ID。
local offeringId = ARGV[4]
-- ARGV[5]：预占记录过期时间，避免异常中断后永久占位。
local ttl = tonumber(ARGV[5])
-- ARGV[6]：预占创建时间。
local now = ARGV[6]

-- 第一次抢这个开课班时，用数据库人数初始化Redis闸门。
if redis.call("HGET", gateKey, "initialized") ~= "1" then
  redis.call("HSET", gateKey, "initialized", "1", "active", tostring(enrolledCount), "capacity", tostring(capacity), "waitlistSeq", "0")
else
  -- 后续请求同步最新容量，方便管理员调整容量后继续使用同一个闸门。
  redis.call("HSET", gateKey, "capacity", tostring(capacity))
end

-- 同一个学生对同一个开课班只能有一个有效预占。
local existing = redis.call("HGET", reservationKey, "status")
if existing and existing ~= "FAILED" then
  -- 已经选课或候补时直接返回DUPLICATE，不重复占名额。
  return {"DUPLICATE", existing, redis.call("HGET", reservationKey, "waitlistPosition") or ""}
end

-- active表示Redis里已经预占的正式名额数量。
local active = tonumber(redis.call("HGET", gateKey, "active") or enrolledCount)
if active >= capacity then
  -- 正式名额已满，选课接口返回容量满，前端再显示候补入口。
  return {"COURSE_FULL", "", ""}
end

-- 还有正式名额时，先把Redis正式预占数加1。
redis.call("HINCRBY", gateKey, "active", 1)
-- 写入学生的正式预占记录。此时数据库还没入库，但页面可以先显示已入课表。
redis.call("HSET", reservationKey,
  "status", "ACTIVE_RESERVED",
  "kind", "ACTIVE",
  "profileId", profileId,
  "offeringId", offeringId,
  "waitlistPosition", "",
  "createdAt", now
)
-- 预占记录设置TTL，防止Worker异常时Redis状态长期残留。
redis.call("EXPIRE", reservationKey, ttl)
-- 投递写回任务。Worker消费后会创建ACTIVE登记和操作日志。
local streamId = redis.call("XADD", streamKey, "*",
  "reservationKey", reservationKey,
  "profileId", profileId,
  "offeringId", offeringId,
  "kind", "ACTIVE",
  "createdAt", now
)
-- 保存Stream消息ID，运维页重投或排查时可以看到来源。
redis.call("HSET", reservationKey, "streamId", streamId)

-- 返回RESERVED表示Redis入口抢名额成功。
return {"RESERVED", "ACTIVE_RESERVED", ""}
`;

const reserveWaitlistScript = `
-- KEYS[1]：开课班容量闸门，保存正式预占数和候补序号。
local gateKey = KEYS[1]
-- KEYS[2]：某个学生在某个开课班上的候补预占记录。
local reservationKey = KEYS[2]
-- KEYS[3]：写回任务队列，Worker会把候补写入PostgreSQL。
local streamKey = KEYS[3]
-- ARGV[1]：课程容量。
local capacity = tonumber(ARGV[1])
-- ARGV[2]：数据库中当前已选人数。
local enrolledCount = tonumber(ARGV[2])
-- ARGV[3]：数据库中当前最大候补顺位。
local waitlistMax = tonumber(ARGV[3])
-- ARGV[4]：学生档案ID。
local profileId = ARGV[4]
-- ARGV[5]：开课班ID。
local offeringId = ARGV[5]
-- ARGV[6]：预占过期时间。
local ttl = tonumber(ARGV[6])
-- ARGV[7]：候补创建时间。
local now = ARGV[7]

-- 第一次进入候补闸门时，用数据库人数和最大候补顺位初始化Redis状态。
if redis.call("HGET", gateKey, "initialized") ~= "1" then
  redis.call("HSET", gateKey, "initialized", "1", "active", tostring(enrolledCount), "capacity", tostring(capacity), "waitlistSeq", tostring(waitlistMax))
else
  -- 同步最新容量。
  redis.call("HSET", gateKey, "capacity", tostring(capacity))
  -- 防止Redis候补序号小于数据库已有顺位。
  local currentSeq = tonumber(redis.call("HGET", gateKey, "waitlistSeq") or "0")
  if currentSeq < waitlistMax then
    redis.call("HSET", gateKey, "waitlistSeq", tostring(waitlistMax))
  end
end

-- 同一学生不能重复加入同一开课班候补。
local existing = redis.call("HGET", reservationKey, "status")
if existing and existing ~= "FAILED" then
  -- 已有正式或候补状态时返回DUPLICATE，保留原候补顺位。
  return {"DUPLICATE", existing, redis.call("HGET", reservationKey, "waitlistPosition") or ""}
end

-- 只有正式名额已满时才允许候补。
local active = tonumber(redis.call("HGET", gateKey, "active") or enrolledCount)
if active < capacity then
  -- 仍有正式名额时，前端应引导学生点击选课，而不是候补。
  return {"SEAT_AVAILABLE", "", ""}
end

-- 候补顺位由Redis原子自增生成，保证并发下不会重复。
local position = redis.call("HINCRBY", gateKey, "waitlistSeq", 1)
-- 写入候补预占记录。页面可以立即显示候补中。
redis.call("HSET", reservationKey,
  "status", "WAITLIST_RESERVED",
  "kind", "WAITLIST",
  "profileId", profileId,
  "offeringId", offeringId,
  "waitlistPosition", tostring(position),
  "createdAt", now
)
-- 候补预占同样设置TTL，防止异常状态长期残留。
redis.call("EXPIRE", reservationKey, ttl)
-- 投递候补写回任务。Worker消费后会创建WAITLISTED登记。
local streamId = redis.call("XADD", streamKey, "*",
  "reservationKey", reservationKey,
  "profileId", profileId,
  "offeringId", offeringId,
  "kind", "WAITLIST",
  "waitlistPosition", tostring(position),
  "createdAt", now
)
-- 保存Stream消息ID，便于运维页展示和恢复。
redis.call("HSET", reservationKey, "streamId", streamId)

-- 返回RESERVED和候补顺位。
return {"RESERVED", "WAITLIST_RESERVED", tostring(position)}
`;

const releaseReservationScript = `
-- KEYS[1]：开课班容量闸门。
local gateKey = KEYS[1]
-- KEYS[2]：学生在该开课班上的预占记录。
local reservationKey = KEYS[2]
-- 先读取当前预占状态，判断是否需要归还正式名额。
local status = redis.call("HGET", reservationKey, "status")
if not status then
  -- 没有预占记录时返回MISSING，调用方可按需修正gate计数。
  return {"MISSING", ""}
end
if status == "ACTIVE_RESERVED" or status == "CONFIRMED_ACTIVE" then
  -- 正式预占或已确认正式登记会占用Redis active计数。
  local active = tonumber(redis.call("HGET", gateKey, "active") or "0")
  if active > 0 then
    -- 释放正式名额时归还一个active计数，避免减成负数。
    redis.call("HINCRBY", gateKey, "active", -1)
  end
end
-- 删除学生预占记录。候补记录删除时不影响active计数。
redis.call("DEL", reservationKey)
-- 返回被释放的原状态，便于服务层判断。
return {"RELEASED", status}
`;

// 生成单个学生在单个开课班上的预占状态键。
export function reservationKey(profileId: string, offeringId: string) {
  return `enrollment:reservation:${profileId}:${offeringId}`;
}

// 生成开课班容量闸门键，记录已预占数和候补序号。
export function gateKey(offeringId: string) {
  return `enrollment:gate:${offeringId}`;
}

// 抢正式名额：通过Lua脚本原子完成容量判断和预占写入。
export async function reserveActiveSeat({
  profileId,
  offeringId,
  capacity,
  enrolledCount,
}: {
  profileId: string;
  offeringId: string;
  capacity: number;
  enrolledCount: number;
}) {
  // Lua脚本会同时写reservation、递增gate计数并投递写回Stream。
  const result = await redis.eval(reserveActiveScript, {
    keys: [gateKey(offeringId), reservationKey(profileId, offeringId), reservationConfig.streamKey],
    arguments: [
      String(capacity),
      String(enrolledCount),
      profileId,
      offeringId,
      String(reservationConfig.reservationTtlSeconds),
      new Date().toISOString(),
    ],
  });

  return normalizeReservationResult(result);
}

// 加入候补：只在正式名额已满时生成候补预占和候补顺位。
export async function reserveWaitlistSeat({
  profileId,
  offeringId,
  capacity,
  enrolledCount,
  waitlistMax,
}: {
  profileId: string;
  offeringId: string;
  capacity: number;
  enrolledCount: number;
  waitlistMax: number;
}) {
  // waitlistMax来自数据库，Lua会保证Redis候补序号不倒退。
  const result = await redis.eval(reserveWaitlistScript, {
    keys: [gateKey(offeringId), reservationKey(profileId, offeringId), reservationConfig.streamKey],
    arguments: [
      String(capacity),
      String(enrolledCount),
      String(waitlistMax),
      profileId,
      offeringId,
      String(reservationConfig.reservationTtlSeconds),
      new Date().toISOString(),
    ],
  });

  return normalizeReservationResult(result);
}

// 释放学生在某开课班上的预占状态。
export async function releaseReservation(profileId: string, offeringId: string) {
  // 正式预占被释放时，需要同步减少Redis gate里的active计数。
  const result = await redis.eval(releaseReservationScript, {
    keys: [gateKey(offeringId), reservationKey(profileId, offeringId)],
    arguments: [],
  });

  return Array.isArray(result) ? String(result[0]) : "MISSING";
}

// 只递减开课班Redis正式预占计数，供清理异常记录使用。
export async function decrementActiveGate(offeringId: string) {
  const key = gateKey(offeringId);
  const exists = await redis.exists(key);

  if (exists) {
    // 防止计数已经为0时继续减成负数。
    const active = Number((await redis.hGet(key, "active")) ?? 0);

    if (active > 0) {
      await redis.hIncrBy(key, "active", -1);
    }
  }
}

// Worker写回成功后，把Redis预占标记为已确认。
export async function markReservationConfirmed({
  profileId,
  offeringId,
  status,
}: {
  profileId: string;
  offeringId: string;
  status: Extract<ReservationStatus, "CONFIRMED_ACTIVE" | "CONFIRMED_WAITLIST">;
}) {
  const key = reservationKey(profileId, offeringId);
  await redis.hSet(key, "status", status);
  await redis.expire(key, reservationConfig.reservationTtlSeconds);
}

// 写回失败时把预占标记为失败，等待运维页面清理或恢复。
export async function markReservationFailed(profileId: string, offeringId: string) {
  const key = reservationKey(profileId, offeringId);
  await redis.hSet(key, "status", "FAILED");
  await redis.expire(key, 5 * 60);
}

// 读取某个学生当前仍有效的Redis预占状态。
export async function getStudentReservations(profileId: string) {
  const keys = await redis.keys(`enrollment:reservation:${profileId}:*`);
  const reservations: StudentReservation[] = [];

  for (const key of keys) {
    // Redis hash是弱结构，读取后需要重新校验必要字段。
    const value = await redis.hGetAll(key);
    const status = value.status as ReservationStatus | undefined;
    const kind = value.kind as ReservationKind | undefined;

    if (!status || !kind || status === "FAILED") {
      // 失败预占不参与学生端展示。
      continue;
    }

    reservations.push({
      key,
      profileId: value.profileId,
      offeringId: value.offeringId,
      status,
      kind,
      waitlistPosition: value.waitlistPosition ? Number(value.waitlistPosition) : null,
    });
  }

  return reservations;
}

// 清理全部选课Redis状态，通常在Seed或压测准备阶段使用。
export async function clearEnrollmentReservationState() {
  const keys = await redis.keys("enrollment:*");

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

// 清理某个开课班相关的Redis容量闸门和预占记录。
export async function clearOfferingReservationState(offeringId: string) {
  const keys = [
    gateKey(offeringId),
    ...(await redis.keys(`enrollment:reservation:*:${offeringId}`)),
  ];

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

// 读取开课班Redis容量闸门快照，供运维页展示。
export async function getRedisGateSnapshot(offeringId: string) {
  return redis.hGetAll(gateKey(offeringId));
}

// 扫描全部学生-开课班预占记录，供运维页比对数据库状态。
export async function getEnrollmentReservationRecords() {
  const keys = await redis.keys("enrollment:reservation:*:*");
  const records: EnrollmentReservationRecord[] = [];

  for (const key of keys) {
    // key中也包含profileId和offeringId，作为hash字段缺失时的兜底。
    const value = await redis.hGetAll(key);
    const parts = key.split(":");
    const status = value.status as ReservationStatus | undefined;

    if (!status) {
      continue;
    }

    records.push({
      key,
      profileId: value.profileId || parts[2] || "",
      offeringId: value.offeringId || parts[3] || "",
      status,
      kind: value.kind === "ACTIVE" || value.kind === "WAITLIST" ? value.kind : null,
      waitlistPosition: value.waitlistPosition ? Number(value.waitlistPosition) : null,
      createdAt: value.createdAt || null,
      streamId: value.streamId || null,
    });
  }

  return records;
}

// 将待写回的预占状态重新投递到Redis Stream。
export async function requeueReservationWriteback(record: EnrollmentReservationRecord) {
  if (
    !record.kind ||
    !record.profileId ||
    !record.offeringId ||
    (record.status !== "ACTIVE_RESERVED" && record.status !== "WAITLIST_RESERVED")
  ) {
    // 只允许ACTIVE_RESERVED和WAITLIST_RESERVED重新投递。
    return false;
  }

  // 重投时保留原reservationKey，使Worker可以继续按幂等逻辑处理。
  const fields = [
    "reservationKey",
    record.key,
    "profileId",
    record.profileId,
    "offeringId",
    record.offeringId,
    "kind",
    record.kind,
    "createdAt",
    new Date().toISOString(),
  ];

  if (record.kind === "WAITLIST" && record.waitlistPosition !== null) {
    // 候补重投必须保留原顺位，避免恢复后队列顺序变化。
    fields.push("waitlistPosition", String(record.waitlistPosition));
  }

  const streamId = await redis.sendCommand([
    "XADD",
    reservationConfig.streamKey,
    "*",
    ...fields,
  ]);
  await redis.hSet(record.key, "streamId", String(streamId));
  await redis.expire(record.key, reservationConfig.reservationTtlSeconds);

  return true;
}

// 删除失败或悬空预占记录。
export async function deleteEnrollmentReservationRecord(record: EnrollmentReservationRecord) {
  if (record.kind === "ACTIVE" && record.offeringId) {
    // 删除正式预占前先归还Redis gate中的名额。
    await decrementActiveGate(record.offeringId);
  }

  await redis.del(record.key);
}

// 把Lua脚本返回的数组结果转成TypeScript结构。
function normalizeReservationResult(result: unknown): ReservationResult {
  const [code, status, waitlistPosition] = Array.isArray(result)
    ? result.map((item) => String(item ?? ""))
    : ["DUPLICATE", "", ""];

  return {
    code: code as ReservationResultCode,
    status: status ? (status as ReservationStatus) : undefined,
    waitlistPosition: waitlistPosition ? Number(waitlistPosition) : null,
  };
}
