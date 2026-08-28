/**
 * "Arms" of a heatmap cell: the same model × quant × hardware × engine-minor measured under
 * different configurations (different `config_id`). The interesting comparison is almost
 * always between arms — same silicon, one flag apart — so these helpers name each arm by
 * exactly what was changed.
 */
import type { Args, MetricBlock, ResultRecord, SweepPoint } from '@atlas/core';
import type { IndexRow } from '../data/types.js';
import { argsDiff } from './diff.js';

export interface CellArm {
  configId: string;
  rows: IndexRow[];
}

/** Sibling runs in the record's cell, grouped by config: the current arm first, then by size. */
export function cellArms(index: IndexRow[], rec: ResultRecord): CellArm[] {
  const by = new Map<string, IndexRow[]>();
  for (const r of index) {
    if (r.cell_id !== rec.cell_id) continue;
    const list = by.get(r.config_id);
    if (list) list.push(r);
    else by.set(r.config_id, [r]);
  }
  return [...by.entries()]
    .map(([configId, rows]) => ({ configId, rows }))
    .sort((a, b) => {
      if (a.configId === rec.config_id) return -1;
      if (b.configId === rec.config_id) return 1;
      return b.rows.length - a.rows.length;
    });
}

/**
 * What sets this arm apart from the base run, as `flag=value` chips. Empty when nothing
 * differs — then the arm is a reproduction and the caller labels it by contributor instead.
 */
export function armDiff(base: Args, arm: Args): string[] {
  return argsDiff([base, arm])
    .filter((row) => row.differs)
    .map((row) => `${row.name}=${row.values[1] ?? 'unset'}`);
}

/** Short series label for an arm: the differing flags, or a fallback identity. */
export function armLabel(base: Args, arm: Args, fallback: string): string {
  const diff = armDiff(base, arm);
  if (diff.length === 0) return fallback;
  if (diff.length <= 2) return diff.join(' ');
  return `${diff.slice(0, 2).join(' ')} +${diff.length - 2}`;
}

/**
 * One configuration's prefill runs as sweep points over context length. The x comes from the
 * workload's resolved `input_tokens` — the registry defines the lengths, not this code. When
 * the same length was run twice the newest wins.
 */
export function prefillPoints(recs: ResultRecord[]): SweepPoint[] {
  const byLen = new Map<number, { rec: ResultRecord; metrics: MetricBlock }>();
  for (const rec of recs) {
    if (rec.kind !== 'prefill' || !rec.metrics) continue;
    const len = rec.workload?.resolved_params?.input_tokens;
    if (typeof len !== 'number') continue;
    const prev = byLen.get(len);
    if (!prev || (rec.provenance.started_at ?? '') > (prev.rec.provenance.started_at ?? ''))
      byLen.set(len, { rec, metrics: rec.metrics });
  }
  return [...byLen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([len, e]) => ({ input_tokens: len, metrics: e.metrics }));
}
