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
  // 给API层保留稳定错误码，避免只靠中文消息判断业务分支。
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "EnrollmentError";
  }
}

// 获取学生端Dashboard，优先使用短期Redis缓存。
export async function getStudentDashboard(profileId: string) {
  const cached = await getJsonCache<Awaited<ReturnType<typeof loadStudentDashboard>>>(
    cacheKeys.courseList(profileId),
  );

  if (cached) {
    // 页面刷新频繁时直接复用缓存，降低数据库查询压力。
    return cached;
  }

  const dashboard = await loadStudentDashboard(profileId);
  // Dashboard包含课程列表、规则诊断和课表，缓存时间保持较短。
  await setJsonCache(cacheKeys.courseList(profileId), dashboard, 20);
  return dashboard;
}

// 从数据库和Redis组合学生端所需的完整视图。
async function loadStudentDashboard(profileId: string) {
  // 学生档案和当前学期课程是Dashboard的基础上下文。
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

  // 只加载正式和候补登记，因为它们会占用课表。
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
  // Redis reservation用于展示尚未写回数据库的预占状态。
  const redisReservations = await getStudentReservations(profileId);
  const redisReservationsByOffering = new Map(
    redisReservations.map((reservation) => [reservation.offeringId, reservation]),
  );
  const gateSnapshots = await Promise.all(
    term.offerings.map((offering) => getRedisGateSnapshot(offering.id)),
  );
  // 页面容量优先使用Redis gate，保证压测预占后能立即反映名额变化。
  const gateActiveByOffering = new Map(
    term.offerings.map((offering, index) => {
      const active = gateSnapshots[index]?.active;
      return [
        offering.id,
        active !== undefined && active !== "" ? Number(active) : offering.enrolledCount,
      ] as const;
    }),
  );
  // 把Redis预占合成临时登记，让课表和按钮能立即显示新状态。
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
        // 预占引用的开课班不存在时，不进入学生端视图。
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

  // 已选和候补都视为时间占用，用于后续冲突判断。
  const occupiedCourses = visibleRegistrations
    .filter((registration) => registration.offering.status !== OfferingStatus.CANCELED)
    .map((registration) => ({
      offeringId: registration.offeringId,
      courseName: registration.offering.course.name,
      meetingTimes: registration.offering.meetingTimes,
    }));

  const courses = term.offerings.map((offering) => {
    // 合并数据库登记和Redis预占，得到本人在该课上的当前状态。
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
    // 规则诊断统一供按钮、详情和测试断言使用。
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

// 学生正式选课，只抢正式名额，满员时返回COURSE_FULL。
export async function selectCourse(profileId: string, offeringId: string) {
  // 先做非容量规则校验，再进入Redis容量闸门。
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
    // 满员后让前端刷新为候补入口。
    await safeInvalidateEnrollmentCaches(profileId);
    throw new EnrollmentError("COURSE_FULL", "课程容量已满");
  }

  if (result.code === "DUPLICATE") {
    // 重复提交不重复占位，直接返回已有状态。
    throw new Error(result.status?.includes("WAITLIST") ? "已加入候补" : "已选择该课程");
  }

  // 预占成功后清理本人课程缓存，页面立即显示已入课表。
  await safeInvalidateEnrollmentCaches(profileId);
  return {
    id: reservationKey(profileId, offeringId),
    studentId: profileId,
    offeringId,
    status: RegistrationStatus.ACTIVE,
    waitlistPosition: null,
  };
}

// 学生显式加入候补，只在课程已满时允许。
export async function joinWaitlist(profileId: string, offeringId: string) {
  // 候补也要复用同一组选课规则，避免绕过时间冲突等限制。
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
    // 仍有正式名额时，不允许直接进入候补。
    await safeInvalidateEnrollmentCaches(profileId);
    throw new EnrollmentError("SEAT_AVAILABLE", "课程仍有余量");
  }

  if (result.code === "DUPLICATE") {
    // 已选或已候补时不重复生成候补顺位。
    throw new Error(result.status?.includes("WAITLIST") ? "已加入候补" : "已选择该课程");
  }

  // 候补预占成功后让学生端立即显示候补中。
  await safeInvalidateEnrollmentCaches(profileId);
  return {
    id: reservationKey(profileId, offeringId),
    studentId: profileId,
    offeringId,
    status: RegistrationStatus.WAITLISTED,
    waitlistPosition: result.waitlistPosition ?? null,
  };
}

// 校验学生是否可以对某开课班发起正式选课或候补。
async function validateEnrollmentIntent({
  profileId,
  offeringId,
}: {
  profileId: string;
  offeringId: string;
}) {
  // 并行读取身份、学期、开课班、本人登记和Redis预占状态。
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

  // 已选和候补登记都参与时间冲突判断。
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
  // Redis预占也代表学生意向，需要纳入冲突判断。
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
  // 统一整理成规则诊断所需的占用课程结构。
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
  // 本人已有状态会阻止重复选课或重复候补。
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
    // 服务层只抛出第一个阻断原因，详情页仍可展示完整检查表。
    throw new Error(reasons[0]);
  }

  return {
    student,
    term,
    offering,
    existing,
  };
}

// 学生退课或退出Redis临时预占。
export async function dropCourse(profileId: string, registrationId: string) {
  // 尚未写回数据库的预占用Redis key作为临时登记ID。
  const reservedOfferingId = reservationIdToOfferingId(profileId, registrationId);

  if (reservedOfferingId) {
    // 临时预占退课只需要释放Redis状态。
    await releaseReservation(profileId, reservedOfferingId);
    await safeInvalidateAllEnrollmentCaches();
    return;
  }

  // 已落库登记必须在事务中更新，并可能触发候补递补。
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

    // 同一开课班的退课和递补需要串行化。
    await acquireOfferingLock(tx, registration.offeringId);

    if (registration.offering.course.category === CourseCategory.REQUIRED) {
      throw new Error("必修课不可退课");
    }

    assertTermOpen(registration.offering.term);

    if (registration.offering.status !== OfferingStatus.PUBLISHED) {
      throw new Error("课程已冻结，不能退课");
    }

    if (registration.status === RegistrationStatus.WAITLISTED) {
      // 退出候补不释放正式名额，也不触发递补。
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

    // 正式退课会释放数据库名额。
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
      // 历史登记没有Redis reservation时，也要修正Redis gate计数。
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

    // 正式名额释放后，尝试把队首候补转为正式入选。
    await promoteFirstWaitlistedRegistration({
      tx,
      offeringId: registration.offeringId,
      courseName: registration.offering.course.name,
    });
  });

  await safeInvalidateAllEnrollmentCaches();
}

// 读取数据库中当前最大候补顺位。
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

// 把Redis预占类型映射为页面可理解的登记状态。
function reservationStatusToRegistrationStatus(reservation: StudentReservation) {
  return reservation.kind === "WAITLIST"
    ? RegistrationStatus.WAITLISTED
    : RegistrationStatus.ACTIVE;
}

// 从临时登记ID中解析开课班ID。
function reservationIdToOfferingId(profileId: string, registrationId: string) {
  if (!registrationId.startsWith(RESERVATION_REGISTRATION_PREFIX)) {
    return null;
  }

  // 临时ID格式来自reservationKey：enrollment:reservation:profileId:offeringId。
  const parts = registrationId.split(":");
  const reservationProfileId = parts[2];
  const offeringId = parts[3];

  return reservationProfileId === profileId && offeringId ? offeringId : null;
}

// 判断登记状态是否占用课表时间。
function isScheduleOccupyingStatus(status: RegistrationStatus) {
  return status === RegistrationStatus.ACTIVE || status === RegistrationStatus.WAITLISTED;
}

// 将同一开课班的队首候补转为正式入选。
async function promoteFirstWaitlistedRegistration({
  tx,
  offeringId,
  courseName,
}: {
  tx: Prisma.TransactionClient;
  offeringId: string;
  courseName: string;
}) {
  // FIFO顺序优先看waitlistPosition，再用候补时间兜底。
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
    // 没有候补时，正式退课只释放名额。
    return;
  }

  // 带状态条件更新，避免并发下重复递补同一条候补。
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

  // 候补转正后恢复开课班已选人数。
  await tx.courseOffering.update({
    where: { id: offeringId },
    data: {
      enrolledCount: {
        increment: 1,
      },
    },
  });

  // 日志保存原候补顺位，方便管理员追踪。
  await tx.operationLog.create({
    data: {
      type: OperationType.WAITLIST_PROMOTED,
      actorRole: Role.STUDENT,
      actorId: candidate.studentId,
      targetId: offeringId,
      message: `${candidate.student.name}从候补转入${courseName}`,
      metadata: {
        previousWaitlistPosition: candidate.waitlistPosition,
      },
    },
  });
}

// 构造课程详情和按钮状态使用的结构化选课检查。
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
  // 开放期、资格、时间冲突和容量分别计算，便于页面逐项展示。
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

  // 每项检查都有稳定code，避免前端依赖中文字符串判断业务状态。
  return [
    {
      code: "TERM_WINDOW",
      label: "选课时间",
      status: termOpen ? "pass" : "block",
      detail: termOpen ? "可以提交" : "不在开放时间",
    },
    {
      code: "OFFERING_STATUS",
      label: "开课状态",
      status: offering.status === OfferingStatus.PUBLISHED ? "pass" : "block",
      detail: offeringStatusDetail(offering.status),
    },
    {
      code: "COURSE_CATEGORY",
      label: "课程类型",
      status:
        offering.course.category === CourseCategory.REQUIRED
          ? "block"
          : ownRegistrationStatus === RegistrationStatus.ACTIVE ||
            ownRegistrationStatus === RegistrationStatus.WAITLISTED
          ? "info"
          : "pass",
      detail:
        offering.course.category === CourseCategory.REQUIRED
          ? "已由教务安排"
          : ownRegistrationStatus === RegistrationStatus.ACTIVE
          ? "已在课表"
          : ownRegistrationStatus === RegistrationStatus.WAITLISTED
          ? "候补中"
          : "可以自主选择",
    },
    {
      code: "ELIGIBILITY",
      label: "适合对象",
      status: eligible ? "pass" : "block",
      detail:
        offering.course.category === CourseCategory.MAJOR_ELECTIVE
          ? eligible
            ? "专业和年级符合"
            : "专业或年级不符合"
          : "不限制专业年级",
    },
    {
      code: "CAPACITY",
      label: "名额",
      status: full ? "info" : "pass",
      detail: full
        ? `${offering.enrolledCount}/${offering.capacity} · 已满，可候补`
        : `${offering.enrolledCount}/${offering.capacity}`,
    },
    {
      code: "TIME_CONFLICT",
      label: "上课时间",
      status: conflictCourse ? "block" : "pass",
      detail: conflictCourse ? `与${conflictCourse.courseName}冲突` : "没有冲突",
    },
  ];
}

// 从规则检查中提取会阻止操作的原因。
function getUnavailableReasons(
  ruleChecks: CourseRuleCheck[],
  ownRegistrationStatus?: RegistrationStatus,
) {
  const reasons: string[] = ruleChecks
    .filter((check) => check.status === "block")
    .map(ruleCheckToReason);

  if (ownRegistrationStatus === RegistrationStatus.ACTIVE && !reasons.includes("已选择该课程")) {
    // 已正式入选时，重复点击需要被明确拦截。
    reasons.push("已选择该课程");
  }

  if (
    ownRegistrationStatus === RegistrationStatus.WAITLISTED &&
    !reasons.includes("已加入候补")
  ) {
    // 已候补时，重复加入候补需要被明确拦截。
    reasons.push("已加入候补");
  }

  return reasons;
}

// 将结构化检查项映射成服务层错误原因。
function ruleCheckToReason(check: CourseRuleCheck) {
  if (check.code === "TERM_WINDOW") return "不在选课开放期";
  if (check.code === "COURSE_CATEGORY") return "必修课由教务系统预置";
  if (check.code === "ELIGIBILITY") return "不符合专业年级范围";
  if (check.code === "CAPACITY") return "课程容量已满";
  if (check.code === "TIME_CONFLICT") return "上课时间冲突";
  if (check.code === "OFFERING_STATUS") {
    return check.detail.includes("停开") ? "课程已停开" : "课程名单已冻结";
  }

  return "不可选";
}

// 把开课班状态转成课程详情中的短文本。
function offeringStatusDetail(status: OfferingStatus) {
  if (status === OfferingStatus.PUBLISHED) return "开放";
  if (status === OfferingStatus.CLOSED) return "名单已冻结";
  return "课程已停开";
}

// 判断当前时间是否位于选课开放期内。
function isTermOpen(term: { selectionStartsAt: Date; selectionEndsAt: Date }) {
  const now = new Date();
  return now >= term.selectionStartsAt && now <= term.selectionEndsAt;
}

// 退课等动作复用的开放期断言。
function assertTermOpen(term: { selectionStartsAt: Date; selectionEndsAt: Date }) {
  if (!isTermOpen(term)) {
    throw new Error("不在选课开放期");
  }
}

// 对同一学生的提交加事务级锁，防止重复提交互相覆盖。
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

// 对同一开课班加事务级锁，保护容量和候补顺序。
async function acquireOfferingLock(tx: Prisma.TransactionClient, offeringId: string) {
  await tx.$queryRaw<{ locked: string | null }[]>`
    SELECT pg_advisory_xact_lock(hashtext(${`offering:${offeringId}`}))::text AS locked
  `;
}

// 运行选课事务，并对可重试的并发冲突做有限重试。
async function runEnrollmentTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 5,
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // ReadCommitted配合显式咨询锁，减少串行化失败带来的等待。
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 30_000,
        timeout: 30_000,
      });
    } catch (error) {
      lastError = error;

      if (!isRetryableTransactionError(error) || attempt === attempts) {
        // 非可重试错误或达到最大次数时直接抛出。
        throw error;
      }

      // 简单递增退避，降低热点课程短时间重试压力。
      await wait(attempt * 25);
    }
  }

  throw lastError;
}

// 判断事务错误是否属于可重试的并发冲突。
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

// 等待指定毫秒数，供事务重试退避使用。
function wait(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
