import { OfferingStatus, OperationType, RegistrationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import {
  cancelOffering,
  closeOffering,
  getAdminDashboard,
  getEnrollmentResultSnapshot,
  updateTermWindow,
} from "@/lib/services/admin";
import { dropCourse, joinWaitlist, selectCourse } from "@/lib/services/enrollment";
import { processEnrollmentWritebackBatch } from "@/lib/services/enrollment-writeback";
import { seedDemoData } from "@/prisma/seed";

describe("admin dashboard", () => {
  beforeEach(async () => {
    await seedDemoData();
  });

  it("returns offering detail with registrations and related logs", async () => {
    const offering = await prisma.courseOffering.findFirstOrThrow({
      where: {
        course: {
          courseNo: "SE301",
        },
      },
    });
    const studentA = await prisma.studentProfile.findUniqueOrThrow({
      where: { studentNo: "20240001" },
    });
    const studentB = await prisma.studentProfile.findUniqueOrThrow({
      where: { studentNo: "20240002" },
    });

    await selectCourse(studentA.id, offering.id);
    await drainWriteback();
    const dropped = await prisma.courseRegistration.findUniqueOrThrow({
      where: {
        studentId_offeringId: {
          studentId: studentA.id,
          offeringId: offering.id,
        },
      },
    });
    await dropCourse(studentA.id, dropped.id);
    await selectCourse(studentB.id, offering.id);
    await drainWriteback();
    await cancelOffering("admin-test", offering.id, "测试停开");

    const dashboard = await getAdminDashboard();
    const detail = dashboard.offeringDetails.find((item) => item.id === offering.id);

    expect(detail?.dropped).toBe(1);
    expect(detail?.removed).toBe(1);
    expect(detail?.registrations.map((registration) => registration.status)).toEqual(
      expect.arrayContaining([RegistrationStatus.DROPPED, RegistrationStatus.REMOVED]),
    );
    expect(detail?.logs.map((log) => log.type)).toEqual(
      expect.arrayContaining([
        OperationType.COURSE_DROPPED,
        OperationType.OFFERING_CANCELED,
      ]),
    );
  });

  it("returns waitlist stats and removes waitlisted registrations when stopped", async () => {
    const offering = await prisma.courseOffering.findFirstOrThrow({
      where: {
        course: {
          courseNo: "GE204",
        },
      },
    });
    const studentA = await prisma.studentProfile.findUniqueOrThrow({
      where: { studentNo: "20240001" },
    });
    const studentB = await prisma.studentProfile.findUniqueOrThrow({
      where: { studentNo: "20240002" },
    });

    await selectCourse(studentA.id, offering.id);
    await joinWaitlist(studentB.id, offering.id);
    await drainWriteback();

    const dashboard = await getAdminDashboard();
    const detail = dashboard.offeringDetails.find((item) => item.id === offering.id);

    expect(detail?.active).toBe(1);
    expect(detail?.waitlisted).toBe(1);
    expect(detail?.registrations.map((registration) => registration.status)).toEqual(
      expect.arrayContaining([RegistrationStatus.ACTIVE, RegistrationStatus.WAITLISTED]),
    );

    await cancelOffering("admin-test", offering.id, "测试停开候补");

    const afterCancel = await getAdminDashboard();
    const canceled = afterCancel.offeringDetails.find((item) => item.id === offering.id);

    expect(canceled?.removed).toBe(2);
    expect(
      canceled?.registrations.every(
        (registration) => registration.status === RegistrationStatus.REMOVED,
      ),
    ).toBe(true);
    expect(canceled?.logs.map((log) => log.type)).toEqual(
      expect.arrayContaining([
        OperationType.COURSE_WAITLISTED,
        OperationType.OFFERING_CANCELED,
      ]),
    );
  });

  it("updates the selection window and rejects invalid ranges", async () => {
    const term = await prisma.term.findFirstOrThrow({
      where: { isCurrent: true },
    });
    const selectionStartsAt = new Date(term.selectionStartsAt.getTime() - 60_000);
    const selectionEndsAt = new Date(term.selectionEndsAt.getTime() + 60_000);

    await expect(
      updateTermWindow({
        adminId: "admin-test",
        selectionStartsAt: selectionEndsAt,
        selectionEndsAt,
      }),
    ).rejects.toThrow("开始时间必须早于结束时间");

    await updateTermWindow({
      adminId: "admin-test",
      selectionStartsAt,
      selectionEndsAt,
    });

    const updated = await prisma.term.findUniqueOrThrow({
      where: { id: term.id },
    });
    const log = await prisma.operationLog.findFirstOrThrow({
      where: {
        type: OperationType.TERM_WINDOW_UPDATED,
        targetId: term.id,
      },
    });

    expect(updated.selectionStartsAt.toISOString()).toBe(selectionStartsAt.toISOString());
    expect(updated.selectionEndsAt.toISOString()).toBe(selectionEndsAt.toISOString());
    expect(log.actorId).toBe("admin-test");
  });

  it("freezes an offering and records the operation", async () => {
    const offering = await prisma.courseOffering.findFirstOrThrow({
      where: {
        course: {
          courseNo: "SE301",
        },
      },
    });

    await closeOffering("admin-test", offering.id);

    const closed = await prisma.courseOffering.findUniqueOrThrow({
      where: { id: offering.id },
    });
    const log = await prisma.operationLog.findFirstOrThrow({
      where: {
        type: OperationType.OFFERING_CLOSED,
        targetId: offering.id,
      },
    });

    expect(closed.status).toBe(OfferingStatus.CLOSED);
    expect(log.message).toContain("冻结");
  });

  it("returns current term enrollment result snapshot", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE301");

    await selectCourse(studentId, offeringId);
    await drainWriteback();

    const snapshot = await getEnrollmentResultSnapshot();

    expect(snapshot.some((row) => row.student.studentNo === "20240001")).toBe(true);
    expect(snapshot.some((row) => row.offering.course.courseNo === "SE301")).toBe(true);
    expect(snapshot.every((row) => row.offering.term.isCurrent)).toBe(true);
  });
});

async function drainWriteback() {
  for (let index = 0; index < 5; index += 1) {
    const processed = await processEnrollmentWritebackBatch({
      consumer: `admin-test-${process.pid}-${index}`,
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
