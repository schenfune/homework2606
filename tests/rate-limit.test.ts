import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => ({
  expire: vi.fn(),
  incr: vi.fn(),
}));

vi.mock("@/lib/db/redis", () => ({
  redis: redisMock,
}));

import {
  assertStudentEnrollmentRateLimit,
  RateLimitError,
  studentEnrollmentRateLimitKey,
} from "@/lib/services/rate-limit";

describe("student enrollment rate limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses shared keys for student enrollment actions", () => {
    expect(studentEnrollmentRateLimitKey("profile-1", "select")).toBe(
      "rate-limit:select:profile-1",
    );
    expect(studentEnrollmentRateLimitKey("profile-1", "waitlist")).toBe(
      "rate-limit:waitlist:profile-1",
    );
    expect(studentEnrollmentRateLimitKey("profile-1", "drop")).toBe(
      "rate-limit:drop:profile-1",
    );
  });

  it("sets a 60 second window on the first action", async () => {
    redisMock.incr.mockResolvedValueOnce(1);

    await assertStudentEnrollmentRateLimit("profile-1", "select");

    expect(redisMock.incr).toHaveBeenCalledWith("rate-limit:select:profile-1");
    expect(redisMock.expire).toHaveBeenCalledWith("rate-limit:select:profile-1", 60);
  });

  it("rejects when the shared 20 request window is exceeded", async () => {
    redisMock.incr.mockResolvedValueOnce(21);

    await expect(
      assertStudentEnrollmentRateLimit("profile-1", "waitlist"),
    ).rejects.toThrow(RateLimitError);

    expect(redisMock.expire).not.toHaveBeenCalled();
  });
});
