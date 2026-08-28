import type { CoverageLevel, SiteConfig } from '@atlas/core';

/** Vendor → CSS class suffix used by `.vendor-*` rules. */
export function vendorClass(vendor: string | null | undefined): string {
  const v = (vendor ?? '').toLowerCase();
  if (v === 'nvidia' || v === 'amd' || v === 'apple' || v === 'intel') return `vendor-${v}`;
  if (v === 'cpu' || v === 'generic' || v === 'x86' || v === 'arm') return 'vendor-cpu';
  return 'vendor-other';
}

/** Resolved CSS variable value (for canvas/uPlot which cannot read custom properties). */
export function cssVar(name: string, fallback = '#888'): string {
  if (typeof getComputedStyle === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function vendorColor(vendor: string | null | undefined): string {
  return cssVar(`--${vendorClass(vendor)}`, cssVar('--vendor-other'));
}

/** Fixed categorical order for chart series: assigned by entity, never cycled. Leads with the
 * two validated chart accents; status colours (--warn etc.) are never series colours. */
const SERIES_VARS = [
  '--chart-1',
  '--chart-2',
  '--vendor-apple',
  '--vendor-nvidia',
  '--accent',
  '--vendor-cpu',
  '--vendor-intel',
  '--vendor-amd',
];
export function seriesColor(i: number): string {
  return cssVar(SERIES_VARS[i % SERIES_VARS.length]!);
}

/** Apply site evidence colours to CSS variables. `none` is kept theme-aware. */
export function applyEvidenceColors(site: SiteConfig): void {
  const root = document.documentElement.style;
  const c = site.evidence_colors ?? ({} as Record<CoverageLevel, string>);
  for (const level of ['single', 'reproduced', 'disputed', 'stale'] as CoverageLevel[]) {
    if (c[level]) root.setProperty(`--ev-${level}`, c[level]);
  }
}

/** Sequential step 0..5 for a 0..1 value (accuracy heat cells). */
export function seqStep(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v >= 0.95) return 5;
  if (v >= 0.85) return 4;
  if (v >= 0.7) return 3;
  if (v >= 0.5) return 2;
  if (v >= 0.25) return 1;
  return 0;
}

/** Convert #rrggbb to rgba(). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
