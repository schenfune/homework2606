import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, keyLength)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword({
  password,
  hash,
}: {
  password: string;
  hash: string;
}) {
  const [salt, stored] = hash.split(":");

  if (!salt || !stored) {
    return false;
  }

  const derived = (await scrypt(password, salt, keyLength)) as Buffer;
  const storedBuffer = Buffer.from(stored, "hex");

  return (
    storedBuffer.length === derived.length &&
    timingSafeEqual(storedBuffer, derived)
  );
}
