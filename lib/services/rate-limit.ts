import { redis } from "@/lib/db/redis";

const studentEnrollmentRateLimit = {
  limit: 20,
  windowSeconds: 60,
} as const;

export type StudentEnrollmentRateLimitAction = "select" | "waitlist" | "drop";

export class RateLimitError extends Error {
  constructor(message = "操作过于频繁，请稍后再试") {
    super(message);
    this.name = "RateLimitError";
  }
}

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
    throw new RateLimitError();
  }
}

// 学生选课相关入口共用的限流策略，页面按钮和HTTP API使用同一组Redis键。
export async function assertStudentEnrollmentRateLimit(
  profileId: string,
  action: StudentEnrollmentRateLimitAction,
) {
  await assertRateLimit({
    key: studentEnrollmentRateLimitKey(profileId, action),
    limit: studentEnrollmentRateLimit.limit,
    windowSeconds: studentEnrollmentRateLimit.windowSeconds,
  });
}

// 生成学生选课动作限流键，确保API和Server Action计数一致。
export function studentEnrollmentRateLimitKey(
  profileId: string,
  action: StudentEnrollmentRateLimitAction,
) {
  return `rate-limit:${action}:${profileId}`;
}
