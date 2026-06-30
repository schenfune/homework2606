import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  keys: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/db/redis", () => ({
  redis: redisMock,
}));

import {
  cacheKeys,
  getJsonCache,
  invalidateAllEnrollmentCaches,
  invalidateEnrollmentCaches,
  safeInvalidateAllEnrollmentCaches,
  safeInvalidateEnrollmentCaches,
  setJsonCache,
} from "@/lib/services/cache";

describe("cache service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads and writes JSON values", async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ ok: true }));

    await expect(getJsonCache<{ ok: boolean }>("demo")).resolves.toEqual({ ok: true });
    await setJsonCache("demo", { ok: true }, 15);

    expect(redisMock.set).toHaveBeenCalledWith("demo", JSON.stringify({ ok: true }), {
      EX: 15,
    });
  });

  it("returns null for empty cache values", async () => {
    redisMock.get.mockResolvedValueOnce(null);

    await expect(getJsonCache("missing")).resolves.toBeNull();
  });

  it("invalidates admin and optional student caches", async () => {
    await invalidateEnrollmentCaches("student-1");

    expect(redisMock.del).toHaveBeenCalledWith([
      cacheKeys.adminStats,
      cacheKeys.courseList("student-1"),
    ]);
  });

  it("invalidates all enrollment caches", async () => {
    redisMock.keys.mockResolvedValueOnce(["course-list:a", "course-list:b"]);

    await invalidateAllEnrollmentCaches();

    expect(redisMock.del).toHaveBeenCalledWith([
      cacheKeys.adminStats,
      "course-list:a",
      "course-list:b",
    ]);
  });

  it("swallows cache invalidation errors in safe helpers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    redisMock.del.mockRejectedValueOnce(new Error("redis down"));
    await safeInvalidateEnrollmentCaches("student-1");

    redisMock.keys.mockRejectedValueOnce(new Error("redis down"));
    await safeInvalidateAllEnrollmentCaches();

    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
