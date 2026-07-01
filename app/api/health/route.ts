import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";

export const dynamic = "force-dynamic";

// 健康检查接口，用于Nginx多实例和现场部署验证。
export async function GET() {
  // 数据库和Redis并行检查，减少健康检查自身耗时。
  const [database, cache] = await Promise.all([checkDatabase(), checkRedis()]);
  const ok = database.ok && cache.ok;

  return NextResponse.json(
    {
      ok,
      instance: process.env.APP_INSTANCE ?? process.env.HOSTNAME ?? "local",
      checks: {
        database,
        redis: cache,
      },
      time: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
    },
  );
}

// 检查PostgreSQL连接是否可用。
async function checkDatabase() {
  try {
    // 最轻量的SQL探测即可判断连接和查询能力。
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

// 检查Redis连接是否可用。
async function checkRedis() {
  try {
    // PING能验证连接和Redis服务状态。
    await redis.ping();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

// 把未知异常转换成健康检查可返回的短消息。
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}
