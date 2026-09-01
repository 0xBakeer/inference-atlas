/**
 * Per-request samples out of `raw.payload.requests` — the atlas-bench harness records one
 * entry per request (`{ id: "concurrency16-r00042", ttft_ms, e2e_ms, ... }`). The payload is
 * untyped by contract (`Record<string, unknown>`), so everything here guards at runtime and
 * an absent or foreign payload simply yields no samples.
 */
import type { ResultRecord } from './types.js';
import { isNum } from './format.js';

export interface RequestSample {
  id: string;
  /** Sweep level parsed from the id prefix (`concurrency16-…` → 16); null when not encoded. */
  level: number | null;
  ttft_ms: number | null;
  e2e_ms: number | null;
  completion_tokens: number | null;
  ok: boolean;
  warmup: boolean;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const num = (v: unknown): number | null => (isNum(v) ? v : null);

/** `concurrency16-r00042` → 16; `input8192-r3` → 8192. Axis name is whatever the harness used. */
export function levelFromId(id: string): number | null {
  const m = /^[a-z_]*?(\d+)-/.exec(id);
  return m ? Number(m[1]) : null;
}

export function requestSamples(rec: ResultRecord): RequestSample[] {
  const payload = rec.raw?.payload;
  if (!isRec(payload) || !Array.isArray(payload.requests)) return [];
  const out: RequestSample[] = [];
  for (const r of payload.requests) {
    if (!isRec(r) || typeof r.id !== 'string') continue;
    out.push({
      id: r.id,
      level: levelFromId(r.id),
      ttft_ms: num(r.ttft_ms),
      e2e_ms: num(r.e2e_ms),
      completion_tokens: num(r.completion_tokens),
      ok: r.status === 'ok',
      warmup: r.warmup === true,
    });
  }
  return out;
}

/**
 * Measured (non-warmup) samples grouped by sweep level, levels ascending. Warmup requests are
 * excluded because they time engine compilation, not the configuration.
 */
export function samplesByLevel(samples: RequestSample[]): Map<number, RequestSample[]> {
  const by = new Map<number, RequestSample[]>();
  for (const s of samples) {
    if (s.warmup || s.level === null) continue;
    const list = by.get(s.level);
    if (list) list.push(s);
    else by.set(s.level, [s]);
  }
  return new Map([...by.entries()].sort((a, b) => a[0] - b[0]));
}

/** Linear-interpolated quantile of an unsorted list; null when empty. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
