import { RegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { safeInvalidateAllEnrollmentCaches } from "@/lib/services/cache";
import {
  deleteEnrollmentReservationRecord,
  getEnrollmentReservationRecords,
  getRedisGateSnapshot,
  requeueReservationWriteback,
  type EnrollmentReservationRecord,
} from "@/lib/services/enrollment-reservations";
import { processEnrollmentWritebackBatch } from "@/lib/services/enrollment-writeback";

export type EnrollmentOpsStatus = "NORMAL" | "PENDING" | "ACTION_REQUIRED" | "ERROR";

// 生成管理员一致性运维页面的数据快照。
export async function getEnrollmentOpsDashboard() {
  // 当前学期的开课班和登记代表数据库最终状态。
  const term = await prisma.term.findFirst({
    where: {
      isCurrent: true,
    },
    include: {
      offerings: {
        include: {
          course: true,
          registrations: true,
        },
        orderBy: [{ course: { courseNo: "asc" } }, { classNo: "asc" }],
      },
    },
  });

  if (!term) {
    throw new Error("当前学期不存在");
  }

  // Redis reservation代表短期预占或待写回状态。
  const reservations = await getEnrollmentReservationRecords();
  const validity = await loadReservationValidity(reservations);
  const gateSnapshots = await Promise.all(
    term.offerings.map((offering) => getRedisGateSnapshot(offering.id)),
  );
  const orphanReservations = reservations.filter(
    (reservation) =>
      !validity.studentIds.has(reservation.profileId) ||
      !validity.offeringIds.has(reservation.offeringId),
  );
  const offerings = term.offerings.map((offering, index) => {
    // 按开课班聚合Redis预占和数据库登记。
    const offeringReservations = reservations.filter(
      (reservation) => reservation.offeringId === offering.id,
    );
    const dbActive = countRegistrations(offering.registrations, RegistrationStatus.ACTIVE);
    const dbWaitlisted = countRegistrations(
      offering.registrations,
      RegistrationStatus.WAITLISTED,
    );
    const gate = gateSnapshots[index] ?? {};
    const redisActiveReserved = Number(gate.active ?? 0);
    const pendingActive = countReservations(offeringReservations, "ACTIVE_RESERVED");
    const pendingWaitlist = countReservations(offeringReservations, "WAITLIST_RESERVED");
    const failed = countReservations(offeringReservations, "FAILED");
    const offeringOrphans = offeringReservations.filter(
      (reservation) => !validity.studentIds.has(reservation.profileId),
    ).length;
    const enrolledCounterMatchesActive = offering.enrolledCount === dbActive;
    const activeNotGreaterThanCapacity = dbActive <= offering.capacity;
    const redisActiveNotGreaterThanCapacity = redisActiveReserved <= offering.capacity;
    const status = resolveOpsStatus({
      enrolledCounterMatchesActive,
      activeNotGreaterThanCapacity,
      redisActiveNotGreaterThanCapacity,
      pending: pendingActive + pendingWaitlist,
      failed,
      orphan: offeringOrphans,
    });

    return {
      id: offering.id,
      courseNo: offering.course.courseNo,
      name: offering.course.name,
      classNo: offering.classNo,
      capacity: offering.capacity,
      enrolledCount: offering.enrolledCount,
      dbActive,
      dbWaitlisted,
      redisActiveReserved,
      pendingActive,
      pendingWaitlist,
      failed,
      orphan: offeringOrphans,
      status,
      checks: {
        enrolledCounterMatchesActive,
        activeNotGreaterThanCapacity,
        redisActiveNotGreaterThanCapacity,
        noPendingWriteback: pendingActive + pendingWaitlist === 0,
      },
    };
  });
  // 页面顶部汇总各类运维状态。
  const summary = offerings.reduce(
    (total, offering) => {
      total[offering.status] += 1;
      total.pendingActive += offering.pendingActive;
      total.pendingWaitlist += offering.pendingWaitlist;
      total.failed += offering.failed;
      return total;
    },
    {
      NORMAL: 0,
      PENDING: 0,
      ACTION_REQUIRED: 0,
      ERROR: 0,
      pendingActive: 0,
      pendingWaitlist: 0,
      failed: 0,
      orphan: 0,
    },
  );
  summary.orphan = orphanReservations.length;

  return {
    term,
    offerings,
    summary,
  };
}

// 将待写回预占重新投递到Redis Stream。
export async function requeuePendingReservations() {
  const reservations = await getEnrollmentReservationRecords();
  let requeued = 0;

  for (const reservation of reservations) {
    // 只有ACTIVE_RESERVED和WAITLIST_RESERVED会被真正重投。
    if (await requeueReservationWriteback(reservation)) {
      requeued += 1;
    }
  }

  return {
    requeued,
  };
}

// 页面按钮触发的一批写回处理。
export async function processOpsWritebackBatch() {
  // 先重投，解决Stream丢失或消息卡pending后无法继续写回的问题。
  const { requeued } = await requeuePendingReservations();
  const processed = await processEnrollmentWritebackBatch({
    consumer: `admin-ops-${process.pid}-${Date.now()}`,
    count: 500,
    blockMs: 1,
  });

  // 写回后清理缓存，让学生端和管理员端看到最新状态。
  await safeInvalidateAllEnrollmentCaches();

  return {
    requeued,
    processed,
  };
}

// 清理失败预占和已经找不到学生或开课班的悬空记录。
export async function clearFailedReservations() {
  const reservations = await getEnrollmentReservationRecords();
  const validity = await loadReservationValidity(reservations);
  let cleared = 0;

  for (const reservation of reservations) {
    // 悬空记录通常来自Seed、删除数据或压测目标重建。
    const orphan =
      !validity.studentIds.has(reservation.profileId) ||
      !validity.offeringIds.has(reservation.offeringId);

    if (reservation.status === "FAILED" || orphan) {
      // 正常预占和已确认预占不能被这个动作清理。
      await deleteEnrollmentReservationRecord(reservation);
      cleared += 1;
    }
  }

  if (cleared > 0) {
    await safeInvalidateAllEnrollmentCaches();
  }

  return {
    cleared,
  };
}

// 批量判断预占记录引用的学生和开课班是否仍然存在。
async function loadReservationValidity(reservations: EnrollmentReservationRecord[]) {
  // 去重后查询，避免逐条访问数据库。
  const profileIds = Array.from(new Set(reservations.map((reservation) => reservation.profileId)));
  const offeringIds = Array.from(new Set(reservations.map((reservation) => reservation.offeringId)));
  const [students, offerings] = await Promise.all([
    profileIds.length
      ? prisma.studentProfile.findMany({
          where: {
            id: {
              in: profileIds,
            },
          },
          select: {
            id: true,
          },
        })
      : [],
    offeringIds.length
      ? prisma.courseOffering.findMany({
          where: {
            id: {
              in: offeringIds,
            },
          },
          select: {
            id: true,
          },
        })
      : [],
  ]);

  return {
    studentIds: new Set(students.map((student) => student.id)),
    offeringIds: new Set(offerings.map((offering) => offering.id)),
  };
}

// 统计某类数据库登记数量。
function countRegistrations(
  registrations: { status: RegistrationStatus }[],
  status: RegistrationStatus,
) {
  return registrations.filter((registration) => registration.status === status).length;
}

// 统计某类Redis预占数量。
function countReservations(
  reservations: EnrollmentReservationRecord[],
  status: EnrollmentReservationRecord["status"],
) {
  return reservations.filter((reservation) => reservation.status === status).length;
}

// 根据数据库和Redis检查结果计算运维状态。
function resolveOpsStatus({
  enrolledCounterMatchesActive,
  activeNotGreaterThanCapacity,
  redisActiveNotGreaterThanCapacity,
  pending,
  failed,
  orphan,
}: {
  enrolledCounterMatchesActive: boolean;
  activeNotGreaterThanCapacity: boolean;
  redisActiveNotGreaterThanCapacity: boolean;
  pending: number;
  failed: number;
  orphan: number;
}): EnrollmentOpsStatus {
  // 容量或计数不一致是最高优先级异常。
  if (
    !enrolledCounterMatchesActive ||
    !activeNotGreaterThanCapacity ||
    !redisActiveNotGreaterThanCapacity
  ) {
    return "ERROR";
  }

  if (failed > 0 || orphan > 0) {
    // 失败和悬空预占需要管理员处理。
    return "ACTION_REQUIRED";
  }

  if (pending > 0) {
    // 待写回表示异步流程尚未完成，不等同于数据错误。
    return "PENDING";
  }

  return "NORMAL";
}
