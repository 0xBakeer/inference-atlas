/** Generic filtering + sorting helpers shared by the tables. */

export type SortDir = 'asc' | 'desc';

export interface SortSpec {
  key: string;
  dir: SortDir;
}

/** `-output_tok_s` -> desc, `model` -> asc */
export function parseSort(s: string | null | undefined, fallback: SortSpec): SortSpec {
  if (!s) return fallback;
  if (s.startsWith('-')) return { key: s.slice(1), dir: 'desc' };
  return { key: s, dir: 'asc' };
}

export function serializeSort(s: SortSpec): string {
  return (s.dir === 'desc' ? '-' : '') + s.key;
}

export function toggleSort(cur: SortSpec, key: string, defaultDir: SortDir = 'asc'): SortSpec {
  if (cur.key !== key) return { key, dir: defaultDir };
  return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
}

export type Accessor<T> = (row: T) => string | number | null | undefined | boolean;

/** Stable sort; nulls always last regardless of direction. */
export function sortRows<T>(rows: T[], accessor: Accessor<T>, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i, v: accessor(r) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined || a.v === '';
      const bn = b.v === null || b.v === undefined || b.v === '';
      if (an && bn) return a.i - b.i;
      if (an) return 1;
      if (bn) return -1;
      let c: number;
      if (typeof a.v === 'number' && typeof b.v === 'number') c = a.v - b.v;
      else if (typeof a.v === 'boolean' && typeof b.v === 'boolean') c = Number(a.v) - Number(b.v);
      else
        c = String(a.v).localeCompare(String(b.v), undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.r);
}

export function uniqueSorted<T>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true }),
  );
}

export function countBy<T>(
  rows: T[],
  key: (r: T) => string | null | undefined,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (k === null || k === undefined) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Case-insensitive multi-token substring match over a haystack string. */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const h = haystack.toLowerCase();
  return q.split(/\s+/).every((t) => h.includes(t));
}

/** Scored fuzzy match for the command palette: prefix > word-start > substring > subsequence. */
export function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80 - (t.length - q.length) * 0.1;
  const wordStart = t.split(/[\s\-_/.]+/).some((w) => w.startsWith(q));
  if (wordStart) return 60;
  const idx = t.indexOf(q);
  if (idx >= 0) return 40 - idx * 0.1;
  // subsequence
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) if (t[i] === q[qi]) qi++;
  if (qi === q.length) return 10 - (t.length - q.length) * 0.01;
  return 0;
}

export function inDateRange(
  iso: string | null | undefined,
  from: string | null,
  to: string | null,
): boolean {
  if (!from && !to) return true;
  if (!iso) return false;
  const d = iso.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
