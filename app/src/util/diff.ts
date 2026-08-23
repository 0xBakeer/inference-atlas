import { normalizeValue } from '@atlas/core';
import type { ArgValue, Args, EngineParam } from '@atlas/core';

export interface ArgsDiffRow {
  name: string;
  values: Array<string | null>; // normalized strings per column, null = not set
  differs: boolean;
}

/** Side-by-side args. Only rows where at least one column differs have `differs: true`. */
export function argsDiff(argSets: Args[]): ArgsDiffRow[] {
  const names = new Set<string>();
  for (const a of argSets) for (const k of Object.keys(a)) names.add(k);
  const rows: ArgsDiffRow[] = [];
  for (const name of [...names].sort()) {
    const values = argSets.map((a) => {
      const v = a[name];
      if (v === undefined || v === null) return null;
      return normalizeValue(v as ArgValue);
    });
    const first = values[0];
    const differs = values.some((v) => v !== first);
    rows.push({ name, values, differs });
  }
  return rows;
}

/** Canonical pairs diff: how many resolved params differ between two canonical results. */
export function canonicalDistance(a: Record<string, string>, b: Record<string, string>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let n = 0;
  for (const k of keys) if (a[k] !== b[k]) n++;
  return n;
}

export function parseCanonical(canonical: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!canonical) return out;
  for (const part of canonical.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export interface VersionDiff {
  added: EngineParam[];
  removed: EngineParam[];
  defaultChanged: Array<{ name: string; from: ArgValue; to: ArgValue }>;
  typeChanged: Array<{ name: string; from: string; to: string }>;
}

/** What changed between two engine version files. */
export function versionDiff(older: EngineParam[], newer: EngineParam[]): VersionDiff {
  const o = new Map(older.map((p) => [p.name, p]));
  const n = new Map(newer.map((p) => [p.name, p]));
  const added = newer.filter((p) => !o.has(p.name));
  const removed = older.filter((p) => !n.has(p.name));
  const defaultChanged: VersionDiff['defaultChanged'] = [];
  const typeChanged: VersionDiff['typeChanged'] = [];
  for (const p of newer) {
    const prev = o.get(p.name);
    if (!prev) continue;
    if (JSON.stringify(prev.default ?? null) !== JSON.stringify(p.default ?? null)) {
      defaultChanged.push({ name: p.name, from: prev.default, to: p.default });
    }
    if (prev.type !== p.type) typeChanged.push({ name: p.name, from: prev.type, to: p.type });
  }
  return { added, removed, defaultChanged, typeChanged };
}

/** Better-direction aware metric delta: positive = b is better than a. */
export function metricDelta(
  a: number | null | undefined,
  b: number | null | undefined,
  better: 'higher' | 'lower',
): { pct: number; better: boolean; same: boolean } | null {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b))
    return null;
  if (a === 0) return b === 0 ? { pct: 0, better: false, same: true } : null;
  const pct = (b - a) / Math.abs(a);
  const same = Math.abs(pct) < 0.0005;
  const isBetter = better === 'higher' ? b > a : b < a;
  return { pct, better: isBetter && !same, same };
}
