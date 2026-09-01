/** Block-character primitives: sparklines, horizontal bars, half-block heatmap rows. */

import type { ColorLevel } from './color.js';
import { paint } from './color.js';

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const;

/**
 * One character per value, scaled to the min/max of the series (or the given bounds).
 * `null` values render as `·` — an absent measurement is visible, not silently dropped.
 */
export function sparkline(
  values: Array<number | null>,
  bounds?: { min: number; max: number },
): string {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return '·'.repeat(values.length);
  const min = bounds?.min ?? Math.min(...present);
  const max = bounds?.max ?? Math.max(...present);
  const span = max - min || 1;
  return values
    .map((v) => {
      if (v === null || !Number.isFinite(v)) return '·';
      const t = (v - min) / span;
      return SPARK[Math.max(0, Math.min(7, Math.round(t * 7)))];
    })
    .join('');
}

/** Horizontal bar of `width` cells filled to `frac` ∈ [0,1], eighth-block precision. */
export function hbar(frac: number, width: number): string {
  const t = Math.max(0, Math.min(1, frac));
  const eighths = Math.round(t * width * 8);
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  const bar = '█'.repeat(full) + (rest > 0 ? EIGHTHS[rest]! : '');
  return bar + ' '.repeat(Math.max(0, width - full - (rest > 0 ? 1 : 0)));
}

/**
 * Heatmap rows via `▀`: each character shows two grid rows — foreground paints the top one,
 * background the bottom. `grid[row][col]` is a colour hex or null (empty cell). An odd row
 * count leaves the last bottom half unpainted.
 */
export function heatmapRows(grid: Array<Array<string | null>>, level: ColorLevel): string[] {
  const out: string[] = [];
  for (let r = 0; r < grid.length; r += 2) {
    const top = grid[r]!;
    const bottom = grid[r + 1] ?? [];
    let line = '';
    for (let c = 0; c < top.length; c++) {
      const t = top[c] ?? null;
      const b = bottom[c] ?? null;
      if (!t && !b) {
        line += ' ';
      } else if (level === 'mono') {
        // No colour: show presence with block characters instead.
        line += t && b ? '█' : t ? '▀' : '▄';
      } else if (t && b) {
        line += paint('▀', { fg: t, bg: b }, level);
      } else if (t) {
        line += paint('▀', { fg: t }, level);
      } else {
        line += paint('▄', { fg: b }, level);
      }
    }
    out.push(line);
  }
  return out;
}
