import {
  OfferingStatus,
  OperationType,
  RegistrationStatus,
  Role,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  cacheKeys,
  getJsonCache,
  safeInvalidateAllEnrollmentCaches,
  setJsonCache,
} from "@/lib/services/cache";
import { clearOfferingReservationState } from "@/lib/services/enrollment-reservations";

export async function getAdminDashboard() {
  const cached = await getJsonCache<Awaited<ReturnType<typeof loadAdminDashboard>>>(
    cacheKeys.adminStats,
  );

  if (cached) {
    return cached;
  }

  const dashboard = await loadAdminDashboard();
  await setJsonCache(cacheKeys.adminStats, dashboard, 20);
  return dashboard;
}

async function loadAdminDashboard() {
  const term = await prisma.term.findFirst({
    where: { isCurrent: true },
    include: {
      offerings: {
        include: {
          course: true,
          meetingTimes: true,
          registrations: {
            include: {
              student: {
                include: {
                  department: true,
                  major: true,
                },
              },
            },
            orderBy: [
              { status: "asc" },
              { waitlistPosition: "asc" },
              { registeredAt: "asc" },
            ],
          },
        },
        orderBy: [{ course: { courseNo: "asc" } }, { classNo: "asc" }],
      },
    },
  });

  if (!term) {
    throw new Error("当前学期不存在");
  }

  const logs = await prisma.operationLog.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: 30,
  });

  return {
    term,
    stats: term.offerings.map((offering) => {
      const active = offering.registrations.filter(
        (registration) => registration.status === RegistrationStatus.ACTIVE,
      ).length;
      const dropped = offering.registrations.filter(
        (registration) => registration.status === RegistrationStatus.DROPPED,
      ).length;
      const waitlisted = offering.registrations.filter(
        (registration) => registration.status === RegistrationStatus.WAITLISTED,
      ).length;
      const removed = offering.registrations.filter(
        (registration) => registration.status === RegistrationStatus.REMOVED,
      ).length;

      return {
        id: offering.id,
        courseNo: offering.course.courseNo,
        name: offering.course.name,
        classNo: offering.classNo,
        category: offering.course.category,
        status: offering.status,
        capacity: offering.capacity,
        active,
        waitlisted,
        dropped,
        removed,
        rate: offering.capacity === 0 ? 0 : Math.round((active / offering.capacity) * 100),
      };
    }),
    offeringDetails: term.offerings.map((offering) => {
      const active = offering.registrations.filter(
        (registration) => registration.status === RegistrationStatus.ACTIVE,
      ).length;
      const dropped = offering.registrations.filter(
        (registration) => registration.status === RegistrationStatus.DROPPED,
      ).length;
      const waitlisted = offering.registrations.filter(
        (registration) => registration.status === RegistrationStatus.WAITLISTED,
      ).length;
      const removed = offering.registrations.filter(
        (registration) => registration.status === RegistrationStatus.REMOVED,
      ).length;

      return {
        id: offering.id,
        courseNo: offering.course.courseNo,
        name: offering.course.name,
        classNo: offering.classNo,
        category: offering.course.category,
        status: offering.status,
        capacity: offering.capacity,
        enrolledCount: offering.enrolledCount,
        teacherName: offering.teacherName,
        meetingTimes: offering.meetingTimes,
        active,
        waitlisted,
        dropped,
        removed,
        rate: offering.capacity === 0 ? 0 : Math.round((active / offering.capacity) * 100),
        registrations: offering.registrations,
        logs: logs.filter((log) => log.targetId === offering.id),
      };
    }),
    logs,
  };
}

export async function updateTermWindow({
  adminId,
  selectionStartsAt,
  selectionEndsAt,
}: {
  adminId: string;
  selectionStartsAt: Date;
  selectionEndsAt: Date;
}) {
  if (selectionStartsAt >= selectionEndsAt) {
    throw new Error("开始时间必须早于结束时间");
  }

  await prisma.$transaction(async (tx) => {
    const term = await tx.term.findFirst({
      where: { isCurrent: true },
    });

    if (!term) {
      throw new Error("当前学期不存在");
    }

    await tx.term.update({
      where: { id: term.id },
      data: {
        selectionStartsAt,
        selectionEndsAt,
      },
    });

    await tx.operationLog.create({
      data: {
        type: OperationType.TERM_WINDOW_UPDATED,
        actorRole: Role.ADMIN,
        actorId: adminId,
        targetId: term.id,
        message: "管理员更新选课开放期",
        metadata: {
          selectionStartsAt,
          selectionEndsAt,
        },
      },
    });
  });

  await safeInvalidateAllEnrollmentCaches();
}

export async function closeOffering(adminId: string, offeringId: string) {
  await prisma.$transaction(async (tx) => {
    const offering = await tx.courseOffering.update({
      where: { id: offeringId },
      data: { status: OfferingStatus.CLOSED },
      include: { course: true },
    });

    await tx.operationLog.create({
      data: {
        type: OperationType.OFFERING_CLOSED,
        actorRole: Role.ADMIN,
        actorId: adminId,
        targetId: offeringId,
        message: `管理员冻结${offering.course.name}名单`,
      },
    });
  });

  await clearOfferingReservationState(offeringId);
  await safeInvalidateAllEnrollmentCaches();
}

export async function cancelOffering(adminId: string, offeringId: string, reason?: string) {
  await prisma.$transaction(async (tx) => {
    const offering = await tx.courseOffering.findUnique({
      where: { id: offeringId },
      include: {
        course: true,
        registrations: {
          where: {
            status: {
              in: [RegistrationStatus.ACTIVE, RegistrationStatus.WAITLISTED],
            },
          },
        },
      },
    });

    if (!offering) {
      throw new Error("开课班不存在");
    }

    await tx.courseOffering.update({
      where: { id: offeringId },
      data: {
        status: OfferingStatus.CANCELED,
        enrolledCount: 0,
        canceledReason: reason,
      },
    });

    await tx.courseRegistration.updateMany({
      where: {
        offeringId,
        status: {
          in: [RegistrationStatus.ACTIVE, RegistrationStatus.WAITLISTED],
        },
      },
      data: {
        status: RegistrationStatus.REMOVED,
      },
    });

    await tx.operationLog.create({
      data: {
        type: OperationType.OFFERING_CANCELED,
        actorRole: Role.ADMIN,
        actorId: adminId,
        targetId: offeringId,
        message: `管理员停开${offering.course.name}`,
        metadata: {
          reason,
          removedCount: offering.registrations.length,
        },
      },
    });
  });

  await clearOfferingReservationState(offeringId);
  await safeInvalidateAllEnrollmentCaches();
}

export async function getEnrollmentResultSnapshot() {
  return prisma.courseRegistration.findMany({
    where: {
      offering: {
        term: {
          isCurrent: true,
        },
      },
    },
    include: {
      student: {
        include: {
          department: true,
          major: true,
        },
      },
      offering: {
        include: {
          course: true,
          term: true,
        },
      },
    },
    orderBy: [
      { offering: { course: { courseNo: "asc" } } },
      { student: { studentNo: "asc" } },
    ],
  });
}
