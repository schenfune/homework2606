import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

// 使用随机盐和scrypt派生密钥保存密码。
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  // 派生结果与盐拼接保存，登录校验时再拆开计算。
  const derived = (await scrypt(password, salt, keyLength)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

// 校验明文密码是否匹配已保存的盐和派生密钥。
export async function verifyPassword({
  password,
  hash,
}: {
  password: string;
  hash: string;
}) {
  const [salt, stored] = hash.split(":");

  if (!salt || !stored) {
    // 哈希格式不完整时直接判定失败。
    return false;
  }

  const derived = (await scrypt(password, salt, keyLength)) as Buffer;
  const storedBuffer = Buffer.from(stored, "hex");

  // 长度一致后使用常量时间比较，减少时序侧信道风险。
  return (
    storedBuffer.length === derived.length &&
    timingSafeEqual(storedBuffer, derived)
  );
}
