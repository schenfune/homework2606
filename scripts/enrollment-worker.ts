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

// 持续消费Redis Stream中的选课预占任务并写回数据库。
async function main() {
  // 启动时确保消费组存在，避免第一次运行Worker时报NOGROUP。
  await ensureEnrollmentWritebackGroup();
  console.log(`选课写回Worker已启动: ${consumer}`);

  do {
    // 每轮最多处理batchSize条；没有任务时最多阻塞blockMs。
    const processed = await processEnrollmentWritebackBatch({
      consumer,
      count: batchSize,
      blockMs,
    });

    if (processed > 0) {
      // 只在真正处理到任务时输出日志，避免空轮询刷屏。
      console.log(`已写回${processed}条选课预占任务`);
    }
  } while (!once);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      // Worker异常退出时保留非0退出码，方便Docker日志和CI定位。
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (once) {
        // 单次模式通常用于测试或手动处理写回，结束后主动释放连接。
        await prisma.$disconnect();

        if (redis.isOpen) {
          await redis.quit();
        }
      }
    });
}
