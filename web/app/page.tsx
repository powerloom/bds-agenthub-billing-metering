/**
 * Static UI at https://<host>/metering (same origin as signup + credits API).
 */
export default function Home() {
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
            Verifiable on-chain. Metered in credits. Sign up, top up, copy your API
            key — then plug into OpenClaw / MCP in minutes.
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

        <section id="signup" className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 space-y-4">
          <h2 className="text-xl font-semibold">Sign up & top up</h2>
          <p className="text-sm text-zinc-400">
            Wire this form to <code className="text-zinc-300">POST /signup/initiate</code>{" "}
            and the existing credits routes on this origin. CLI users:{" "}
            <code className="text-zinc-300">bds-agent signup</code> against{" "}
            <code className="text-zinc-300">https://bds-agent-metering.powerloom.io</code>.
          </p>
          <form className="space-y-4 opacity-60 pointer-events-none">
            <div>
              <label className="block text-sm text-zinc-400">Email</label>
              <input
                type="email"
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2"
                placeholder="you@example.com"
                disabled
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400">Agent name</label>
              <input
                type="text"
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2"
                placeholder="my-openclaw-agent"
                disabled
              />
            </div>
            <button
              type="button"
              className="rounded-lg bg-zinc-700 px-4 py-2 text-sm"
              disabled
            >
              Continue (stub)
            </button>
          </form>
        </section>

        <p className="text-sm text-zinc-500">
          ClawHub skill: <code className="text-zinc-300">powerloom-bds-univ3</code>. Top-up
          links in product copy should point at{" "}
          <code className="text-zinc-300">https://bds-metering.powerloom.io/metering</code>.
        </p>
      </main>
    </div>
  );
}
