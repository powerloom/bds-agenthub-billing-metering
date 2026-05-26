"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { MeteringShell } from "../components/MeteringShell";

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

function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b-2 border-pl-border">
            {headers.map((h) => (
              <th key={h} className="py-2 pr-4 pl-label font-normal normal-case tracking-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-b border-pl-border-subtle">
              {cells.map((cell, j) => (
                <td key={j} className="py-2 pr-4 text-pl-text-muted last:text-white">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
    <MeteringShell
      title="BDS Metering"
      subtitle="Credit usage & API activity"
      activeNav="account"
      maxWidth="7xl"
    >
      <section className="space-y-2">
        <p className="text-pl-text-muted text-sm max-w-2xl">
          View balance, daily usage, and per-endpoint call counts. Your key stays in this browser tab
          only (sessionStorage).
        </p>
      </section>

      {!apiKey ? (
        <section className="pl-card p-6 space-y-4 max-w-xl">
          <h2 className="pl-section-title">Unlock with API key</h2>
          <form onSubmit={onUnlock} className="space-y-4">
            <div>
              <label className="pl-label mb-2" htmlFor="api-key">
                API key
              </label>
              <input
                id="api-key"
                type="password"
                autoComplete="off"
                className="pl-input font-mono"
                placeholder="sk_live_..."
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
            </div>
            <button type="submit" className="pl-btn-primary">
              View usage
            </button>
          </form>
          <p className="text-xs text-pl-text-muted font-mono">
            Lost your key? Pay-signup users: POST /api-key/recover/challenge then verify (see metering
            docs).
          </p>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void loadData(apiKey)}
              disabled={loading}
              className="pl-btn-secondary disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button type="button" onClick={onSignOut} className="text-sm text-pl-text-muted hover:text-white underline">
              Sign out
            </button>
          </div>

          {err && (
            <div className="rounded-lg border-2 border-red-800/80 bg-red-950/30 px-4 py-3 text-sm text-red-200">
              {err}
            </div>
          )}

          {balance && (
            <section className="grid sm:grid-cols-3 gap-4">
              {[
                { label: "Balance", value: fmtCredits(balance.credit_balance), accent: true },
                { label: "Credits used (lifetime)", value: fmtCredits(balance.total_credits_used), accent: false },
                {
                  label: "Rate limits",
                  value: `${balance.rate_limits.requests_per_minute}/min · ${balance.rate_limits.requests_per_day}/day`,
                  accent: false,
                },
              ].map((c) => (
                <div key={c.label} className="pl-card p-6">
                  <p className="pl-stat-label mb-2">{c.label}</p>
                  <p className={`pl-stat-value text-xl sm:text-2xl ${c.accent ? "pl-stat-value-accent" : ""}`}>
                    {c.value}
                  </p>
                </div>
              ))}
            </section>
          )}

          {summary && (
            <section className="pl-card p-6 space-y-4">
              <h2 className="pl-section-title">Usage by day (last {summary.window_days} days)</h2>
              {summary.by_day.length === 0 ? (
                <p className="text-sm text-pl-text-muted">No usage in this window yet.</p>
              ) : (
                <DataTable
                  headers={["Day", "Calls", "Credits used"]}
                  rows={summary.by_day.map((row) => [
                    <span key="d" className="font-mono text-xs text-white">{row.day}</span>,
                    row.usage_events,
                    fmtCredits(row.credits_used),
                  ])}
                />
              )}
            </section>
          )}

          {summary && (
            <section className="pl-card p-6 space-y-4">
              <h2 className="pl-section-title">Top endpoints</h2>
              {topEndpoints.length === 0 ? (
                <p className="text-sm text-pl-text-muted">
                  No structured endpoint data yet (older rows may lack route templates).
                </p>
              ) : (
                <DataTable
                  headers={["Route", "Method", "Calls", "Credits"]}
                  rows={topEndpoints.map((row) => [
                    <span key="r" className="font-mono text-xs text-white break-all">{row.route_template}</span>,
                    row.http_method,
                    row.call_count,
                    fmtCredits(row.credits_used),
                  ])}
                />
              )}
            </section>
          )}

          <section className="pl-card p-6 space-y-4">
            <h2 className="pl-section-title">Recent activity</h2>
            {recent.length === 0 ? (
              <p className="text-sm text-pl-text-muted">No transactions yet.</p>
            ) : (
              <DataTable
                headers={["Time", "Type", "Route", "Source", "Amount"]}
                rows={recent.map((row) => [
                  <span key="t" className="font-mono text-xs text-white whitespace-nowrap">
                    {row.created_at.replace("T", " ").slice(0, 19)}
                  </span>,
                  row.type,
                  <span key="route" className="font-mono text-xs text-white max-w-xs truncate block">
                    {row.route_template ?? row.description ?? "—"}
                  </span>,
                  row.client_source ?? "—",
                  fmtCredits(row.amount),
                ])}
              />
            )}
          </section>

          <p className="text-sm text-pl-text-muted font-mono">
            Top up: bds-agent credits topup ·{" "}
            <a href="/credits/plans" className="text-pl-accent hover:underline">
              view plans
            </a>
          </p>
        </>
      )}
    </MeteringShell>
  );
}
