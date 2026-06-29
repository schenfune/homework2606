import { redis } from "@/lib/db/redis";

export const cacheKeys = {
  courseList: (studentId: string) => `course-list:${studentId}`,
  adminStats: "admin:course-stats",
};

export async function getJsonCache<T>(key: string) {
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

export async function setJsonCache(key: string, value: unknown, seconds = 30) {
  await redis.set(key, JSON.stringify(value), {
    EX: seconds,
  });
}

export async function invalidateEnrollmentCaches(studentId?: string) {
  const keys = [cacheKeys.adminStats];

  if (studentId) {
    keys.push(cacheKeys.courseList(studentId));
  }

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

export async function invalidateAllEnrollmentCaches() {
  const courseListKeys = await redis.keys("course-list:*");
  const keys = [cacheKeys.adminStats, ...courseListKeys];

  if (keys.length > 0) {
    await redis.del(keys);
  }
}

export async function safeInvalidateEnrollmentCaches(studentId?: string) {
  try {
    await invalidateEnrollmentCaches(studentId);
  } catch (error) {
    console.error("Failed to invalidate enrollment cache", error);
  }
}

export async function safeInvalidateAllEnrollmentCaches() {
  try {
    await invalidateAllEnrollmentCaches();
  } catch (error) {
    console.error("Failed to invalidate all enrollment caches", error);
  }
}
