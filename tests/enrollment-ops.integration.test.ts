import { RegistrationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { redis } from "@/lib/db/redis";
import { prisma } from "@/lib/db/prisma";
import { joinWaitlist, selectCourse } from "@/lib/services/enrollment";
import {
  clearFailedReservations,
  getEnrollmentOpsDashboard,
  processOpsWritebackBatch,
  requeuePendingReservations,
} from "@/lib/services/enrollment-ops";
import {
  getRedisGateSnapshot,
  markReservationFailed,
  reservationKey,
} from "@/lib/services/enrollment-reservations";
import { seedDemoData } from "@/prisma/seed";

describe("enrollment ops dashboard", () => {
  beforeEach(async () => {
    await seedDemoData();
  });

  it("shows pending active reservations and processes writeback", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE304");

    await selectCourse(studentId, offeringId);

    const before = await getEnrollmentOpsDashboard();
    const beforeOffering = before.offerings.find((offering) => offering.id === offeringId);

    expect(beforeOffering?.status).toBe("PENDING");
    expect(beforeOffering?.pendingActive).toBe(1);
    expect(beforeOffering?.dbActive).toBe(0);

    await processOpsWritebackBatch();

    const after = await getEnrollmentOpsDashboard();
    const afterOffering = after.offerings.find((offering) => offering.id === offeringId);
    const registration = await prisma.courseRegistration.findUniqueOrThrow({
      where: {
        studentId_offeringId: {
          studentId,
          offeringId,
        },
      },
    });

    expect(registration.status).toBe(RegistrationStatus.ACTIVE);
    expect(afterOffering?.pendingActive).toBe(0);
    expect(afterOffering?.dbActive).toBe(1);
  });

  it("writes back waitlist reservations", async () => {
    const first = await fixture("20240001", "GE204");
    const second = await fixture("20240002", "GE204");

    await selectCourse(first.studentId, first.offeringId);
    await joinWaitlist(second.studentId, second.offeringId);

    const before = await getEnrollmentOpsDashboard();
    const beforeOffering = before.offerings.find((offering) => offering.id === first.offeringId);

    expect(beforeOffering?.pendingActive).toBe(1);
    expect(beforeOffering?.pendingWaitlist).toBe(1);

    await processOpsWritebackBatch();

    const waitlisted = await prisma.courseRegistration.findUniqueOrThrow({
      where: {
        studentId_offeringId: {
          studentId: second.studentId,
          offeringId: second.offeringId,
        },
      },
    });

    expect(waitlisted.status).toBe(RegistrationStatus.WAITLISTED);
    expect(waitlisted.waitlistPosition).toBe(1);
  });

  it("keeps repeated requeue idempotent", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE304");

    await selectCourse(studentId, offeringId);
    await requeuePendingReservations();
    await requeuePendingReservations();
    await processOpsWritebackBatch();

    const registrations = await prisma.courseRegistration.findMany({
      where: {
        studentId,
        offeringId,
        status: RegistrationStatus.ACTIVE,
      },
    });
    const offering = await prisma.courseOffering.findUniqueOrThrow({
      where: {
        id: offeringId,
      },
    });

    expect(registrations).toHaveLength(1);
    expect(offering.enrolledCount).toBe(1);
  });

  it("clears failed and orphan reservations without deleting normal pending ones", async () => {
    const failed = await fixture("20240001", "SE304");
    const pending = await fixture("20240002", "SE301");
    const orphanKey = reservationKey("missing-student", failed.offeringId);

    await selectCourse(failed.studentId, failed.offeringId);
    await selectCourse(pending.studentId, pending.offeringId);
    await markReservationFailed(failed.studentId, failed.offeringId);
    await redis.hSet(orphanKey, {
      status: "WAITLIST_RESERVED",
      kind: "WAITLIST",
      profileId: "missing-student",
      offeringId: failed.offeringId,
      waitlistPosition: "99",
      createdAt: new Date().toISOString(),
    });

    const result = await clearFailedReservations();
    const failedReservation = await redis.hGetAll(reservationKey(failed.studentId, failed.offeringId));
    const pendingReservation = await redis.hGetAll(
      reservationKey(pending.studentId, pending.offeringId),
    );
    const orphanReservation = await redis.hGetAll(orphanKey);
    const failedGate = await getRedisGateSnapshot(failed.offeringId);

    expect(result.cleared).toBe(2);
    expect(failedReservation.status).toBeUndefined();
    expect(orphanReservation.status).toBeUndefined();
    expect(pendingReservation.status).toBe("ACTIVE_RESERVED");
    expect(Number(failedGate.active ?? 0)).toBe(0);
  });
});

async function fixture(studentNo: string, courseNo: string) {
  const student = await prisma.studentProfile.findUniqueOrThrow({
    where: { studentNo },
  });
  const offering = await prisma.courseOffering.findFirstOrThrow({
    where: {
      course: {
        courseNo,
      },
    },
  });

  return {
    studentId: student.id,
    offeringId: offering.id,
  };
}
