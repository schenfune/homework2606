import { redis } from "@/lib/db/redis";

// 校验某个Redis限流键在窗口期内是否超过允许次数。
export async function assertRateLimit({
  key,
  limit,
  windowSeconds,
}: {
  key: string;
  limit: number;
  windowSeconds: number;
}) {
  // 每次操作递增同一个Redis计数键。
  const value = await redis.incr(key);

  if (value === 1) {
    // 第一次访问时设置过期时间，形成固定窗口限流。
    await redis.expire(key, windowSeconds);
  }

  if (value > limit) {
    // 超过窗口内次数后抛出业务错误，由API层转成响应。
    throw new Error("操作过于频繁，请稍后再试");
  }
}
