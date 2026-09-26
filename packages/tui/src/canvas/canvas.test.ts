import { describe, expect, it } from 'vitest';
import { BrailleGrid } from './braille.js';
import { columnRows, heatmapRows, hbar, resample, resampleFlags, sparkline } from './blocks.js';
import { detectColorLevel, hexToRgb, paint, ramp, rgbTo256 } from './color.js';
import { legendChips, renderChart } from './chart.js';
import { niceTicks, padDomain } from './scale.js';

const plain = () => (s: string) => s;

describe('color', () => {
  it('honours NO_COLOR before everything else', () => {
    expect(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('mono');
  });
  it('detects truecolor via COLORTERM', () => {
    expect(detectColorLevel({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })).toBe('truecolor');
  });
  it('falls back to 256 on a plain TERM', () => {
    expect(detectColorLevel({ TERM: 'xterm' })).toBe('256');
  });
  it('parses hex', () => {
    expect(hexToRgb('#3b82f6')).toEqual({ r: 0x3b, g: 0x82, b: 0xf6 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });
  it('maps pure grays onto the grayscale ramp', () => {
    expect(rgbTo256({ r: 128, g: 128, b: 128 })).toBeGreaterThanOrEqual(232);
  });
  it('mono paint is the identity', () => {
    expect(paint('x', { fg: '#ff0000', bold: true }, 'mono')).toBe('x');
  });
  it('truecolor paint wraps in 38;2 codes', () => {
    expect(paint('x', { fg: '#ff0000' }, 'truecolor')).toBe('\u001b[38;2;255;0;0mx\u001b[0m');
  });
  it('ramp interpolates its endpoints', () => {
    expect(ramp(['#000000', '#ffffff'], 0)).toBe('#000000');
    expect(ramp(['#000000', '#ffffff'], 1)).toBe('#ffffff');
  });
});

describe('scale', () => {
  it('produces 1/2/5 ticks', () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 7, 4)).toEqual([0, 2, 4, 6]);
  });
  it('pads a degenerate domain', () => {
    const [lo, hi] = padDomain(5, 5);
    expect(lo).toBeLessThan(5);
    expect(hi).toBeGreaterThan(5);
  });
});

describe('sparkline', () => {
  it('spans the eight block heights', () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█');
  });
  it('marks missing values instead of dropping them', () => {
    expect(sparkline([0, null, 7])).toBe('▁·█');
  });
  it('handles an all-null series', () => {
    expect(sparkline([null, null])).toBe('··');
  });
});

describe('hbar', () => {
  it('fills to the fraction at cell precision', () => {
    expect(hbar(1, 4)).toBe('████');
    expect(hbar(0.5, 4)).toBe('██  ');
    expect(hbar(0, 4)).toBe('    ');
  });
  it('uses eighth blocks between cells', () => {
    expect(hbar(0.5 + 1 / 16, 4)).toBe('██▎ ');
  });
});

describe('BrailleGrid', () => {
  it('sets individual dots to the right braille bits', () => {
    const g = new BrailleGrid(1, 1);
    g.set(0, 0);
    g.set(1, 3);
    // dot (0,0) = 0x01, dot (1,3) = 0x80 → U+2881
    expect(g.render(plain)).toEqual([String.fromCharCode(0x2881)]);
  });
  it('draws a horizontal line through every column', () => {
    const g = new BrailleGrid(3, 1);
    g.line(0, 0, 5, 0);
    const [row] = g.render(plain);
    expect(row).toHaveLength(3);
    expect(row).not.toContain(' ');
  });
  it('ignores out-of-bounds dots', () => {
    const g = new BrailleGrid(1, 1);
    g.set(-1, 0);
    g.set(99, 99);
    expect(g.render(plain)).toEqual([' ']);
  });
  it('cell overrides replace the braille char', () => {
    const g = new BrailleGrid(2, 1);
    g.set(0, 0);
    g.mark(0, 0, '◉');
    expect(g.render(plain)[0]![0]).toBe('◉');
  });
});

describe('heatmapRows', () => {
  it('renders presence as blocks in mono', () => {
    const rows = heatmapRows(
      [
        ['#ff0000', null],
        [null, '#00ff00'],
      ],
      'mono',
    );
    expect(rows).toEqual(['▀▄']);
  });
  it('pairs top and bottom into one ▀ cell in colour', () => {
    const rows = heatmapRows([['#ff0000'], ['#00ff00']], 'truecolor');
    expect(rows[0]).toBe('\u001b[38;2;255;0;0;48;2;0;255;0m▀\u001b[0m');
  });
});

describe('renderChart', () => {
  it('renders a mono line chart with a drawn axis', () => {
    const lines = renderChart({
      width: 30,
      height: 4,
      level: 'mono',
      series: [
        { label: 'tok/s', color: '#3b82f6', points: [1, 2, 4, 8, 16].map((x) => ({ x, y: x })) },
      ],
    });
    expect(lines.some((l) => l.includes('│'))).toBe(true);
    expect(lines.some((l) => l.includes('┤'))).toBe(true); // a labelled tick
    expect(lines.some((l) => l.includes('└') && l.includes('┬'))).toBe(true);
    // The plot body carries braille characters.
    expect(lines.join('')).toMatch(/[⠀-⣿]/);
  });

  it('labels the exact sweep levels rather than inventing round numbers', () => {
    const levels = [1, 2, 4, 8, 16, 32];
    const lines = renderChart({
      width: 46,
      height: 5,
      level: 'mono',
      tightX: true,
      xTicks: levels,
      xFmt: (v) => String(Math.round(v)),
      series: [{ label: '', color: '#fff', points: levels.map((x) => ({ x, y: 100 / x })) }],
    });
    const xRow = lines[lines.length - 1]!;
    expect(xRow).toContain('1');
    expect(xRow).toContain('32');
    // No padded phantom values outside the measured range.
    expect(xRow).not.toContain('-');
    expect(xRow).not.toContain('34');
  });

  it('never repeats a y label', () => {
    // A narrow range formats many ticks to the same "20k" — those rows must collapse.
    const lines = renderChart({
      width: 30,
      height: 8,
      level: 'mono',
      series: [
        {
          label: '',
          color: '#fff',
          points: [17451, 19673, 20433, 22766].map((y, i) => ({ x: i, y })),
        },
      ],
    });
    const labels = lines
      .map((l) => l.split('│')[0]?.split('┤')[0]?.trim())
      .filter((l): l is string => !!l);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('fills the area under a curve so a shallow slope reads as a body', () => {
    const points = [1, 2, 4, 8].map((x) => ({ x, y: x }));
    const bare = renderChart({
      width: 30,
      height: 5,
      level: 'mono',
      series: [{ label: '', color: '#fff', points }],
    });
    const filled = renderChart({
      width: 30,
      height: 5,
      level: 'mono',
      series: [{ label: '', color: '#fff', points, fill: true }],
    });
    const ink = (ls: string[]) => ls.join('').replace(/[^⠀-⣿]/g, '').length;
    expect(ink(filled)).toBeGreaterThan(ink(bare));
  });

  it('gives a second series its own right-hand axis', () => {
    const lines = renderChart({
      width: 44,
      height: 6,
      level: 'mono',
      series: [
        { label: 'tok/s', color: '#5b8cff', points: [1, 2, 4].map((x) => ({ x, y: x * 100 })) },
        {
          label: 'ms',
          color: '#f97316',
          axis: 'right',
          points: [1, 2, 4].map((x) => ({ x, y: x * 7 })),
        },
      ],
    });
    // Left labels in the gutter, right labels after the plot.
    expect(lines.some((l) => l.includes('├'))).toBe(true);
    expect(lines.join('\n')).toMatch(/\b400\b/);
    expect(lines.join('\n')).toMatch(/\b25\b/);
  });

  it('legendChips names each series', () => {
    const chips = legendChips(
      [
        { label: 'tok/s', color: '#5b8cff', points: [] },
        { label: 'TTFT ms', color: '#f97316', points: [] },
      ],
      'mono',
    );
    expect(chips).toContain('tok/s');
    expect(chips).toContain('TTFT ms');
  });
  it('says so when there is no data', () => {
    expect(renderChart({ width: 20, height: 4, level: 'mono', series: [] })).toEqual(['(no data)']);
  });
  it('marks the highlighted point', () => {
    const lines = renderChart({
      width: 30,
      height: 4,
      level: 'mono',
      series: [
        {
          label: '',
          color: '#fff',
          connect: false,
          points: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
      ],
      highlight: { series: 0, point: 1 },
    });
    expect(lines.join('')).toContain('◉');
  });
});

describe('resample', () => {
  it('averages a long series down to the target width', () => {
    const out = resample([0, 10, 20, 30], 2);
    expect(out).toEqual([5, 25]);
  });

  it('repeats a short series up so the chart fills its panel', () => {
    expect(resample([1, 2], 6)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it('keeps a series that already fits', () => {
    expect(resample([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it('yields null for a bucket with no measured value', () => {
    expect(resample([null, null, 4, 4], 2)).toEqual([null, 4]);
  });

  it('never truncates — the tail of the run must survive', () => {
    const values = Array.from({ length: 400 }, (_, i) => (i < 200 ? 0 : 100));
    const out = resample(values, 10);
    expect(out.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(out.slice(5)).toEqual([100, 100, 100, 100, 100]);
  });
});

describe('resampleFlags', () => {
  it('flags a column when any sample in it failed', () => {
    expect(resampleFlags([false, true, false, false], 2)).toEqual([true, false]);
  });
  it('stretches a short flag series', () => {
    expect(resampleFlags([true, false], 4)).toEqual([true, true, false, false]);
  });
});

describe('columnRows', () => {
  it('fills columns from the bottom row up', () => {
    const rows = columnRows([1, 0.5, 0], 2, { min: 0, max: 1 });
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe('█'); // full column reaches the top row
    expect(rows[1]![0]).toBe('█');
    expect(rows[0]![1]).toBe(' '); // half column: nothing in the top row
    expect(rows[1]![1]).toBe('█');
    expect(rows[0]![2]).toBe(' ');
  });

  it('marks a missing value on the baseline instead of dropping the column', () => {
    const rows = columnRows([null], 2, { min: 0, max: 1 });
    expect(rows[1]).toBe('·');
  });
});

/** Visible width: ANSI codes cost no columns, braille and blocks cost one each. */
const ANSI = new RegExp(`${String.fromCharCode(27)}[[][0-9;]*m`, 'g');
const visible = (s: string): number => s.replace(ANSI, '').length;

describe('layout invariants', () => {
  it('never renders a chart line wider than the width it was given', () => {
    const points = [1, 2, 4, 8, 16, 32].map((x) => ({ x, y: 1000 / x }));
    for (const width of [30, 46, 74, 100, 140]) {
      for (const level of ['mono', 'truecolor'] as const) {
        const lines = renderChart({
          width,
          height: 8,
          level,
          tightX: true,
          xTicks: points.map((p) => p.x),
          series: [
            { label: 'tok/s', color: '#5b8cff', points, fill: true },
            {
              label: 'ms',
              color: '#f97316',
              axis: 'right',
              points: points.map((p) => ({ x: p.x, y: p.y * 40 })),
            },
          ],
        });
        for (const line of lines) expect(visible(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('never renders a column chart wider than its column count', () => {
    for (const width of [10, 40, 96]) {
      const rows = columnRows(resample([1, 2, 3, 4, 5], width), 3);
      for (const row of rows) expect(row.length).toBe(width);
    }
  });
});
