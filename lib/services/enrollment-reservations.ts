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

export const reservationConfig = {
  reservationTtlSeconds: 30 * 60,
  streamKey: "enrollment:writeback:stream",
  streamGroup: "enrollment-writeback",
};

const reserveActiveScript = `
local gateKey = KEYS[1]
local reservationKey = KEYS[2]
local streamKey = KEYS[3]
local capacity = tonumber(ARGV[1])
local enrolledCount = tonumber(ARGV[2])
local profileId = ARGV[3]
local offeringId = ARGV[4]
local ttl = tonumber(ARGV[5])
local now = ARGV[6]

if redis.call("HGET", gateKey, "initialized") ~= "1" then
  redis.call("HSET", gateKey, "initialized", "1", "active", tostring(enrolledCount), "capacity", tostring(capacity), "waitlistSeq", "0")
else
  redis.call("HSET", gateKey, "capacity", tostring(capacity))
end

local existing = redis.call("HGET", reservationKey, "status")
if existing and existing ~= "FAILED" then
  return {"DUPLICATE", existing, redis.call("HGET", reservationKey, "waitlistPosition") or ""}
end

local active = tonumber(redis.call("HGET", gateKey, "active") or enrolledCount)
if active >= capacity then
  return {"COURSE_FULL", "", ""}
end

redis.call("HINCRBY", gateKey, "active", 1)
redis.call("HSET", reservationKey,
  "status", "ACTIVE_RESERVED",
  "kind", "ACTIVE",
  "profileId", profileId,
  "offeringId", offeringId,
  "waitlistPosition", "",
  "createdAt", now
)
redis.call("EXPIRE", reservationKey, ttl)
local streamId = redis.call("XADD", streamKey, "*",
  "reservationKey", reservationKey,
  "profileId", profileId,
  "offeringId", offeringId,
  "kind", "ACTIVE",
  "createdAt", now
)
redis.call("HSET", reservationKey, "streamId", streamId)

return {"RESERVED", "ACTIVE_RESERVED", ""}
`;

const reserveWaitlistScript = `
local gateKey = KEYS[1]
local reservationKey = KEYS[2]
local streamKey = KEYS[3]
local capacity = tonumber(ARGV[1])
local enrolledCount = tonumber(ARGV[2])
local waitlistMax = tonumber(ARGV[3])
local profileId = ARGV[4]
local offeringId = ARGV[5]
local ttl = tonumber(ARGV[6])
local now = ARGV[7]

if redis.call("HGET", gateKey, "initialized") ~= "1" then
  redis.call("HSET", gateKey, "initialized", "1", "active", tostring(enrolledCount), "capacity", tostring(capacity), "waitlistSeq", tostring(waitlistMax))
else
  redis.call("HSET", gateKey, "capacity", tostring(capacity))
  local currentSeq = tonumber(redis.call("HGET", gateKey, "waitlistSeq") or "0")
  if currentSeq < waitlistMax then
    redis.call("HSET", gateKey, "waitlistSeq", tostring(waitlistMax))
  end
end

local existing = redis.call("HGET", reservationKey, "status")
if existing and existing ~= "FAILED" then
  return {"DUPLICATE", existing, redis.call("HGET", reservationKey, "waitlistPosition") or ""}
end

local active = tonumber(redis.call("HGET", gateKey, "active") or enrolledCount)
if active < capacity then
  return {"SEAT_AVAILABLE", "", ""}
end

local position = redis.call("HINCRBY", gateKey, "waitlistSeq", 1)
redis.call("HSET", reservationKey,
  "status", "WAITLIST_RESERVED",
  "kind", "WAITLIST",
  "profileId", profileId,
  "offeringId", offeringId,
  "waitlistPosition", tostring(position),
  "createdAt", now
)
redis.call("EXPIRE", reservationKey, ttl)
local streamId = redis.call("XADD", streamKey, "*",
  "reservationKey", reservationKey,
  "profileId", profileId,
  "offeringId", offeringId,
  "kind", "WAITLIST",
  "waitlistPosition", tostring(position),
  "createdAt", now
)
redis.call("HSET", reservationKey, "streamId", streamId)

return {"RESERVED", "WAITLIST_RESERVED", tostring(position)}
`;

const releaseReservationScript = `
local gateKey = KEYS[1]
local reservationKey = KEYS[2]
local status = redis.call("HGET", reservationKey, "status")
if not status then
  return {"MISSING", ""}
end
if status == "ACTIVE_RESERVED" or status == "CONFIRMED_ACTIVE" then
  local active = tonumber(redis.call("HGET", gateKey, "active") or "0")
  if active > 0 then
    redis.call("HINCRBY", gateKey, "active", -1)
  end
end
redis.call("DEL", reservationKey)
return {"RELEASED", status}
`;

export function reservationKey(profileId: string, offeringId: string) {
  return `enrollment:reservation:${profileId}:${offeringId}`;
}

export function gateKey(offeringId: string) {
  return `enrollment:gate:${offeringId}`;
}

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

export async function releaseReservation(profileId: string, offeringId: string) {
  const result = await redis.eval(releaseReservationScript, {
    keys: [gateKey(offeringId), reservationKey(profileId, offeringId)],
    arguments: [],
  });

  return Array.isArray(result) ? String(result[0]) : "MISSING";
}

export async function decrementActiveGate(offeringId: string) {
  const key = gateKey(offeringId);
  const exists = await redis.exists(key);

  if (exists) {
    const active = Number((await redis.hGet(key, "active")) ?? 0);

    if (active > 0) {
      await redis.hIncrBy(key, "active", -1);
    }
  }
}

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

export async function markReservationFailed(profileId: string, offeringId: string) {
  const key = reservationKey(profileId, offeringId);
  await redis.hSet(key, "status", "FAILED");
  await redis.expire(key, 5 * 60);
}

export async function getStudentReservations(profileId: string) {
  const keys = await redis.keys(`enrollment:reservation:${profileId}:*`);
  const reservations: StudentReservation[] = [];

  for (const key of keys) {
    const value = await redis.hGetAll(key);
    const status = value.status as ReservationStatus | undefined;
    const kind = value.kind as ReservationKind | undefined;

    if (!status || !kind || status === "FAILED") {
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

export async function clearEnrollmentReservationState() {
  const keys = await redis.keys("enrollment:*");

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

export async function clearOfferingReservationState(offeringId: string) {
  const keys = [
    gateKey(offeringId),
    ...(await redis.keys(`enrollment:reservation:*:${offeringId}`)),
  ];

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

export async function getRedisGateSnapshot(offeringId: string) {
  return redis.hGetAll(gateKey(offeringId));
}

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
