import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("password hashing", () => {
  it("verifies the original password", async () => {
    const hash = await hashPassword("12345678");

    await expect(verifyPassword({ password: "12345678", hash })).resolves.toBe(true);
  });

  it("rejects a different password", async () => {
    const hash = await hashPassword("12345678");

    await expect(verifyPassword({ password: "wrong-password", hash })).resolves.toBe(false);
  });

  it("uses a different salt for each hash", async () => {
    const first = await hashPassword("12345678");
    const second = await hashPassword("12345678");

    expect(first).not.toBe(second);
    expect(first.split(":")).toHaveLength(2);
    expect(second.split(":")).toHaveLength(2);
  });

  it("rejects malformed hashes", async () => {
    await expect(
      verifyPassword({ password: "12345678", hash: "not-a-valid-hash" }),
    ).resolves.toBe(false);
  });

  it("rejects hashes with an invalid stored key length", async () => {
    const [salt] = (await hashPassword("12345678")).split(":");

    await expect(
      verifyPassword({ password: "12345678", hash: `${salt}:abcd` }),
    ).resolves.toBe(false);
  });
});
