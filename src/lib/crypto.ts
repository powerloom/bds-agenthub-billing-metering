import { createHash, randomBytes, randomUUID } from "node:crypto";

const USER_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 64 hex chars = 32 random bytes — returned to client once */
export function randomSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function randomFromCharset(length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) {
    s += USER_CODE_CHARSET[randomBytes(1)[0]! % USER_CODE_CHARSET.length];
  }
  return s;
}

/** Format XXXX-XXXX, charset without ambiguous chars */
export function generateUserCode(): string {
  const a = randomFromCharset(4);
  const b = randomFromCharset(4);
  return `${a}-${b}`;
}

export function randomApiKey(): string {
  const suffix = randomBytes(48).toString("hex");
  return `sk_live_${suffix}`;
}

export function randomOrgId(): string {
  return `org_${randomBytes(12).toString("hex")}`;
}

export function randomUuid(): string {
  return randomUUID();
}
