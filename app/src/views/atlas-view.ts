import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { CoverageLevel, Gap, WorkloadKind } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import type { HeatCellSelect } from '../components/heatmap.js';
import '../components/heatmap.js';
import '../components/cell-drawer.js';
import { icon } from '../components/icons.js';
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
import { fmtInt, fmtPct } from '../util/format.js';
import { headlineMetric } from '../util/metrics.js';
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
    return html`<section class="hero">
      <div>
        <div class="eyebrow">A map of what has been measured</div>
        <h1 class="display mt-3">
          <span class="n">${fmtInt(stats?.cells_covered ?? 0)}</span> of
          <span class="n">${fmtInt(stats?.cells_possible ?? 0)}</span> squares have a number.<br />
          <b>The rest are yours.</b>
        </h1>
        <p class="desc">${site.site.description ?? site.site.tagline}</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="#/gaps">${icon('flag')} Pick a gap to fill</a>
          <a class="btn" href="#/explore">${icon('sparkle')} Explore a configuration</a>
          <a class="btn btn-ghost" href="#/contribute"
            >How contributing works ${icon('arrowRight')}</a
          >
        </div>
      </div>
      ${this.miniMap()}
      <div class="stats-strip" style="grid-column:1/-1">
        ${this.stat(stats?.runs, 'runs')}
        ${this.stat(stats?.cells_covered, 'cells measured', stats ? html`<small>/ ${fmtInt(stats.cells_possible)}</small>` : nothing)}
        ${this.stat(cov * 100, 'covered', html`<small>%</small>`, 1)}
        ${this.stat(stats?.contributors, 'contributors')} ${this.stat(stats?.engines, 'engines')}
        ${this.stat(stats?.models, 'models')} ${this.stat(stats?.hardware, 'devices')}
        <div class="stat">
          <div class="v" style="font-size:var(--fs-lg);padding-top:6px">
            ${stats?.runs && stats.last_updated ? when(stats.last_updated) : html`<span class="faint">–</span>`}
          </div>
          <div class="k">last result</div>
        </div>
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

  /** Every possible cell as a tiny square, measured ones first. The whole map at a glance. */
  private miniMap(): TemplateResult {
    const possible = store.possible;
    const cov = store.coverage.value;
    const levels: CoverageLevel[] = [];
    for (const pc of possible) levels.push(cov[pc.cell_id]?.level ?? 'none');
    const rank: Record<CoverageLevel, number> = {
      disputed: 0,
      reproduced: 1,
      single: 2,
      stale: 3,
      none: 4,
    };
    levels.sort((a, b) => rank[a] - rank[b]);
    const maxSquares = 720;
    const per = Math.max(1, Math.ceil(levels.length / maxSquares));
    const squares: CoverageLevel[] = [];
    for (let i = 0; i < levels.length; i += per) {
      const chunk = levels.slice(i, i + per);
      squares.push(chunk.find((l) => l !== 'none') ?? 'none');
    }
    return html`<div class="col" style="align-items:flex-end;gap:8px;min-width:0">
      <div class="mini-map" title="Every possible cell in the registry. Measured squares first.">
        ${squares.map((l) => html`<i class=${l}></i>`)}
      </div>
      <span class="xs muted right"
        >${fmtInt(possible.length)} possible cells ·
        ${per > 1 ? `each square ≈ ${per} cells` : 'one square per cell'}</span
      >
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
        ['serving', 'sweep', 'prefill', 'longctx', 'eval'].map((k) => ({ value: k, label: k })),
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
          <a href=${href('engines', g.engine_id)}>${g.engine_id}</a>
          <span class="muted">${g.engine_version}</span>
          <span class="faint">·</span>
          <a class="mono" href=${modelHref(g.model_id)}>${g.model_id}</a
          ><span class="muted">/${g.quant_id}</span>
          <span class="faint">·</span>
          <a href=${href('hardware', g.hardware_id)}>${g.hardware_id}</a>
        </div>
        <div class="why">
          ${g.reasons.slice(0, 3).map((r) => html`<span class="tag">${r}</span>`)}
        </div>
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
                      <span>${r.engine.id} <span class="muted">${r.engine.version}</span></span>
                      <span class="faint">·</span
                      ><span>${r.model.id}<span class="muted">/${r.model.quant_id}</span></span>
                      <span class="faint">·</span><span>${r.hardware.id}</span>
                    </div>
                    <div class="xs muted row" style="gap:6px;flex-wrap:wrap">
                      ${kindTag(r.kind)} ${r.workload_id} · ${r.provenance.login} ·
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

    return html`<div class="page">
      ${this.hero()}
      <section class="mt-5">
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
