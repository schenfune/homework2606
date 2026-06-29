import { OperationType, RegistrationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { cancelOffering, getAdminDashboard } from "@/lib/services/admin";
import { dropCourse, selectCourse } from "@/lib/services/enrollment";
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

    const dropped = await selectCourse(studentA.id, offering.id);
    await dropCourse(studentA.id, dropped.id);
    await selectCourse(studentB.id, offering.id);
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
    await selectCourse(studentB.id, offering.id);

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
