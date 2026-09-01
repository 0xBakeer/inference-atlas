import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { renderServeCommand, resolveConditions } from '@atlas/core';
import type { EngineVersion, ResultRecord, SweepAxis, SweepPoint } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import '../components/chart.js';
import '../components/request-strip.js';
import '../components/run-picker.js';
import type { StripMetric } from '../components/request-strip.js';
import { icon } from '../components/icons.js';
import {
  sweepAxisOf,
  sweepChartBuild,
  sweepHasMetric,
  sweepX,
  sweepY,
  type SweepMetric,
  type SweepSeries,
} from '../components/sweep-chart.js';
import {
  codeBlock,
  condMeasured,
  condTag,
  copyBtn,
  deltaTag,
  emptyState,
  engineLink,
  hardwareLink,
  hashChip,
  hbar,
  kindTag,
  kv,
  metricCard,
  modelLink,
  skeletonBlock,
  skeletonLines,
  sparkline,
  verifBadge,
  when,
  who,
  workloadLink,
} from '../components/ui.js';
import type { IndexRow } from '../data/types.js';
import { href, modelHref, navigate } from '../router.js';
import { store } from '../store.js';
import { armDiff, armLabel, cellArms, prefillPoints } from '@atlas/core';
import { cssVar, seriesColor } from '../util/colors.js';
import { absDateTime } from '../util/dates.js';
import { metricDelta } from '@atlas/core';
import { fmtGB, fmtInt, fmtMs, fmtNum, fmtPct, fmtTokS, fmtW, shortSha } from '@atlas/core';
import { blockCards, headlineMetric } from '@atlas/core';
import { requestSamples } from '@atlas/core';
import { fmtDefault, isDefault } from '../components/param-form.js';
import { modelRefFor } from './explore-view.js';
import { ViewElement } from './view-base.js';

@customElement('atlas-run-view')
export class AtlasRunView extends ViewElement {
  @property({ attribute: false }) runId = '';
  @state() private rec: ResultRecord | null | undefined = undefined;
  @state() private vf: EngineVersion | null = null;
  @state() private itemFilter: 'all' | 'correct' | 'incorrect' = 'all';
  @state() private stripMetric: StripMetric = 'ttft';
  @state() private siblings = new Map<string, ResultRecord | null>();
  private loadedFor = '';

  protected override willUpdate(_c: PropertyValues): void {
    if (this.runId && this.runId !== this.loadedFor && store.registry.value) {
      this.loadedFor = this.runId;
      this.rec = undefined;
      this.siblings = new Map();
      const row = store.rowById(this.runId);
      void store.run(row ?? { run_id: this.runId }).then((rec) => {
        if (this.loadedFor !== this.runId) return;
        this.rec = rec;
        if (rec) {
          void store.engineVersion(rec.engine.id, rec.engine.version).then((vf) => (this.vf = vf));
          this.loadSiblings(rec);
        }
      });
    }
  }

  /**
   * The full records of the cell's other runs: they carry the args (to name each arm by what
   * actually differs) and the sweep points (to overlay the curves). Cells are small, so a
   * handful of lazy fetches — the store caches them for the compare view anyway.
   */
  private loadSiblings(rec: ResultRecord): void {
    const runId = this.runId;
    // Big cells can hold dozens of runs; fetch the ones the page actually draws from first:
    // same-workload arms (curve overlay), then this config's prefill family (context curve),
    // then one run per other config (arm naming needs its args).
    const score = (r: IndexRow): number =>
      r.workload_id === rec.workload_id
        ? 0
        : r.kind === 'prefill' && r.config_id === rec.config_id
          ? 1
          : r.config_id !== rec.config_id
            ? 2
            : 3;
    const rows = [...this.siblingRows(rec)].sort((a, b) => score(a) - score(b)).slice(0, 12);
    for (const row of rows) {
      void store.run(row).then((sib) => {
        if (this.loadedFor !== runId) return;
        this.siblings = new Map(this.siblings).set(row.run_id, sib);
      });
    }
  }

  private siblingRows(rec: ResultRecord): IndexRow[] {
    return store.index.value.filter((r) => r.cell_id === rec.cell_id && r.run_id !== rec.run_id);
  }

  private loadedSiblings(): ResultRecord[] {
    return [...this.siblings.values()].filter((r): r is ResultRecord => !!r);
  }

  private repoUrl(): string {
    const s = store.site;
    return `${s.repo.host ?? 'https://github.com'}/${s.repo.owner}/${s.repo.name}`;
  }

  override render() {
    if (!store.registry.value) return html`<div class="page">${skeletonLines(8)}</div>`;
    if (this.rec === undefined)
      return html`<div class="page">${skeletonLines(3)}${skeletonBlock(240)}</div>`;
    const rec = this.rec;
    if (!rec) {
      return html`<div class="page">
        ${emptyState({ title: 'No run with this id', text: `“${this.runId}” is not in the compiled index. It may have been renamed, or the data has not been rebuilt since it was added.`, action: html`<a class="btn" href="#/results">${icon('table')} Browse results</a>` })}
      </div>`;
    }
    const row = store.rowById(rec.run_id);
    const repo = this.repoUrl();
    const prov = rec.provenance;
    const cards = blockCards(rec.metrics);
    const lk = store.lookups;
    const engine = lk.engines.get(rec.engine.id) ?? null;
    const model = lk.models.get(rec.model.id) ?? null;
    const quant = model?.quants.find((q) => q.id === rec.model.quant_id) ?? null;
    const serve =
      rec.serve_command ??
      (engine
        ? renderServeCommand(
            engine.meta,
            modelRefFor(engine.meta, model?.model ?? null, quant),
            rec.args,
          )
        : '');
    const workload = lk.workloads.get(rec.workload_id) ?? null;
    const issueUrl = `${repo}/issues/new?title=${encodeURIComponent(`Problem with run ${rec.run_id}`)}&body=${encodeURIComponent(`Run: ${location.href}\nFile: ${row?.path ?? ''}\n\nWhat looks wrong:\n`)}&labels=data-issue`;
    const reproduceSpec = {
      engine_id: rec.engine.id,
      engine_version: rec.engine.version,
      model_id: rec.model.id,
      quant_id: rec.model.quant_id,
      hardware_id: rec.hardware.id,
      hw_count: rec.hardware.count,
      args: rec.args,
      dtype: rec.model.dtype ?? null,
      workload_ids: [rec.workload_id],
    };

    return html`<div class="page">
      <div class="run-head">
        <div class="row-wrap xs muted">
          <a href="#/results">Results</a> ${icon('chevronRight')}
          <span class="mono">${rec.run_id}</span>
          ${copyBtn(rec.run_id, '', { cls: 'btn-xs btn-ghost', done: 'run_id copied' })}
        </div>
        <div class="title">
          <span
            ><a href=${href('engines', rec.engine.id)}>${engine?.meta.name ?? rec.engine.id}</a>
            <span class="ver">${rec.engine.version}</span></span
          >
          <span class="sep">·</span>
          <span
            ><a href=${modelHref(rec.model.id)}>${model?.model.name ?? rec.model.id}</a
            ><span class="ver">/${rec.model.quant_id}</span></span
          >
          <span class="sep">·</span>
          <span
            ><a href=${href('hardware', rec.hardware.id)}
              >${lk.hardware.get(rec.hardware.id)?.name ?? rec.hardware.id}</a
            >${rec.hardware.count > 1 ? html`<span class="ver"> ×${rec.hardware.count}</span>` : nothing}</span
          >
        </div>
        <div class="meta">
          ${kindTag(rec.kind)} ${workloadLink(rec.workload_id)}
          ${workload ? html`<span class="muted">${workload.name}</span>` : nothing}
          ${verifBadge(rec.verification.level)}
          ${rec.verification.reproduced_by?.length ? html`<span class="xs muted">reproduced by ${rec.verification.reproduced_by.join(', ')}</span>` : nothing}
          <span class="xs muted"
            >cell ${hashChip(rec.cell_id)} config
            ${hashChip(rec.config_id, { href: `#/explore?engine=${rec.engine.id}&version=${rec.engine.version}&model=${rec.model.id}&quant=${rec.model.quant_id}&hardware=${rec.hardware.id}&args=${encodeURIComponent(JSON.stringify(rec.args))}`, title: 'open in the explorer' })}</span
          >
        </div>
        <div class="row-wrap mt-2">
          ${addButton(reproduceSpec, { label: 'Reproduce', primary: true, title: 'Open the packet for this exact configuration and workload' })}
          <a class="btn" href=${`#/compare?runs=${rec.run_id}`}>${icon('compare')} Compare with…</a>
          <a class="btn" href=${issueUrl} target="_blank" rel="noopener"
            >${icon('alert')} Report a problem</a
          >
          ${row?.path ? html`<a class="btn btn-ghost" href=${`${repo}/blob/${store.site.repo.default_branch}/${row.path}`} target="_blank" rel="noopener">${icon('github')} Source file</a>` : nothing}
        </div>
      </div>

      <div class="split main-aside">
        <div class="stack">
          ${
            cards.length
              ? html`<section>
                  <div class="section-title">
                    <h2>Metrics</h2>
                    <span class="meta"
                      >${rec.kind === 'longctx' || rec.kind === 'sweep' ? 'headline; per-point numbers below' : ''}</span
                    >
                  </div>
                  <div class="metric-grid">
                    ${cards.map((c, i) => metricCard(c, { hero: i === 0 }))}
                  </div>
                </section>`
              : rec.kind !== 'eval'
                ? html`<section>
                    <div class="callout">
                      No aggregate metrics were recorded for this
                      run${rec.sweep?.length ? ' — the numbers live in the sweep points below' : ''}.
                    </div>
                  </section>`
                : nothing
          }
          ${rec.sweep?.length ? this.sweep(rec) : nothing}
          ${rec.kind === 'prefill' ? this.prefillCurve(rec) : nothing} ${this.arms(rec)}
          ${rec.scores ? this.scores(rec) : nothing}
          ${rec.failures?.length ? this.failures(rec) : nothing}
          ${rec.gotchas?.length ? this.gotchas(rec) : nothing} ${this.args(rec, serve)}
          ${this.raw(rec)}
        </div>

        <aside class="stack">
          <section class="card">
            <div class="card-head"><h3>Provenance</h3></div>
            <div class="prov-card">
              ${who(prov.github_login, { userId: prov.github_user_id, avatarUrl: row?.provenance.avatar_url, size: 'lg' })}
              <div>
                ${kv([
                  [
                    'commit',
                    prov.commit
                      ? hashChip(prov.commit, { href: `${repo}/commit/${prov.commit}`, short: 7 })
                      : html`<span class="faint">not yet stamped by the build</span>`,
                  ],
                  [
                    'PR',
                    prov.pr
                      ? html`<a href=${`${repo}/pull/${prov.pr}`} target="_blank" rel="noopener"
                          >#${prov.pr}</a
                        >`
                      : html`<span class="faint">–</span>`,
                  ],
                  [
                    'started',
                    html`<span title=${absDateTime(prov.started_at)}
                      >${absDateTime(prov.started_at)}</span
                    >`,
                  ],
                  prov.finished_at ? ['finished', absDateTime(prov.finished_at)] : null,
                  ['submitted', when(prov.submitted_at)],
                  [
                    'method',
                    html`<span class="tag">${prov.method}</span
                      >${prov.agent ? html` <span class="tag">${prov.agent.name}${prov.agent.model ? ` · ${prov.agent.model}` : ''}</span>` : nothing}`,
                  ],
                  [
                    'user id',
                    prov.github_user_id ?? html`<span class="faint">resolved by CI</span>`,
                  ],
                  (() => {
                    const c = resolveConditions(rec);
                    return ['conditions', html`${condTag(c)}${condMeasured(c)}`] as [
                      string,
                      unknown,
                    ];
                  })(),
                ])}
              </div>
            </div>
            ${prov.notes ? html`<p class="small mt-3" style="line-height:1.5">${prov.notes}</p>` : nothing}
          </section>

          <section class="card">
            <div class="card-head"><h3>Environment</h3></div>
            ${kv([
              ['engine', engineLink(rec.engine.id, rec.engine.version)],
              rec.engine.container
                ? ['container', html`<span class="mono xs">${rec.engine.container}</span>`]
                : null,
              rec.engine.install_method ? ['install', rec.engine.install_method] : null,
              rec.engine.commit
                ? ['engine commit', html`<span class="mono xs">${rec.engine.commit}</span>`]
                : null,
              ['model', modelLink(rec.model.id, rec.model.quant_id)],
              rec.model.hf_id
                ? [
                    'weights',
                    html`<a
                      href=${`https://huggingface.co/${rec.model.hf_id}`}
                      target="_blank"
                      rel="noopener"
                      class="mono xs"
                      >${rec.model.hf_id}</a
                    >`,
                  ]
                : null,
              rec.model.revision
                ? ['revision', html`<span class="mono xs">${rec.model.revision}</span>`]
                : null,
              ['dtype', rec.model.dtype ?? 'auto'],
              ['hardware', hardwareLink(rec.hardware.id, rec.hardware.count)],
              rec.hardware.driver ? ['driver', rec.hardware.driver] : null,
              rec.hardware.cuda ? ['CUDA', rec.hardware.cuda] : null,
              rec.hardware.rocm ? ['ROCm', rec.hardware.rocm] : null,
              rec.hardware.host?.cpu ? ['host CPU', rec.hardware.host.cpu] : null,
              rec.hardware.host?.ram_gb ? ['host RAM', `${rec.hardware.host.ram_gb} GB`] : null,
              rec.hardware.host?.os
                ? [
                    'OS',
                    `${rec.hardware.host.os}${rec.hardware.host.arch ? ` (${rec.hardware.host.arch})` : ''}`,
                  ]
                : null,
              rec.workload?.resolved_params
                ? [
                    'workload params',
                    html`<span class="mono xs"
                      >${Object.entries(rec.workload.resolved_params)
                        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                        .join(' ')}</span
                    >`,
                  ]
                : null,
              rec.derived?.tokens_per_watt
                ? ['tok/W', fmtNum(rec.derived.tokens_per_watt, 2)]
                : null,
              rec.derived?.tok_s_per_gb_bandwidth
                ? ['tok/s per GB/s', fmtNum(rec.derived.tok_s_per_gb_bandwidth, 3)]
                : null,
              rec.derived?.bandwidth_efficiency
                ? ['bandwidth efficiency', fmtPct(rec.derived.bandwidth_efficiency)]
                : null,
            ])}
          </section>

          <section class="card">
            <div class="card-head"><h3>Compare with…</h3></div>
            <atlas-run-picker
              .exclude=${[rec.run_id]}
              @pick=${(e: CustomEvent<string>) => navigate(`#/compare?runs=${rec.run_id},${e.detail}`)}
            ></atlas-run-picker>
            <p class="xs muted mt-2">
              Runs in the same cell make the most useful comparisons: same model, quant, hardware
              and engine minor.
            </p>
          </section>
        </aside>
      </div>
    </div>`;
  }

  /**
   * The sweep as an operating map: throughput and latency vertically paired over one synced
   * x axis (never a dual-axis chart), so the point where aggregate tok/s keeps climbing while
   * TTFT collapses is visible without reading a single number. Arms of the same cell that ran
   * the same sweep are overlaid, named by the flags that differ.
   */
  private sweep(rec: ResultRecord): TemplateResult {
    const pts = rec.sweep!;
    const axis = sweepAxisOf(pts);
    const series = this.sweepSeriesFor(rec);
    const throughput = sweepHasMetric(pts, 'throughput');
    const latency: SweepMetric | null = sweepHasMetric(pts, 'ttft')
      ? 'ttft'
      : sweepHasMetric(pts, 'tpot')
        ? 'tpot'
        : null;
    const sync = `sweep-${rec.run_id}`;
    const samples = requestSamples(rec);
    const stripMetrics: StripMetric[] = (['ttft', 'e2e'] as StripMetric[]).filter((m) =>
      samples.some((s) => !s.warmup && (m === 'ttft' ? s.ttft_ms : s.e2e_ms) !== null),
    );
    const stripMetric = stripMetrics.includes(this.stripMetric)
      ? this.stripMetric
      : (stripMetrics[0] ?? 'ttft');
    const throttled = pts.some((p) => p.metrics.thermal_throttle_detected);
    return html`<section>
      <div class="section-title">
        <h2>
          ${axis === 'concurrency' ? 'Parallelism sweep' : axis === 'input_tokens' ? 'Depth sweep' : 'Sweep'}
        </h2>
        <span class="meta"
          >${pts.length}
          points${series.length > 1 ? ` · ${series.length - 1} other arm${series.length === 2 ? '' : 's'} of this cell overlaid` : ''}</span
        >
        ${throttled ? html`<span class="tag danger">thermal throttle</span>` : nothing}
      </div>
      <div class="card chart-pair">
        ${
          throughput
            ? html`<div class="eyebrow plain">Aggregate throughput</div>
                <atlas-chart
                  .build=${sweepChartBuild(series, 'throughput', axis, { sync })}
                  .height=${240}
                  .key=${`t${series.length}`}
                ></atlas-chart>`
            : nothing
        }
        ${
          latency
            ? html`<div class="eyebrow plain pair-lower">
                  ${latency === 'ttft' ? 'Time to first token' : 'Time per output token'}
                  <span class="muted">— p50${series.length === 1 ? ', p95 band' : ''}</span>
                </div>
                <atlas-chart
                  .build=${sweepChartBuild(series, latency, axis, { sync })}
                  .height=${190}
                  .key=${`l${series.length}`}
                ></atlas-chart>`
            : nothing
        }
      </div>
      ${
        samples.length && stripMetrics.length
          ? html`<div class="card mt-3">
              <div class="row mb-2">
                <div class="eyebrow plain">Every request</div>
                <span class="spacer"></span>
                <div class="seg sm">
                  ${stripMetrics.map(
                    (m) =>
                      html`<button
                        aria-pressed=${m === stripMetric}
                        @click=${() => (this.stripMetric = m)}
                      >
                        ${m === 'ttft' ? 'TTFT' : 'E2E'}
                      </button>`,
                  )}
                </div>
              </div>
              <atlas-request-strip
                .samples=${samples}
                .metric=${stripMetric}
                .height=${230}
              ></atlas-request-strip>
            </div>`
          : nothing
      }
      ${this.telemetry(pts, axis)}
      <div class="table-wrap mt-3">
        <table class="table cards">
          <thead>
            <tr>
              <th>${axis.replace('_', ' ')}</th>
              <th class="num">decode / output tok/s</th>
              <th class="num">TTFT p50</th>
              <th class="num">TPOT p50</th>
              <th class="num">success</th>
              <th class="num">VRAM</th>
              <th>label</th>
            </tr>
          </thead>
          <tbody>
            ${pts.map(
              (p) =>
                html`<tr>
                  <td class="num primary" data-label=${axis}>${fmtInt(sweepX(p, axis))}</td>
                  <td class="num" data-label="tok/s">
                    ${sweepY(p, 'throughput') === null ? html`<span class="null">–</span>` : fmtTokS(sweepY(p, 'throughput'))}
                  </td>
                  <td class="num" data-label="TTFT">
                    ${sweepY(p, 'ttft') === null ? html`<span class="null">–</span>` : fmtMs(sweepY(p, 'ttft'))}
                  </td>
                  <td class="num" data-label="TPOT">
                    ${sweepY(p, 'tpot') === null ? html`<span class="null">–</span>` : fmtMs(sweepY(p, 'tpot'))}
                  </td>
                  <td class="num" data-label="success">
                    ${p.metrics.success_rate == null ? html`<span class="null">–</span>` : fmtPct(p.metrics.success_rate, 0)}
                  </td>
                  <td class="num" data-label="VRAM">
                    ${p.metrics.vram_peak_gb == null ? html`<span class="null">–</span>` : `${fmtNum(p.metrics.vram_peak_gb, 1)} GB`}
                  </td>
                  <td data-label="label" class="muted xs">${p.label ?? ''}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  /** This run plus every loaded arm that ran the same sweep, labelled by what differs. */
  private sweepSeriesFor(rec: ResultRecord): SweepSeries[] {
    const series: SweepSeries[] = [
      { label: 'this run', color: cssVar('--chart-1'), points: rec.sweep! },
    ];
    for (const sib of this.loadedSiblings()) {
      if (!sib.sweep?.length || sib.workload_id !== rec.workload_id) continue;
      series.push({
        label: armLabel(rec.args, sib.args, `by ${sib.provenance.github_login}`),
        color: seriesColor(series.length),
        points: sib.sweep,
      });
    }
    return series;
  }

  /**
   * What the machine did while the sweep ran. Small multiples, one per sensor — never a
   * second y axis on the main chart. VRAM is null by nature on unified-memory parts, so RAM
   * stands in when that is what was measured.
   */
  private telemetry(pts: SweepPoint[], axis: SweepAxis): TemplateResult | typeof nothing {
    const ordered = [...pts].sort((a, b) => (sweepX(a, axis) ?? 0) - (sweepX(b, axis) ?? 0));
    const tiles = [
      {
        label: 'GPU util',
        unit: '%',
        fmt: (v: number) => fmtNum(v, 0),
        vals: ordered.map((p) => p.metrics.gpu_util_avg_pct ?? null),
      },
      {
        label: 'Avg power',
        unit: 'W',
        fmt: fmtW,
        vals: ordered.map((p) => p.metrics.power_avg_w ?? null),
      },
      ordered.some((p) => p.metrics.vram_peak_gb != null)
        ? {
            label: 'Peak VRAM',
            unit: 'GB',
            fmt: fmtGB,
            vals: ordered.map((p) => p.metrics.vram_peak_gb ?? null),
          }
        : {
            label: 'Peak RAM',
            unit: 'GB',
            fmt: fmtGB,
            vals: ordered.map((p) => p.metrics.ram_peak_gb ?? null),
          },
      {
        label: 'Max temp',
        unit: '°C',
        fmt: (v: number) => fmtNum(v, 0),
        vals: ordered.map((p) => p.metrics.temp_max_c ?? null),
      },
    ].filter((t) => t.vals.some((v) => v != null));
    if (tiles.length === 0) return nothing;
    return html`<div class="telemetry-grid mt-3">
      ${tiles.map((t) => {
        const nums = t.vals.filter((v): v is number => v != null);
        const last = nums[nums.length - 1]!;
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        return html`<div class="telemetry-tile" title=${`${t.label} across the sweep levels`}>
          <span class="k">${t.label}</span>
          <span class="v">${t.fmt(last)}<span class="unit">${t.unit}</span></span>
          ${sparkline(t.vals, { width: 96, height: 26 })}
          <span class="range">${min === max ? 'flat' : `${t.fmt(min)}–${t.fmt(max)}`}</span>
        </div>`;
      })}
    </div>`;
  }

  /**
   * Prefill flatness: the same configuration run at every registered context length. The x
   * values come from the workloads' resolved `input_tokens`, so a new prefill workload in the
   * registry extends this chart with no code change.
   */
  private prefillCurve(rec: ResultRecord): TemplateResult | typeof nothing {
    const family = [rec, ...this.loadedSiblings()].filter((r) => r.config_id === rec.config_id);
    const points = prefillPoints(family);
    if (points.length < 2) return nothing;
    const series: SweepSeries[] = [{ label: 'prefill tok/s', color: cssVar('--chart-1'), points }];
    return html`<section>
      <div class="section-title">
        <h2>Prefill across context length</h2>
        <span class="meta">${points.length} lengths, same configuration — flat is the ideal</span>
      </div>
      <div class="card">
        <atlas-chart
          .build=${sweepChartBuild(series, 'prefill', 'input_tokens', { logX: true })}
          .height=${220}
          .key=${points.length}
        ></atlas-chart>
      </div>
    </section>`;
  }

  /**
   * The cell's other arms: same model × quant × hardware × engine-minor, measured under a
   * different flag set (or reproduced by somebody else). This is the comparison the atlas
   * exists for, so it is one click, not a search.
   */
  private arms(rec: ResultRecord): TemplateResult | typeof nothing {
    const rows = this.siblingRows(rec);
    if (rows.length === 0) return nothing;
    const groups = cellArms(store.index.value, rec).filter(
      (g) => !(g.configId === rec.config_id && g.rows.every((r) => r.run_id === rec.run_id)),
    );
    const currentRow = store.rowById(rec.run_id);
    return html`<section>
      <div class="section-title">
        <h2>Same cell, other runs</h2>
        <span class="meta">${rows.length} in this model × hardware × engine-minor square</span>
      </div>
      <div class="arm-list">
        ${groups.map((g) => {
          const sibRec = g.rows
            .map((r) => this.siblings.get(r.run_id))
            .find((r): r is ResultRecord => !!r);
          const sameConfig = g.configId === rec.config_id;
          const chips = sameConfig ? [] : sibRec ? armDiff(rec.args, sibRec.args) : null;
          // The same workload is the apples-to-apples comparison — surface it first, cap the
          // rest: a fully-swept cell holds dozens of runs and this is a summary, not a table.
          const all = g.rows
            .filter((r) => r.run_id !== rec.run_id)
            .sort(
              (a, b) =>
                Number(b.workload_id === rec.workload_id) -
                Number(a.workload_id === rec.workload_id),
            );
          const runs = all.slice(0, 6);
          if (runs.length === 0) return nothing;
          return html`<div class="arm-group">
            <div class="arm-head">
              ${
                sameConfig
                  ? html`<span class="tag">same config</span>
                      <span class="xs muted"
                        >this exact fingerprint — repeats and other workloads</span
                      >`
                  : html`<span class="tag accent">different config</span> ${
                        chips === null
                          ? html`<span class="xs muted">config ${hashChip(g.configId)}</span>`
                          : chips.length
                            ? chips
                                .slice(0, 4)
                                .map((c) => html`<span class="chip mono">${c}</span>`)
                            : html`<span class="xs muted">differs only in canonical form</span>`
                      }
                      ${chips && chips.length > 4 ? html`<span class="xs muted">+${chips.length - 4} more</span>` : nothing}`
              }
            </div>
            ${runs.map((r) => {
              const hl = headlineMetric(r, store.site.coverage.key_metrics);
              const comparable = currentRow && r.workload_id === rec.workload_id && hl;
              const base = comparable ? hl.def.fromRow(currentRow) : null;
              const delta =
                comparable && base !== null ? metricDelta(base, hl.value, hl.def.better) : null;
              return html`<a class="arm-run" href=${href('run', r.run_id)}>
                <span class="row" style="gap:6px;min-width:0">
                  ${kindTag(r.kind)}
                  <span class="mono xs ellipsis">${r.workload_id}</span>
                </span>
                <span class="hl">
                  ${hl ? html`${hl.def.fmt(hl.value)}<span class="unit">${hl.def.unit}</span> <span class="xs muted">${hl.def.short}</span>` : html`<span class="faint">–</span>`}
                  ${delta ? deltaTag(delta) : nothing}
                </span>
                <span class="meta xs muted">
                  ${r.provenance.login} ·
                  ${when(r.provenance.submitted_at ?? r.provenance.started_at)}
                </span>
                <span
                  class="btn btn-xs"
                  @click=${(e: Event) => {
                    e.preventDefault();
                    e.stopPropagation();
                    navigate(`#/compare?runs=${rec.run_id},${r.run_id}`);
                  }}
                  >${icon('compare')} Compare</span
                >
              </a>`;
            })}
            ${
              all.length > runs.length
                ? html`<span class="xs muted"
                    >+${all.length - runs.length} more runs of this configuration</span
                  >`
                : nothing
            }
          </div>`;
        })}
      </div>
    </section>`;
  }

  private scores(rec: ResultRecord): TemplateResult {
    const s = rec.scores!;
    const items = s.items ?? [];
    const shown = items
      .filter((it) => this.itemFilter === 'all' || (this.itemFilter === 'correct') === it.correct)
      .slice(0, 200);
    const cats = Object.entries(s.by_category ?? {});
    const diffs = Object.entries(s.by_difficulty ?? {});
    return html`<section>
      <div class="section-title">
        <h2>Eval scores</h2>
        <span class="meta">suite ${s.suite}</span>
      </div>
      <div class="metric-grid">
        <div class="metric hero">
          <span class="k">Accuracy</span><span class="v">${fmtPct(s.accuracy)}</span
          ><span class="sub">${s.correct} / ${s.total} correct</span>
        </div>
        ${
          s.avg_latency_ms != null
            ? html`<div class="metric">
                <span class="k">Avg latency</span
                ><span class="v">${fmtMs(s.avg_latency_ms)}<span class="unit">ms</span></span>
              </div>`
            : nothing
        }
        ${
          s.avg_output_tokens != null
            ? html`<div class="metric">
                <span class="k">Avg output</span
                ><span class="v">${fmtInt(s.avg_output_tokens)}<span class="unit">tok</span></span>
              </div>`
            : nothing
        }
        ${s.failures != null ? html`<div class="metric"><span class="k">Failures</span><span class="v">${s.failures}</span></div>` : nothing}
      </div>
      ${
        cats.length || diffs.length
          ? html`<div class="split mt-3">
              ${
                cats.length
                  ? html`<div class="card tight">
                      <div class="eyebrow plain mb-2">By category</div>
                      ${cats.map(([k, v]) => hbar(k, v.total ? v.correct / v.total : 0, `${v.correct}/${v.total}`))}
                    </div>`
                  : nothing
              }
              ${
                diffs.length
                  ? html`<div class="card tight">
                      <div class="eyebrow plain mb-2">By difficulty</div>
                      ${diffs.map(([k, v]) => hbar(k, v.total ? v.correct / v.total : 0, `${v.correct}/${v.total}`))}
                    </div>`
                  : nothing
              }
            </div>`
          : nothing
      }
      ${
        items.length
          ? html`<div class="row mt-3 mb-2">
                <span class="small muted">${items.length} items</span>
                <span class="spacer"></span>
                <div class="seg sm">
                  ${(['all', 'correct', 'incorrect'] as const).map((f) => html`<button aria-pressed=${this.itemFilter === f} @click=${() => (this.itemFilter = f)}>${f}</button>`)}
                </div>
              </div>
              <div class="table-wrap" style="max-height:480px">
                <table class="table eval-item-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>id</th>
                      <th>category</th>
                      <th>difficulty</th>
                      <th>predicted</th>
                      <th>expected</th>
                      <th class="num">latency</th>
                      <th class="num">tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${shown.map(
                      (it) =>
                        html`<tr>
                          <td><i class="ok-dot ${it.correct ? '' : 'bad'}"></i></td>
                          <td class="mono xs">${it.id}</td>
                          <td class="xs">${it.category ?? ''}</td>
                          <td class="xs">${it.difficulty ?? ''}</td>
                          <td class="pred" title=${it.predicted ?? ''}>${it.predicted ?? ''}</td>
                          <td class="exp" title=${it.expected ?? ''}>${it.expected ?? ''}</td>
                          <td class="num">${it.latency_ms == null ? '–' : fmtMs(it.latency_ms)}</td>
                          <td class="num">${it.output_tokens ?? '–'}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
              ${shown.length < items.filter((it) => this.itemFilter === 'all' || (this.itemFilter === 'correct') === it.correct).length ? html`<p class="xs muted mt-1">Showing the first 200 — the raw payload has everything.</p>` : nothing}`
          : nothing
      }
    </section>`;
  }

  private failures(rec: ResultRecord): TemplateResult {
    return html`<section>
      <div class="section-title">
        <h2>Failures</h2>
        <span class="meta">${rec.failures!.length} recorded — a failure is a valid result</span>
      </div>
      <div class="col">
        ${rec.failures!.map(
          (f) =>
            html`<div class="failure">
              <span class="tag danger">${f.category}</span>
              <span class="xs muted nowrap">at ${f.at} · ×${f.count}</span>
              <span class="msg"
                >${f.message ?? ''}${f.sample_request_id ? html` <span class="muted">(${f.sample_request_id})</span>` : nothing}</span
              >
            </div>`,
        )}
      </div>
    </section>`;
  }

  private gotchas(rec: ResultRecord): TemplateResult {
    const ic = { info: 'info', warn: 'warn', blocker: 'alert' } as const;
    return html`<section>
      <div class="section-title">
        <h2>Gotchas</h2>
        <span class="meta">what you had to know to make this run work</span>
      </div>
      <div class="col">
        ${rec.gotchas!.map(
          (g) =>
            html`<div class="gotcha ${g.severity}">
              <span
                class="sev"
                style=${g.severity === 'blocker' ? 'color:var(--danger)' : g.severity === 'warn' ? 'color:var(--warn)' : 'color:var(--link)'}
                title=${g.severity}
                >${icon(ic[g.severity])}</span
              >
              <span
                >${g.text}${g.link ? html` <a href=${g.link} target="_blank" rel="noopener">${icon('external')}</a>` : nothing}</span
              >
            </div>`,
        )}
      </div>
    </section>`;
  }

  private args(rec: ResultRecord, serve: string): TemplateResult {
    const params = this.vf?.params ?? [];
    const byName = new Map(params.map((p) => [p.name, p]));
    const entries = Object.entries(rec.args);
    return html`<section>
      <div class="section-title">
        <h2>Arguments</h2>
        <span class="meta">${entries.length} passed · canonical fingerprint below</span>
      </div>
      ${
        entries.length
          ? html`<div class="table-wrap">
              <table class="table args-table cards">
                <thead>
                  <tr>
                    <th>flag</th>
                    <th>value</th>
                    <th>default in ${rec.engine.version}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${entries.map(([k, v]) => {
                    const p = byName.get(k);
                    const def = p ? isDefault(p, v) : false;
                    return html`<tr class=${def ? '' : 'non-default'}>
                      <td class="name mono xs primary" data-label="flag">${k}</td>
                      <td class="mono xs" data-label="value">
                        ${typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </td>
                      <td class="mono xs muted" data-label="default">
                        ${p ? fmtDefault(p) : html`<span class="faint">unknown flag</span>`}
                      </td>
                      <td class="default-marker" data-label="">
                        ${p ? (def ? 'equals default — dropped from fingerprint' : html`<span class="tag accent">non-default</span>`) : ''}
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>`
          : html`<p class="small muted">No flags beyond the defaults.</p>`
      }
      <div class="mt-3">
        <div class="eyebrow plain mb-2">Canonical</div>
        ${codeBlock(rec.args_canonical, { lang: 'text' })}
      </div>
      ${
        serve
          ? html`<div class="mt-3">
              <div class="eyebrow plain mb-2">
                Serve
                command${rec.serve_command ? '' : ' (rendered from args — the exact command line was not recorded)'}
              </div>
              ${codeBlock(serve, { lang: 'bash' })}
            </div>`
          : nothing
      }
    </section>`;
  }

  private raw(rec: ResultRecord): TemplateResult {
    const json = JSON.stringify(rec, null, 2);
    return html`<section>
      <details class="json-view">
        <summary>
          ${icon('chevronRight')} Raw record
          <span class="muted xs"
            >${rec.raw?.harness ? `${rec.raw.harness} ${rec.raw.harness_version ?? ''}` : ''}
            ${rec.raw?.truncated ? '· payload truncated' : ''}
            ${rec.raw?.sha256 ? `· sha256 ${shortSha(rec.raw.sha256)}` : ''}</span
          >
        </summary>
        ${codeBlock(json, { lang: 'json', maxHeight: 520 })}
      </details>
    </section>`;
  }
}
