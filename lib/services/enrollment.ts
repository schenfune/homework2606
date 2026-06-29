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

  const activeSlots = registrations.flatMap((registration) =>
    registration.offering.status === OfferingStatus.CANCELED
      ? []
      : registration.offering.meetingTimes,
  );

  const courses = term.offerings.map((offering) => {
    const ownRegistration = offering.registrations[0];
    const reasons = getUnavailableReasons({
      offering,
      student,
      term,
      activeSlots: activeSlots.filter((slot) => slot.offeringId !== offering.id),
      ownRegistrationStatus: ownRegistration?.status,
    });

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
  const registration = await prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${profileId})) AS locked
      `;

      if (!lock?.locked) {
        throw new Error("同一学生正在提交选课请求，请稍后再试");
      }

      const [student, term, offering] = await Promise.all([
        tx.studentProfile.findUnique({
          where: { id: profileId },
          include: { department: true, major: true },
        }),
        tx.term.findFirst({ where: { isCurrent: true } }),
        tx.courseOffering.findUnique({
          where: { id: offeringId },
          include: {
            course: true,
            meetingTimes: true,
            eligibilityRules: true,
          },
        }),
      ]);

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

      const reasons = getUnavailableReasons({
        offering,
        student,
        term,
        activeSlots: activeRegistrations.flatMap((registration) => registration.offering.meetingTimes),
        ownRegistrationStatus: existing?.status,
      });

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
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  await safeInvalidateEnrollmentCaches(profileId);
  return registration;
}

export async function dropCourse(profileId: string, registrationId: string) {
  await prisma.$transaction(async (tx) => {
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

function getUnavailableReasons({
  offering,
  student,
  term,
  activeSlots,
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
  activeSlots: {
    offeringId?: string;
    weekday: number;
    startPeriod: number;
    endPeriod: number;
    startWeek: number;
    endWeek: number;
  }[];
  ownRegistrationStatus?: RegistrationStatus;
}) {
  const reasons: string[] = [];

  if (offering.course.category === CourseCategory.REQUIRED) {
    reasons.push("必修课由教务系统预置");
  }

  if (ownRegistrationStatus === RegistrationStatus.ACTIVE) {
    reasons.push("已选择该课程");
  }

  if (!isTermOpen(term)) {
    reasons.push("不在选课开放期");
  }

  if (offering.status === OfferingStatus.CLOSED) {
    reasons.push("课程名单已冻结");
  }

  if (offering.status === OfferingStatus.CANCELED) {
    reasons.push("课程已取消");
  }

  if (offering.enrolledCount >= offering.capacity) {
    reasons.push("课程容量已满");
  }

  if (
    offering.course.category === CourseCategory.MAJOR_ELECTIVE &&
    !offering.eligibilityRules.some(
      (rule) =>
        rule.majorId === student.majorId &&
        rule.grade === student.grade &&
        rule.departmentId === student.departmentId,
    )
  ) {
    reasons.push("不符合专业年级范围");
  }

  if (hasMeetingConflict(activeSlots, offering.meetingTimes)) {
    reasons.push("上课时间冲突");
  }

  return reasons;
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
