import {
  CourseCategory,
  OfferingStatus,
  OperationType,
  Prisma,
  RegistrationStatus,
  Role,
} from "@prisma/client";
import { redis } from "@/lib/db/redis";
import { prisma } from "@/lib/db/prisma";
import {
  markReservationConfirmed,
  releaseReservation,
  reservationConfig,
  type ReservationKind,
} from "@/lib/services/enrollment-reservations";
import { safeInvalidateAllEnrollmentCaches } from "@/lib/services/cache";

type StreamTask = {
  id: string;
  reservationKey: string;
  profileId: string;
  offeringId: string;
  kind: ReservationKind;
  waitlistPosition: number | null;
};

type WritebackAction = {
  confirmStatus?: "CONFIRMED_ACTIVE" | "CONFIRMED_WAITLIST";
  releaseReservation?: boolean;
  invalidateCaches?: boolean;
};

// 确保Redis Stream消费组存在，Worker启动和批处理前都会调用。
export async function ensureEnrollmentWritebackGroup() {
  try {
    await redis.sendCommand([
      "XGROUP",
      "CREATE",
      reservationConfig.streamKey,
      reservationConfig.streamGroup,
      "0",
      "MKSTREAM",
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (!message.includes("BUSYGROUP")) {
      // BUSYGROUP表示消费组已存在，其余错误需要抛出。
      throw error;
    }
  }
}

// 从Redis Stream读取一批预占任务并写回数据库。
export async function processEnrollmentWritebackBatch({
  consumer = `worker-${process.pid}`,
  count = 25,
  blockMs = 1000,
}: {
  consumer?: string;
  count?: number;
  blockMs?: number;
} = {}) {
  await ensureEnrollmentWritebackGroup();

  // XREADGROUP阻塞读取新消息，没消息时最多等待blockMs。
  const reply = await redis.sendCommand([
    "XREADGROUP",
    "GROUP",
    reservationConfig.streamGroup,
    consumer,
    "COUNT",
    String(count),
    "BLOCK",
    String(blockMs),
    "STREAMS",
    reservationConfig.streamKey,
    ">",
  ]);
  const tasks = parseStreamTasks(reply);

  for (const task of tasks) {
    try {
      // 每条任务独立写回，单条失败不阻塞后续任务。
      await writeBackReservation(task);
      await redis.sendCommand([
        "XACK",
        reservationConfig.streamKey,
        reservationConfig.streamGroup,
        task.id,
      ]);
    } catch (error) {
      // 未ACK的消息会留在Stream pending中，后续可由运维功能重投。
      console.error("Enrollment writeback failed", task, error);
    }
  }

  return tasks.length;
}

// 根据预占任务类型写入正式登记或候补登记。
async function writeBackReservation(task: StreamTask) {
  const status = await redis.hGet(task.reservationKey, "status");
  const expectedStatus = task.kind === "ACTIVE" ? "ACTIVE_RESERVED" : "WAITLIST_RESERVED";

  if (status !== expectedStatus) {
    // 预占已被确认、释放或失败时，直接跳过以保证幂等。
    return;
  }

  // 数据库事务内使用开课班锁，保证同一开课班的容量和候补顺序稳定。
  const action = await prisma.$transaction(
    async (tx) => {
      await acquireOfferingLock(tx, task.offeringId);

      const student = await tx.studentProfile.findUnique({
        where: { id: task.profileId },
      });
      const offering = await tx.courseOffering.findUnique({
        where: { id: task.offeringId },
        include: { course: true },
      });
      const existing = await tx.courseRegistration.findUnique({
        where: {
          studentId_offeringId: {
            studentId: task.profileId,
            offeringId: task.offeringId,
          },
        },
      });

      if (!student || !offering || offering.status !== OfferingStatus.PUBLISHED) {
        // 学生、课程不存在或课程不可选时释放Redis预占。
        return {
          releaseReservation: true,
          invalidateCaches: true,
        };
      }

      if (task.kind === "ACTIVE") {
        return writeBackActiveRegistration({ tx, task, student, offering, existing });
      }

      return writeBackWaitlistRegistration({ tx, task, student, offering, existing });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 30_000,
      timeout: 30_000,
    },
  );

  if (action.releaseReservation) {
    // 数据库无法接收该预占时，归还Redis名额或删除候补预占。
    await releaseReservation(task.profileId, task.offeringId);
  }

  if (action.confirmStatus) {
    // 写回成功后保留短期确认状态，供学生端刷新时合并展示。
    await markReservationConfirmed({
      profileId: task.profileId,
      offeringId: task.offeringId,
      status: action.confirmStatus,
    });
  }

  if (action.invalidateCaches) {
    // 写回改变了最终名单，需要清理学生和管理员侧缓存。
    await safeInvalidateAllEnrollmentCaches();
  }
}

// 把正式预占写成ACTIVE登记，并维护开课班已选人数。
async function writeBackActiveRegistration({
  tx,
  task,
  student,
  offering,
  existing,
}: {
  tx: Prisma.TransactionClient;
  task: StreamTask;
  student: { name: string };
  offering: {
    id: string;
    capacity: number;
    course: { name: string; category: CourseCategory };
  };
  existing: { id: string; status: RegistrationStatus } | null;
}): Promise<WritebackAction> {
  if (existing?.status === RegistrationStatus.ACTIVE) {
    // 已经写回过的任务只需要确认Redis状态。
    return {
      confirmStatus: "CONFIRMED_ACTIVE",
    };
  }

  if (existing?.status === RegistrationStatus.WAITLISTED) {
    // 同一学生已经候补时，不允许再写入正式预占。
    return {
      releaseReservation: true,
    };
  }

  // 用updateMany带容量条件，防止数据库最终名单超过容量。
  const updated = await tx.courseOffering.updateMany({
    where: {
      id: offering.id,
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
    // 数据库容量已满时释放Redis预占，并刷新页面状态。
    return {
      releaseReservation: true,
      invalidateCaches: true,
    };
  }

  if (existing) {
    // 复用退课或移除后的登记记录，避免唯一约束冲突。
    await tx.courseRegistration.update({
      where: { id: existing.id },
      data: {
        status: RegistrationStatus.ACTIVE,
        registeredAt: new Date(),
        waitlistedAt: null,
        waitlistPosition: null,
      },
    });
  } else {
    // 首次选课时创建新的正式登记。
    await tx.courseRegistration.create({
      data: {
        studentId: task.profileId,
        offeringId: task.offeringId,
        status: RegistrationStatus.ACTIVE,
      },
    });
  }

  // 写入操作日志，标记该记录来自异步写回。
  await tx.operationLog.create({
    data: {
      type: OperationType.COURSE_SELECTED,
      actorRole: Role.STUDENT,
      actorId: task.profileId,
      targetId: task.offeringId,
      message: `${student.name}选择${offering.course.name}`,
      metadata: {
        writeback: true,
      },
    },
  });

  return {
    confirmStatus: "CONFIRMED_ACTIVE",
    invalidateCaches: true,
  };
}

// 把候补预占写成WAITLISTED登记。
async function writeBackWaitlistRegistration({
  tx,
  task,
  student,
  offering,
  existing,
}: {
  tx: Prisma.TransactionClient;
  task: StreamTask;
  student: { name: string };
  offering: { course: { name: string } };
  existing: { id: string; status: RegistrationStatus } | null;
}): Promise<WritebackAction> {
  if (existing?.status === RegistrationStatus.WAITLISTED) {
    // 候补已存在时只确认Redis状态，避免重复入队。
    return {
      confirmStatus: "CONFIRMED_WAITLIST",
    };
  }

  if (existing?.status === RegistrationStatus.ACTIVE) {
    // 已经正式入选时不再保留候补预占。
    return {
      releaseReservation: true,
    };
  }

  // 优先使用Redis预占时生成的顺位，缺失时按数据库当前最大值补齐。
  const position = task.waitlistPosition ?? (await nextWaitlistPosition(tx, task.offeringId));
  const now = new Date();

  if (existing) {
    // 复用历史登记记录进入候补状态。
    await tx.courseRegistration.update({
      where: { id: existing.id },
      data: {
        status: RegistrationStatus.WAITLISTED,
        waitlistedAt: now,
        waitlistPosition: position,
      },
    });
  } else {
    // 首次候补时创建候补登记。
    await tx.courseRegistration.create({
      data: {
        studentId: task.profileId,
        offeringId: task.offeringId,
        status: RegistrationStatus.WAITLISTED,
        waitlistedAt: now,
        waitlistPosition: position,
      },
    });
  }

  // 操作日志保存候补顺位，方便管理员追踪。
  await tx.operationLog.create({
    data: {
      type: OperationType.COURSE_WAITLISTED,
      actorRole: Role.STUDENT,
      actorId: task.profileId,
      targetId: task.offeringId,
      message: `${student.name}候补${offering.course.name}`,
      metadata: {
        waitlistPosition: position,
        writeback: true,
      },
    },
  });

  return {
    confirmStatus: "CONFIRMED_WAITLIST",
    invalidateCaches: true,
  };
}

// 对开课班加PostgreSQL事务级咨询锁。
async function acquireOfferingLock(tx: Prisma.TransactionClient, offeringId: string) {
  await tx.$queryRaw<{ locked: string | null }[]>`
    SELECT pg_advisory_xact_lock(hashtext(${`offering:${offeringId}`}))::text AS locked
  `;
}

// 计算数据库中的下一个候补顺位。
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

// 把Redis XREADGROUP返回值解析成写回任务列表。
function parseStreamTasks(reply: unknown) {
  const tasks: StreamTask[] = [];

  const streams = Array.isArray(reply)
    ? reply
    : reply && typeof reply === "object"
    ? Object.entries(reply)
    : [];

  if (streams.length === 0) {
    return tasks;
  }

  for (const stream of streams) {
    if (!Array.isArray(stream) || !Array.isArray(stream[1])) {
      continue;
    }

    for (const entry of stream[1]) {
      if (!Array.isArray(entry) || !Array.isArray(entry[1])) {
        continue;
      }

      const id = String(entry[0]);
      const fields = entry[1] as unknown[];
      const data: Record<string, string> = {};

      // Redis Stream字段按key/value交替排列，需要还原成对象。
      for (let index = 0; index < fields.length; index += 2) {
        data[String(fields[index])] = String(fields[index + 1] ?? "");
      }

      if (!data.profileId || !data.offeringId || !data.kind) {
        // 字段不完整的消息不进入写回流程。
        continue;
      }

      tasks.push({
        id,
        reservationKey: data.reservationKey,
        profileId: data.profileId,
        offeringId: data.offeringId,
        kind: data.kind === "WAITLIST" ? "WAITLIST" : "ACTIVE",
        waitlistPosition: data.waitlistPosition ? Number(data.waitlistPosition) : null,
      });
    }
  }

  return tasks;
}
