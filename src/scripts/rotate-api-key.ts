/**
 * Pay-signup only: rotate `sk_live_...` by proving control of `payer_address` (EIP-191).
 *
 * The metering service stores only a hash of the key; rotation = new secret + new hash.
 *
 * Env:
 *   METERING_BASE_URL — optional, default https://bds-metering.powerloom.io
 *   WALLET_PRIVATE_KEY — required, 0x-prefixed key for the wallet used as pay-signup `payer_address`
 *
 * Usage:
 *   METERING_BASE_URL=https://bds-metering.powerloom.io \
 *   WALLET_PRIVATE_KEY=0x... \
 *   npm run rotate-api-key
 *
 * Optional: pass base URL as `--base-url=https://...`
 *
 * Security: treat WALLET_PRIVATE_KEY like a hot wallet secret; prefer a dedicated pay wallet.
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";

function meteringRoot(): string {
  const fromArg = process.argv.find((a) => a.startsWith("--base-url="));
  const raw =
    fromArg?.slice("--base-url=".length)?.trim() ||
    process.env.METERING_BASE_URL?.trim() ||
    "https://bds-metering.powerloom.io";
  return raw.replace(/\/$/, "");
}

async function main(): Promise<void> {
  const pk = process.env.WALLET_PRIVATE_KEY?.trim();
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error("[rotate-api-key] Set WALLET_PRIVATE_KEY to a 0x-prefixed 32-byte hex private key.");
    process.exit(1);
  }

  const account = privateKeyToAccount(pk as `0x${string}`);
  const root = meteringRoot();

  const chRes = await fetch(`${root}/api-key/recover/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ address: account.address }),
  });
  const chJson = (await chRes.json()) as Record<string, unknown>;

  if (!chRes.ok) {
    console.error("[rotate-api-key] POST /api-key/recover/challenge failed:", chRes.status, chJson);
    process.exit(1);
  }

  const message = String(chJson.message ?? "");
  const nonce = String(chJson.nonce ?? "");
  if (!message || !nonce) {
    console.error("[rotate-api-key] challenge response missing message or nonce:", chJson);
    process.exit(1);
  }

  const signature = await account.signMessage({ message });

  const vRes = await fetch(`${root}/api-key/recover/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      address: account.address,
      nonce,
      signature,
    }),
  });
  const vJson = (await vRes.json()) as Record<string, unknown>;

  if (!vRes.ok) {
    console.error("[rotate-api-key] POST /api-key/recover/verify failed:", vRes.status, vJson);
    process.exit(1);
  }

  const apiKey = String(vJson.api_key ?? "");
  if (!apiKey) {
    console.error("[rotate-api-key] verify response missing api_key:", vJson);
    process.exit(1);
  }

  process.stdout.write(`${apiKey}\n`);
  process.stderr.write(
    "[rotate-api-key] Previous sk_live_ key is invalid. Update POWERLOOM_API_KEY / Bearer token where you use BDS.\n",
  );
}

main().catch((e) => {
  console.error("[rotate-api-key]", e instanceof Error ? e.message : e);
  process.exit(1);
});
