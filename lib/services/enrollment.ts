import {
  CourseCategory,
  OfferingStatus,
  OperationType,
  Prisma,
  RegistrationStatus,
  Role,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  cacheKeys,
  getJsonCache,
  safeInvalidateEnrollmentCaches,
  setJsonCache,
} from "@/lib/services/cache";
import { hasMeetingConflict } from "@/lib/services/schedule";

export type RuleCheckCode =
  | "TERM_WINDOW"
  | "OFFERING_STATUS"
  | "COURSE_CATEGORY"
  | "ELIGIBILITY"
  | "CAPACITY"
  | "TIME_CONFLICT";

export type RuleCheckStatus = "pass" | "block" | "info";

export type CourseRuleCheck = {
  code: RuleCheckCode;
  label: string;
  status: RuleCheckStatus;
  detail: string;
};

export async function getStudentDashboard(profileId: string) {
  const cached = await getJsonCache<Awaited<ReturnType<typeof loadStudentDashboard>>>(
    cacheKeys.courseList(profileId),
  );

  if (cached) {
    return cached;
  }

  const dashboard = await loadStudentDashboard(profileId);
  await setJsonCache(cacheKeys.courseList(profileId), dashboard, 20);
  return dashboard;
}

async function loadStudentDashboard(profileId: string) {
  const [student, term] = await Promise.all([
    prisma.studentProfile.findUnique({
      where: { id: profileId },
      include: {
        department: true,
        major: true,
      },
    }),
    prisma.term.findFirst({
      where: { isCurrent: true },
      include: {
        offerings: {
          include: {
            course: true,
            meetingTimes: true,
            eligibilityRules: true,
            registrations: {
              where: { studentId: profileId },
            },
          },
          orderBy: [{ course: { courseNo: "asc" } }, { classNo: "asc" }],
        },
      },
    }),
  ]);

  if (!student || !term) {
    throw new Error("学生档案或当前学期不存在");
  }

  const registrations = await prisma.courseRegistration.findMany({
    where: {
      studentId: profileId,
      status: RegistrationStatus.ACTIVE,
    },
    include: {
      offering: {
        include: {
          course: true,
          meetingTimes: true,
        },
      },
    },
    orderBy: {
      registeredAt: "asc",
    },
  });

  const activeCourses = registrations
    .filter((registration) => registration.offering.status !== OfferingStatus.CANCELED)
    .map((registration) => ({
      offeringId: registration.offeringId,
      courseName: registration.offering.course.name,
      meetingTimes: registration.offering.meetingTimes,
    }));

  const courses = term.offerings.map((offering) => {
    const ownRegistration = offering.registrations[0];
    const ruleChecks = buildCourseRuleChecks({
      offering,
      student,
      term,
      activeCourses: activeCourses.filter((course) => course.offeringId !== offering.id),
      ownRegistrationStatus: ownRegistration?.status,
    });
    const reasons = getUnavailableReasons(ruleChecks, ownRegistration?.status);

    return {
      id: offering.id,
      courseNo: offering.course.courseNo,
      name: offering.course.name,
      classNo: offering.classNo,
      category: offering.course.category,
      credits: offering.course.credits,
      teacherName: offering.teacherName,
      capacity: offering.capacity,
      enrolledCount: offering.enrolledCount,
      status: offering.status,
      meetingTimes: offering.meetingTimes,
      ruleChecks,
      unavailableReasons: reasons,
      selected: ownRegistration?.status === RegistrationStatus.ACTIVE,
    };
  });

  return {
    student,
    term,
    courses,
    registrations,
    totalCredits: registrations.reduce(
      (sum, registration) => sum + registration.offering.course.credits,
      0,
    ),
  };
}

export async function selectCourse(profileId: string, offeringId: string) {
  const registration = await runSerializableTransaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${profileId})) AS locked
    `;

    if (!lock?.locked) {
      throw new Error("同一学生正在提交选课请求，请稍后再试");
    }

    const student = await tx.studentProfile.findUnique({
      where: { id: profileId },
      include: { department: true, major: true },
    });
    const term = await tx.term.findFirst({ where: { isCurrent: true } });
    const offering = await tx.courseOffering.findUnique({
      where: { id: offeringId },
      include: {
        course: true,
        meetingTimes: true,
        eligibilityRules: true,
      },
    });

    if (!student || !term || !offering) {
      throw new Error("选课数据不存在");
    }

    const existing = await tx.courseRegistration.findUnique({
      where: {
        studentId_offeringId: {
          studentId: profileId,
          offeringId,
        },
      },
    });

    const activeRegistrations = await tx.courseRegistration.findMany({
      where: {
        studentId: profileId,
        status: RegistrationStatus.ACTIVE,
        offering: {
          status: {
            not: OfferingStatus.CANCELED,
          },
        },
      },
      include: {
        offering: {
          include: {
            course: true,
            meetingTimes: true,
          },
        },
      },
    });

    const activeCourses = activeRegistrations
      .filter((registration) => registration.offeringId !== offeringId)
      .map((registration) => ({
        offeringId: registration.offeringId,
        courseName: registration.offering.course.name,
        meetingTimes: registration.offering.meetingTimes,
      }));

    const ruleChecks = buildCourseRuleChecks({
      offering,
      student,
      term,
      activeCourses,
      ownRegistrationStatus: existing?.status,
    });
    const reasons = getUnavailableReasons(ruleChecks, existing?.status);

    if (reasons.length > 0) {
      throw new Error(reasons[0]);
    }

    const updated = await tx.courseOffering.updateMany({
      where: {
        id: offeringId,
        status: OfferingStatus.PUBLISHED,
        enrolledCount: {
          lt: offering.capacity,
        },
      },
      data: {
        enrolledCount: {
          increment: 1,
        },
      },
    });

    if (updated.count !== 1) {
      throw new Error("课程容量已满");
    }

    const registration = existing
      ? await tx.courseRegistration.update({
          where: { id: existing.id },
          data: {
            status: RegistrationStatus.ACTIVE,
            registeredAt: new Date(),
          },
        })
      : await tx.courseRegistration.create({
          data: {
            studentId: profileId,
            offeringId,
            status: RegistrationStatus.ACTIVE,
          },
        });

    await tx.operationLog.create({
      data: {
        type: OperationType.COURSE_SELECTED,
        actorRole: Role.STUDENT,
        actorId: profileId,
        targetId: offeringId,
        message: `${student.name}选择${offering.course.name}`,
      },
    });

    return registration;
  });

  await safeInvalidateEnrollmentCaches(profileId);
  return registration;
}

export async function dropCourse(profileId: string, registrationId: string) {
  await runSerializableTransaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${profileId})) AS locked
    `;

    if (!lock?.locked) {
      throw new Error("同一学生正在提交退课请求，请稍后再试");
    }

    const registration = await tx.courseRegistration.findFirst({
      where: {
        id: registrationId,
        studentId: profileId,
        status: RegistrationStatus.ACTIVE,
      },
      include: {
        offering: {
          include: {
            course: true,
            term: true,
          },
        },
        student: true,
      },
    });

    if (!registration) {
      throw new Error("选课记录不存在");
    }

    if (registration.offering.course.category === CourseCategory.REQUIRED) {
      throw new Error("必修课不可退课");
    }

    assertTermOpen(registration.offering.term);

    if (registration.offering.status !== OfferingStatus.PUBLISHED) {
      throw new Error("课程已冻结，不能退课");
    }

    await tx.courseRegistration.update({
      where: { id: registration.id },
      data: { status: RegistrationStatus.DROPPED },
    });

    await tx.courseOffering.update({
      where: { id: registration.offeringId },
      data: {
        enrolledCount: {
          decrement: 1,
        },
      },
    });

    await tx.operationLog.create({
      data: {
        type: OperationType.COURSE_DROPPED,
        actorRole: Role.STUDENT,
        actorId: profileId,
        targetId: registration.offeringId,
        message: `${registration.student.name}退选${registration.offering.course.name}`,
      },
    });
  });

  await safeInvalidateEnrollmentCaches(profileId);
}

export function buildCourseRuleChecks({
  offering,
  student,
  term,
  activeCourses,
  ownRegistrationStatus,
}: {
  offering: Prisma.CourseOfferingGetPayload<{
    include: {
      course: true;
      meetingTimes: true;
      eligibilityRules: true;
    };
  }>;
  student: { departmentId: string; majorId: string; grade: number };
  term: { selectionStartsAt: Date; selectionEndsAt: Date };
  activeCourses: {
    offeringId: string;
    courseName: string;
    meetingTimes: {
      weekday: number;
      startPeriod: number;
      endPeriod: number;
      startWeek: number;
      endWeek: number;
    }[];
  }[];
  ownRegistrationStatus?: RegistrationStatus;
}): CourseRuleCheck[] {
  const termOpen = isTermOpen(term);
  const eligible =
    offering.course.category !== CourseCategory.MAJOR_ELECTIVE ||
    offering.eligibilityRules.some(
      (rule) =>
        rule.majorId === student.majorId &&
        rule.grade === student.grade &&
        rule.departmentId === student.departmentId,
    );
  const conflictCourse = activeCourses.find((course) =>
    hasMeetingConflict(course.meetingTimes, offering.meetingTimes),
  );
  const full = offering.enrolledCount >= offering.capacity;

  return [
    {
      code: "TERM_WINDOW",
      label: "开放期",
      status: termOpen ? "pass" : "block",
      detail: termOpen ? "当前开放" : "未开放",
    },
    {
      code: "OFFERING_STATUS",
      label: "课程状态",
      status: offering.status === OfferingStatus.PUBLISHED ? "pass" : "block",
      detail: offeringStatusDetail(offering.status),
    },
    {
      code: "COURSE_CATEGORY",
      label: "课程类别",
      status:
        offering.course.category === CourseCategory.REQUIRED
          ? "block"
          : ownRegistrationStatus === RegistrationStatus.ACTIVE
          ? "info"
          : "pass",
      detail:
        offering.course.category === CourseCategory.REQUIRED
          ? "必修锁定"
          : ownRegistrationStatus === RegistrationStatus.ACTIVE
          ? "已入课表"
          : "学生可选",
    },
    {
      code: "ELIGIBILITY",
      label: "专业年级",
      status: eligible ? "pass" : "block",
      detail:
        offering.course.category === CourseCategory.MAJOR_ELECTIVE
          ? eligible
            ? "范围匹配"
            : "范围不匹配"
          : "不限专业",
    },
    {
      code: "CAPACITY",
      label: "容量",
      status: full ? "block" : "pass",
      detail: `${offering.enrolledCount}/${offering.capacity}`,
    },
    {
      code: "TIME_CONFLICT",
      label: "时间冲突",
      status: conflictCourse ? "block" : "pass",
      detail: conflictCourse ? conflictCourse.courseName : "无冲突",
    },
  ];
}

function getUnavailableReasons(
  ruleChecks: CourseRuleCheck[],
  ownRegistrationStatus?: RegistrationStatus,
) {
  const reasons = ruleChecks
    .filter((check) => check.status === "block")
    .map(ruleCheckToReason);

  if (ownRegistrationStatus === RegistrationStatus.ACTIVE && !reasons.includes("已选择该课程")) {
    reasons.push("已选择该课程");
  }

  return reasons;
}

function ruleCheckToReason(check: CourseRuleCheck) {
  if (check.code === "TERM_WINDOW") return "不在选课开放期";
  if (check.code === "COURSE_CATEGORY") return "必修课由教务系统预置";
  if (check.code === "ELIGIBILITY") return "不符合专业年级范围";
  if (check.code === "CAPACITY") return "课程容量已满";
  if (check.code === "TIME_CONFLICT") return "上课时间冲突";
  if (check.code === "OFFERING_STATUS") {
    return check.detail === "已取消" ? "课程已取消" : "课程名单已冻结";
  }

  return "不可选";
}

function offeringStatusDetail(status: OfferingStatus) {
  if (status === OfferingStatus.PUBLISHED) return "开放";
  if (status === OfferingStatus.CLOSED) return "已冻结";
  return "已取消";
}

function isTermOpen(term: { selectionStartsAt: Date; selectionEndsAt: Date }) {
  const now = new Date();
  return now >= term.selectionStartsAt && now <= term.selectionEndsAt;
}

function assertTermOpen(term: { selectionStartsAt: Date; selectionEndsAt: Date }) {
  if (!isTermOpen(term)) {
    throw new Error("不在选课开放期");
  }
}

async function runSerializableTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 3,
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;

      if (!isRetryableTransactionError(error) || attempt === attempts) {
        throw error;
      }

      await wait(attempt * 25);
    }
  }

  throw lastError;
}

function isRetryableTransactionError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2034"
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : "";
  return message.includes("write conflict") || message.includes("deadlock");
}

function wait(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
