import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";

export const dynamic = "force-dynamic";

export async function GET() {
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

async function checkDatabase() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

async function checkRedis() {
  try {
    await redis.ping();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}
