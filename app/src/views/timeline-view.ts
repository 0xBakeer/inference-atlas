import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { addButton } from '../components/add-modal.js';
import { resolveSelection, type CellChangeEvent } from '../components/cell-picker.js';
import '../components/cell-picker.js';
import '../components/chart.js';
import { icon } from '../components/icons.js';
import { ordinalLinesBuild } from '../components/sweep-chart.js';
import { emptyState, selectField, skeletonLines } from '../components/ui.js';
import { engineMinors } from '../data/derive.js';
import { qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { seriesColor } from '../util/colors.js';
import { fmtSignedPct } from '@atlas/core';
import { METRIC_BY_KEY, METRICS } from '@atlas/core';
import { ViewElement } from './view-base.js';

const REGRESSION = 0.1;

@customElement('atlas-timeline-view')
export class AtlasTimelineView extends ViewElement {
  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(6)}</div>`;
    const q = this.q;
    // default: the cell with the most distinct engine versions
    const byCell = new Map<
      string,
      { model: string; quant: string; hardware: string; engine: string; versions: Set<string> }
    >();
    for (const r of store.index.value) {
      const k = `${r.engine.id}|${r.model.id}|${r.model.quant_id}|${r.hardware.id}`;
      const e = byCell.get(k) ?? {
        model: r.model.id,
        quant: r.model.quant_id,
        hardware: r.hardware.id,
        engine: r.engine.id,
        versions: new Set(),
      };
      e.versions.add(r.engine.version);
      byCell.set(k, e);
    }
    const richest = [...byCell.values()].sort((a, b) => b.versions.size - a.versions.size)[0];
    const sel = resolveSelection(
      {
        engine: qget(q, 'engine') ?? richest?.engine ?? null,
        model: qget(q, 'model') ?? richest?.model ?? null,
        quant: qget(q, 'quant') ?? richest?.quant ?? null,
        hardware: qget(q, 'hardware') ?? richest?.hardware ?? null,
      },
      { requireAll: true },
    );
    const engine = sel.engine ? store.lookups.engines.get(sel.engine) : null;
    const versions = engine?.versions ?? [];
    const rows = store.index.value.filter(
      (r) =>
        r.engine.id === sel.engine &&
        r.model.id === sel.model &&
        r.model.quant_id === sel.quant &&
        r.hardware.id === sel.hardware,
    );
    const metricKeys = METRICS.filter((m) => rows.some((r) => m.fromRow(r) !== null)).map(
      (m) => m.key,
    );
    const metricKey = metricKeys.includes(qget(q, 'metric') ?? '')
      ? qget(q, 'metric')!
      : (metricKeys[0] ?? store.site.atlas.default_metric);
    const metric = METRIC_BY_KEY[metricKey]!;
    const workloads = [...new Set(rows.map((r) => r.workload_id))];
    const series = workloads.map((w, i) => ({
      label: w,
      color: seriesColor(i),
      values: versions.map((v) => {
        const vals = rows
          .filter((r) => r.workload_id === w && r.engine.version === v)
          .map((r) => metric.fromRow(r))
          .filter((x): x is number => x !== null);
        if (!vals.length) return null;
        // best per version for higher-is-better, lowest for lower-is-better
        return metric.better === 'higher' ? Math.max(...vals) : Math.min(...vals);
      }),
    }));
    // regressions: consecutive measured versions with a >10% move in the bad direction
    const regressions: Array<{ workload: string; from: string; to: string; pct: number }> = [];
    const flagged = new Set<string>();
    for (const s of series) {
      let prev: { v: string; y: number } | null = null;
      s.values.forEach((y, i) => {
        if (y === null) return;
        const v = versions[i]!;
        if (prev) {
          const pct = (y - prev.y) / Math.abs(prev.y || 1);
          const bad = metric.better === 'higher' ? pct <= -REGRESSION : pct >= REGRESSION;
          if (bad) {
            regressions.push({ workload: s.label, from: prev.v, to: v, pct });
            flagged.add(v);
          }
        }
        prev = { v, y };
      });
    }
    const measuredVersions = versions.filter((v) => rows.some((r) => r.engine.version === v));
    const showAll = q.get('all') === '1';
    const chartVersions = showAll ? versions : measuredVersions;
    const chartSeries = series.map((s) => ({
      ...s,
      values: chartVersions.map((v) => s.values[versions.indexOf(v)] ?? null),
    }));
    const bestVersion = (s: (typeof series)[number]): { v: string; y: number } | null => {
      let best: { v: string; y: number } | null = null;
      s.values.forEach((y, i) => {
        if (y === null) return;
        if (best === null || (metric.better === 'higher' ? y > best.y : y < best.y))
          best = { v: versions[i]!, y };
      });
      return best;
    };
    const minorsMissing = engine
      ? engineMinors(engine).filter((m) => !rows.some((r) => r.engine.minor === m.minor))
      : [];

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Timeline</div>
        <h1>Did the engine get faster or slower?</h1>
        <p class="lede">
          The same model, quantization and device measured on different versions of one engine. Each
          line is one test; a drop of more than ${REGRESSION * 100}% between two measured versions
          is flagged as a regression.
        </p>
      </div>
      <div class="card mb-4">
        <atlas-cell-picker
          .value=${sel}
          .fields=${['engine', 'model', 'quant', 'hardware']}
          compact
          @cell-change=${(e: CellChangeEvent) => setQuery({ engine: e.detail.engine, model: e.detail.model, quant: e.detail.quant, hardware: e.detail.hardware })}
        ></atlas-cell-picker>
        <div class="filters mt-2">
          <label class="switch" style="padding-bottom:6px"
            ><input
              type="checkbox"
              .checked=${showAll}
              @change=${(e: Event) => setQuery({ all: (e.target as HTMLInputElement).checked })}
            /><span class="track"></span>Show versions nobody measured</label
          >
          ${selectField(
            'Metric',
            metricKey,
            (metricKeys.length ? metricKeys : METRICS.map((m) => m.key)).map((k) => ({
              value: k,
              label: METRIC_BY_KEY[k]!.label,
            })),
            (v) => setQuery({ metric: v }),
            { allowEmpty: false },
          )}
        </div>
      </div>
      ${
        rows.length === 0
          ? emptyState({
              title: 'Nobody has measured this cell on any version',
              text: 'Pick another combination, or add the first point of this timeline.',
              action: addButton(
                {
                  engine_id: sel.engine,
                  engine_version: sel.version,
                  model_id: sel.model,
                  quant_id: sel.quant,
                  hardware_id: sel.hardware,
                },
                { primary: true },
              ),
            })
          : html`<div class="stats-strip mb-4">
                <div class="stat">
                  <div class="v">${measuredVersions.length}<small>/ ${versions.length}</small></div>
                  <div class="k">versions measured</div>
                </div>
                <div class="stat">
                  <div class="v">${workloads.length}</div>
                  <div class="k">tests tracked</div>
                </div>
                <div class="stat">
                  <div class="v">${rows.length}</div>
                  <div class="k">runs</div>
                </div>
                <div class="stat">
                  <div class="v" style=${regressions.length ? 'color:var(--danger)' : ''}>
                    ${regressions.length}
                  </div>
                  <div class="k">regressions</div>
                </div>
              </div>
              <div class="card hide-legend">
                <atlas-chart
                  .build=${ordinalLinesBuild(chartVersions, chartSeries, `${metric.label}${metric.unit ? ` (${metric.unit})` : ''}`, (v) => metric.fmt(v), flagged)}
                  .height=${300}
                  .key=${`${metricKey}${rows.length}${chartVersions.join()}`}
                  .chartTitle=${`${metric.label} across ${engine?.meta.name ?? sel.engine} versions`}
                  .subtitle=${`${sel.model}/${sel.quant} on ${store.lookups.hardware.get(sel.hardware ?? '')?.name ?? sel.hardware}`}
                ></atlas-chart>
                <div class="tl-legend mt-3">
                  ${series.map((s) => {
                    const b = bestVersion(s);
                    return html`<span class="tl-series" title=${s.label}
                      ><i class="sw" style="background:${s.color}"></i
                      ><span class="ellipsis"
                        >${store.lookups.workloads.get(s.label)?.name ?? s.label}</span
                      >${b ? html`<span class="xs muted">best ${metric.fmt(b.y)} on ${b.v}</span>` : nothing}</span
                    >`;
                  })}
                </div>
              </div>
              ${
                regressions.length
                  ? html`<section class="mt-4">
                      <div class="section-title">
                        <h2>Regressions</h2>
                        <span class="meta"
                          >${metric.better === 'higher' ? 'drops' : 'increases'} larger than
                          ${REGRESSION * 100}% between measured versions</span
                        >
                      </div>
                      <div class="col">
                        ${regressions.map((r) => html`<div class="callout warn"><b class="regress">${fmtSignedPct(r.pct, 0)}</b> ${r.workload} · ${r.from} → ${r.to}</div>`)}
                      </div>
                    </section>`
                  : html`<p class="small muted mt-3">
                      ${measuredVersions.length > 1 ? 'No regressions between measured versions.' : 'Only one version has numbers — add another to see the trend.'}
                    </p>`
              }
              <section class="mt-4">
                <div class="section-title"><h2>Versions</h2></div>
                <div class="table-wrap">
                  <table class="table cards">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Minor</th>
                        ${workloads.map((w) => html`<th class="num" title=${w}>${store.lookups.workloads.get(w)?.name ?? w}</th>`)}
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${versions.map(
                        (v, i) =>
                          html`<tr>
                            <td class="mono primary">
                              ${v}${flagged.has(v) ? html` <span class="tag danger">regression</span>` : nothing}
                            </td>
                            <td class="mono xs muted" data-label="minor">
                              ${engineMinors(engine!).find((m) => m.version === v)?.minor ?? ''}
                            </td>
                            ${series.map((s) => html`<td class="num" data-label=${s.label}>${s.values[i] === null ? html`<span class="null">–</span>` : metric.fmt(s.values[i])}</td>`)}
                            <td class="right" data-label="">
                              ${
                                rows.some((r) => r.engine.version === v)
                                  ? html`<a
                                      class="btn btn-xs"
                                      href=${`#/results?engine=${sel.engine}&version=${v}&model=${encodeURIComponent(sel.model ?? '')}&quant=${sel.quant}&hardware=${sel.hardware}`}
                                      >runs ${icon('arrowRight')}</a
                                    >`
                                  : addButton(
                                      {
                                        engine_id: sel.engine,
                                        engine_version: v,
                                        model_id: sel.model,
                                        quant_id: sel.quant,
                                        hardware_id: sel.hardware,
                                        workload_ids: workloads,
                                      },
                                      { label: 'Add', size: 'xs' },
                                    )
                              }
                            </td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>
                ${minorsMissing.length ? html`<p class="xs muted mt-2">${minorsMissing.length} engine minor${minorsMissing.length === 1 ? '' : 's'} without any measurement in this cell.</p>` : nothing}
              </section>
              <p class="xs muted mt-3">
                Numbers are the best run per version and test; a version without a row for a test
                shows –. Open
                <a
                  href=${`#/results?engine=${sel.engine}&model=${encodeURIComponent(sel.model ?? '')}&quant=${sel.quant}&hardware=${sel.hardware}&kind=all`}
                  >every run of this cell</a
                >.
              </p>`
      }
    </div>`;
  }
}
