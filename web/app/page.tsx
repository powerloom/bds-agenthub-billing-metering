"use client";

/**
 * Static UI at https://<host>/metering (same origin as signup + credits API).
 * Wired to POST /signup/initiate and GET /signup/status; human completes Turnstile at GET /verify.
 */
import { useCallback, useEffect, useState } from "react";
import { MeteringShell } from "./components/MeteringShell";

const STORAGE_KEY = "bds_metering_api_key";

type InitiateOk = {
  session_token: string;
  verification_url: string;
  user_code: string;
  expires_in: number;
};

type StatusPending = { status: "pending"; expires_in: number };
type StatusExpired = { status: "expired" };
type StatusApproved = {
  status: "approved";
  api_key: string;
  org_id: string;
  rate_limits: { requests_per_minute: number; requests_per_day: number };
};

export default function Home() {
  const [email, setEmail] = useState("");
  const [agentName, setAgentName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{
    email?: string | null;
    agent_name?: string | null;
  } | null>(null);

  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "verify"; data: InitiateOk }
    | { kind: "done"; key: string; orgId: string; rateLimits: StatusApproved["rate_limits"] }
  >({ kind: "idle" });

  const pollStatus = useCallback(async (sessionToken: string): Promise<StatusApproved | null> => {
    const res = await fetch(
      `/signup/status?session_token=${encodeURIComponent(sessionToken)}`,
      { method: "GET" },
    );
    if (res.status === 404) {
      throw new Error(
        "Session not found, or the API key was already delivered. Start signup again or use the CLI.",
      );
    }
    if (res.status === 429) {
      // Transient throttle — keep verify UI; next interval will retry.
      return null;
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      const code = j.error ?? `status ${res.status}`;
      throw new Error(code === "rate_limited" ? "Too many checks. Please wait a few seconds." : code);
    }
    const data = (await res.json()) as StatusPending | StatusExpired | StatusApproved;
    if (data.status === "approved") {
      return data;
    }
    if (data.status === "expired") {
      throw new Error("This signup session expired. Start again.");
    }
    return null;
  }, []);

  const pendingSessionToken =
    phase.kind === "verify" ? phase.data.session_token : null;

  useEffect(() => {
    if (!pendingSessionToken) return;
    const token = pendingSessionToken;
    let cancelled = false;
    const tick = async () => {
      try {
        const approved = await pollStatus(token);
        if (cancelled || !approved) return;
        setPhase({
          kind: "done",
          key: approved.api_key,
          orgId: approved.org_id,
          rateLimits: approved.rate_limits,
        });
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Verification failed");
          setPhase({ kind: "idle" });
        }
      }
    };
    const id = window.setInterval(() => {
      void tick();
    }, 4000);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pendingSessionToken, pollStatus]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setFieldErr(null);
    setSubmitting(true);
    try {
      const res = await fetch("/signup/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          agent_name: agentName.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (res.status === 400 && data.error === "validation_failed") {
        const fields = data.fields as { email?: string | null; agent_name?: string | null } | undefined;
        setFieldErr(fields ?? {});
        return;
      }
      if (res.status === 409) {
        setErr(
          String(
            data.message ??
              "An account with this email already exists. Use your existing API key.",
          ),
        );
        return;
      }
      if (res.status === 429) {
        setErr("Too many attempts. Try again later.");
        return;
      }
      if (!res.ok) {
        setErr(String(data.message ?? data.error ?? `Request failed (${res.status})`));
        return;
      }

      const ok = data as unknown as InitiateOk;
      if (!ok.session_token || !ok.user_code) {
        setErr("Unexpected response from server.");
        return;
      }
      setPhase({ kind: "verify", data: ok });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <MeteringShell
      title="BDS Metering"
      subtitle="Sign up · credits · agent API access"
      activeNav="signup"
      maxWidth="3xl"
    >
      <section className="space-y-3">
        <p className="text-base sm:text-lg text-pl-text-muted leading-relaxed">
          Verifiable on-chain Uniswap V3 data for agents. Metered in credits — sign up, top up, copy
          your API key, then plug into OpenClaw or hosted MCP.
        </p>
      </section>

      <section className="grid sm:grid-cols-3 gap-4">
        {[
          {
            title: "Verifiable",
            body: "Snapshots tied to Powerloom protocol state — not a trust-me API.",
          },
          {
            title: "Agent-ready",
            body: "Bearer token + hosted MCP at bds-mcp.powerloom.io/sse.",
          },
          {
            title: "POWER or USDC",
            body: "Credit top-ups on EVM rails (same service as this page).",
          },
        ].map((c) => (
          <div key={c.title} className="pl-card p-4">
            <h2 className="font-orbitron text-sm font-semibold text-white">{c.title}</h2>
            <p className="mt-2 text-sm text-pl-text-muted">{c.body}</p>
          </div>
        ))}
      </section>

      {err && (
        <div className="rounded-lg border-2 border-red-800/80 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {err}
        </div>
      )}

      {phase.kind === "done" ? (
        <section className="pl-card p-6 space-y-4 border-pl-accent/40">
          <h2 className="pl-section-title text-pl-accent">Your API key</h2>
          <p className="text-sm text-pl-text-muted">
            Copy it now — for security we only show it once in this flow. Org:{" "}
            <code className="font-mono text-white">{phase.orgId}</code> · limits{" "}
            {phase.rateLimits.requests_per_minute}/min, {phase.rateLimits.requests_per_day}/day
          </p>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <code className="block flex-1 break-all rounded-lg border-2 border-pl-border bg-pl-bg-input px-3 py-2 text-sm font-mono">
              {phase.key}
            </code>
            <button type="button" className="pl-btn-primary shrink-0" onClick={() => void navigator.clipboard.writeText(phase.key)}>
              Copy
            </button>
          </div>
          <p className="text-sm text-pl-text-muted font-mono">
            Set POWERLOOM_API_KEY in your shell or OpenClaw env.
          </p>
          <a
            href="/metering/account"
            className="inline-block pl-btn-secondary"
            onClick={() => {
              try {
                sessionStorage.setItem(STORAGE_KEY, phase.key);
              } catch {
                /* ignore */
              }
            }}
          >
            View usage →
          </a>
        </section>
      ) : (
        <section id="signup" className="pl-card p-6 space-y-4">
          <h2 className="pl-section-title">Sign up & top up</h2>
          <p className="text-sm text-pl-text-muted font-mono leading-relaxed">
            POST /signup/initiate → browser verify (Turnstile + terms) → GET /signup/status. CLI:{" "}
            bds-agent signup against https://bds-metering.powerloom.io
          </p>

          {phase.kind === "verify" && (
            <div className="rounded-lg border-2 border-pl-accent/30 bg-pl-bg-elevated px-4 py-3 space-y-3 text-sm">
              <p className="text-white">
                <strong>Next:</strong> open verification, complete the captcha and terms, then keep
                this tab open.
              </p>
              <p>
                Your code:{" "}
                <code className="text-lg font-mono tracking-wide text-pl-accent">
                  {phase.data.user_code}
                </code>
              </p>
              <a
                href={`/verify?code=${encodeURIComponent(phase.data.user_code)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block pl-btn-primary"
              >
                Open verification page
              </a>
              <p className="text-pl-text-muted font-mono text-xs">Waiting for verification…</p>
              <button
                type="button"
                className="text-sm text-pl-text-muted underline hover:text-white"
                onClick={() => {
                  setPhase({ kind: "idle" });
                  setErr(null);
                }}
              >
                Cancel and start over
              </button>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="pl-label mb-2" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="pl-input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting || phase.kind === "verify"}
                required
                autoComplete="email"
              />
              {fieldErr?.email && <p className="mt-1 text-sm text-red-400">{fieldErr.email}</p>}
            </div>
            <div>
              <label className="pl-label mb-2" htmlFor="agent">
                Agent name
              </label>
              <input
                id="agent"
                type="text"
                className="pl-input"
                placeholder="my-openclaw-agent"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                disabled={submitting || phase.kind === "verify"}
                required
                pattern="[a-zA-Z0-9_-]{1,64}"
                title="1–64 characters: letters, digits, underscore, hyphen"
                autoComplete="off"
              />
              {fieldErr?.agent_name && (
                <p className="mt-1 text-sm text-red-400">{fieldErr.agent_name}</p>
              )}
            </div>
            <button type="submit" disabled={submitting || phase.kind === "verify"} className="pl-btn-primary disabled:opacity-50">
              {submitting ? "Starting…" : phase.kind === "verify" ? "Continue below" : "Continue"}
            </button>
          </form>
        </section>
      )}

      <p className="text-sm text-pl-text-muted font-mono">
        ClawHub: powerloom-bds-univ3 · bds-metering.powerloom.io/metering
      </p>
    </MeteringShell>
  );
}
