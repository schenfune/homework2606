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

export async function getEnrollmentOpsDashboard() {
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

export async function requeuePendingReservations() {
  const reservations = await getEnrollmentReservationRecords();
  let requeued = 0;

  for (const reservation of reservations) {
    if (await requeueReservationWriteback(reservation)) {
      requeued += 1;
    }
  }

  return {
    requeued,
  };
}

export async function processOpsWritebackBatch() {
  const { requeued } = await requeuePendingReservations();
  const processed = await processEnrollmentWritebackBatch({
    consumer: `admin-ops-${process.pid}-${Date.now()}`,
    count: 500,
    blockMs: 1,
  });

  await safeInvalidateAllEnrollmentCaches();

  return {
    requeued,
    processed,
  };
}

export async function clearFailedReservations() {
  const reservations = await getEnrollmentReservationRecords();
  const validity = await loadReservationValidity(reservations);
  let cleared = 0;

  for (const reservation of reservations) {
    const orphan =
      !validity.studentIds.has(reservation.profileId) ||
      !validity.offeringIds.has(reservation.offeringId);

    if (reservation.status === "FAILED" || orphan) {
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

async function loadReservationValidity(reservations: EnrollmentReservationRecord[]) {
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

function countRegistrations(
  registrations: { status: RegistrationStatus }[],
  status: RegistrationStatus,
) {
  return registrations.filter((registration) => registration.status === status).length;
}

function countReservations(
  reservations: EnrollmentReservationRecord[],
  status: EnrollmentReservationRecord["status"],
) {
  return reservations.filter((reservation) => reservation.status === status).length;
}

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
  if (
    !enrolledCounterMatchesActive ||
    !activeNotGreaterThanCapacity ||
    !redisActiveNotGreaterThanCapacity
  ) {
    return "ERROR";
  }

  if (failed > 0 || orphan > 0) {
    return "ACTION_REQUIRED";
  }

  if (pending > 0) {
    return "PENDING";
  }

  return "NORMAL";
}
