/**
 * What is new on the map, derived from the compiled index alone: the day a model, a device,
 * an engine or a cell first got a number, and who put it there. The build stamps no dates on
 * registry files, so "new" here means "first measured", which is also what a visitor means.
 */
import type { IndexRow } from '../data/types.js';

export type NewsKind = 'model' | 'hardware' | 'engine' | 'cell' | 'contributor';

export interface NewsItem {
  kind: NewsKind;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  id: string;
  by: string;
  run_id: string;
}

export const rowDate = (r: IndexRow): string =>
  (r.provenance.submitted_at ?? r.provenance.started_at ?? '').slice(0, 10);

/** First appearances, newest first. Cells are only reported when `cells` is true. */
export function firstAppearances(rows: IndexRow[], opts: { cells?: boolean } = {}): NewsItem[] {
  const sorted = [...rows]
    .filter((r) => rowDate(r))
    .sort((a, b) => rowDate(a).localeCompare(rowDate(b)));
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  const first = (kind: NewsKind, id: string, r: IndexRow) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, date: rowDate(r), id, by: r.provenance.login, run_id: r.run_id });
  };
  for (const r of sorted) {
    first('contributor', r.provenance.login, r);
    first('model', r.model.id, r);
    first('hardware', r.hardware.id, r);
    first('engine', r.engine.id, r);
    if (opts.cells) first('cell', r.cell_id, r);
  }
  return out.reverse();
}

export interface PeriodStats {
  runs: number;
  contributors: number;
  cells: number;
  models: number;
  hardware: number;
}

/** Activity in the last `days` days, counted against `now`. */
export function periodStats(rows: IndexRow[], days: number, now = new Date()): PeriodStats {
  const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const recent = rows.filter((r) => rowDate(r) >= since);
  const firsts = firstAppearances(rows, { cells: true }).filter((n) => n.date >= since);
  return {
    runs: recent.length,
    contributors: new Set(recent.map((r) => r.provenance.login)).size,
    cells: firsts.filter((n) => n.kind === 'cell').length,
    models: firsts.filter((n) => n.kind === 'model').length,
    hardware: firsts.filter((n) => n.kind === 'hardware').length,
  };
}

/** Runs per week for the last `weeks` weeks, oldest first — a sparkline's worth. */
export function weeklyCounts(rows: IndexRow[], weeks: number, now = new Date()): number[] {
  const out = new Array<number>(weeks).fill(0);
  const end = now.getTime();
  for (const r of rows) {
    const d = rowDate(r);
    if (!d) continue;
    const age = (end - new Date(d).getTime()) / (7 * 86400000);
    const idx = weeks - 1 - Math.floor(age);
    if (idx >= 0 && idx < weeks) out[idx]!++;
  }
  return out;
}
