/** Parse a non-negative decimal string into atomic units (bigint). No float rounding. */
export function parseDecimalToAtomicUnits(amountStr: string, decimals: number): bigint {
  const s = amountStr.trim();
  if (!s || s.startsWith("-")) {
    throw new Error("invalid_amount");
  }
  const parts = s.split(".");
  const whole = parts[0]!.replace(/^0+/, "") || "0";
  const fracRaw = parts.length > 1 ? parts[1]! : "";
  if (parts.length > 2) {
    throw new Error("invalid_amount");
  }
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fracRaw)) {
    throw new Error("invalid_amount");
  }
  const mult = 10n ** BigInt(decimals);
  return BigInt(whole) * mult + BigInt(frac || "0");
}
