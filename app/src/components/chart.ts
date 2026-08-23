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
}

export function chartPalette(): ChartPalette {
  return {
    ink: cssVar('--ink'),
    muted: cssVar('--muted'),
    line: cssVar('--line'),
    surface: cssVar('--surface'),
    accent: cssVar('--accent'),
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
    this.plot.setSize({ width: w, height: this.height });
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
    this.plot = new uPlot({ ...opts, width: w, height: this.height }, data, host);
  }

  override render() {
    return html`<div class="chart-box" style="min-height:${this.height}px"></div>`;
  }
}
