const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateEmail(email: string): string | null {
  const t = email.trim();
  if (!t || t.length > 254) return "email is required and must be at most 254 characters";
  if (!EMAIL_RE.test(t)) return "invalid email format";
  return null;
}

export function validateAgentName(name: string): string | null {
  const t = name.trim();
  if (!t) return "agent_name is required";
  if (!AGENT_NAME_RE.test(t)) return "agent_name must be 1–64 chars: letters, digits, _, -";
  return null;
}

export function normalizeUserCode(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned.length <= 4) return cleaned;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}
