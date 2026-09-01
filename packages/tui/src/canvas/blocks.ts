/** Block-character primitives: sparklines, column charts, bars, half-block heatmap rows. */

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

const VERTICAL = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * A column chart `height` rows tall, one column per value, filled from the bottom.
 * One row of sparkline throws away most of the shape of 400 requests; four rows of columns
 * keep it, and the eighth-blocks give sub-row precision at the top of each bar.
 */
export function columnRows(
  values: Array<number | null>,
  height: number,
  bounds?: { min: number; max: number },
): string[] {
  const rows = Math.max(1, height);
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const min = bounds?.min ?? 0;
  const max = bounds?.max ?? (present.length > 0 ? Math.max(...present) : 1);
  const span = max - min || 1;
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    // Row 0 is the top; the band it covers sits `rows - 1 - r` rows above the floor.
    const floor = (rows - 1 - r) * 8;
    let line = '';
    for (const v of values) {
      if (v === null || !Number.isFinite(v)) {
        line += r === rows - 1 ? '·' : ' ';
        continue;
      }
      const eighths = Math.round(((v - min) / span) * rows * 8);
      line += VERTICAL[Math.max(0, Math.min(8, eighths - floor))];
    }
    out.push(line);
  }
  return out;
}

/**
 * Fit a series to exactly `width` columns: average down when there are more samples than
 * columns, repeat up when there are fewer. Downsampling beats truncation — showing the
 * first 90 of 400 requests silently hides three quarters of the run — and upsampling beats
 * a chart that stops halfway across its own panel.
 */
export function resample(values: Array<number | null>, width: number): Array<number | null> {
  if (width <= 0) return [];
  if (values.length === 0) return [];
  if (values.length < width) {
    return Array.from({ length: width }, (_, i) => {
      const v = values[Math.min(values.length - 1, Math.floor((i * values.length) / width))];
      return v ?? null;
    });
  }
  if (values.length === width) return values;
  const out: Array<number | null> = [];
  for (let i = 0; i < width; i++) {
    const from = Math.floor((i * values.length) / width);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / width));
    let sum = 0;
    let n = 0;
    for (let j = from; j < to; j++) {
      const v = values[j];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    out.push(n > 0 ? sum / n : null);
  }
  return out;
}

/** The same fit for a boolean channel: a column is flagged if any sample in it was. */
export function resampleFlags(flags: boolean[], width: number): boolean[] {
  if (width <= 0 || flags.length === 0) return [];
  if (flags.length < width) {
    return Array.from(
      { length: width },
      (_, i) => flags[Math.min(flags.length - 1, Math.floor((i * flags.length) / width))] ?? false,
    );
  }
  if (flags.length === width) return flags;
  const out: boolean[] = [];
  for (let i = 0; i < width; i++) {
    const from = Math.floor((i * flags.length) / width);
    const to = Math.max(from + 1, Math.floor(((i + 1) * flags.length) / width));
    out.push(flags.slice(from, to).some(Boolean));
  }
  return out;
}
