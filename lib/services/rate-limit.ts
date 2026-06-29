import { redis } from "@/lib/db/redis";

export async function assertRateLimit({
  key,
  limit,
  windowSeconds,
}: {
  key: string;
  limit: number;
  windowSeconds: number;
}) {
  const value = await redis.incr(key);

  if (value === 1) {
    await redis.expire(key, windowSeconds);
  }

  if (value > limit) {
    throw new Error("操作过于频繁，请稍后再试");
  }
}
