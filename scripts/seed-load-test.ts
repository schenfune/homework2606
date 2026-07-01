import { CourseCategory, OfferingStatus, Prisma, Role } from "@prisma/client";
import { makeSignature } from "better-auth/crypto";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { hashPassword } from "../lib/auth/password";
import { prisma } from "../lib/db/prisma";
import { redis } from "../lib/db/redis";
import { safeInvalidateAllEnrollmentCaches } from "../lib/services/cache";
import { clearEnrollmentReservationState } from "../lib/services/enrollment-reservations";

const artifactDir = "artifacts";
const targetPath = `${artifactDir}/load-test-target.json`;
const studentCount = Number(process.env.LOAD_STUDENT_COUNT || 200);
const capacity = Number(process.env.LOAD_COURSE_CAPACITY || 30);
const password = process.env.LOAD_STUDENT_PASSWORD || "12345678";
const courseNo = process.env.LOAD_COURSE_NO || "LT101";
const studentPrefix = process.env.LOAD_STUDENT_PREFIX || "LT2026";
const authSecret =
  process.env.BETTER_AUTH_SECRET ?? "course-dev-secret-change-me-before-production-2026";

type LoadStudent = {
  studentNo: string;
  email: string;
  password: string;
  cookie: string;
};

// 准备多学生抢课压测所需的课程、学生账号和会话Cookie。
async function main() {
  if (!Number.isInteger(studentCount) || studentCount <= 0) {
    throw new Error("LOAD_STUDENT_COUNT必须是正整数");
  }

  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error("LOAD_COURSE_CAPACITY必须是正整数");
  }

  // 在一个事务内重建压测课程和学生，避免半成品数据进入压测。
  const result = await prisma.$transaction(
    async (tx) => {
      // 压测学生统一放在软件学院和软件工程专业下。
      const department = await tx.department.upsert({
        where: { code: "SE" },
        update: {
          name: "软件学院",
        },
        create: {
          code: "SE",
          name: "软件学院",
        },
      });
      const major = await tx.major.upsert({
        where: { code: "080902" },
        update: {
          name: "软件工程",
          departmentId: department.id,
        },
        create: {
          code: "080902",
          name: "软件工程",
          departmentId: department.id,
        },
      });
      const term = await ensureCurrentTerm(tx);
      // LT101是专用压测课程，不参与普通演示课程。
      const course = await tx.course.upsert({
        where: { courseNo },
        update: {
          name: "高并发选课演练",
          credits: 2,
          category: CourseCategory.MAJOR_ELECTIVE,
          departmentId: department.id,
        },
        create: {
          courseNo,
          name: "高并发选课演练",
          credits: 2,
          category: CourseCategory.MAJOR_ELECTIVE,
          departmentId: department.id,
        },
      });
      const existingOffering = await tx.courseOffering.findUnique({
        where: {
          termId_courseId_classNo: {
            termId: term.id,
            courseId: course.id,
            classNo: "LT",
          },
        },
      });
      const existingStudents = await tx.studentProfile.findMany({
        where: {
          studentNo: {
            startsWith: studentPrefix,
          },
        },
        select: {
          id: true,
        },
      });
      const existingStudentIds = existingStudents.map((student) => student.id);
      const operationLogCleanup: Prisma.OperationLogWhereInput[] = [];
      const registrationCleanup: Prisma.CourseRegistrationWhereInput[] = [];

      if (existingOffering) {
        // 重建同一压测课程时，先清理旧名单和旧日志。
        operationLogCleanup.push({ targetId: existingOffering.id });
        registrationCleanup.push({ offeringId: existingOffering.id });
      }

      if (existingStudentIds.length > 0) {
        // 旧压测学生产生的登记和日志也要清理。
        operationLogCleanup.push({
          actorId: {
            in: existingStudentIds,
          },
        });
        registrationCleanup.push({
          studentId: {
            in: existingStudentIds,
          },
        });
      }

      if (operationLogCleanup.length > 0) {
        await tx.operationLog.deleteMany({
          where: {
            OR: operationLogCleanup,
          },
        });
      }

      if (registrationCleanup.length > 0) {
        await tx.courseRegistration.deleteMany({
          where: {
            OR: registrationCleanup,
          },
        });
      }

      if (existingOffering) {
        await tx.meetingTime.deleteMany({
          where: {
            offeringId: existingOffering.id,
          },
        });
        await tx.eligibilityRule.deleteMany({
          where: {
            offeringId: existingOffering.id,
          },
        });
      }

      const offering = await tx.courseOffering.upsert({
        where: {
          termId_courseId_classNo: {
            termId: term.id,
            courseId: course.id,
            classNo: "LT",
          },
        },
        update: {
          capacity,
          enrolledCount: 0,
          teacherName: "压测教师",
          status: OfferingStatus.PUBLISHED,
          canceledReason: null,
        },
        create: {
          termId: term.id,
          courseId: course.id,
          classNo: "LT",
          capacity,
          enrolledCount: 0,
          teacherName: "压测教师",
          status: OfferingStatus.PUBLISHED,
        },
      });

      // 压测课程安排在较晚节次，减少与普通演示课程冲突。
      await tx.meetingTime.create({
        data: {
          offeringId: offering.id,
          weekday: 6,
          startPeriod: 11,
          endPeriod: 12,
          startWeek: 1,
          endWeek: 16,
        },
      });
      await tx.eligibilityRule.create({
        data: {
          offeringId: offering.id,
          departmentId: department.id,
          majorId: major.id,
          grade: 2026,
        },
      });

      const students: LoadStudent[] = [];
      const passwordHash = await hashPassword(password);
      const sessionExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // 预置Better Auth会话Cookie，避免压测被登录接口限流影响。
      for (let index = 1; index <= studentCount; index += 1) {
        const studentNo = `${studentPrefix}${String(index).padStart(4, "0")}`;
        const email = `${studentNo.toLowerCase()}@campus.local`;
        const student = await tx.studentProfile.upsert({
          where: { studentNo },
          update: {
            name: `压测学生${String(index).padStart(3, "0")}`,
            grade: 2026,
            departmentId: department.id,
            majorId: major.id,
          },
          create: {
            studentNo,
            name: `压测学生${String(index).padStart(3, "0")}`,
            grade: 2026,
            departmentId: department.id,
            majorId: major.id,
          },
        });
        const user = await tx.user.upsert({
          where: { email },
          update: {
            name: student.name,
            emailVerified: true,
            username: studentNo,
            displayUsername: studentNo,
            role: Role.STUDENT,
            profileId: student.id,
          },
          create: {
            name: student.name,
            email,
            emailVerified: true,
            username: studentNo,
            displayUsername: studentNo,
            role: Role.STUDENT,
            profileId: student.id,
          },
        });

        await tx.session.deleteMany({
          where: {
            userId: user.id,
          },
        });
        await tx.account.deleteMany({
          where: {
            userId: user.id,
            providerId: "credential",
          },
        });
        await tx.account.create({
          data: {
            accountId: email,
            providerId: "credential",
            userId: user.id,
            password: passwordHash,
          },
        });
        const sessionToken = randomBytes(32).toString("hex");
        const signedSessionToken = await signSessionToken(sessionToken);

        await tx.session.create({
          data: {
            token: sessionToken,
            expiresAt: sessionExpiresAt,
            userId: user.id,
          },
        });
        students.push({
          studentNo,
          email,
          password,
          cookie: `better-auth.session_token=${signedSessionToken}`,
        });
      }

      return {
        offering,
        course,
        students,
      };
    },
    {
      timeout: 60_000,
    },
  );

  // 压测前清理缓存、Redis预占和限流键，保证结果可复现。
  await safeInvalidateAllEnrollmentCaches();
  await clearEnrollmentReservationState();
  await clearRateLimitKeys(result.students.map((student) => student.studentNo));
  await mkdir(artifactDir, { recursive: true });
  await clearOldLoadArtifacts();
  // k6脚本从目标文件读取课程、容量、学生和Cookie。
  await writeFile(
    targetPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: "flash",
        courseNo: result.course.courseNo,
        courseName: result.course.name,
        offeringId: result.offering.id,
        classNo: result.offering.classNo,
        capacity: result.offering.capacity,
        studentCount: result.students.length,
        password,
        students: result.students,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log("压测数据已准备");
  console.log(`课程: ${result.course.courseNo} ${result.course.name}`);
  console.log(`开课班ID: ${result.offering.id}`);
  console.log(`容量: ${result.offering.capacity}`);
  console.log(`学生数: ${result.students.length}`);
  console.log(`目标文件: ${targetPath}`);
}

// 确保存在当前学期，压测数据必须挂到当前学期下。
async function ensureCurrentTerm(tx: Prisma.TransactionClient) {
  const currentTerm = await tx.term.findFirst({
    where: {
      isCurrent: true,
    },
  });

  if (currentTerm) {
    return currentTerm;
  }

  // 没有当前学期时创建一个开放中的默认学期。
  const now = new Date();
  return tx.term.upsert({
    where: {
      code: "2025-2026-1",
    },
    update: {
      isCurrent: true,
      selectionStartsAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      selectionEndsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    },
    create: {
      code: "2025-2026-1",
      name: "2025-2026学年第一学期",
      startsAt: new Date("2025-09-01T00:00:00+08:00"),
      endsAt: new Date("2026-01-18T23:59:59+08:00"),
      selectionStartsAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      selectionEndsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      isCurrent: true,
    },
  });
}

// 清理压测学生的限流键，避免上一次压测影响下一次结果。
async function clearRateLimitKeys(studentNos: string[]) {
  const profiles = await prisma.studentProfile.findMany({
    where: {
      studentNo: {
        in: studentNos,
      },
    },
    select: {
      id: true,
    },
  });

  if (profiles.length > 0) {
    await redis.del(profiles.map((profile) => `rate-limit:select:${profile.id}`));
  }
}

// 删除旧压测报告，避免新旧结果混在一起。
async function clearOldLoadArtifacts() {
  await Promise.all(
    [
      "k6-enrollment-summary.json",
      "k6-enrollment-report.html",
      "load-test-verification.json",
      "load-test-verification.md",
    ].map((fileName) => rm(`${artifactDir}/${fileName}`, { force: true })),
  );
}

// 生成Better Auth兼容的签名会话Token。
async function signSessionToken(token: string) {
  return `${token}.${await makeSignature(token, authSecret)}`;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();

    if (redis.isOpen) {
      await redis.quit();
    }
  });
