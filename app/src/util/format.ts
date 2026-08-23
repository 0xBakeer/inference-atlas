/** Number formatting. Every metric shows its unit; the unit is rendered separately by the caller. */

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function fmtInt(v: number | null | undefined): string {
  return isNum(v) ? intFmt.format(Math.round(v)) : '–';
}

export function fmtNum(v: number | null | undefined, decimals = 1): string {
  if (!isNum(v)) return '–';
  const abs = Math.abs(v);
  if (abs >= 10000) return intFmt.format(Math.round(v));
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 1 decimal; integers above 1000 lose the decimal. */
export function fmtTokS(v: number | null | undefined): string {
  if (!isNum(v)) return '–';
  if (Math.abs(v) >= 1000) return intFmt.format(Math.round(v));
  return fmtNum(v, 1);
}

/** 0 decimals above 10 ms, 1 below. */
export function fmtMs(v: number | null | undefined): string {
  if (!isNum(v)) return '–';
  if (Math.abs(v) >= 10) return intFmt.format(Math.round(v));
  return fmtNum(v, 1);
}

/** Fractions 0..1 to percent. */
export function fmtPct(v: number | null | undefined, decimals = 1): string {
  if (!isNum(v)) return '–';
  return `${(v * 100).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`;
}

export function fmtGB(v: number | null | undefined): string {
  if (!isNum(v)) return '–';
  return fmtNum(v, v >= 100 ? 0 : 1);
}

export function fmtW(v: number | null | undefined): string {
  return isNum(v) ? intFmt.format(Math.round(v)) : '–';
}

/** 1234 -> 1.2k, 1234567 -> 1.2M */
export function fmtCompact(v: number | null | undefined): string {
  if (!isNum(v)) return '–';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return intFmt.format(v);
}

/** Tokens: 262144 -> 256K, 1048576 -> 1M. */
export function fmtTokens(v: number | null | undefined): string {
  if (!isNum(v)) return '–';
  if (v >= 1024 * 1024 && v % (1024 * 1024) === 0) return `${v / (1024 * 1024)}M`;
  if (v >= 1024 && v % 1024 === 0) return `${v / 1024}K`;
  return fmtCompact(v);
}

export function fmtUsd(v: number | null | undefined): string {
  if (!isNum(v)) return '–';
  return `$${intFmt.format(Math.round(v))}`;
}

export function fmtParams(b: number | null | undefined): string {
  if (!isNum(b)) return '–';
  if (b < 1) return `${Math.round(b * 1000)}M`;
  return `${b % 1 === 0 ? b : b.toFixed(1)}B`;
}

export function fmtSignedPct(v: number | null | undefined, decimals = 1): string {
  if (!isNum(v)) return '–';
  const s = (v * 100).toFixed(decimals);
  return `${v > 0 ? '+' : ''}${s}%`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

export function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
