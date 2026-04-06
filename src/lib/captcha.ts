import type { AppConfig } from "../config.js";

export async function verifyTurnstile(
  config: AppConfig,
  token: string,
  remoteip: string | undefined,
): Promise<boolean> {
  if (config.skipTurnstile) {
    return true;
  }
  if (!config.turnstileSecretKey) {
    return false;
  }
  const body = new URLSearchParams({
    secret: config.turnstileSecretKey,
    response: token,
  });
  if (remoteip) body.set("remoteip", remoteip);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}
