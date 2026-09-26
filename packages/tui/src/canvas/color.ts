/**
 * ANSI colour without a dependency. Three levels: truecolor when the terminal advertises it,
 * a 256-colour cube approximation otherwise, and mono under NO_COLOR / TERM=dumb — mono is
 * also what the tests render, so every chart has a deterministic plain-text form.
 */

export type ColorLevel = 'truecolor' | '256' | 'mono';

const ESC = '\u001b';

export function detectColorLevel(
  env: Record<string, string | undefined> = process.env,
): ColorLevel {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return 'mono';
  const term = env['TERM'] ?? '';
  if (term === 'dumb' || term === '') return 'mono';
  const colorterm = env['COLORTERM'] ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  if (/kitty|ghostty|iterm|wezterm|alacritty/i.test(env['TERM_PROGRAM'] ?? term))
    return 'truecolor';
  return '256';
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Nearest xterm-256 index: the 6×6×6 cube or the grayscale ramp, whichever is closer. */
export function rgbTo256({ r, g, b }: Rgb): number {
  const cube = [0, 95, 135, 175, 215, 255];
  const level = (v: number) =>
    cube.reduce((best, c, i) => (Math.abs(c - v) < Math.abs(cube[best]! - v) ? i : best), 0);
  const ri = level(r),
    gi = level(g),
    bi = level(b);
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = (cube[ri]! - r) ** 2 + (cube[gi]! - g) ** 2 + (cube[bi]! - b) ** 2;
  const gray = Math.max(0, Math.min(23, Math.round((0.299 * r + 0.587 * g + 0.114 * b - 8) / 10)));
  const gv = 8 + gray * 10;
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return grayDist < cubeDist ? 232 + gray : cubeIdx;
}

export interface PaintStyle {
  fg?: string | null;
  bg?: string | null;
  bold?: boolean;
  dim?: boolean;
}

/** Wrap `text` in the ANSI codes the level supports; mono returns the text untouched. */
export function paint(text: string, style: PaintStyle, level: ColorLevel): string {
  if (level === 'mono' || (!style.fg && !style.bg && !style.bold && !style.dim)) return text;
  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  const push = (hex: string, isBg: boolean) => {
    const rgb = hexToRgb(hex);
    if (level === 'truecolor') codes.push(`${isBg ? 48 : 38};2;${rgb.r};${rgb.g};${rgb.b}`);
    else codes.push(`${isBg ? 48 : 38};5;${rgbTo256(rgb)}`);
  };
  if (style.fg) push(style.fg, false);
  if (style.bg) push(style.bg, true);
  if (codes.length === 0) return text;
  return `${ESC}[${codes.join(';')}m${text}${ESC}[0m`;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  };
}

const toHex = ({ r, g, b }: Rgb): string =>
  `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

/** Sample a multi-stop gradient at t ∈ [0,1]. */
export function ramp(stops: string[], t: number): string {
  if (stops.length === 0) return '#888888';
  if (stops.length === 1) return stops[0]!;
  const u = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  return toHex(mixRgb(hexToRgb(stops[i]!), hexToRgb(stops[i + 1]!), u - i));
}
