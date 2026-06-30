import { OfferingStatus, RegistrationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { redis } from "@/lib/db/redis";
import { prisma } from "@/lib/db/prisma";
import {
  reservationConfig,
  reservationKey,
  type ReservationKind,
  type ReservationStatus,
} from "@/lib/services/enrollment-reservations";
import { processEnrollmentWritebackBatch } from "@/lib/services/enrollment-writeback";
import { seedDemoData } from "@/prisma/seed";

describe("enrollment writeback worker", () => {
  beforeEach(async () => {
    await seedDemoData();
  });

  it("confirms an active reservation when the active registration already exists", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE304");

    await prisma.courseRegistration.create({
      data: {
        studentId,
        offeringId,
        status: RegistrationStatus.ACTIVE,
      },
    });
    await prisma.courseOffering.update({
      where: { id: offeringId },
      data: { enrolledCount: 1 },
    });
    await enqueueReservation({
      studentId,
      offeringId,
      kind: "ACTIVE",
      status: "ACTIVE_RESERVED",
    });

    await drainWriteback();

    const reservation = await redis.hGetAll(reservationKey(studentId, offeringId));
    const activeCount = await prisma.courseRegistration.count({
      where: {
        studentId,
        offeringId,
        status: RegistrationStatus.ACTIVE,
      },
    });

    expect(reservation.status).toBe("CONFIRMED_ACTIVE");
    expect(activeCount).toBe(1);
  });

  it("releases an active reservation when the student is already waitlisted", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE304");

    await prisma.courseRegistration.create({
      data: {
        studentId,
        offeringId,
        status: RegistrationStatus.WAITLISTED,
        waitlistedAt: new Date(),
        waitlistPosition: 1,
      },
    });
    await enqueueReservation({
      studentId,
      offeringId,
      kind: "ACTIVE",
      status: "ACTIVE_RESERVED",
    });

    await drainWriteback();

    const reservation = await redis.hGetAll(reservationKey(studentId, offeringId));
    const waitlisted = await prisma.courseRegistration.findUniqueOrThrow({
      where: {
        studentId_offeringId: {
          studentId,
          offeringId,
        },
      },
    });

    expect(reservation.status).toBeUndefined();
    expect(waitlisted.status).toBe(RegistrationStatus.WAITLISTED);
  });

  it("releases a waitlist reservation when the student is already active", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE304");

    await prisma.courseRegistration.create({
      data: {
        studentId,
        offeringId,
        status: RegistrationStatus.ACTIVE,
      },
    });
    await enqueueReservation({
      studentId,
      offeringId,
      kind: "WAITLIST",
      status: "WAITLIST_RESERVED",
      waitlistPosition: 3,
    });

    await drainWriteback();

    const reservation = await redis.hGetAll(reservationKey(studentId, offeringId));
    const active = await prisma.courseRegistration.findUniqueOrThrow({
      where: {
        studentId_offeringId: {
          studentId,
          offeringId,
        },
      },
    });

    expect(reservation.status).toBeUndefined();
    expect(active.status).toBe(RegistrationStatus.ACTIVE);
  });

  it("releases pending reservations for stopped offerings", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE304");

    await prisma.courseOffering.update({
      where: { id: offeringId },
      data: { status: OfferingStatus.CANCELED },
    });
    await enqueueReservation({
      studentId,
      offeringId,
      kind: "ACTIVE",
      status: "ACTIVE_RESERVED",
    });

    await drainWriteback();

    const reservation = await redis.hGetAll(reservationKey(studentId, offeringId));
    const registrations = await prisma.courseRegistration.count({
      where: { studentId, offeringId },
    });

    expect(reservation.status).toBeUndefined();
    expect(registrations).toBe(0);
  });
});

async function enqueueReservation({
  studentId,
  offeringId,
  kind,
  status,
  waitlistPosition,
}: {
  studentId: string;
  offeringId: string;
  kind: ReservationKind;
  status: Extract<ReservationStatus, "ACTIVE_RESERVED" | "WAITLIST_RESERVED">;
  waitlistPosition?: number;
}) {
  const key = reservationKey(studentId, offeringId);
  const now = new Date().toISOString();
  const fields = [
    "reservationKey",
    key,
    "profileId",
    studentId,
    "offeringId",
    offeringId,
    "kind",
    kind,
    "createdAt",
    now,
  ];

  if (kind === "WAITLIST" && waitlistPosition !== undefined) {
    fields.push("waitlistPosition", String(waitlistPosition));
  }

  await redis.hSet(key, {
    status,
    kind,
    profileId: studentId,
    offeringId,
    waitlistPosition: waitlistPosition?.toString() ?? "",
    createdAt: now,
  });
  await redis.expire(key, reservationConfig.reservationTtlSeconds);
  const streamId = await redis.sendCommand([
    "XADD",
    reservationConfig.streamKey,
    "*",
    ...fields,
  ]);
  await redis.hSet(key, "streamId", String(streamId));
}

async function drainWriteback() {
  for (let index = 0; index < 5; index += 1) {
    const processed = await processEnrollmentWritebackBatch({
      consumer: `writeback-test-${process.pid}-${index}`,
      count: 100,
      blockMs: 1,
    });

    if (processed === 0) {
      return;
    }
  }
}

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
