import { OperationType, RegistrationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { cancelOffering, getAdminDashboard } from "@/lib/services/admin";
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
