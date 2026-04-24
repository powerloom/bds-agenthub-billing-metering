/**
 * Minimal JSON-RPC for Tempo verification (eth_getTransactionReceipt, eth_chainId).
 * Transfer log matching follows pympp ChargeIntent._verify_transfer_logs (TIP-20).
 */

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_WITH_MEMO_TOPIC =
  "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";

type JsonRpcOk<T> = { jsonrpc: "2.0"; id: number; result: T };
type JsonRpcErr = { jsonrpc: "2.0"; id: number; error: { message?: string; code?: number } };

export async function jsonRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) {
    throw new Error(`rpc_http_${r.status}`);
  }
  const j = (await r.json()) as JsonRpcOk<T> | JsonRpcErr;
  if ("error" in j && j.error) {
    const msg = j.error.message ?? "rpc_error";
    throw new Error(msg);
  }
  if ("result" in j) {
    return j.result as T;
  }
  throw new Error("rpc_no_result");
}

export type ReceiptLog = {
  address: string;
  topics: string[];
  data: string;
};

export type TxReceipt = {
  status: string;
  logs: ReceiptLog[];
};

/** True if receipt contains a TIP-20 Transfer or TransferWithMemo to recipient with value >= minAmount. */
export function receiptContainsTip20Payment(
  receipt: TxReceipt,
  tokenAddress: string,
  recipient: string,
  minAmount: bigint,
): boolean {
  const tok = tokenAddress.toLowerCase();
  const rec = recipient.toLowerCase();
  const t0 = TRANSFER_TOPIC.toLowerCase();
  const t1 = TRANSFER_WITH_MEMO_TOPIC.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tok) {
      continue;
    }
    const topics = log.topics;
    if (topics.length < 3) {
      continue;
    }
    const eventTopic = topics[0]!.toLowerCase();
    const toTopic = topics[2]!;
    const toAddr = ("0x" + toTopic.slice(-40)).toLowerCase();
    if (toAddr !== rec) {
      continue;
    }

    if (eventTopic === t0) {
      const data = log.data ?? "0x";
      if (data.length < 66) {
        continue;
      }
      const amount = BigInt(data);
      if (amount >= minAmount) {
        return true;
      }
      continue;
    }

    if (eventTopic === t1) {
      const data = log.data ?? "0x";
      if (data.length < 66) {
        continue;
      }
      const amount = BigInt("0x" + data.slice(2, 66));
      if (amount >= minAmount) {
        return true;
      }
    }
  }

  return false;
}

export async function fetchReceipt(rpcUrl: string, txHash: string): Promise<TxReceipt | null> {
  const result = await jsonRpc<TxReceipt | null>(rpcUrl, "eth_getTransactionReceipt", [txHash]);
  return result;
}

export async function fetchChainId(rpcUrl: string): Promise<bigint> {
  const hex = await jsonRpc<string>(rpcUrl, "eth_chainId", []);
  return BigInt(hex);
}

type TxObject = { from?: string };

/** Returns lowercase `0x` address of transaction sender, or null if not found. */
export async function fetchTransactionFrom(rpcUrl: string, txHash: string): Promise<string | null> {
  const result = await jsonRpc<TxObject | null>(rpcUrl, "eth_getTransactionByHash", [txHash]);
  const from = result?.from;
  if (!from || typeof from !== "string") {
    return null;
  }
  return from.toLowerCase();
}
