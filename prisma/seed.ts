import {
  CourseCategory,
  OfferingStatus,
  Prisma,
  RegistrationStatus,
  Role,
} from "@prisma/client";
import { pathToFileURL } from "node:url";
import { hashPassword } from "../lib/auth/password";
import { prisma } from "../lib/db/prisma";
import { safeInvalidateAllEnrollmentCaches } from "../lib/services/cache";

const demoPassword = "12345678";

export async function seedDemoData() {
  await prisma.$transaction(async (tx) => {
    await tx.operationLog.deleteMany();
    await tx.courseRegistration.deleteMany();
    await tx.eligibilityRule.deleteMany();
    await tx.meetingTime.deleteMany();
    await tx.courseOffering.deleteMany();
    await tx.course.deleteMany();
    await tx.term.deleteMany();
    await tx.studentProfile.deleteMany();
    await tx.major.deleteMany();
    await tx.department.deleteMany();
    await tx.session.deleteMany();
    await tx.account.deleteMany();
    await tx.user.deleteMany();

    const software = await tx.department.create({
      data: {
        code: "SE",
        name: "软件学院",
      },
    });

    const humanities = await tx.department.create({
      data: {
        code: "HM",
        name: "人文学院",
      },
    });

    const softwareEngineering = await tx.major.create({
      data: {
        code: "080902",
        name: "软件工程",
        departmentId: software.id,
      },
    });

    const digitalMedia = await tx.major.create({
      data: {
        code: "080906",
        name: "数字媒体技术",
        departmentId: software.id,
      },
    });

    const literature = await tx.major.create({
      data: {
        code: "050101",
        name: "汉语言文学",
        departmentId: humanities.id,
      },
    });

    const studentA = await tx.studentProfile.create({
      data: {
        studentNo: "20240001",
        name: "林知远",
        grade: 2024,
        departmentId: software.id,
        majorId: softwareEngineering.id,
      },
    });

    const studentB = await tx.studentProfile.create({
      data: {
        studentNo: "20240002",
        name: "许清然",
        grade: 2024,
        departmentId: software.id,
        majorId: digitalMedia.id,
      },
    });

    const studentC = await tx.studentProfile.create({
      data: {
        studentNo: "20230003",
        name: "周听澜",
        grade: 2023,
        departmentId: humanities.id,
        majorId: literature.id,
      },
    });

    await createAuthUser({
      tx,
      username: studentA.studentNo,
      name: studentA.name,
      role: Role.STUDENT,
      profileId: studentA.id,
    });
    await createAuthUser({
      tx,
      username: studentB.studentNo,
      name: studentB.name,
      role: Role.STUDENT,
      profileId: studentB.id,
    });
    await createAuthUser({
      tx,
      username: studentC.studentNo,
      name: studentC.name,
      role: Role.STUDENT,
      profileId: studentC.id,
    });
    await createAuthUser({
      tx,
      username: "admin001",
      name: "选课管理员",
      role: Role.ADMIN,
      profileId: null,
    });

    const now = new Date();
    const term = await tx.term.create({
      data: {
        code: "2025-2026-1",
        name: "2025-2026学年第一学期",
        startsAt: new Date("2025-09-01T00:00:00+08:00"),
        endsAt: new Date("2026-01-18T23:59:59+08:00"),
        selectionStartsAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        selectionEndsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        isCurrent: true,
      },
    });

    const requiredCourse = await tx.course.create({
      data: {
        courseNo: "SE101",
        name: "程序设计基础",
        credits: 4,
        category: CourseCategory.REQUIRED,
        departmentId: software.id,
      },
    });

    const architectureCourse = await tx.course.create({
      data: {
        courseNo: "SE301",
        name: "软件体系结构",
        credits: 3,
        category: CourseCategory.MAJOR_ELECTIVE,
        departmentId: software.id,
      },
    });

    const webCourse = await tx.course.create({
      data: {
        courseNo: "SE302",
        name: "Web应用开发",
        credits: 3,
        category: CourseCategory.MAJOR_ELECTIVE,
        departmentId: software.id,
      },
    });

    const artCourse = await tx.course.create({
      data: {
        courseNo: "GE201",
        name: "艺术鉴赏",
        credits: 2,
        category: CourseCategory.PUBLIC_ELECTIVE,
        departmentId: humanities.id,
      },
    });

    const requiredOffering = await createOffering({
      tx,
      termId: term.id,
      courseId: requiredCourse.id,
      classNo: "01",
      teacherName: "陈老师",
      capacity: 80,
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
    });

    await tx.courseRegistration.createMany({
      data: [studentA, studentB].map((student) => ({
        studentId: student.id,
        offeringId: requiredOffering.id,
        status: RegistrationStatus.ACTIVE,
      })),
    });

    const architectureOffering = await createOffering({
      tx,
      termId: term.id,
      courseId: architectureCourse.id,
      classNo: "01",
      teacherName: "李老师",
      capacity: 2,
      weekday: 2,
      startPeriod: 3,
      endPeriod: 4,
    });

    await tx.eligibilityRule.createMany({
      data: [
        {
          offeringId: architectureOffering.id,
          departmentId: software.id,
          majorId: softwareEngineering.id,
          grade: 2024,
        },
        {
          offeringId: architectureOffering.id,
          departmentId: software.id,
          majorId: digitalMedia.id,
          grade: 2024,
        },
      ],
    });

    const webOffering = await createOffering({
      tx,
      termId: term.id,
      courseId: webCourse.id,
      classNo: "01",
      teacherName: "王老师",
      capacity: 40,
      weekday: 1,
      startPeriod: 1,
      endPeriod: 2,
    });

    await tx.eligibilityRule.create({
      data: {
        offeringId: webOffering.id,
        departmentId: software.id,
        majorId: softwareEngineering.id,
        grade: 2024,
      },
    });

    await createOffering({
      tx,
      termId: term.id,
      courseId: artCourse.id,
      classNo: "01",
      teacherName: "赵老师",
      capacity: 120,
      weekday: 4,
      startPeriod: 7,
      endPeriod: 8,
    });

    await tx.courseOffering.update({
      where: { id: requiredOffering.id },
      data: {
        enrolledCount: 2,
      },
    });
  });

  await safeInvalidateAllEnrollmentCaches();
}

async function createAuthUser({
  tx,
  username,
  name,
  role,
  profileId,
}: {
  tx: Prisma.TransactionClient;
  username: string;
  name: string;
  role: Role;
  profileId: string | null;
}) {
  const email = `${username}@campus.local`;
  const user = await tx.user.create({
    data: {
      name,
      email,
      emailVerified: true,
      username,
      displayUsername: username,
      role,
      profileId,
    },
  });

  await tx.account.create({
    data: {
      accountId: email,
      providerId: "credential",
      userId: user.id,
      password: await hashPassword(demoPassword),
    },
  });
}

async function createOffering({
  tx,
  termId,
  courseId,
  classNo,
  teacherName,
  capacity,
  weekday,
  startPeriod,
  endPeriod,
}: {
  tx: Prisma.TransactionClient;
  termId: string;
  courseId: string;
  classNo: string;
  teacherName: string;
  capacity: number;
  weekday: number;
  startPeriod: number;
  endPeriod: number;
}) {
  return tx.courseOffering.create({
    data: {
      termId,
      courseId,
      classNo,
      teacherName,
      capacity,
      status: OfferingStatus.PUBLISHED,
      meetingTimes: {
        create: {
          weekday,
          startPeriod,
          endPeriod,
          startWeek: 1,
          endWeek: 16,
        },
      },
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemoData()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (error) => {
      console.error(error);
      await prisma.$disconnect();
      process.exit(1);
    });
}
