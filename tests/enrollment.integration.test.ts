import { CourseCategory, RegistrationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { selectCourse } from "@/lib/services/enrollment";
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
    const successful = results.filter((result) => result.status === "fulfilled");
    const activeCount = await prisma.courseRegistration.count({
      where: {
        offeringId: offering.id,
        status: RegistrationStatus.ACTIVE,
      },
    });
    const updated = await prisma.courseOffering.findUniqueOrThrow({
      where: { id: offering.id },
    });

    expect(successful).toHaveLength(1);
    expect(activeCount).toBe(1);
    expect(updated.enrolledCount).toBe(1);
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
