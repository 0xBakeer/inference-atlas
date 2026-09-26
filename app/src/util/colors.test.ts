import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERIES_VARS, vendorClass, withAlpha } from './colors.js';

/* Palette accessibility gates for the categorical series (SERIES_VARS) in both themes.
 *
 * The checks mirror the dataviz palette validator (same OKLab math, same Machado 2009
 * CVD simulation at severity 1.0, same thresholds), so a token edit that pushes a hue
 * below the chroma floor, out of the lightness band, or an adjacent pair into the
 * CVD warn band fails here instead of shipping. Values are parsed from tokens.css —
 * the real stylesheet, not a copy.
 */

// -- tokens.css parsing ---------------------------------------------------------

/* happy-dom rewrites import.meta.url to an http: URL, so resolve from the working
 * directory instead (vitest may run from the repo root or from app/). */
const tokensPath = ['src/styles/tokens.css', 'app/src/styles/tokens.css']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));
if (!tokensPath) throw new Error('tokens.css not found from ' + process.cwd());
const css = readFileSync(tokensPath, 'utf8');

function parseBlock(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out.set(`--${m[1]!}`, m[2]!.trim());
  return out;
}

const darkStart = css.indexOf("[data-theme='dark']");
const lightVars = parseBlock(css.slice(0, darkStart));
const darkOnly = parseBlock(css.slice(darkStart));
/** Dark inherits from :root; only overridden vars change. */
const darkVars = new Map([...lightVars, ...darkOnly]);

function hexVar(vars: Map<string, string>, name: string): string {
  const v = vars.get(name);
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a 6-digit hex: ${v}`);
  return v;
}

// -- color math (identical formulation to the dataviz validator) -----------------

type Vec3 = [number, number, number];
const s2lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexLin = (h: string): Vec3 =>
  [1, 3, 5].map((i) => s2lin(parseInt(h.slice(i, i + 2), 16) / 255)) as Vec3;

function oklabFromLin([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const oklch = (h: string): { L: number; C: number } => {
  const [L, a, b] = oklabFromLin(hexLin(h));
  return { L, C: Math.hypot(a, b) };
};

/** Machado, Oliveira & Fernandes (2009), severity 1.0 — part of the standard. */
const MACHADO: Record<'protan' | 'deutan', number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};
function simulate(h: string, kind: 'protan' | 'deutan'): Vec3 {
  const [r, g, b] = hexLin(h);
  const M = MACHADO[kind];
  const clamp = (c: number): number => Math.max(0, Math.min(1, c));
  return [0, 1, 2].map((i) => clamp(M[i]![0]! * r + M[i]![1]! * g + M[i]![2]! * b)) as Vec3;
}
/** Euclidean distance in OKLab ×100; no kind = unsimulated (normal) vision. */
function deltaE(h1: string, h2: string, kind?: 'protan' | 'deutan'): number {
  const a = oklabFromLin(kind ? simulate(h1, kind) : hexLin(h1));
  const b = oklabFromLin(kind ? simulate(h2, kind) : hexLin(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
const cvdDeltaE = (a: string, b: string): number =>
  Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'));

const relLum = (h: string): number => {
  const [r, g, b] = hexLin(h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function contrast(a: string, b: string): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// -- thresholds (validator constants) --------------------------------------------

const CHROMA_FLOOR = 0.1; // below this a hue reads as gray and stops doing identity work
const BAND: Record<Mode, [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] };
const CVD_TARGET = 8.0; // adjacent pairs must CLEAR the target, not sit in the 6–8 warn band
const NORMAL_FLOOR = 15.0; // worst adjacent pair, unsimulated vision — hard gate
const CONTRAST_MIN = 3.0; // marks vs surface

type Mode = 'light' | 'dark';
const MODES: { mode: Mode; vars: Map<string, string>; surfaces: string[] }[] = [
  { mode: 'light', vars: lightVars, surfaces: ['--surface', '--bg'] },
  { mode: 'dark', vars: darkVars, surfaces: ['--surface', '--bg'] },
];

describe.each(MODES)('categorical palette ($mode)', ({ mode, vars, surfaces }) => {
  const palette = SERIES_VARS.map((name) => ({ name, hex: hexVar(vars, name) }));

  it('defines every series token as a plain hex in this theme', () => {
    expect(palette).toHaveLength(8);
  });

  it(`keeps every hue inside the ${mode} lightness band`, () => {
    const [lo, hi] = BAND[mode];
    for (const { name, hex } of palette) {
      const { L } = oklch(hex);
      expect
        .soft(L, `${name} ${hex} L=${L.toFixed(3)} outside [${lo}, ${hi}]`)
        .toBeGreaterThanOrEqual(lo);
      expect
        .soft(L, `${name} ${hex} L=${L.toFixed(3)} outside [${lo}, ${hi}]`)
        .toBeLessThanOrEqual(hi);
    }
  });

  it('keeps every hue above the chroma floor (no gray-outs)', () => {
    for (const { name, hex } of palette) {
      const { C } = oklch(hex);
      expect
        .soft(C, `${name} ${hex} C=${C.toFixed(3)} reads as gray`)
        .toBeGreaterThanOrEqual(CHROMA_FLOOR);
    }
  });

  it('clears CVD ΔE >= 8 for every ADJACENT series pair (not just the 6–8 warn band)', () => {
    for (let i = 0; i < palette.length - 1; i++) {
      const a = palette[i]!,
        b = palette[i + 1]!;
      const d = cvdDeltaE(a.hex, b.hex);
      expect
        .soft(
          d,
          `${a.name} ↔ ${b.name} (${a.hex} ↔ ${b.hex}) CVD ΔE ${d.toFixed(1)} < ${CVD_TARGET}`,
        )
        .toBeGreaterThanOrEqual(CVD_TARGET);
    }
  });

  it('clears the normal-vision floor for every adjacent pair', () => {
    for (let i = 0; i < palette.length - 1; i++) {
      const a = palette[i]!,
        b = palette[i + 1]!;
      const d = deltaE(a.hex, b.hex);
      expect
        .soft(d, `${a.name} ↔ ${b.name} normal ΔE ${d.toFixed(1)} < ${NORMAL_FLOOR}`)
        .toBeGreaterThanOrEqual(NORMAL_FLOOR);
    }
  });

  it('keeps every series colour >= 3:1 against the card surface and the page background', () => {
    for (const surfaceVar of surfaces) {
      const surface = hexVar(vars, surfaceVar);
      for (const { name, hex } of palette) {
        const c = contrast(hex, surface);
        expect
          .soft(c, `${name} ${hex} is ${c.toFixed(2)}:1 on ${surfaceVar} ${surface}`)
          .toBeGreaterThanOrEqual(CONTRAST_MIN);
      }
    }
  });

  it('keeps status colours apart from vendor and chart series (colour means one thing)', () => {
    // Regression gate: dark --vendor-amd used to sit at ΔE 1.4 from dark --danger.
    // 5.5 is set from the measured minimum of the shipped palette (5.9, light warn↔cpu);
    // anything under it means a status colour is drifting into a series identity.
    const STATUS_MIN = 5.5;
    for (const statusVar of ['--ok', '--warn', '--danger']) {
      const status = hexVar(vars, statusVar);
      for (const { name, hex } of palette) {
        const d = deltaE(status, hex);
        expect
          .soft(
            d,
            `${statusVar} ${status} ↔ ${name} ${hex} normal ΔE ${d.toFixed(1)} < ${STATUS_MIN}`,
          )
          .toBeGreaterThanOrEqual(STATUS_MIN);
      }
    }
  });
});

describe('series assignment', () => {
  it('leads with the validated chart accents and never uses status tokens', () => {
    expect(SERIES_VARS.slice(0, 2)).toEqual(['--chart-1', '--chart-2']);
    for (const name of SERIES_VARS) expect(name).not.toMatch(/^--(ok|warn|danger)/);
  });
});

describe('vendorClass', () => {
  it('maps known vendors, folds generic architectures into cpu, and falls back to other', () => {
    expect(vendorClass('NVIDIA')).toBe('vendor-nvidia');
    expect(vendorClass('apple')).toBe('vendor-apple');
    expect(vendorClass('x86')).toBe('vendor-cpu');
    expect(vendorClass('arm')).toBe('vendor-cpu');
    expect(vendorClass('acme')).toBe('vendor-other');
    expect(vendorClass(null)).toBe('vendor-other');
  });
});

describe('withAlpha', () => {
  it('converts #rrggbb and passes through non-hex values', () => {
    expect(withAlpha('#1b4fd6', 0.5)).toBe('rgba(27, 79, 214, 0.5)');
    expect(withAlpha('var(--x)', 0.5)).toBe('var(--x)');
  });
});
