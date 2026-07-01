import { redis } from "@/lib/db/redis";

export const cacheKeys = {
  courseList: (studentId: string) => `course-list:${studentId}`,
  adminStats: "admin:course-stats",
};

// 从Redis读取JSON缓存，缓存不存在时返回null。
export async function getJsonCache<T>(key: string) {
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

// 把任意可序列化对象写入Redis，并设置短TTL。
export async function setJsonCache(key: string, value: unknown, seconds = 30) {
  await redis.set(key, JSON.stringify(value), {
    EX: seconds,
  });
}

// 清理单个学生课程列表和管理员统计缓存。
export async function invalidateEnrollmentCaches(studentId?: string) {
  const keys = [cacheKeys.adminStats];

  if (studentId) {
    // 学生相关操作只需要额外清理本人课程列表。
    keys.push(cacheKeys.courseList(studentId));
  }

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

// 清理所有学生课程列表缓存和管理员统计缓存。
export async function invalidateAllEnrollmentCaches() {
  // 课程列表缓存按学生拆分，因此先按前缀扫描。
  const courseListKeys = await redis.keys("course-list:*");
  const keys = [cacheKeys.adminStats, ...courseListKeys];

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

// 安全清理局部缓存，失败时不影响主业务事务。
export async function safeInvalidateEnrollmentCaches(studentId?: string) {
  try {
    await invalidateEnrollmentCaches(studentId);
  } catch (error) {
    console.error("Failed to invalidate enrollment cache", error);
  }
}

// 安全清理全部选课缓存，供写回和运维恢复调用。
export async function safeInvalidateAllEnrollmentCaches() {
  try {
    await invalidateAllEnrollmentCaches();
  } catch (error) {
    console.error("Failed to invalidate all enrollment caches", error);
  }
}
