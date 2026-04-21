"use client";

/**
 * Static UI at https://<host>/metering (same origin as signup + credits API).
 * Wired to POST /signup/initiate and GET /signup/status; human completes Turnstile at GET /verify.
 */
import { useCallback, useEffect, useState } from "react";

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
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `status ${res.status}`);
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
    }, 2000);
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="border-b border-zinc-800 px-6 py-4">
        <span className="text-sm font-medium tracking-tight">Powerloom BDS</span>
      </header>
      <main className="flex-1 max-w-3xl mx-auto px-6 py-16 flex flex-col gap-12">
        <section className="space-y-4">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
            Consensus-backed Uniswap V3 data for agents
          </h1>
          <p className="text-lg text-zinc-400">
            Verifiable on-chain. Metered in credits. Sign up, top up, copy your API key — then plug
            into OpenClaw / MCP in minutes.
          </p>
        </section>
        <section className="grid sm:grid-cols-3 gap-3">
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
            <div
              key={c.title}
              className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
            >
              <h2 className="font-medium text-zinc-100">{c.title}</h2>
              <p className="mt-2 text-sm text-zinc-400">{c.body}</p>
            </div>
          ))}
        </section>

        {err && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {err}
          </div>
        )}

        {phase.kind === "done" ? (
          <section className="rounded-xl border border-emerald-900/50 bg-emerald-950/30 p-6 space-y-4">
            <h2 className="text-xl font-semibold text-emerald-100">Your API key</h2>
            <p className="text-sm text-zinc-400">
              Copy it now — for security we only show it once in this flow. Org:{" "}
              <code className="text-zinc-300">{phase.orgId}</code> · limits{" "}
              {phase.rateLimits.requests_per_minute}/min, {phase.rateLimits.requests_per_day}/day
            </p>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
              <code className="block flex-1 break-all rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">
                {phase.key}
              </code>
              <button
                type="button"
                className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 shrink-0"
                onClick={() => void navigator.clipboard.writeText(phase.key)}
              >
                Copy
              </button>
            </div>
            <p className="text-sm text-zinc-500">
              Set <code className="text-zinc-400">POWERLOOM_API_KEY</code> to this value in your shell or
              OpenClaw env.
            </p>
          </section>
        ) : (
          <section id="signup" className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-4">
            <h2 className="text-xl font-semibold">Sign up & top up</h2>
            <p className="text-sm text-zinc-400">
              We call <code className="text-zinc-300">POST /signup/initiate</code> on this origin.
              After you verify in the browser (Turnstile + terms), we poll{" "}
              <code className="text-zinc-300">GET /signup/status</code> and show your key here. CLI:{" "}
              <code className="text-zinc-300">bds-agent signup</code> against{" "}
              <code className="text-zinc-300">https://bds-metering.powerloom.io</code>.
            </p>

            {phase.kind === "verify" && (
              <div className="rounded-lg border border-amber-900/40 bg-amber-950/25 px-4 py-3 space-y-2 text-sm">
                <p className="text-amber-100/90">
                  <strong>Next:</strong> open verification, complete the captcha and terms, then keep
                  this tab open.
                </p>
                <p>
                  Your code:{" "}
                  <code className="text-lg font-mono tracking-wide text-amber-200">
                    {phase.data.user_code}
                  </code>
                </p>
                <a
                  href={`/verify?code=${encodeURIComponent(phase.data.user_code)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-500"
                >
                  Open verification page
                </a>
                <p className="text-zinc-500">Waiting for verification…</p>
                <button
                  type="button"
                  className="text-sm text-zinc-500 underline hover:text-zinc-300"
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
                <label className="block text-sm text-zinc-400" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting || phase.kind === "verify"}
                  required
                  autoComplete="email"
                />
                {fieldErr?.email && (
                  <p className="mt-1 text-sm text-red-400">{fieldErr.email}</p>
                )}
              </div>
              <div>
                <label className="block text-sm text-zinc-400" htmlFor="agent">
                  Agent name
                </label>
                <input
                  id="agent"
                  type="text"
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100"
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
              <button
                type="submit"
                disabled={submitting || phase.kind === "verify"}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {submitting ? "Starting…" : phase.kind === "verify" ? "Continue below" : "Continue"}
              </button>
            </form>
          </section>
        )}

        <p className="text-sm text-zinc-500">
          ClawHub skill: <code className="text-zinc-300">powerloom-bds-univ3</code>. Top-up:{" "}
          <code className="text-zinc-300">https://bds-metering.powerloom.io/metering</code> (this
          page).
        </p>
      </main>
    </div>
  );
}
