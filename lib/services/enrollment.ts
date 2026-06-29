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
  safeInvalidateAllEnrollmentCaches,
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

const SCHEDULE_OCCUPYING_STATUSES = [
  RegistrationStatus.ACTIVE,
  RegistrationStatus.WAITLISTED,
];

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
      status: {
        in: SCHEDULE_OCCUPYING_STATUSES,
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
    orderBy: {
      registeredAt: "asc",
    },
  });

  const occupiedCourses = registrations
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
      activeCourses: occupiedCourses.filter((course) => course.offeringId !== offering.id),
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
      waitlisted: ownRegistration?.status === RegistrationStatus.WAITLISTED,
      waitlistPosition: ownRegistration?.waitlistPosition,
    };
  });

  const activeRegistrations = registrations.filter(
    (registration) => registration.status === RegistrationStatus.ACTIVE,
  );

  return {
    student,
    term,
    courses,
    registrations,
    totalCredits: activeRegistrations.reduce(
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

    await acquireOfferingLock(tx, offeringId);

    const existing = await tx.courseRegistration.findUnique({
      where: {
        studentId_offeringId: {
          studentId: profileId,
          offeringId,
        },
      },
    });

    const occupiedRegistrations = await tx.courseRegistration.findMany({
      where: {
        studentId: profileId,
        status: {
          in: SCHEDULE_OCCUPYING_STATUSES,
        },
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

    const occupiedCourses = occupiedRegistrations
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
      activeCourses: occupiedCourses,
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

    if (updated.count === 1) {
      const registration = existing
        ? await tx.courseRegistration.update({
            where: { id: existing.id },
            data: {
              status: RegistrationStatus.ACTIVE,
              registeredAt: new Date(),
              waitlistedAt: null,
              waitlistPosition: null,
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
    }

    const currentOffering = await tx.courseOffering.findUnique({
      where: { id: offeringId },
      select: {
        capacity: true,
        enrolledCount: true,
        status: true,
      },
    });

    if (!currentOffering || currentOffering.status !== OfferingStatus.PUBLISHED) {
      throw new Error("课程名单已冻结");
    }

    if (currentOffering.enrolledCount < currentOffering.capacity) {
      throw new Error("选课提交冲突，请重试");
    }

    const registration = await createOrRestoreWaitlistRegistration({
      tx,
      existing,
      profileId,
      offeringId,
    });

    await tx.operationLog.create({
      data: {
        type: OperationType.COURSE_WAITLISTED,
        actorRole: Role.STUDENT,
        actorId: profileId,
        targetId: offeringId,
        message: `${student.name}候补${offering.course.name}`,
        metadata: {
          waitlistPosition: registration.waitlistPosition,
        },
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
        status: {
          in: SCHEDULE_OCCUPYING_STATUSES,
        },
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

    await acquireOfferingLock(tx, registration.offeringId);

    if (registration.offering.course.category === CourseCategory.REQUIRED) {
      throw new Error("必修课不可退课");
    }

    assertTermOpen(registration.offering.term);

    if (registration.offering.status !== OfferingStatus.PUBLISHED) {
      throw new Error("课程已冻结，不能退课");
    }

    if (registration.status === RegistrationStatus.WAITLISTED) {
      await tx.courseRegistration.update({
        where: { id: registration.id },
        data: {
          status: RegistrationStatus.DROPPED,
          waitlistPosition: null,
        },
      });

      await tx.operationLog.create({
        data: {
          type: OperationType.WAITLIST_DROPPED,
          actorRole: Role.STUDENT,
          actorId: profileId,
          targetId: registration.offeringId,
          message: `${registration.student.name}退出${registration.offering.course.name}候补`,
        },
      });

      return;
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

    await promoteFirstWaitlistedRegistration({
      tx,
      offeringId: registration.offeringId,
      courseName: registration.offering.course.name,
    });
  });

  await safeInvalidateAllEnrollmentCaches();
}

async function createOrRestoreWaitlistRegistration({
  tx,
  existing,
  profileId,
  offeringId,
}: {
  tx: Prisma.TransactionClient;
  existing: { id: string } | null;
  profileId: string;
  offeringId: string;
}) {
  const position = await nextWaitlistPosition(tx, offeringId);
  const now = new Date();

  return existing
    ? tx.courseRegistration.update({
        where: { id: existing.id },
        data: {
          status: RegistrationStatus.WAITLISTED,
          waitlistedAt: now,
          waitlistPosition: position,
        },
      })
    : tx.courseRegistration.create({
        data: {
          studentId: profileId,
          offeringId,
          status: RegistrationStatus.WAITLISTED,
          waitlistedAt: now,
          waitlistPosition: position,
        },
      });
}

async function promoteFirstWaitlistedRegistration({
  tx,
  offeringId,
  courseName,
}: {
  tx: Prisma.TransactionClient;
  offeringId: string;
  courseName: string;
}) {
  const candidate = await tx.courseRegistration.findFirst({
    where: {
      offeringId,
      status: RegistrationStatus.WAITLISTED,
    },
    include: {
      student: true,
    },
    orderBy: [
      { waitlistPosition: "asc" },
      { waitlistedAt: "asc" },
      { registeredAt: "asc" },
    ],
  });

  if (!candidate) {
    return;
  }

  const promoted = await tx.courseRegistration.updateMany({
    where: {
      id: candidate.id,
      status: RegistrationStatus.WAITLISTED,
    },
    data: {
      status: RegistrationStatus.ACTIVE,
      registeredAt: new Date(),
      waitlistPosition: null,
    },
  });

  if (promoted.count !== 1) {
    return;
  }

  await tx.courseOffering.update({
    where: { id: offeringId },
    data: {
      enrolledCount: {
        increment: 1,
      },
    },
  });

  await tx.operationLog.create({
    data: {
      type: OperationType.WAITLIST_PROMOTED,
      actorRole: Role.STUDENT,
      actorId: candidate.studentId,
      targetId: offeringId,
      message: `${candidate.student.name}递补${courseName}`,
      metadata: {
        previousWaitlistPosition: candidate.waitlistPosition,
      },
    },
  });
}

async function nextWaitlistPosition(tx: Prisma.TransactionClient, offeringId: string) {
  const aggregate = await tx.courseRegistration.aggregate({
    where: {
      offeringId,
      status: RegistrationStatus.WAITLISTED,
    },
    _max: {
      waitlistPosition: true,
    },
  });

  return (aggregate._max.waitlistPosition ?? 0) + 1;
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
          : ownRegistrationStatus === RegistrationStatus.ACTIVE ||
            ownRegistrationStatus === RegistrationStatus.WAITLISTED
          ? "info"
          : "pass",
      detail:
        offering.course.category === CourseCategory.REQUIRED
          ? "必修锁定"
          : ownRegistrationStatus === RegistrationStatus.ACTIVE
          ? "已入课表"
          : ownRegistrationStatus === RegistrationStatus.WAITLISTED
          ? "候补中"
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
      status: full ? "info" : "pass",
      detail: full
        ? `${offering.enrolledCount}/${offering.capacity} · 可候补`
        : `${offering.enrolledCount}/${offering.capacity}`,
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
  const reasons: string[] = ruleChecks
    .filter((check) => check.status === "block")
    .map(ruleCheckToReason);

  if (ownRegistrationStatus === RegistrationStatus.ACTIVE && !reasons.includes("已选择该课程")) {
    reasons.push("已选择该课程");
  }

  if (
    ownRegistrationStatus === RegistrationStatus.WAITLISTED &&
    !reasons.includes("已加入候补")
  ) {
    reasons.push("已加入候补");
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
    return check.detail === "已停开" ? "课程已停开" : "课程名单已冻结";
  }

  return "不可选";
}

function offeringStatusDetail(status: OfferingStatus) {
  if (status === OfferingStatus.PUBLISHED) return "开放";
  if (status === OfferingStatus.CLOSED) return "已冻结";
  return "已停开";
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

async function acquireOfferingLock(tx: Prisma.TransactionClient, offeringId: string) {
  const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtext(${`offering:${offeringId}`})) AS locked
  `;

  if (!lock?.locked) {
    throw new Error("课程名单正在更新，请稍后再试");
  }
}

async function runSerializableTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 5,
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
  return (
    message.includes("write conflict") ||
    message.includes("deadlock") ||
    message.includes("课程名单正在更新")
  );
}

function wait(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
