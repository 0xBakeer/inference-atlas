import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import type uPlot from 'uplot';
import { axisDefaults, type ChartBuild } from '../components/chart.js';
import '../components/chart.js';
import { icon } from '../components/icons.js';
import { emptyState, selectField, skeletonLines, vendorDot } from '../components/ui.js';
import type { IndexRow } from '../data/types.js';
import { href, navigate, qget, qnum, setQuery } from '../router.js';
import { store } from '../store.js';
import { cssVar, vendorColor, withAlpha } from '../util/colors.js';
import { fmtGB, fmtInt } from '../util/format.js';
import { METRIC_BY_KEY } from '../util/metrics.js';
import { paretoFrontier } from '../util/pareto.js';
import { ViewElement } from './view-base.js';

const X_OPTS = ['ttft_p95', 'ttft_p50', 'tpot_p50', 'vram_peak_gb', 'power_avg_w'];
const Y_OPTS = ['output_tok_s', 'decode_tok_s_per_request', 'tok_per_w', 'accuracy'];

interface Pt {
  row: IndexRow;
  x: number;
  y: number;
  size: number;
  color: string;
}

@customElement('atlas-pareto-view')
export class AtlasParetoView extends ViewElement {
  private points(xKey: string, yKey: string): Pt[] {
    const q = this.q;
    const lk = store.lookups;
    const xm = METRIC_BY_KEY[xKey]!;
    const ym = METRIC_BY_KEY[yKey]!;
    const memMax = qnum(q, 'mem');
    const engine = qget(q, 'engine');
    const sizeMax = qnum(q, 'size');
    const bitsMax = qnum(q, 'bits');
    const out: Pt[] = [];
    for (const r of store.index.value) {
      const hw = lk.hardware.get(r.hardware.id);
      const model = lk.models.get(r.model.id);
      const quant = model?.quants.find((x) => x.id === r.model.quant_id);
      if (engine && r.engine.id !== engine) continue;
      if (memMax !== null && hw?.memory_gb && hw.memory_gb > memMax) continue;
      if (sizeMax !== null && model && model.model.params_b > sizeMax) continue;
      if (bitsMax !== null && quant && quant.bits > bitsMax) continue;
      const x = xm.fromRow(r);
      const y = ym.fromRow(r);
      if (x === null || y === null) continue;
      const vram = r.metrics.vram_peak_gb ?? null;
      out.push({
        row: r,
        x,
        y,
        size: vram ? Math.max(4, Math.min(14, 3 + Math.sqrt(vram))) : 5,
        color: vendorColor(hw?.vendor),
      });
    }
    return out;
  }

  private build(pts: Pt[], xKey: string, yKey: string, frontier: number[]): ChartBuild {
    return (_w, _t, p) => {
      const xm = METRIC_BY_KEY[xKey]!;
      const ym = METRIC_BY_KEY[yKey]!;
      const xs = pts.map((pt) => pt.x);
      const ys = pts.map((pt) => pt.y);
      const accent = cssVar('--accent');
      let hover: number | null = null;
      let tip: HTMLDivElement | null = null;
      const opts: uPlot.Options = {
        width: 600,
        height: 380,
        legend: { show: false },
        cursor: {
          show: true,
          x: false,
          y: false,
          points: { show: false },
          drag: { x: false, y: false },
        },
        scales: {
          x: {
            time: false,
            range: (_u, min, max) => [
              Math.min(0, min - (max - min) * 0.05),
              max + (max - min) * 0.08 || 1,
            ],
          },
          y: {
            range: (_u, min, max) => [
              Math.min(0, min - (max - min) * 0.05),
              max + (max - min) * 0.1 || 1,
            ],
          },
        },
        axes: [
          {
            ...axisDefaults(p, `${xm.label}${xm.unit ? ` (${xm.unit})` : ''}`),
            values: (_u, v) => v.map((x) => xm.fmt(x)),
          },
          {
            ...axisDefaults(p, `${ym.label}${ym.unit ? ` (${ym.unit})` : ''}`),
            values: (_u, v) => v.map((x) => ym.fmt(x)),
          },
        ],
        series: [{}, { label: ym.label, paths: () => null, points: { show: false } }],
        hooks: {
          init: [
            (u) => {
              tip = document.createElement('div');
              tip.className = 'u-tooltip';
              tip.style.display = 'none';
              u.over.appendChild(tip);
              u.over.style.cursor = 'crosshair';
              u.over.addEventListener('click', () => {
                if (hover !== null) navigate(href('run', pts[hover]!.row.run_id));
              });
              u.over.addEventListener('mouseleave', () => {
                hover = null;
                if (tip) tip.style.display = 'none';
                u.redraw(false);
              });
            },
          ],
          setCursor: [
            (u) => {
              const { left, top } = u.cursor;
              if (left == null || top == null || left < 0) return;
              let best: number | null = null;
              let bd = 18;
              pts.forEach((pt, i) => {
                const px = u.valToPos(pt.x, 'x');
                const py = u.valToPos(pt.y, 'y');
                const d = Math.hypot(px - left, py - top);
                if (d < bd) {
                  bd = d;
                  best = i;
                }
              });
              if (best !== hover) {
                hover = best;
                u.redraw(false);
              }
              if (tip) {
                if (hover === null) tip.style.display = 'none';
                else {
                  const pt = pts[hover]!;
                  tip.innerHTML = `<div><b>${pt.row.engine.id} ${pt.row.engine.version}</b> · ${pt.row.model.id}/${pt.row.model.quant_id}</div><div>${pt.row.hardware.id} · ${pt.row.workload_id}</div><div style="margin-top:3px">${xm.short}: ${xm.fmt(pt.x)} ${xm.unit} · ${ym.short}: ${ym.fmt(pt.y)} ${ym.unit}${pt.row.metrics.vram_peak_gb ? ` · VRAM ${fmtGB(pt.row.metrics.vram_peak_gb)} GB` : ''}</div><div style="opacity:.6;margin-top:2px">click to open</div>`;
                  tip.style.display = 'block';
                  const x = u.valToPos(pt.x, 'x');
                  const y = u.valToPos(pt.y, 'y');
                  const w = tip.offsetWidth;
                  tip.style.transform = `translate(${x + 14 + w > u.over.clientWidth ? x - w - 14 : x + 14}px, ${Math.max(0, y - 30)}px)`;
                }
              }
            },
          ],
          draw: [
            (u) => {
              const ctx = u.ctx;
              const dpr = devicePixelRatio || 1;
              ctx.save();
              // frontier
              if (frontier.length > 1) {
                ctx.beginPath();
                ctx.strokeStyle = accent;
                ctx.lineWidth = 1.5 * dpr;
                ctx.setLineDash([4 * dpr, 4 * dpr]);
                frontier.forEach((i, k) => {
                  const x = u.valToPos(pts[i]!.x, 'x', true);
                  const y = u.valToPos(pts[i]!.y, 'y', true);
                  if (k === 0) ctx.moveTo(x, y);
                  else ctx.lineTo(x, y);
                });
                ctx.stroke();
                ctx.setLineDash([]);
              }
              const onFront = new Set(frontier);
              pts.forEach((pt, i) => {
                const x = u.valToPos(pt.x, 'x', true);
                const y = u.valToPos(pt.y, 'y', true);
                const r = pt.size * dpr * (i === hover ? 1.3 : 1);
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fillStyle = withAlpha(pt.color, i === hover ? 0.95 : 0.7);
                ctx.fill();
                ctx.lineWidth = (onFront.has(i) ? 2 : 1) * dpr;
                ctx.strokeStyle = onFront.has(i) ? accent : p.surface;
                ctx.stroke();
              });
              ctx.restore();
            },
          ],
        },
      };
      return { opts, data: [xs, ys] as uPlot.AlignedData };
    };
  }

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(6)}</div>`;
    const q = this.q;
    const xKey = X_OPTS.includes(qget(q, 'x') ?? '') ? qget(q, 'x')! : 'ttft_p95';
    const yKey = Y_OPTS.includes(qget(q, 'y') ?? '') ? qget(q, 'y')! : 'output_tok_s';
    const xm = METRIC_BY_KEY[xKey]!;
    const ym = METRIC_BY_KEY[yKey]!;
    const pts = this.points(xKey, yKey);
    const frontier = paretoFrontier(pts, xm.better, ym.better);
    const hwInPlot = [...new Set(pts.map((p) => p.row.hardware.id))];
    // suggest axis pairs that have data when the current one does not
    const suggestions: Array<[string, string]> = [];
    if (pts.length === 0) {
      for (const x of X_OPTS)
        for (const y of Y_OPTS)
          if (
            store.index.value.some(
              (r) => METRIC_BY_KEY[x]!.fromRow(r) !== null && METRIC_BY_KEY[y]!.fromRow(r) !== null,
            )
          )
            suggestions.push([x, y]);
    }
    const lk = store.lookups;

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Pareto</div>
        <h1>Latency against throughput</h1>
        <p class="lede">
          Every point is a run. The dashed line is the Pareto frontier: nothing measured so far
          beats those runs on both axes at once. Colour is the hardware vendor, size is peak VRAM.
        </p>
      </div>
      <div class="filters mb-3">
        ${selectField(
          'X axis',
          xKey,
          X_OPTS.map((k) => ({ value: k, label: METRIC_BY_KEY[k]!.label })),
          (v) => setQuery({ x: v }),
          { allowEmpty: false },
        )}
        ${selectField(
          'Y axis',
          yKey,
          Y_OPTS.map((k) => ({ value: k, label: METRIC_BY_KEY[k]!.label })),
          (v) => setQuery({ y: v }),
          { allowEmpty: false },
        )}
        ${selectField(
          'Engine',
          qget(q, 'engine'),
          reg.engines.map((e) => ({ value: e.meta.id, label: e.meta.name })),
          (v) => setQuery({ engine: v }),
        )}
        ${selectField(
          'Device memory ≤',
          qget(q, 'mem'),
          [16, 24, 32, 48, 64, 80, 96, 128, 192].map((n) => ({
            value: String(n),
            label: `${n} GB`,
          })),
          (v) => setQuery({ mem: v }),
          { allLabel: 'Any' },
        )}
        ${selectField(
          'Model size ≤',
          qget(q, 'size'),
          [4, 8, 14, 30, 70, 120, 400].map((n) => ({ value: String(n), label: `${n}B` })),
          (v) => setQuery({ size: v }),
          { allLabel: 'Any' },
        )}
        ${selectField(
          'Quant bits ≤',
          qget(q, 'bits'),
          [4, 5, 6, 8, 16].map((n) => ({ value: String(n), label: `${n} bit` })),
          (v) => setQuery({ bits: v }),
          { allLabel: 'Any' },
        )}
      </div>
      ${
        pts.length === 0
          ? emptyState({
              title: `No runs carry both ${xm.label} and ${ym.label} yet`,
              text: suggestions.length
                ? 'Pick an axis pair that has data, or add a measurement that records both.'
                : 'Nobody has measured these metrics yet — the serving workloads record all of them.',
              action: html`<div class="row-wrap" style="justify-content:center">
                ${suggestions.slice(0, 4).map(([x, y]) => html`<button class="btn btn-sm" @click=${() => setQuery({ x, y })}>${METRIC_BY_KEY[x]!.short} × ${METRIC_BY_KEY[y]!.short}</button>`)}
                <a class="btn btn-primary btn-sm" href="#/gaps"
                  >${icon('flag')} Add a serving measurement</a
                >
              </div>`,
            })
          : html`<div class="card">
                <atlas-chart
                  .build=${this.build(pts, xKey, yKey, frontier)}
                  .height=${400}
                  .key=${`${xKey}${yKey}${pts.length}`}
                ></atlas-chart>
                <div class="row-wrap mt-3" style="justify-content:space-between">
                  <div class="legend-inline">
                    ${hwInPlot.map((id) => html`<span>${vendorDot(lk.hardware.get(id)?.vendor)} ${lk.hardware.get(id)?.name ?? id}</span>`)}
                  </div>
                  <span class="xs muted"
                    >${fmtInt(pts.length)} runs · ${frontier.length} on the frontier</span
                  >
                </div>
              </div>
              <section class="mt-5">
                <div class="section-title">
                  <h2>Frontier</h2>
                  <span class="meta">best trade-offs measured so far</span>
                </div>
                <div class="table-wrap">
                  <table class="table cards">
                    <thead>
                      <tr>
                        <th>run</th>
                        <th>hardware</th>
                        <th>workload</th>
                        <th class="num">${xm.short} <span class="unit">${xm.unit}</span></th>
                        <th class="num">${ym.short} <span class="unit">${ym.unit}</span></th>
                        <th class="num">VRAM <span class="unit">GB</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${frontier.map((i) => {
                        const pt = pts[i]!;
                        return html`<tr
                          class="clickable"
                          @click=${() => navigate(href('run', pt.row.run_id))}
                        >
                          <td class="primary mono xs">
                            ${pt.row.engine.id} ${pt.row.engine.version} ·
                            ${pt.row.model.id}/${pt.row.model.quant_id}
                          </td>
                          <td class="mono xs" data-label="hardware">${pt.row.hardware.id}</td>
                          <td class="mono xs" data-label="workload">${pt.row.workload_id}</td>
                          <td class="num" data-label=${xm.short}>${xm.fmt(pt.x)}</td>
                          <td class="num" data-label=${ym.short}>${ym.fmt(pt.y)}</td>
                          <td class="num" data-label="VRAM">
                            ${pt.row.metrics.vram_peak_gb == null ? '–' : fmtGB(pt.row.metrics.vram_peak_gb)}
                          </td>
                        </tr>`;
                      })}
                    </tbody>
                  </table>
                </div>
              </section>`
      }
      ${nothing}
    </div>`;
  }
}
