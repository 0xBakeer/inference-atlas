/**
 * A braille dot canvas: every terminal cell is a 2×4 dot matrix (U+2800 block), which makes
 * a W×H character area a 2W×4H pixel surface. Series are tracked per cell so colour survives
 * the collapse from dots to characters — the last series to touch a cell wins it.
 */

// Dot bit for (dx ∈ 0..1, dy ∈ 0..3), per the braille pattern encoding.
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export class BrailleGrid {
  readonly cols: number;
  readonly rows: number;
  /** Dot-space dimensions: x ∈ [0, cols*2), y ∈ [0, rows*4). y grows downwards. */
  readonly width: number;
  readonly height: number;
  private readonly bits: Uint8Array;
  private readonly series: Int16Array;
  /** Per-cell character override (e.g. a highlight marker), keyed `${col},${row}`. */
  private readonly overrides = new Map<number, { char: string; series: number }>();

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.width = this.cols * 2;
    this.height = this.rows * 4;
    this.bits = new Uint8Array(this.cols * this.rows);
    this.series = new Int16Array(this.cols * this.rows).fill(-1);
  }

  /** Set one dot in dot-space. Out-of-bounds is ignored, not an error. */
  set(x: number, y: number, seriesIdx = 0): void {
    const dx = Math.round(x);
    const dy = Math.round(y);
    if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) return;
    const cell = Math.floor(dy / 4) * this.cols + Math.floor(dx / 2);
    this.bits[cell] = this.bits[cell]! | DOT_BITS[dy % 4]![dx % 2]!;
    this.series[cell] = seriesIdx;
  }

  /** Bresenham line in dot-space. */
  line(x0: number, y0: number, x1: number, y1: number, seriesIdx = 0): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(ax, ay, seriesIdx);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  /** Replace the character of the cell containing dot (x,y) — used to highlight a point. */
  mark(x: number, y: number, char: string, seriesIdx = 0): void {
    const col = Math.floor(Math.round(x) / 2);
    const row = Math.floor(Math.round(y) / 4);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return;
    this.overrides.set(row * this.cols + col, { char, series: seriesIdx });
  }

  /**
   * Collapse to `rows` strings. `colorOf(seriesIdx)` maps a series to a paint function
   * (already bound to a colour level); untouched cells render as spaces.
   */
  render(colorOf: (seriesIdx: number) => (s: string) => string): string[] {
    const out: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let line = '';
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        const override = this.overrides.get(i);
        if (override) {
          line += colorOf(override.series)(override.char);
          continue;
        }
        const b = this.bits[i]!;
        if (b === 0) {
          line += ' ';
          continue;
        }
        line += colorOf(this.series[i]!)(String.fromCharCode(0x2800 + b));
      }
      out.push(line);
    }
    return out;
  }
}
