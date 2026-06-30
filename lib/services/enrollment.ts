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
import {
  decrementActiveGate,
  getRedisGateSnapshot,
  getStudentReservations,
  releaseReservation,
  reservationKey,
  reserveActiveSeat,
  reserveWaitlistSeat,
  type StudentReservation,
} from "@/lib/services/enrollment-reservations";
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
const RESERVATION_REGISTRATION_PREFIX = "enrollment:reservation:";

export class EnrollmentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "EnrollmentError";
  }
}

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
  const redisReservations = await getStudentReservations(profileId);
  const redisReservationsByOffering = new Map(
    redisReservations.map((reservation) => [reservation.offeringId, reservation]),
  );
  const gateSnapshots = await Promise.all(
    term.offerings.map((offering) => getRedisGateSnapshot(offering.id)),
  );
  const gateActiveByOffering = new Map(
    term.offerings.map((offering, index) => {
      const active = gateSnapshots[index]?.active;
      return [
        offering.id,
        active !== undefined && active !== "" ? Number(active) : offering.enrolledCount,
      ] as const;
    }),
  );
  const syntheticRegistrations = redisReservations
    .filter(
      (reservation) =>
        !registrations.some(
          (registration) =>
            registration.offeringId === reservation.offeringId &&
            isScheduleOccupyingStatus(registration.status),
        ),
    )
    .flatMap((reservation) => {
      const offering = term.offerings.find((item) => item.id === reservation.offeringId);

      if (!offering) {
        return [];
      }

      return [
        {
          id: reservation.key,
          status: reservationStatusToRegistrationStatus(reservation),
          registeredAt: new Date(),
          waitlistedAt: reservation.kind === "WAITLIST" ? new Date() : null,
          waitlistPosition: null,
          updatedAt: new Date(),
          studentId: profileId,
          offeringId: reservation.offeringId,
          offering,
        },
      ];
    });
  const visibleRegistrations = [...registrations, ...syntheticRegistrations];

  const occupiedCourses = visibleRegistrations
    .filter((registration) => registration.offering.status !== OfferingStatus.CANCELED)
    .map((registration) => ({
      offeringId: registration.offeringId,
      courseName: registration.offering.course.name,
      meetingTimes: registration.offering.meetingTimes,
    }));

  const courses = term.offerings.map((offering) => {
    const ownRegistration = offering.registrations[0];
    const ownReservation = redisReservationsByOffering.get(offering.id);
    const ownStatus =
      ownRegistration && isScheduleOccupyingStatus(ownRegistration.status)
        ? ownRegistration.status
        : ownReservation
        ? reservationStatusToRegistrationStatus(ownReservation)
        : undefined;
    const enrolledCount = gateActiveByOffering.get(offering.id) ?? offering.enrolledCount;
    const offeringForRules = {
      ...offering,
      enrolledCount,
    };
    const ruleChecks = buildCourseRuleChecks({
      offering: offeringForRules,
      student,
      term,
      activeCourses: occupiedCourses.filter((course) => course.offeringId !== offering.id),
      ownRegistrationStatus: ownStatus,
    });
    const reasons = getUnavailableReasons(ruleChecks, ownStatus);

    return {
      id: offering.id,
      courseNo: offering.course.courseNo,
      name: offering.course.name,
      classNo: offering.classNo,
      category: offering.course.category,
      credits: offering.course.credits,
      teacherName: offering.teacherName,
      capacity: offering.capacity,
      enrolledCount,
      status: offering.status,
      meetingTimes: offering.meetingTimes,
      ruleChecks,
      unavailableReasons: reasons,
      selected: ownStatus === RegistrationStatus.ACTIVE,
      waitlisted: ownStatus === RegistrationStatus.WAITLISTED,
      waitlistPosition: ownRegistration?.waitlistPosition ?? null,
    };
  });

  const activeRegistrations = visibleRegistrations.filter(
    (registration) => registration.status === RegistrationStatus.ACTIVE,
  );

  return {
    student,
    term,
    courses,
    registrations: visibleRegistrations,
    totalCredits: activeRegistrations.reduce(
      (sum, registration) => sum + registration.offering.course.credits,
      0,
    ),
  };
}

export async function selectCourse(profileId: string, offeringId: string) {
  const { offering } = await validateEnrollmentIntent({
    profileId,
    offeringId,
  });
  const result = await reserveActiveSeat({
    profileId,
    offeringId,
    capacity: offering.capacity,
    enrolledCount: offering.enrolledCount,
  });

  if (result.code === "COURSE_FULL") {
    await safeInvalidateEnrollmentCaches(profileId);
    throw new EnrollmentError("COURSE_FULL", "课程容量已满");
  }

  if (result.code === "DUPLICATE") {
    throw new Error(result.status?.includes("WAITLIST") ? "已加入候补" : "已选择该课程");
  }

  await safeInvalidateEnrollmentCaches(profileId);
  return {
    id: reservationKey(profileId, offeringId),
    studentId: profileId,
    offeringId,
    status: RegistrationStatus.ACTIVE,
    waitlistPosition: null,
  };
}

export async function joinWaitlist(profileId: string, offeringId: string) {
  const { offering } = await validateEnrollmentIntent({
    profileId,
    offeringId,
  });
  const waitlistMax = await getWaitlistMax(offeringId);
  const result = await reserveWaitlistSeat({
    profileId,
    offeringId,
    capacity: offering.capacity,
    enrolledCount: offering.enrolledCount,
    waitlistMax,
  });

  if (result.code === "SEAT_AVAILABLE") {
    await safeInvalidateEnrollmentCaches(profileId);
    throw new EnrollmentError("SEAT_AVAILABLE", "课程仍有余量");
  }

  if (result.code === "DUPLICATE") {
    throw new Error(result.status?.includes("WAITLIST") ? "已加入候补" : "已选择该课程");
  }

  await safeInvalidateEnrollmentCaches(profileId);
  return {
    id: reservationKey(profileId, offeringId),
    studentId: profileId,
    offeringId,
    status: RegistrationStatus.WAITLISTED,
    waitlistPosition: result.waitlistPosition ?? null,
  };
}

async function validateEnrollmentIntent({
  profileId,
  offeringId,
}: {
  profileId: string;
  offeringId: string;
}) {
  const [student, term, offering, existing, redisReservations] = await Promise.all([
    prisma.studentProfile.findUnique({
      where: { id: profileId },
      include: { department: true, major: true },
    }),
    prisma.term.findFirst({ where: { isCurrent: true } }),
    prisma.courseOffering.findUnique({
      where: { id: offeringId },
      include: {
        course: true,
        meetingTimes: true,
        eligibilityRules: true,
      },
    }),
    prisma.courseRegistration.findUnique({
      where: {
        studentId_offeringId: {
          studentId: profileId,
          offeringId,
        },
      },
    }),
    getStudentReservations(profileId),
  ]);

  if (!student || !term || !offering) {
    throw new Error("选课数据不存在");
  }

  const occupiedRegistrations = await prisma.courseRegistration.findMany({
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
  const redisOfferingIds = redisReservations
    .filter((reservation) => reservation.offeringId !== offeringId)
    .map((reservation) => reservation.offeringId);
  const reservedOfferings =
    redisOfferingIds.length > 0
      ? await prisma.courseOffering.findMany({
          where: {
            id: {
              in: redisOfferingIds,
            },
            status: {
              not: OfferingStatus.CANCELED,
            },
          },
          include: {
            course: true,
            meetingTimes: true,
          },
        })
      : [];
  const occupiedCourses = [
    ...occupiedRegistrations
      .filter((registration) => registration.offeringId !== offeringId)
      .map((registration) => ({
        offeringId: registration.offeringId,
        courseName: registration.offering.course.name,
        meetingTimes: registration.offering.meetingTimes,
      })),
    ...reservedOfferings.map((reservedOffering) => ({
      offeringId: reservedOffering.id,
      courseName: reservedOffering.course.name,
      meetingTimes: reservedOffering.meetingTimes,
    })),
  ];
  const ownReservation = redisReservations.find(
    (reservation) => reservation.offeringId === offeringId,
  );
  const ownStatus =
    existing && isScheduleOccupyingStatus(existing.status)
      ? existing.status
      : ownReservation
      ? reservationStatusToRegistrationStatus(ownReservation)
      : undefined;
  const ruleChecks = buildCourseRuleChecks({
    offering,
    student,
    term,
    activeCourses: occupiedCourses,
    ownRegistrationStatus: ownStatus,
  });
  const reasons = getUnavailableReasons(ruleChecks, ownStatus);

  if (reasons.length > 0) {
    throw new Error(reasons[0]);
  }

  return {
    student,
    term,
    offering,
    existing,
  };
}

export async function dropCourse(profileId: string, registrationId: string) {
  const reservedOfferingId = reservationIdToOfferingId(profileId, registrationId);

  if (reservedOfferingId) {
    await releaseReservation(profileId, reservedOfferingId);
    await safeInvalidateAllEnrollmentCaches();
    return;
  }

  await runEnrollmentTransaction(async (tx) => {
    await acquireStudentSubmissionLock(tx, profileId, "退课");

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

      await releaseReservation(profileId, registration.offeringId);
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
    const releaseResult = await releaseReservation(profileId, registration.offeringId);

    if (releaseResult === "MISSING") {
      await decrementActiveGate(registration.offeringId);
    }

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

async function getWaitlistMax(offeringId: string) {
  const aggregate = await prisma.courseRegistration.aggregate({
    where: {
      offeringId,
      status: RegistrationStatus.WAITLISTED,
    },
    _max: {
      waitlistPosition: true,
    },
  });

  return aggregate._max.waitlistPosition ?? 0;
}

function reservationStatusToRegistrationStatus(reservation: StudentReservation) {
  return reservation.kind === "WAITLIST"
    ? RegistrationStatus.WAITLISTED
    : RegistrationStatus.ACTIVE;
}

function reservationIdToOfferingId(profileId: string, registrationId: string) {
  if (!registrationId.startsWith(RESERVATION_REGISTRATION_PREFIX)) {
    return null;
  }

  const parts = registrationId.split(":");
  const reservationProfileId = parts[2];
  const offeringId = parts[3];

  return reservationProfileId === profileId && offeringId ? offeringId : null;
}

function isScheduleOccupyingStatus(status: RegistrationStatus) {
  return status === RegistrationStatus.ACTIVE || status === RegistrationStatus.WAITLISTED;
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

async function acquireStudentSubmissionLock(
  tx: Prisma.TransactionClient,
  profileId: string,
  action: "选课" | "退课",
) {
  const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtext(${profileId})) AS locked
  `;

  if (!lock?.locked) {
    throw new Error(`同一学生正在提交${action}请求，请稍后再试`);
  }
}

async function acquireOfferingLock(tx: Prisma.TransactionClient, offeringId: string) {
  await tx.$queryRaw<{ locked: string | null }[]>`
    SELECT pg_advisory_xact_lock(hashtext(${`offering:${offeringId}`}))::text AS locked
  `;
}

async function runEnrollmentTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 5,
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 30_000,
        timeout: 30_000,
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
