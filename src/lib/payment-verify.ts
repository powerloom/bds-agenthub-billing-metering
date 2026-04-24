import {
  fetchChainId,
  fetchReceipt,
  fetchTransactionFrom,
  fetchTransactionNativeFields,
  receiptContainsTip20Payment,
  type TxReceipt,
} from "./tempo-rpc.js";

export type Erc20PaymentVerifyError =
  | "rpc_error"
  | "rpc_chain_mismatch"
  | "tx_not_found"
  | "tx_reverted"
  | "payment_mismatch"
  | "payer_mismatch";

/**
 * Verifies a confirmed ERC-20 (TIP-20 compatible) `Transfer` in `txHash` to `recipient` for at least `minAtomic`.
 * Optionally enforces that the transaction was sent from `expectedPayer`.
 */
export async function verifyErc20Payment(
  rpcUrl: string,
  txHash: string,
  planChainId: number,
  tokenContract: string,
  recipient: string,
  minAtomic: bigint,
  options?: { expectedPayer?: string },
): Promise<{ ok: true } | { ok: false; error: Erc20PaymentVerifyError; message: string; http: number }> {
  let chainFromRpc: bigint;
  try {
    chainFromRpc = await fetchChainId(rpcUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "rpc_error", message: `RPC error: ${msg}`, http: 502 };
  }
  if (chainFromRpc !== BigInt(planChainId)) {
    return {
      ok: false,
      error: "rpc_chain_mismatch",
      message: "RPC network chain does not match the plan's chain_id.",
      http: 502,
    };
  }

  if (options?.expectedPayer) {
    const want = options.expectedPayer.toLowerCase();
    let from: string | null;
    try {
      from = await fetchTransactionFrom(rpcUrl, txHash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: "rpc_error", message: `RPC error: ${msg}`, http: 502 };
    }
    if (!from) {
      return { ok: false, error: "tx_not_found", message: "Transaction not found.", http: 400 };
    }
    if (from !== want) {
      return {
        ok: false,
        error: "payer_mismatch",
        message: "Transaction sender does not match the quote payer address.",
        http: 400,
      };
    }
  }

  let receipt: TxReceipt | null;
  try {
    receipt = await fetchReceipt(rpcUrl, txHash);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "rpc_error", message: `Could not fetch receipt: ${msg}`, http: 502 };
  }
  if (!receipt) {
    return {
      ok: false,
      error: "tx_not_found",
      message: "Transaction not found or not yet finalized. Wait for confirmation and retry.",
      http: 400,
    };
  }
  if (receipt.status !== "0x1") {
    return { ok: false, error: "tx_reverted", message: "Transaction failed on-chain.", http: 400 };
  }
  const okPay = receiptContainsTip20Payment(receipt, tokenContract, recipient, minAtomic);
  if (!okPay) {
    return {
      ok: false,
      error: "payment_mismatch",
      message:
        "Receipt does not show a matching token transfer to the configured recipient for this plan (check amount, token, and payee).",
      http: 400,
    };
  }
  return { ok: true };
}

/**
 * Verifies a **native / CGT value** transfer: `eth_getTransactionByHash` has `to == recipient`
 * and `value >= minAtomic` (e.g. Powerloom 7869 where fee token is not surfaced as an ERC-20
 * `Transfer` in the receipt). Expects a plain send (`input` empty or `0x`); do not use for
 * ERC-20 `transfer` calls.
 */
export async function verifyNativeValuePayment(
  rpcUrl: string,
  txHash: string,
  planChainId: number,
  recipient: string,
  minAtomic: bigint,
  options?: { expectedPayer?: string },
): Promise<{ ok: true } | { ok: false; error: Erc20PaymentVerifyError; message: string; http: number }> {
  let chainFromRpc: bigint;
  try {
    chainFromRpc = await fetchChainId(rpcUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "rpc_error", message: `RPC error: ${msg}`, http: 502 };
  }
  if (chainFromRpc !== BigInt(planChainId)) {
    return {
      ok: false,
      error: "rpc_chain_mismatch",
      message: "RPC network chain does not match the plan's chain_id.",
      http: 502,
    };
  }

  let receipt: TxReceipt | null;
  try {
    receipt = await fetchReceipt(rpcUrl, txHash);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "rpc_error", message: `Could not fetch receipt: ${msg}`, http: 502 };
  }
  if (!receipt) {
    return {
      ok: false,
      error: "tx_not_found",
      message: "Transaction not found or not yet finalized. Wait for confirmation and retry.",
      http: 400,
    };
  }
  if (receipt.status !== "0x1") {
    return { ok: false, error: "tx_reverted", message: "Transaction failed on-chain.", http: 400 };
  }

  let tx: { from: string; to: string; value: bigint } | null;
  try {
    tx = await fetchTransactionNativeFields(rpcUrl, txHash);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "rpc_error", message: `RPC error: ${msg}`, http: 502 };
  }
  if (!tx) {
    return {
      ok: false,
      error: "payment_mismatch",
      message: "Transaction is not a simple native value transfer to an address (missing to/value).",
      http: 400,
    };
  }

  if (options?.expectedPayer) {
    const want = options.expectedPayer.toLowerCase();
    if (tx.from !== want) {
      return {
        ok: false,
        error: "payer_mismatch",
        message: "Transaction sender does not match the quote payer address.",
        http: 400,
      };
    }
  }

  const wantTo = recipient.trim().toLowerCase();
  if (tx.to !== wantTo) {
    return {
      ok: false,
      error: "payment_mismatch",
      message: "Transaction recipient does not match the expected treasury address for this plan.",
      http: 400,
    };
  }
  if (tx.value < minAtomic) {
    return {
      ok: false,
      error: "payment_mismatch",
      message: "Transaction value is below the required amount for this plan.",
      http: 400,
    };
  }

  return { ok: true };
}
