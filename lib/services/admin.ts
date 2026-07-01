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

// 获取管理员Dashboard，优先读取短期缓存。
export async function getAdminDashboard() {
  const cached = await getJsonCache<Awaited<ReturnType<typeof loadAdminDashboard>>>(
    cacheKeys.adminStats,
  );

  if (cached) {
    // 管理员统计页可能频繁刷新，缓存可减少聚合查询压力。
    return cached;
  }

  const dashboard = await loadAdminDashboard();
  // 管理端数据变化后会显式清理缓存，因此TTL保持较短。
  await setJsonCache(cacheKeys.adminStats, dashboard, 20);
  return dashboard;
}

// 从数据库加载当前学期统计、详情和最近日志。
async function loadAdminDashboard() {
  // 一次性加载开课班、课程、上课时间和登记名单，供统计和详情复用。
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
      // 课程统计表只需要按登记状态聚合数量。
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
      // 详情Sheet保留完整登记名单和该开课班相关日志。
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

// 更新当前学期选课开放期。
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
    // 开始时间必须早于结束时间，否则学生端规则无法判断。
    throw new Error("开始时间必须早于结束时间");
  }

  await prisma.$transaction(async (tx) => {
    // 开放期和操作日志写在同一事务，保证配置变化可追踪。
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
        message: "管理员调整选课时间",
        metadata: {
          selectionStartsAt,
          selectionEndsAt,
        },
      },
    });
  });

  await safeInvalidateAllEnrollmentCaches();
}

// 冻结开课班名单，课程保留但学生不能继续变更名单。
export async function closeOffering(adminId: string, offeringId: string) {
  await prisma.$transaction(async (tx) => {
    // 只改变开课班状态，不移除已有登记。
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

  // 冻结后清理该课Redis预占，防止学生端继续显示未确认状态。
  await clearOfferingReservationState(offeringId);
  await safeInvalidateAllEnrollmentCaches();
}

// 停开开课班，并将正式和候补登记统一转为移除。
export async function cancelOffering(adminId: string, offeringId: string, reason?: string) {
  await prisma.$transaction(async (tx) => {
    // 先读取受影响的正式和候补登记，用于日志记录移除数量。
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

    // 停开后容量计数归零，并保存停开原因。
    await tx.courseOffering.update({
      where: { id: offeringId },
      data: {
        status: OfferingStatus.CANCELED,
        enrolledCount: 0,
        canceledReason: reason,
      },
    });

    // ACTIVE和WAITLISTED都失去课程资格，统一转为REMOVED。
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

  // 停开后删除该课全部Redis预占和容量闸门。
  await clearOfferingReservationState(offeringId);
  await safeInvalidateAllEnrollmentCaches();
}

// 读取当前学期全部选课登记，供CSV导出和外部接口使用。
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
