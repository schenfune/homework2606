import { CourseCategory, RegistrationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { dropCourse, getStudentDashboard, selectCourse } from "@/lib/services/enrollment";
import { seedDemoData } from "@/prisma/seed";

describe("enrollment service", () => {
  beforeEach(async () => {
    await seedDemoData();
  });

  it("selects an eligible major elective", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE301");

    await selectCourse(studentId, offeringId);

    const registration = await prisma.courseRegistration.findUnique({
      where: {
        studentId_offeringId: {
          studentId,
          offeringId,
        },
      },
    });
    const offering = await prisma.courseOffering.findUniqueOrThrow({
      where: { id: offeringId },
    });

    expect(registration?.status).toBe(RegistrationStatus.ACTIVE);
    expect(offering.enrolledCount).toBe(1);
  });

  it("rejects duplicate selection without increasing capacity twice", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE301");

    await selectCourse(studentId, offeringId);
    await expect(selectCourse(studentId, offeringId)).rejects.toThrow();

    const offering = await prisma.courseOffering.findUniqueOrThrow({
      where: { id: offeringId },
    });
    const registrations = await prisma.courseRegistration.count({
      where: {
        studentId,
        offeringId,
        status: RegistrationStatus.ACTIVE,
      },
    });

    expect(offering.enrolledCount).toBe(1);
    expect(registrations).toBe(1);
  });

  it("rejects courses that conflict with required schedule", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE302");

    await expect(selectCourse(studentId, offeringId)).rejects.toThrow("上课时间冲突");
  });

  it("does not oversell the last seat under concurrent requests", async () => {
    const offering = await prisma.courseOffering.findFirstOrThrow({
      where: {
        course: {
          courseNo: "SE301",
        },
      },
    });
    await prisma.courseOffering.update({
      where: { id: offering.id },
      data: {
        capacity: 1,
        enrolledCount: 0,
      },
    });

    const students = await prisma.studentProfile.findMany({
      where: {
        major: {
          code: {
            in: ["080902", "080906"],
          },
        },
      },
      orderBy: {
        studentNo: "asc",
      },
    });

    const results = await Promise.allSettled(
      students.map((student) => selectCourse(student.id, offering.id)),
    );
    const activeCount = await prisma.courseRegistration.count({
      where: {
        offeringId: offering.id,
        status: RegistrationStatus.ACTIVE,
      },
    });
    const waitlistedCount = await prisma.courseRegistration.count({
      where: {
        offeringId: offering.id,
        status: RegistrationStatus.WAITLISTED,
      },
    });
    const updated = await prisma.courseOffering.findUniqueOrThrow({
      where: { id: offering.id },
    });

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(activeCount).toBe(1);
    expect(waitlistedCount).toBe(1);
    expect(updated.enrolledCount).toBe(1);
  });

  it("returns rule checks for selectable and conflicting courses", async () => {
    const student = await prisma.studentProfile.findUniqueOrThrow({
      where: { studentNo: "20240001" },
    });

    const dashboard = await getStudentDashboard(student.id);
    const selectable = dashboard.courses.find((course) => course.courseNo === "SE301");
    const conflicting = dashboard.courses.find((course) => course.courseNo === "SE302");

    expect(selectable?.ruleChecks.every((check) => check.status !== "block")).toBe(true);
    expect(
      conflicting?.ruleChecks.find((check) => check.code === "TIME_CONFLICT")?.status,
    ).toBe("block");
  });

  it("marks required and full courses in rule checks", async () => {
    const { studentId, offeringId } = await fixture("20240001", "SE301");
    await prisma.courseOffering.update({
      where: { id: offeringId },
      data: {
        capacity: 0,
        enrolledCount: 0,
      },
    });

    const dashboard = await getStudentDashboard(studentId);
    const required = dashboard.courses.find((course) => course.courseNo === "SE101");
    const full = dashboard.courses.find((course) => course.courseNo === "SE301");

    expect(
      required?.ruleChecks.find((check) => check.code === "COURSE_CATEGORY")?.status,
    ).toBe("block");
    expect(full?.ruleChecks.find((check) => check.code === "CAPACITY")?.status).toBe("info");
  });

  it("waitlists a full course without increasing enrolled count", async () => {
    const { studentId: firstStudentId, offeringId } = await fixture("20240001", "SE304");
    const { studentId: secondStudentId } = await fixture("20240002", "SE304");

    await selectCourse(firstStudentId, offeringId);
    const waitlisted = await selectCourse(secondStudentId, offeringId);

    const offering = await prisma.courseOffering.findUniqueOrThrow({
      where: { id: offeringId },
    });

    expect(waitlisted.status).toBe(RegistrationStatus.WAITLISTED);
    expect(waitlisted.waitlistPosition).toBe(1);
    expect(offering.enrolledCount).toBe(1);
  });

  it("assigns FIFO waitlist positions", async () => {
    const first = await fixture("20240001", "GE204");
    const second = await fixture("20240002", "GE204");
    const third = await fixture("20230003", "GE204");

    await selectCourse(first.studentId, first.offeringId);
    const secondWaitlist = await selectCourse(second.studentId, second.offeringId);
    const thirdWaitlist = await selectCourse(third.studentId, third.offeringId);

    expect(secondWaitlist.waitlistPosition).toBe(1);
    expect(thirdWaitlist.waitlistPosition).toBe(2);
  });

  it("uses waitlisted courses in conflict checks", async () => {
    const active = await fixture("20240002", "GE202");
    const waitlisted = await fixture("20240001", "GE202");
    const conflicting = await fixture("20240001", "GE201");

    await selectCourse(active.studentId, active.offeringId);
    await selectCourse(waitlisted.studentId, waitlisted.offeringId);

    await expect(selectCourse(conflicting.studentId, conflicting.offeringId)).rejects.toThrow(
      "上课时间冲突",
    );
  });

  it("promotes the first waitlisted student when an active registration drops", async () => {
    const first = await fixture("20240001", "SE304");
    const second = await fixture("20240002", "SE304");

    const active = await selectCourse(first.studentId, first.offeringId);
    await selectCourse(second.studentId, second.offeringId);
    await dropCourse(first.studentId, active.id);

    const promoted = await prisma.courseRegistration.findUniqueOrThrow({
      where: {
        studentId_offeringId: {
          studentId: second.studentId,
          offeringId: second.offeringId,
        },
      },
    });
    const offering = await prisma.courseOffering.findUniqueOrThrow({
      where: { id: first.offeringId },
    });

    expect(promoted.status).toBe(RegistrationStatus.ACTIVE);
    expect(promoted.waitlistPosition).toBeNull();
    expect(offering.enrolledCount).toBe(1);
  });

  it("drops a waitlisted registration without changing enrolled count", async () => {
    const first = await fixture("20240001", "SE304");
    const second = await fixture("20240002", "SE304");

    await selectCourse(first.studentId, first.offeringId);
    const waitlisted = await selectCourse(second.studentId, second.offeringId);
    await dropCourse(second.studentId, waitlisted.id);

    const dropped = await prisma.courseRegistration.findUniqueOrThrow({
      where: { id: waitlisted.id },
    });
    const offering = await prisma.courseOffering.findUniqueOrThrow({
      where: { id: first.offeringId },
    });

    expect(dropped.status).toBe(RegistrationStatus.DROPPED);
    expect(dropped.waitlistPosition).toBeNull();
    expect(offering.enrolledCount).toBe(1);
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
    include: {
      course: true,
    },
  });

  if (offering.course.category === CourseCategory.REQUIRED) {
    throw new Error("Fixture cannot target required course");
  }

  return {
    studentId: student.id,
    offeringId: offering.id,
  };
}
