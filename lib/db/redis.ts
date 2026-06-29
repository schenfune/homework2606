import { createClient } from "redis";

const globalForRedis = globalThis as unknown as {
  redis?: ReturnType<typeof createClient>;
};

export const redis =
  globalForRedis.redis ??
  createClient({
    url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0",
  });

if (!redis.isOpen) {
  redis.connect().catch((error) => {
    console.error("Redis connection failed", error);
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
