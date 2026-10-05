import { formatUnits, parseUnits } from "viem";

export function fmtAmount(value: bigint | undefined, decimals: number, digits = 4): string {
  if (value === undefined) return "…";
  const n = Number(formatUnits(value, decimals));
  if (n !== 0 && Math.abs(n) < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}`;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtUsd(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return "…";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtBps(bps: number | bigint | undefined, digits = 2): string {
  if (bps === undefined) return "…";
  return `${(Number(bps) / 100).toFixed(digits)}%`;
}

export function safeParse(input: string, decimals: number): bigint | null {
  if (!input || !/^\d*\.?\d*$/.test(input)) return null;
  try {
    const v = parseUnits(input, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Trims a bigint amount to a plain decimal string an input box accepts. */
export function toInput(value: bigint, decimals: number, digits = 6): string {
  const s = formatUnits(value, decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, digits).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}

export function shortAddress(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
