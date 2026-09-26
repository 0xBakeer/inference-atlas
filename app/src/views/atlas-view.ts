import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { CoverageLevel, Gap, WorkloadKind } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import type { HeatCellSelect } from '../components/heatmap.js';
import '../components/chart.js';
import '../components/count-up.js';
import '../components/heatmap.js';
import '../components/cell-drawer.js';
import '../components/living-map.js';
import { icon } from '../components/icons.js';
import { activityBuild, barList, bestPerGroup, histogramBuild } from '../components/stat-charts.js';
import type { IndexRow } from '../data/types.js';
import { vendorClass } from '../util/colors.js';
import { shapeLabel, workloadShape } from '../util/recipe.js';
import {
  avatar,
  emptyState,
  kindTag,
  segmented,
  selectField,
  skeletonBlock,
  skeletonLines,
  vendorDot,
  when,
} from '../components/ui.js';
import {
  AXIS_LABEL,
  buildHeatMatrix,
  heatKey,
  type AxisKey,
  type HeatCell,
  type HeatFilters,
  type HeatMatrix,
} from '../data/derive.js';
import { href, modelHref, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { fmtInt, fmtMs, fmtNum, fmtPct, fmtTokS } from '@atlas/core';
import { METRIC_BY_KEY } from '@atlas/core';
import { headlineMetric } from '@atlas/core';
import { ViewElement } from './view-base.js';

const AXES: AxisKey[] = ['model', 'quant', 'hardware', 'engine', 'engine_minor', 'workload'];

@customElement('atlas-atlas-view')
export class AtlasView extends ViewElement {
  @state() private selected: HeatCell | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void store.loadGaps();
  }

  private get rowKey(): AxisKey {
    const v = qget(this.q, 'rows') as AxisKey | null;
    return v && AXES.includes(v) ? v : (store.site.atlas.default_axes.y as AxisKey) || 'model';
  }
  private get colKey(): AxisKey {
    const v = qget(this.q, 'cols') as AxisKey | null;
    return v && AXES.includes(v) ? v : (store.site.atlas.default_axes.x as AxisKey) || 'hardware';
  }

  private filters(): HeatFilters {
    const q = this.q;
    return {
      engine: qget(q, 'engine'),
      kind: qget(q, 'kind') as WorkloadKind | null,
      vendor: qget(q, 'vendor'),
      model: qget(q, 'model'),
      featuredOnly: q.get('featured') === '1',
    };
  }

  private labelFor(key: AxisKey): (id: string) => string {
    const lk = store.lookups;
    switch (key) {
      case 'model':
        return (id) => lk.models.get(id)?.model.name ?? id;
      case 'hardware':
        return (id) => {
          const h = lk.hardware.get(id);
          if (!h) return id;
          // the vendor is carried by the dot; drop it from the label to save the header height
          const re = new RegExp(`^${h.vendor}\\s+`, 'i');
          return h.name.replace(re, '');
        };
      case 'engine':
        return (id) => lk.engines.get(id)?.meta.name ?? id;
      case 'workload':
        return (id) => id;
      default:
        return (id) => id;
    }
  }

  private sortAxis(
    ids: string[],
    cov: Map<string, { covered: number; possible: number }>,
    sort: string,
    label: (s: string) => string,
  ): string[] {
    const arr = [...ids];
    if (sort === 'name')
      return arr.sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }));
    return arr.sort((a, b) => {
      const ca = cov.get(a) ?? { covered: 0, possible: 1 };
      const cb = cov.get(b) ?? { covered: 0, possible: 1 };
      const d = cb.covered / Math.max(1, cb.possible) - ca.covered / Math.max(1, ca.possible);
      if (d !== 0) return d;
      if (cb.covered !== ca.covered) return cb.covered - ca.covered;
      return label(a).localeCompare(label(b), undefined, { numeric: true });
    });
  }

  private matrix(): HeatMatrix | null {
    const reg = store.registry.value;
    if (!reg) return null;
    return buildHeatMatrix(
      reg,
      store.lookups,
      store.possible,
      store.coverage.value,
      store.index.value,
      this.rowKey,
      this.colKey,
      this.filters(),
      store.site.coverage.key_metrics,
    );
  }

  private onSelect(e: HeatCellSelect): void {
    this.selected = e.detail.cell;
  }

  /* ----------------------------------------------------------- templates */

  private hero(): TemplateResult {
    const stats = store.stats.value;
    const site = store.site;
    const cov = stats ? stats.cells_covered / Math.max(1, stats.cells_possible) : 0;
    const possible = store.possible;
    const covMap = store.coverage.value;
    const levels: CoverageLevel[] = possible.map((pc) => covMap[pc.cell_id]?.level ?? 'none');
    return html`<section class="hero-live">
        <atlas-living-map .levels=${levels} .height=${420}></atlas-living-map>
        <div class="hero-copy">
          <div class="eyebrow">A living map of LLM inference</div>
          <h1 class="display mt-3">
            <span class="n"
              ><atlas-count-up .value=${stats?.cells_covered ?? 0}></atlas-count-up
            ></span>
            of
            <span class="n"
              ><atlas-count-up .value=${stats?.cells_possible ?? 0}></atlas-count-up
            ></span>
            squares have a number.<br />
            <b class="grad">The rest are yours.</b>
          </h1>
          <p class="desc">${site.site.description ?? site.site.tagline}</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="#/gaps">${icon('flag')} Pick a gap to fill</a>
            <a class="btn" href="#/results">${icon('table')} See every result</a>
            <a class="btn btn-ghost" href="#/contribute"
              >How contributing works ${icon('arrowRight')}</a
            >
          </div>
          <div class="hero-legend xs muted">
            <span><i class="ev single"></i>measured</span>
            <span><i class="ev reproduced"></i>reproduced</span>
            <span><i class="ev disputed"></i>disputed</span>
            <span><i class="ev none"></i>nobody yet</span>
            <span><i class="ev flash"></i>a square waiting for you</span>
          </div>
        </div>
        <div class="stats-strip hero-stats">
          ${this.stat(stats?.runs, 'runs')}
          ${this.stat(stats?.cells_covered, 'squares measured', stats ? html`<small>/ ${fmtInt(stats.cells_possible)}</small>` : nothing)}
          ${this.stat(cov * 100, 'of the map', html`<small>%</small>`, 1)}
          ${this.stat(stats?.contributors, 'contributors')} ${this.stat(stats?.engines, 'engines')}
          ${this.stat(stats?.models, 'models')} ${this.stat(stats?.hardware, 'devices')}
          <div class="stat">
            <div class="v" style="font-size:var(--fs-lg);padding-top:6px">
              ${stats?.runs && stats.last_updated ? when(stats.last_updated) : html`<span class="faint">–</span>`}
            </div>
            <div class="k">last result</div>
          </div>
        </div>
      </section>
      ${this.ticker()}`;
  }

  /** The latest results, sliding by — the map is alive and somebody just added to it. */
  private ticker(): TemplateResult | typeof nothing {
    const rows = [...store.index.value]
      .sort((a, b) =>
        (b.provenance.submitted_at ?? b.provenance.started_at ?? '').localeCompare(
          a.provenance.submitted_at ?? a.provenance.started_at ?? '',
        ),
      )
      .slice(0, 14);
    if (rows.length < 4) return nothing;
    const lk = store.lookups;
    const item = (r: IndexRow) => {
      const hl = headlineMetric(r, store.site.coverage.key_metrics);
      return html`<a class="tick" href=${href('run', r.run_id)}>
        ${kindTag(r.kind)}
        <b>${lk.models.get(r.model.id)?.model.name ?? r.model.id}</b>
        <span class="muted">/${r.model.quant_id}</span>
        <span class="faint">·</span>
        <span>${lk.hardware.get(r.hardware.id)?.name ?? r.hardware.id}</span>
        <span class="faint">·</span>
        <span>${lk.engines.get(r.engine.id)?.meta.name ?? r.engine.id}</span>
        ${hl ? html`<span class="val">${hl.def.fmt(hl.value)}<span class="unit">${hl.def.unit}</span></span>` : nothing}
        <span class="muted xs">${r.provenance.login}</span>
      </a>`;
    };
    return html`<div class="ticker" aria-label="Latest results">
      <div class="ticker-track">${rows.map(item)}${rows.map(item)}</div>
    </div>`;
  }

  /** The records: the biggest number of each kind on the whole map, and who set it. */
  private records(): TemplateResult | typeof nothing {
    const rows = store.index.value;
    if (rows.length < 3) return nothing;
    const lk = store.lookups;
    type Rec = { label: string; hint: string; row: IndexRow; text: string; unit: string };
    const pick = (
      label: string,
      hint: string,
      filter: (r: IndexRow) => boolean,
      value: (r: IndexRow) => number | null,
      better: 'higher' | 'lower',
      fmt: (v: number) => string,
      unit: string,
    ): Rec | null => {
      let best: { r: IndexRow; v: number } | null = null;
      for (const r of rows) {
        if (!filter(r)) continue;
        const v = value(r);
        if (v === null) continue;
        if (!best || (better === 'higher' ? v > best.v : v < best.v)) best = { r, v };
      }
      return best ? { label, hint, row: best.r, text: fmt(best.v), unit } : null;
    };
    const ctxOf = (r: IndexRow) => workloadShape(lk.workloads.get(r.workload_id)).input;
    const recs = [
      pick(
        'Highest throughput',
        'total tok/s, all users combined',
        (r) => r.kind === 'serving',
        (r) => r.metrics.output_tok_s ?? null,
        'higher',
        fmtTokS,
        'tok/s',
      ),
      pick(
        'Fastest for one user',
        'tok/s a single request sees',
        (r) => r.kind === 'serving' || r.kind === 'sweep',
        (r) => r.metrics.decode_tok_s_per_request ?? null,
        'higher',
        fmtTokS,
        'tok/s',
      ),
      pick(
        'Quickest first token',
        'median wait before the answer starts',
        (r) => r.kind === 'serving',
        (r) => r.metrics.ttft_p50 ?? null,
        'lower',
        fmtMs,
        'ms',
      ),
      pick(
        'Best eval score',
        'accuracy on a pinned question set',
        (r) => r.kind === 'eval',
        (r) => r.metrics.accuracy ?? null,
        'higher',
        (v) => fmtPct(v, 1),
        '',
      ),
      pick(
        'Longest context served',
        'prompt tokens in one request',
        (r) => r.kind === 'longctx' || r.kind === 'prefill',
        (r) => (ctxOf(r).length ? Math.max(...ctxOf(r)) : null),
        'higher',
        (v) => fmtInt(v),
        'tokens',
      ),
      pick(
        'Most tokens per watt',
        'throughput ÷ average power',
        (r) => r.kind === 'serving',
        (r) => METRIC_BY_KEY.tok_per_w!.fromRow(r),
        'higher',
        (v) => fmtNum(v, 1),
        'tok/W',
      ),
    ].filter((x): x is Rec => !!x);
    if (recs.length < 2) return nothing;
    return html`<section class="mt-6">
      <div class="section-title">
        <h2>Records</h2>
        <span class="meta">the biggest number of each kind on the map right now — beat one</span>
      </div>
      <div class="records">
        ${recs.map(
          (rc) =>
            html`<a class="record" href=${href('run', rc.row.run_id)}>
              <span class="k">${rc.label}</span>
              <span class="v">${rc.text}<span class="unit">${rc.unit}</span></span>
              <span class="hint">${rc.hint}</span>
              <span class="holder">
                <b>${lk.models.get(rc.row.model.id)?.model.name ?? rc.row.model.id}</b>
                <span class="muted">/${rc.row.model.quant_id}</span>
                <span class="faint">·</span>
                ${lk.hardware.get(rc.row.hardware.id)?.name ?? rc.row.hardware.id}
                <span class="faint">·</span>
                ${lk.engines.get(rc.row.engine.id)?.meta.name ?? rc.row.engine.id}
              </span>
              <span class="by xs muted">
                ${avatar(rc.row.provenance.login, { userId: rc.row.provenance.user_id, avatarUrl: rc.row.provenance.avatar_url, size: 'sm' })}
                ${rc.row.provenance.login} ·
                ${when(rc.row.provenance.submitted_at ?? rc.row.provenance.started_at)}
              </span>
            </a>`,
        )}
      </div>
    </section>`;
  }

  /** Four charts that say what the map knows: pace, speed spread, best device, best engine. */
  private pulse(): TemplateResult | typeof nothing {
    const rows = store.index.value;
    if (rows.length < 3) return nothing;
    const lk = store.lookups;
    const activity = activityBuild(
      rows.map((r) => r.provenance.submitted_at ?? r.provenance.started_at),
      { label: 'runs', cumulative: true },
    );
    const perUser = rows
      .map((r) => r.metrics.decode_tok_s_per_request)
      .filter((v): v is number => v != null);
    const hist = histogramBuild(perUser, {
      label: 'tok/s per user',
      fmt: (v) => fmtTokS(v),
      bins: 18,
    });
    const serving = rows.filter((r) => r.kind === 'serving');
    const total = METRIC_BY_KEY.output_tok_s!;
    const byDevice = bestPerGroup(serving, (r) => r.hardware.id, total).slice(0, 8);
    const byEngine = bestPerGroup(serving, (r) => r.engine.id, total).slice(0, 8);
    return html`<section class="mt-6">
      <div class="section-title">
        <h2>The pulse</h2>
        <span class="meta">what ${fmtInt(rows.length)} runs say, at a glance</span>
      </div>
      <div class="pulse-grid">
        ${
          activity
            ? html`<section class="card tight">
                <div class="card-head">
                  <h3>Results landing</h3>
                  <span class="muted small">per period, and the running total</span>
                </div>
                <atlas-chart
                  .build=${activity}
                  .height=${190}
                  .key=${rows.length}
                  .chartTitle=${'Results landing on main'}
                ></atlas-chart>
              </section>`
            : nothing
        }
        ${
          hist
            ? html`<section class="card tight">
                <div class="card-head">
                  <h3>How fast one user is served</h3>
                  <span class="muted small"
                    >${fmtInt(perUser.length)} runs by tok/s per request</span
                  >
                </div>
                <atlas-chart
                  .build=${hist}
                  .height=${190}
                  .key=${perUser.length}
                  .chartTitle=${'Speed per user — distribution'}
                ></atlas-chart>
              </section>`
            : nothing
        }
        ${
          byDevice.length > 1
            ? html`<section class="card tight">
                <div class="card-head">
                  <h3>Fastest device</h3>
                  <span class="muted small">best total tok/s measured on each</span>
                </div>
                ${barList(
                  byDevice.map((b) => ({
                    label: lk.hardware.get(b.id)?.name ?? b.id,
                    title: `${b.id} — ${fmtTokS(b.value)} tok/s (${b.row.model.id}/${b.row.model.quant_id}, ${b.row.engine.id})`,
                    value: b.value,
                    text: fmtTokS(b.value),
                    note: lk.models.get(b.row.model.id)?.model.name ?? b.row.model.id,
                    color: `var(--${vendorClass(lk.hardware.get(b.id)?.vendor)})`,
                    href: href('run', b.row.run_id),
                  })),
                  { ariaLabel: 'Best total throughput per device' },
                )}
              </section>`
            : nothing
        }
        ${
          byEngine.length > 1
            ? html`<section class="card tight">
                <div class="card-head">
                  <h3>Fastest engine</h3>
                  <span class="muted small">best total tok/s measured with each</span>
                </div>
                ${barList(
                  byEngine.map((b) => ({
                    label: lk.engines.get(b.id)?.meta.name ?? b.id,
                    title: `${b.id} — ${fmtTokS(b.value)} tok/s (${b.row.model.id}/${b.row.model.quant_id} on ${b.row.hardware.id})`,
                    value: b.value,
                    text: fmtTokS(b.value),
                    note: `${lk.models.get(b.row.model.id)?.model.name ?? b.row.model.id} · ${shapeLabel(workloadShape(lk.workloads.get(b.row.workload_id)))}`,
                    color: 'var(--chart-2)',
                    href: href('run', b.row.run_id),
                  })),
                  { ariaLabel: 'Best total throughput per engine' },
                )}
              </section>`
            : nothing
        }
      </div>
    </section>`;
  }

  private stat(
    v: number | null | undefined,
    label: string,
    suffix: TemplateResult | typeof nothing = nothing,
    decimals = 0,
  ): TemplateResult {
    const text = v === null || v === undefined ? '–' : decimals ? v.toFixed(decimals) : fmtInt(v);
    return html`<div class="stat">
      <div class="v">${text}${suffix}</div>
      <div class="k">${label}</div>
    </div>`;
  }

  private toolbar(m: HeatMatrix): TemplateResult {
    const reg = store.registry.value!;
    const q = this.q;
    const axisOpts = AXES.map((a) => ({ value: a, label: AXIS_LABEL[a] }));
    const sort = qget(q, 'sort') ?? 'coverage';
    const vendors = [...new Set(reg.hardware.map((h) => h.vendor))].sort();
    const showModel = this.rowKey === 'quant' || this.colKey === 'quant';
    return html`<div class="hm-toolbar">
      <div class="axes">
        ${selectField('Rows', this.rowKey, axisOpts, (v) => setQuery({ rows: v }), { allowEmpty: false, small: true })}
        <span class="x">×</span>
        ${selectField('Columns', this.colKey, axisOpts, (v) => setQuery({ cols: v }), { allowEmpty: false, small: true })}
      </div>
      ${
        showModel
          ? selectField(
              'Model',
              qget(q, 'model'),
              reg.models.map((x) => ({ value: x.model.id, label: x.model.name })),
              (v) => setQuery({ model: v }),
              { allLabel: 'All models', small: true },
            )
          : nothing
      }
      ${selectField(
        'Engine',
        qget(q, 'engine'),
        reg.engines.map((e) => ({ value: e.meta.id, label: e.meta.name })),
        (v) => setQuery({ engine: v }),
        { allLabel: 'All engines', small: true },
      )}
      ${selectField(
        'Workload kind',
        qget(q, 'kind'),
        ['serving', 'sweep', 'prefill', 'longctx', 'eval', 'image'].map((k) => ({
          value: k,
          label: k,
        })),
        (v) => setQuery({ kind: v }),
        { allLabel: 'All kinds', small: true },
      )}
      ${selectField(
        'Vendor',
        qget(q, 'vendor'),
        vendors.map((v) => ({ value: v, label: v })),
        (v) => setQuery({ vendor: v }),
        { allLabel: 'All vendors', small: true },
      )}
      <label class="switch" style="padding-bottom:5px"
        ><input
          type="checkbox"
          .checked=${q.get('featured') === '1'}
          @change=${(e: Event) => setQuery({ featured: (e.target as HTMLInputElement).checked })}
        /><span class="track"></span>Featured only</label
      >
      <div class="field">
        <span class="label">Sort</span>${segmented(
          [
            { value: 'coverage', label: 'Coverage' },
            { value: 'name', label: 'Name' },
          ],
          sort,
          (v) => setQuery({ sort: v === 'coverage' ? null : v }),
          'sm',
        )}
      </div>
      <span class="spacer"></span>
      <span class="small muted" style="padding-bottom:6px"
        >${fmtInt(m.totalCovered)} of ${fmtInt(m.totalPossible)} cells ·
        ${fmtPct(m.totalCovered / Math.max(1, m.totalPossible), 1)}</span
      >
    </div>`;
  }

  private legend(): TemplateResult {
    return html`<div class="hm-legend mt-3">
      <span class="eyebrow plain">Colour is evidence, not speed</span>
      <span class="lg"><i class="ev none"></i>nobody has measured it</span>
      <span class="lg"><i class="ev single"></i>one contributor</span>
      <span class="lg"><i class="ev reproduced"></i>reproduced by two or more</span>
      <span class="lg"><i class="ev disputed"></i>disputed — numbers disagree</span>
      <span class="lg"><i class="ev stale"></i>stale — only on old engine minors</span>
      <span class="lg"><i class="ev part"></i>inner size = share of the square measured</span>
    </div>`;
  }

  private gapsSection(): TemplateResult {
    const gaps = store.gaps.value;
    return html`<section class="card flush">
      <div class="card-head">
        <h3>Most wanted</h3>
        <span class="muted small">top gaps by score</span>
        <span class="spacer"></span>
        <a class="btn btn-ghost btn-sm" href="#/gaps">All gaps ${icon('arrowRight')}</a>
      </div>
      <div style="padding:0 var(--sp-4) var(--sp-2)">
        ${
          gaps === null
            ? skeletonLines(6)
            : gaps.length === 0
              ? html`<p class="small muted" style="padding:12px 0">
                  The wanted queue is empty — the build has not produced <code>gaps.json</code> yet.
                  Every grey square on the map is still a gap.
                </p>`
              : gaps.slice(0, 10).map((g, i) => this.gapRow(g, i + 1))
        }
      </div>
    </section>`;
  }

  private gapRow(g: Gap, rank: number): TemplateResult {
    return html`<div class="gap-row">
      <span class="rank">${rank}</span>
      <div class="what">
        <div class="line">
          <a href=${modelHref(g.model_id)}
            ><b>${store.lookups.models.get(g.model_id)?.model.name ?? g.model_id}</b></a
          ><span class="muted mono xs">/${g.quant_id}</span>
          <span class="faint">·</span>
          <a href=${href('hardware', g.hardware_id)}
            >${store.lookups.hardware.get(g.hardware_id)?.name ?? g.hardware_id}</a
          >
          <span class="faint">·</span>
          <a href=${href('engines', g.engine_id)}
            >${store.lookups.engines.get(g.engine_id)?.meta.name ?? g.engine_id}</a
          >
          <span class="muted xs">${g.engine_version}</span>
        </div>
        <div class="why xs muted">${g.workload_ids.length} tests waiting</div>
      </div>
      <span class="row" style="gap:4px">
        <span class="score" title="wanted score">${g.score.toFixed(0)}</span>
        ${addButton(
          {
            engine_id: g.engine_id,
            engine_version: g.engine_version,
            model_id: g.model_id,
            quant_id: g.quant_id,
            hardware_id: g.hardware_id,
            hw_count: g.hw_count,
            workload_ids: g.workload_ids,
          },
          { label: 'Add', size: 'sm' },
        )}
      </span>
    </div>`;
  }

  private latestSection(): TemplateResult {
    const rows = [...store.index.value]
      .sort((a, b) =>
        (b.provenance.submitted_at ?? b.provenance.started_at ?? '').localeCompare(
          a.provenance.submitted_at ?? a.provenance.started_at ?? '',
        ),
      )
      .slice(0, 10);
    return html`<section class="card flush">
      <div class="card-head">
        <h3>Latest results</h3>
        <span class="spacer"></span>
        <a class="btn btn-ghost btn-sm" href="#/results">All results ${icon('arrowRight')}</a>
      </div>
      <div style="padding:0 var(--sp-4) var(--sp-2)">
        ${
          rows.length === 0
            ? html`<p class="small muted" style="padding:12px 0">
                No results yet — the first measurement on the map lands here.
                <a href="#/gaps">Pick a gap</a> and its packet does the rest.
              </p>`
            : rows.map((r) => {
                const hl = headlineMetric(r, store.site.coverage.key_metrics);
                return html`<a class="latest-row" href=${href('run', r.run_id)}>
                  ${avatar(r.provenance.login, { userId: r.provenance.user_id, avatarUrl: r.provenance.avatar_url })}
                  <div class="what">
                    <div class="line">
                      <span
                        ><b>${store.lookups.models.get(r.model.id)?.model.name ?? r.model.id}</b
                        ><span class="muted">/${r.model.quant_id}</span></span
                      >
                      <span class="faint">·</span
                      ><span
                        >${store.lookups.hardware.get(r.hardware.id)?.name ?? r.hardware.id}</span
                      >
                      <span class="faint">·</span
                      ><span
                        >${store.lookups.engines.get(r.engine.id)?.meta.name ?? r.engine.id}
                        <span class="muted xs">${r.engine.version}</span></span
                      >
                    </div>
                    <div class="xs muted row" style="gap:6px;flex-wrap:wrap">
                      ${kindTag(r.kind)}
                      ${store.lookups.workloads.get(r.workload_id)?.name ?? r.workload_id} ·
                      ${r.provenance.login} ·
                      ${when(r.provenance.submitted_at ?? r.provenance.started_at)}
                    </div>
                  </div>
                  <span class="hl"
                    >${hl ? html`${hl.def.fmt(hl.value)}<span class="unit">${hl.def.unit}</span>` : html`<span class="faint">–</span>`}</span
                  >
                </a>`;
              })
        }
      </div>
    </section>`;
  }

  private featuredSection(): TemplateResult {
    const reg = store.registry.value!;
    const f = reg.site.featured ?? {};
    const cov = store.coverage.value;
    const possible = store.possible;
    const covOf = (
      pred: (c: {
        model_id: string;
        hardware_id: string;
        engine_id: string;
        cell_id: string;
      }) => boolean,
    ) => {
      let p = 0;
      let c = 0;
      for (const pc of possible) {
        if (!pred(pc)) continue;
        p++;
        if (cov[pc.cell_id]) c++;
      }
      return { p, c };
    };
    const hw = (f.hardware ?? []).map((id) => store.lookups.hardware.get(id)).filter(Boolean);
    const models = (f.models ?? []).map((id) => store.lookups.models.get(id)).filter(Boolean);
    return html`<section class="card flush">
      <div class="card-head">
        <h3>Featured</h3>
        <span class="muted small">hardware and models we most want numbers for</span>
      </div>
      <div style="padding:var(--sp-3) var(--sp-4) var(--sp-4)" class="col">
        <div class="eyebrow plain">Hardware</div>
        <div class="featured-grid">
          ${hw.map((h) => {
            const { p, c } = covOf((x) => x.hardware_id === h!.id);
            return html`<a class="feat-card" href=${href('hardware', h!.id)}>
              <span class="name">${vendorDot(h!.vendor)} ${h!.name}</span>
              <span class="sub"
                >${h!.memory_gb ?? '–'} GB · ${h!.memory_bandwidth_gbs ?? '–'} GB/s</span
              >
              <span class="cov"
                ><i class="bar"><i style="width:${(c / Math.max(1, p)) * 100}%"></i></i
                >${c}/${p}</span
              >
            </a>`;
          })}
        </div>
        <div class="eyebrow plain mt-3">Models</div>
        <div class="featured-grid">
          ${models.map((m) => {
            const { p, c } = covOf((x) => x.model_id === m!.model.id);
            return html`<a class="feat-card" href=${modelHref(m!.model.id)}>
              <span class="name">${m!.model.name}</span>
              <span class="sub"
                >${m!.model.params_b}B${m!.model.moe ? ` · ${m!.model.active_params_b}B active` : ''}
                · ${m!.quants.length} quants</span
              >
              <span class="cov"
                ><i class="bar"><i style="width:${(c / Math.max(1, p)) * 100}%"></i></i
                >${c}/${p}</span
              >
            </a>`;
          })}
        </div>
      </div>
    </section>`;
  }

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonBlock(400)}</div>`;
    const m = this.matrix();
    const sort = qget(this.q, 'sort') ?? 'coverage';
    const rowLabel = this.labelFor(this.rowKey);
    const colLabel = this.labelFor(this.colKey);
    const rows = m ? this.sortAxis(m.rows, m.rowCoverage, sort, rowLabel) : [];
    const cols = m ? this.sortAxis(m.cols, m.colCoverage, sort, colLabel) : [];
    const selKey = this.selected ? heatKey(this.selected.row, this.selected.col) : null;
    const colDot =
      this.colKey === 'hardware'
        ? (id: string) => vendorDot(store.lookups.hardware.get(id)?.vendor)
        : null;

    return html`<div class="page home">
      ${this.hero()} ${this.records()} ${this.pulse()}
      <section class="mt-6">
        <div class="section-title">
          <h2>Coverage</h2>
          <span class="meta"
            >${AXIS_LABEL[this.rowKey]} × ${AXIS_LABEL[this.colKey]} — click any square</span
          >
        </div>
        ${m ? this.toolbar(m) : nothing}
        ${
          m && m.rows.length
            ? html`<atlas-heatmap
                .matrix=${m}
                .rows=${rows}
                .cols=${cols}
                .rowLabel=${rowLabel}
                .colLabel=${colLabel}
                .selectedKey=${selKey}
                .colDot=${colDot}
                @cell-select=${this.onSelect}
              ></atlas-heatmap>`
            : emptyState({
                title: 'Nothing matches these filters',
                text: 'Loosen a filter or pick different axes.',
                action: html`<button
                  class="btn"
                  @click=${() => setQuery({ engine: null, kind: null, vendor: null, featured: null, model: null })}
                >
                  Clear filters
                </button>`,
              })
        }
        ${this.legend()}
      </section>

      <section class="split-3 mt-6">
        ${this.gapsSection()} ${this.latestSection()} ${this.featuredSection()}
      </section>

      ${
        this.selected
          ? html`<atlas-cell-drawer
              .cell=${this.selected}
              .rowLabel=${rowLabel}
              .colLabel=${colLabel}
              @close=${() => (this.selected = null)}
            ></atlas-cell-drawer>`
          : nothing
      }
    </div>`;
  }
}
