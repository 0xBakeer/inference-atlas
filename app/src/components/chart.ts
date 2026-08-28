/**
 * uPlot wrapper. Owns sizing (ResizeObserver), theme re-creation, and a shared tooltip plugin.
 * Callers pass a `build(width, theme)` factory so colours can be resolved from CSS variables at
 * creation time — canvas cannot read custom properties.
 */
import { html, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { theme as themeSignal, type Theme } from '../theme.js';
import { watch } from '../signal.js';
import { cssVar } from '../util/colors.js';
import { AtlasElement } from './base.js';

export type ChartBuild = (
  width: number,
  theme: Theme,
  palette: ChartPalette,
) => { opts: uPlot.Options; data: uPlot.AlignedData };

export interface ChartPalette {
  ink: string;
  muted: string;
  line: string;
  surface: string;
  accent: string;
  /** Cobalt — the primary curve (throughput). */
  chart1: string;
  /** Signal orange — the counterpart curve (latency). Not --warn: status colours stay reserved. */
  chart2: string;
  chart1Soft: string;
  chart2Soft: string;
}

export function chartPalette(): ChartPalette {
  return {
    ink: cssVar('--ink'),
    muted: cssVar('--muted'),
    line: cssVar('--line'),
    surface: cssVar('--surface'),
    accent: cssVar('--accent'),
    chart1: cssVar('--chart-1'),
    chart2: cssVar('--chart-2'),
    chart1Soft: cssVar('--chart-1-soft', 'rgba(27, 79, 214, 0.14)'),
    chart2Soft: cssVar('--chart-2-soft', 'rgba(194, 94, 0, 0.13)'),
  };
}

/**
 * Ribbon fill: a vertical gradient from the series' soft colour at the line down to
 * transparent at the x-axis — the glow that makes a curve read as a lit instrument trace.
 * Recomputed per draw because uPlot's bbox is only known then.
 */
export function ribbonFill(soft: string): uPlot.Series.Fill {
  // Fade to the same colour at alpha 0 — a black-transparent stop would grey the mid-tones.
  const m = /^rgba\((\s*\d+\s*,\s*\d+\s*,\s*\d+\s*),/.exec(soft);
  const clear = m ? `rgba(${m[1]}, 0)` : 'transparent';
  return (u: uPlot) => {
    // The legend swatch asks for the fill before the plot has a bbox — a gradient over
    // non-finite coordinates throws, so the flat soft colour stands in.
    if (!Number.isFinite(u.bbox.top) || !Number.isFinite(u.bbox.height) || u.bbox.height <= 0)
      return soft;
    const grad = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
    grad.addColorStop(0, soft);
    grad.addColorStop(1, clear);
    return grad;
  };
}

/** Shared axis styling: recessive grid, monospace tabular ticks. */
export function axisDefaults(p: ChartPalette, label?: string): uPlot.Axis {
  return {
    stroke: p.muted,
    font: '11px ui-monospace, SF Mono, Menlo, monospace',
    labelFont: '600 11px Archivo, system-ui, sans-serif',
    labelSize: label ? 18 : 0,
    label,
    grid: { stroke: p.line, width: 1 },
    ticks: { stroke: p.line, width: 1, size: 4 },
    gap: 4,
    size: 44,
  };
}

export interface TooltipFormatter {
  (u: uPlot, idx: number): string | null;
}

/** A minimal tooltip plugin: caller formats the HTML string for the hovered index. */
export function tooltipPlugin(format: TooltipFormatter): uPlot.Plugin {
  let el: HTMLDivElement | null = null;
  return {
    hooks: {
      init: (u) => {
        el = document.createElement('div');
        el.className = 'u-tooltip';
        el.style.display = 'none';
        u.over.appendChild(el);
        u.over.addEventListener('mouseleave', () => {
          if (el) el.style.display = 'none';
        });
      },
      setCursor: (u) => {
        if (!el) return;
        const { left, top, idx } = u.cursor;
        if (idx == null || left == null || top == null || left < 0) {
          el.style.display = 'none';
          return;
        }
        const text = format(u, idx);
        if (!text) {
          el.style.display = 'none';
          return;
        }
        el.innerHTML = text;
        el.style.display = 'block';
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const pw = u.over.clientWidth;
        const x = left + 12 + w > pw ? left - w - 12 : left + 12;
        const y = Math.max(0, Math.min(top - h - 8, u.over.clientHeight - h));
        el.style.transform = `translate(${x}px, ${y}px)`;
      },
    },
  };
}

@customElement('atlas-chart')
export class AtlasChart extends AtlasElement {
  @property({ attribute: false }) build: ChartBuild | null = null;
  @property({ type: Number }) height = 260;
  /** Bump to force a rebuild when `build` closes over new data. */
  @property({ attribute: false }) key: unknown = null;

  private plot: uPlot | null = null;
  private ro: ResizeObserver | null = null;
  private lastWidth = 0;

  private effectiveHeight(): number {
    return matchMedia('(max-width: 720px)').matches ? Math.min(this.height, 210) : this.height;
  }

  constructor() {
    super();
    watch(this, themeSignal);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.plot?.destroy();
    this.plot = null;
  }

  protected override updated(_changed: PropertyValues): void {
    this.rebuild();
  }

  private resize(): void {
    const w = this.clientWidth;
    if (!this.plot || w === this.lastWidth || w === 0) {
      if (!this.plot && w > 0) this.rebuild();
      return;
    }
    this.lastWidth = w;
    this.plot.setSize({ width: w, height: this.effectiveHeight() });
  }

  private rebuild(): void {
    const w = this.clientWidth;
    if (!this.build || w === 0) return;
    this.plot?.destroy();
    this.plot = null;
    const host = this.querySelector('.chart-box') as HTMLElement | null;
    if (!host) return;
    host.innerHTML = '';
    const { opts, data } = this.build(w, themeSignal.value, chartPalette());
    this.lastWidth = w;
    this.plot = new uPlot({ ...opts, width: w, height: this.effectiveHeight() }, data, host);
  }

  override render() {
    return html`<div class="chart-box" style="min-height:${this.effectiveHeight()}px"></div>`;
  }
}
