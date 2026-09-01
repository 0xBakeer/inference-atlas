import { describe, expect, it } from 'vitest';
import { BrailleGrid } from './braille.js';
import { heatmapRows, hbar, sparkline } from './blocks.js';
import { detectColorLevel, hexToRgb, paint, ramp, rgbTo256 } from './color.js';
import { renderChart } from './chart.js';
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
  it('renders a mono line chart with axis and legend', () => {
    const lines = renderChart({
      width: 30,
      height: 4,
      level: 'mono',
      series: [
        { label: 'tok/s', color: '#3b82f6', points: [1, 2, 4, 8, 16].map((x) => ({ x, y: x })) },
      ],
    });
    expect(lines.some((l) => l.includes('│'))).toBe(true);
    expect(lines.some((l) => l.includes('└'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('tok/s');
    // The plot body carries braille characters.
    expect(lines.join('')).toMatch(/[⠀-⣿]/);
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
