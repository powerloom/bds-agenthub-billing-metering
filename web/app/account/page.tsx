"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "bds_metering_api_key";

type Balance = {
  org_id: string;
  email: string;
  credit_balance: number;
  total_credits_purchased: number;
  total_credits_used: number;
  rate_limits: { requests_per_minute: number; requests_per_day: number };
};

type Summary = {
  window_days: number;
  totals: { usage_events: number; credits_used: number; credits_added: number };
  by_day: Array<{ day: string; credits_used: number; usage_events: number }>;
  by_endpoint: Array<{
    route_template: string;
    http_method: string;
    call_count: number;
    credits_used: number;
  }>;
};

type UsageRow = {
  id: string;
  amount: number;
  type: string;
  description: string | null;
  http_method: string | null;
  route_template: string | null;
  request_path: string | null;
  client_source: string | null;
  created_at: string;
};

async function apiGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401) {
    throw new Error("Invalid or revoked API key.");
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(j.message ?? j.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

function fmtCredits(n: number): string {
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(8);
}

export default function AccountPage() {
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<UsageRow[]>([]);

  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      setApiKey(stored);
      setApiKeyInput(stored);
    }
  }, []);

  const loadData = useCallback(async (key: string) => {
    setLoading(true);
    setErr(null);
    try {
      const [bal, sum, usage] = await Promise.all([
        apiGet<Balance>("/credits/balance", key),
        apiGet<Summary>("/credits/usage/summary?days=30", key),
        apiGet<{ transactions: UsageRow[] }>("/credits/usage?limit=20", key),
      ]);
      setBalance(bal);
      setSummary(sum);
      setRecent(usage.transactions);
      sessionStorage.setItem(STORAGE_KEY, key);
    } catch (e) {
      setBalance(null);
      setSummary(null);
      setRecent([]);
      setErr(e instanceof Error ? e.message : "Failed to load account data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (apiKey) {
      void loadData(apiKey);
    }
  }, [apiKey, loadData]);

  const topEndpoints = useMemo(() => summary?.by_endpoint ?? [], [summary]);

  function onUnlock(e: React.FormEvent) {
    e.preventDefault();
    const key = apiKeyInput.trim();
    if (!key.startsWith("sk_live_")) {
      setErr("Paste a valid sk_live_... API key.");
      return;
    }
    setApiKey(key);
  }

  function onSignOut() {
    sessionStorage.removeItem(STORAGE_KEY);
    setApiKey(null);
    setBalance(null);
    setSummary(null);
    setRecent([]);
    setApiKeyInput("");
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between gap-4">
        <span className="text-sm font-medium tracking-tight">Powerloom BDS — Account</span>
        <a href="/metering/" className="text-sm text-zinc-400 hover:text-zinc-200">
          Sign up
        </a>
      </header>

      <main className="flex-1 max-w-4xl mx-auto px-6 py-12 flex flex-col gap-8 w-full">
        <section className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Credit usage</h1>
          <p className="text-zinc-400 text-sm">
            View balance, daily usage, and per-endpoint call counts. Your key stays in this browser tab
            only (sessionStorage).
          </p>
        </section>

        {!apiKey ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-4">
            <h2 className="text-lg font-medium">Unlock with API key</h2>
            <form onSubmit={onUnlock} className="space-y-3">
              <input
                type="password"
                autoComplete="off"
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono"
                placeholder="sk_live_..."
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
              <button
                type="submit"
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
              >
                View usage
              </button>
            </form>
            <p className="text-xs text-zinc-500">
              Lost your key? Pay-signup users can recover via wallet-signed{" "}
              <code className="text-zinc-400">POST /api-key/recover/challenge</code> then{" "}
              <code className="text-zinc-400">POST /api-key/recover/verify</code> (see metering
              service docs).
            </p>
          </section>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                onClick={() => void loadData(apiKey)}
                disabled={loading}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 hover:bg-zinc-900 disabled:opacity-50"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
              <button
                type="button"
                onClick={onSignOut}
                className="text-zinc-500 hover:text-zinc-300 underline"
              >
                Sign out
              </button>
            </div>

            {err && (
              <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {err}
              </div>
            )}

            {balance && (
              <section className="grid sm:grid-cols-3 gap-3">
                {[
                  { label: "Balance", value: fmtCredits(balance.credit_balance) },
                  { label: "Credits used (lifetime)", value: fmtCredits(balance.total_credits_used) },
                  {
                    label: "Rate limits",
                    value: `${balance.rate_limits.requests_per_minute}/min · ${balance.rate_limits.requests_per_day}/day`,
                  },
                ].map((c) => (
                  <div key={c.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                    <p className="text-xs text-zinc-500 uppercase tracking-wide">{c.label}</p>
                    <p className="mt-2 text-lg font-medium">{c.value}</p>
                  </div>
                ))}
              </section>
            )}

            {summary && (
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-4">
                <h2 className="text-lg font-medium">Usage by day (last {summary.window_days} days)</h2>
                {summary.by_day.length === 0 ? (
                  <p className="text-sm text-zinc-500">No usage in this window yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-zinc-500 border-b border-zinc-800">
                          <th className="py-2 pr-4">Day</th>
                          <th className="py-2 pr-4">Calls</th>
                          <th className="py-2">Credits used</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.by_day.map((row) => (
                          <tr key={row.day} className="border-b border-zinc-900">
                            <td className="py-2 pr-4 font-mono text-xs">{row.day}</td>
                            <td className="py-2 pr-4">{row.usage_events}</td>
                            <td className="py-2">{fmtCredits(row.credits_used)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {summary && (
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-4">
                <h2 className="text-lg font-medium">Top endpoints</h2>
                {topEndpoints.length === 0 ? (
                  <p className="text-sm text-zinc-500">No structured endpoint data yet (older rows may lack route templates).</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-zinc-500 border-b border-zinc-800">
                          <th className="py-2 pr-4">Route</th>
                          <th className="py-2 pr-4">Method</th>
                          <th className="py-2 pr-4">Calls</th>
                          <th className="py-2">Credits</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topEndpoints.map((row) => (
                          <tr
                            key={`${row.http_method}:${row.route_template}`}
                            className="border-b border-zinc-900"
                          >
                            <td className="py-2 pr-4 font-mono text-xs">{row.route_template}</td>
                            <td className="py-2 pr-4">{row.http_method}</td>
                            <td className="py-2 pr-4">{row.call_count}</td>
                            <td className="py-2">{fmtCredits(row.credits_used)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-4">
              <h2 className="text-lg font-medium">Recent activity</h2>
              {recent.length === 0 ? (
                <p className="text-sm text-zinc-500">No transactions yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-zinc-500 border-b border-zinc-800">
                        <th className="py-2 pr-4">Time</th>
                        <th className="py-2 pr-4">Type</th>
                        <th className="py-2 pr-4">Route</th>
                        <th className="py-2 pr-4">Source</th>
                        <th className="py-2">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((row) => (
                        <tr key={row.id} className="border-b border-zinc-900">
                          <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                            {row.created_at.replace("T", " ").slice(0, 19)}
                          </td>
                          <td className="py-2 pr-4">{row.type}</td>
                          <td className="py-2 pr-4 font-mono text-xs max-w-xs truncate">
                            {row.route_template ?? row.description ?? "—"}
                          </td>
                          <td className="py-2 pr-4">{row.client_source ?? "—"}</td>
                          <td className="py-2">{fmtCredits(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <p className="text-sm text-zinc-500">
              Top up: <code className="text-zinc-400">bds-agent credits topup</code> or{" "}
              <a href="/credits/plans" className="text-violet-400 hover:underline">
                view plans
              </a>
              .
            </p>
          </>
        )}
      </main>
    </div>
  );
}
