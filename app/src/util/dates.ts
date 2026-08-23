export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 2026-08-23 */
export function absDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return '–';
  return d.toISOString().slice(0, 10);
}

/** 2026-08-23 12:00 UTC */
export function absDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return '–';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** "3 days ago", "in 2 h", "just now". Relative to `now` (injectable for tests). */
export function relTime(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseDate(iso);
  if (!d) return '–';
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const past = diff < 0;
  const units: Array<[number, string]> = [
    [365 * 86400e3, 'y'],
    [30 * 86400e3, 'mo'],
    [7 * 86400e3, 'w'],
    [86400e3, 'd'],
    [3600e3, 'h'],
    [60e3, 'min'],
  ];
  if (abs < 45e3) return 'just now';
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return past ? `${n} ${label} ago` : `in ${n} ${label}`;
    }
  }
  return 'just now';
}

/** Relative + absolute in a title attribute is what callers usually want. */
export function dateLabel(iso: string | null | undefined): { rel: string; abs: string } {
  return { rel: relTime(iso), abs: absDateTime(iso) };
}

export function monthKey(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return 'unknown';
  return d.toISOString().slice(0, 7);
}
