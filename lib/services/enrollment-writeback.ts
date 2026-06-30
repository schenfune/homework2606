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
      throw error;
    }
  }
}

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
      await writeBackReservation(task);
      await redis.sendCommand([
        "XACK",
        reservationConfig.streamKey,
        reservationConfig.streamGroup,
        task.id,
      ]);
    } catch (error) {
      console.error("Enrollment writeback failed", task, error);
    }
  }

  return tasks.length;
}

async function writeBackReservation(task: StreamTask) {
  const status = await redis.hGet(task.reservationKey, "status");
  const expectedStatus = task.kind === "ACTIVE" ? "ACTIVE_RESERVED" : "WAITLIST_RESERVED";

  if (status !== expectedStatus) {
    return;
  }

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
    await releaseReservation(task.profileId, task.offeringId);
  }

  if (action.confirmStatus) {
    await markReservationConfirmed({
      profileId: task.profileId,
      offeringId: task.offeringId,
      status: action.confirmStatus,
    });
  }

  if (action.invalidateCaches) {
    await safeInvalidateAllEnrollmentCaches();
  }
}

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
    return {
      confirmStatus: "CONFIRMED_ACTIVE",
    };
  }

  if (existing?.status === RegistrationStatus.WAITLISTED) {
    return {
      releaseReservation: true,
    };
  }

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
    return {
      releaseReservation: true,
      invalidateCaches: true,
    };
  }

  if (existing) {
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
    await tx.courseRegistration.create({
      data: {
        studentId: task.profileId,
        offeringId: task.offeringId,
        status: RegistrationStatus.ACTIVE,
      },
    });
  }

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
    return {
      confirmStatus: "CONFIRMED_WAITLIST",
    };
  }

  if (existing?.status === RegistrationStatus.ACTIVE) {
    return {
      releaseReservation: true,
    };
  }

  const position = task.waitlistPosition ?? (await nextWaitlistPosition(tx, task.offeringId));
  const now = new Date();

  if (existing) {
    await tx.courseRegistration.update({
      where: { id: existing.id },
      data: {
        status: RegistrationStatus.WAITLISTED,
        waitlistedAt: now,
        waitlistPosition: position,
      },
    });
  } else {
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

async function acquireOfferingLock(tx: Prisma.TransactionClient, offeringId: string) {
  await tx.$queryRaw<{ locked: string | null }[]>`
    SELECT pg_advisory_xact_lock(hashtext(${`offering:${offeringId}`}))::text AS locked
  `;
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

      for (let index = 0; index < fields.length; index += 2) {
        data[String(fields[index])] = String(fields[index + 1] ?? "");
      }

      if (!data.profileId || !data.offeringId || !data.kind) {
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
