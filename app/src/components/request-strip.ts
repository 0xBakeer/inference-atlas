/**
 * Every request behind a sweep, as one dot: x = sweep level (ordinal), y = latency on a log
 * scale. The aggregate curve says what the medians did; this strip shows the spread the
 * medians came from — stragglers, bimodality, failures — which is exactly what percentiles
 * hide. SVG rather than uPlot because the x axis is ordinal with jitter and every dot needs
 * its own hit target; colours stay CSS variables so both themes work untouched.
 */
import { html, nothing, svg, type SVGTemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { fmtCompact, fmtInt, fmtMs } from '../util/format.js';
import { quantile, samplesByLevel, type RequestSample } from '../util/requests.js';
import { AtlasElement } from './base.js';

export type StripMetric = 'ttft' | 'e2e';

const MARGIN = { top: 12, right: 10, bottom: 24, left: 48 };

function metricOf(s: RequestSample, metric: StripMetric): number | null {
  const v = metric === 'ttft' ? s.ttft_ms : s.e2e_ms;
  return v !== null && v > 0 ? v : null;
}

/** Log-decade ticks covering [lo, hi]; 2× and 5× steps fill in when a single decade spans it. */
export function logTicks(lo: number, hi: number): number[] {
  if (!(lo > 0) || !(hi >= lo)) return [];
  const ticks: number[] = [];
  const d0 = Math.floor(Math.log10(lo));
  const d1 = Math.ceil(Math.log10(hi));
  const mantissas = d1 - d0 <= 1 ? [1, 2, 5] : [1];
  for (let d = d0; d <= d1; d++)
    for (const m of mantissas) {
      const v = m * 10 ** d;
      if (v >= lo * 0.999 && v <= hi * 1.001) ticks.push(v);
    }
  return ticks;
}

@customElement('atlas-request-strip')
export class AtlasRequestStrip extends AtlasElement {
  @property({ attribute: false }) samples: RequestSample[] = [];
  @property({ type: String }) metric: StripMetric = 'ttft';
  @property({ type: Number }) height = 220;
  @state() private width = 640;

  private ro: ResizeObserver | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        if (this.clientWidth > 0 && this.clientWidth !== this.width) this.width = this.clientWidth;
      });
      this.ro.observe(this);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }

  override render() {
    const groups = [...samplesByLevel(this.samples).entries()]
      .map(([level, list]) => ({
        level,
        list: list.filter((s) => metricOf(s, this.metric) !== null),
      }))
      .filter((g) => g.list.length > 0);
    if (groups.length === 0) return nothing;

    const values = groups.flatMap((g) => g.list.map((s) => metricOf(s, this.metric)!));
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const w = this.width;
    const h = this.height;
    const plotW = Math.max(60, w - MARGIN.left - MARGIN.right);
    const plotH = Math.max(60, h - MARGIN.top - MARGIN.bottom);
    // Log y even when the span is small: sweeps that collapse do so by orders of magnitude.
    const l0 = Math.log10(lo);
    const l1 = Math.log10(hi);
    const span = Math.max(l1 - l0, 0.1);
    const y = (v: number) => MARGIN.top + plotH - ((Math.log10(v) - l0) / span) * plotH;
    const step = plotW / groups.length;
    const xc = (i: number) => MARGIN.left + step * (i + 0.5);
    const jitterW = Math.min(step * 0.55, 46);

    const dots: SVGTemplateResult[] = [];
    const marks: SVGTemplateResult[] = [];
    groups.forEach((g, i) => {
      const vs = g.list.map((s) => metricOf(s, this.metric)!);
      const p50 = quantile(vs, 0.5)!;
      const min = Math.min(...vs);
      const max = Math.max(...vs);
      marks.push(
        svg`<line class="range" x1=${xc(i)} y1=${y(min)} x2=${xc(i)} y2=${y(max)}></line>
          <line class="p50" x1=${xc(i) - 9} y1=${y(p50)} x2=${xc(i) + 9} y2=${y(p50)}></line>`,
      );
      g.list.forEach((s, j) => {
        // Deterministic golden-ratio jitter: stable across renders, no clumping at the guide.
        const off = (((j * 0.618034) % 1) - 0.5) * jitterW;
        const v = metricOf(s, this.metric)!;
        dots.push(
          svg`<circle class=${s.ok ? 'dot' : 'dot failed'} cx=${xc(i) + off} cy=${y(v)} r="3">
              <title>${`${s.id} · ${this.metric === 'ttft' ? 'TTFT' : 'E2E'} ${fmtMs(v)} ms${s.completion_tokens !== null ? ` · ${fmtInt(s.completion_tokens)} tok` : ''}${s.ok ? '' : ' · failed'}`}</title>
            </circle>`,
        );
      });
    });

    const ticks = logTicks(lo, hi);
    const failed = groups.some((g) => g.list.some((s) => !s.ok));
    return html`<svg
        class="request-strip"
        width=${w}
        height=${h}
        viewBox=${`0 0 ${w} ${h}`}
        role="img"
        aria-label=${`${values.length} requests, ${this.metric === 'ttft' ? 'time to first token' : 'end-to-end latency'} by level`}
      >
        ${ticks.map(
          (t) =>
            svg`<g>
              <line class="grid" x1=${MARGIN.left} y1=${y(t)} x2=${w - MARGIN.right} y2=${y(t)}></line>
              <text class="tick" x=${MARGIN.left - 6} y=${y(t) + 3}>${fmtCompact(t)}</text>
            </g>`,
        )}
        ${groups.map(
          (g, i) =>
            svg`<text class="tick level" x=${xc(i)} y=${h - 8}>${fmtCompact(g.level)}</text>`,
        )}
        ${marks} ${dots}
      </svg>
      <div class="row-wrap xs muted request-strip-caption">
        <span>${fmtInt(values.length)} measured requests · warmup excluded · log scale</span>
        ${failed ? html`<span class="strip-key failed">● failed</span>` : nothing}
      </div>`;
  }
}
