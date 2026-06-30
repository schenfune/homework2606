import { pathToFileURL } from "node:url";
import { redis } from "../lib/db/redis";
import { prisma } from "../lib/db/prisma";
import {
  ensureEnrollmentWritebackGroup,
  processEnrollmentWritebackBatch,
} from "../lib/services/enrollment-writeback";

const consumer = process.env.ENROLLMENT_WORKER_NAME || `worker-${process.pid}`;
const batchSize = Number(process.env.ENROLLMENT_WORKER_BATCH || 25);
const blockMs = Number(process.env.ENROLLMENT_WORKER_BLOCK_MS || 1000);
const once = process.env.ENROLLMENT_WORKER_ONCE === "1";

async function main() {
  await ensureEnrollmentWritebackGroup();
  console.log(`选课写回Worker已启动: ${consumer}`);

  do {
    const processed = await processEnrollmentWritebackBatch({
      consumer,
      count: batchSize,
      blockMs,
    });

    if (processed > 0) {
      console.log(`已写回${processed}条选课预占任务`);
    }
  } while (!once);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (once) {
        await prisma.$disconnect();

        if (redis.isOpen) {
          await redis.quit();
        }
      }
    });
}
