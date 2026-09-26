import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '@lit-labs/virtualizer';
import '../components/chart.js';
import { icon } from '../components/icons.js';
import { activityBuild, barList, histogramBuild } from '../components/stat-charts.js';
import {
  avatar,
  emptyState,
  kindTag,
  selectField,
  sortIcon,
  verifBadge,
  when,
} from '../components/ui.js';
import type { IndexRow } from '../data/types.js';
import { href, navigate, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { copyText, download } from '../util/clipboard.js';
import { toCsv } from '../util/csv.js';
import {
  inDateRange,
  matchesQuery,
  parseSort,
  serializeSort,
  sortRows,
  toggleSort,
  uniqueSorted,
  type SortSpec,
} from '../util/filters.js';
import { fmtInt } from '@atlas/core';
import { shapeLabel, workloadShape } from '../util/recipe.js';
import { METRICS, type MetricDef } from '@atlas/core';
import { ViewElement } from './view-base.js';

interface Col {
  key: string;
  label: string;
  width: number;
  num?: boolean;
  metric?: MetricDef;
  value: (r: IndexRow) => string | number | null | undefined;
  render?: (r: IndexRow) => TemplateResult;
  primary?: boolean;
}

/** Column headers in plain words; the full metric name stays in the tooltip. */
const FRIENDLY: Record<string, string> = {
  decode_tok_s_per_request: 'Per user',
  output_tok_s: 'Total',
  ttft_p50: 'First token',
  ttft_p95: 'First token p95',
  tpot_p50: 'Per token',
  success_rate: 'Success',
};

const COLS: Col[] = [
  {
    key: 'engine',
    label: 'Engine',
    width: 150,
    value: (r) => `${r.engine.id} ${r.engine.version}`,
    render: (r) =>
      html`<span class="xs"
        >${store.lookups.engines.get(r.engine.id)?.meta.name ?? r.engine.id}
        <span class="mono muted" title=${r.engine.version}>${r.engine.version}</span></span
      >`,
  },
  {
    key: 'model',
    label: 'Model / quant',
    width: 230,
    value: (r) => `${r.model.id}/${r.model.quant_id}`,
    render: (r) =>
      html`<span class="mono xs" title=${`${r.model.id}/${r.model.quant_id}`}
        >${r.model.id}<span class="muted">/${r.model.quant_id}</span></span
      >`,
    primary: true,
  },
  {
    key: 'hardware',
    label: 'Hardware',
    width: 180,
    value: (r) => r.hardware.id,
    render: (r) =>
      html`<span class="xs" title=${r.hardware.id}
        >${store.lookups.hardware.get(r.hardware.id)?.name ?? r.hardware.id}${r.hardware.count > 1 ? ` ×${r.hardware.count}` : ''}</span
      >`,
  },
  {
    key: 'workload',
    label: 'Workload',
    width: 200,
    value: (r) => r.workload_id,
    render: (r) => html`<span class="mono xs">${r.workload_id}</span>`,
  },
  { key: 'kind', label: 'Kind', width: 80, value: (r) => r.kind, render: (r) => kindTag(r.kind) },
  {
    key: 'setup',
    label: 'Setup',
    width: 220,
    value: (r) => shapeLabel(workloadShape(store.lookups.workloads.get(r.workload_id))),
    render: (r) => {
      const w = store.lookups.workloads.get(r.workload_id);
      return html`<span class="xs" title=${`${w?.name ?? ''}\n${r.workload_id}`}
        >${w?.kind === 'eval' ? w.name : shapeLabel(workloadShape(w)) || r.workload_id}</span
      >`;
    },
  },
  ...METRICS.map<Col>((m) => ({
    key: m.key,
    label: FRIENDLY[m.key] ?? m.short,
    width: 124,
    num: true,
    metric: m,
    value: (r) => m.fromRow(r),
  })),
  {
    key: 'contributor',
    label: 'By',
    width: 130,
    value: (r) => r.provenance.login,
    render: (r) =>
      html`<span class="row" style="gap:6px"
        >${avatar(r.provenance.login, { userId: r.provenance.user_id, avatarUrl: r.provenance.avatar_url, size: 'sm' })}<span
          class="ellipsis"
          >${r.provenance.login}</span
        ></span
      >`,
  },
  {
    key: 'verification',
    label: 'Verification',
    width: 110,
    value: (r) => r.verification_level,
    render: (r) => verifBadge(r.verification_level),
  },
  {
    key: 'date',
    label: 'Submitted',
    width: 100,
    value: (r) => r.provenance.submitted_at ?? r.provenance.started_at,
    render: (r) => when(r.provenance.submitted_at ?? r.provenance.started_at),
  },
  { key: 'gotchas', label: 'Gotchas', width: 70, num: true, value: (r) => r.gotchas ?? 0 },
];

const DEFAULT_COLS = [
  'model',
  'hardware',
  'engine',
  'setup',
  'kind',
  'output_tok_s',
  'decode_tok_s_per_request',
  'ttft_p50',
  'success_rate',
  'accuracy',
  'contributor',
  'date',
];

const LEAD = ['model', 'hardware', 'engine', 'setup'];
const TAIL = ['contributor', 'date'];

/**
 * One tab per kind of test. Each gets only the columns that mean something for it and is
 * sorted best-first by its main number — a throughput run and an eval never share a column.
 */
const KIND_VIEWS: Array<{ kind: string; label: string; cols: string[]; sort: SortSpec }> = [
  {
    kind: 'serving',
    label: 'Throughput',
    cols: [
      ...LEAD,
      'output_tok_s',
      'decode_tok_s_per_request',
      'ttft_p50',
      'tpot_p50',
      'success_rate',
      'vram_peak_gb',
      ...TAIL,
    ],
    sort: { key: 'output_tok_s', dir: 'desc' },
  },
  {
    kind: 'sweep',
    label: 'Sweeps',
    cols: [
      ...LEAD,
      'output_tok_s',
      'decode_tok_s_per_request',
      'ttft_p50',
      'success_rate',
      ...TAIL,
    ],
    sort: { key: 'output_tok_s', dir: 'desc' },
  },
  {
    kind: 'prefill',
    label: 'Prompt processing',
    cols: [...LEAD, 'ttft_p50', 'ttft_p95', 'success_rate', ...TAIL],
    sort: { key: 'ttft_p50', dir: 'asc' },
  },
  {
    kind: 'longctx',
    label: 'Long context',
    cols: [...LEAD, 'ttft_p50', 'decode_tok_s_per_request', 'success_rate', ...TAIL],
    sort: { key: 'ttft_p50', dir: 'asc' },
  },
  {
    kind: 'eval',
    label: 'Quality evals',
    cols: [...LEAD, 'accuracy', 'success_rate', ...TAIL],
    sort: { key: 'accuracy', dir: 'desc' },
  },
  {
    kind: 'agentic',
    label: 'Agentic',
    cols: [
      ...LEAD,
      'output_tok_s',
      'decode_tok_s_per_request',
      'ttft_p50',
      'success_rate',
      ...TAIL,
    ],
    sort: { key: 'output_tok_s', dir: 'desc' },
  },
  {
    kind: 'image',
    label: 'Images',
    cols: [...LEAD, 's_per_image_p50', 'vram_peak_gb', 'success_rate', ...TAIL],
    sort: { key: 's_per_image_p50', dir: 'asc' },
  },
];

/** One line under the tabs saying what the numbers in this kind of test mean. */
const KIND_NOTES: Record<string, string> = {
  serving:
    'Fixed load: N requests at once, each with a set prompt and answer length (the Setup column). Total = all requests combined; Per user = the speed one request sees.',
  sweep:
    'The same test at rising concurrency. Total is the best point of the sweep; open a row for the whole curve.',
  prefill: 'How fast a long prompt is read in. Lower time to first token is better.',
  longctx:
    'Very long prompts with a needle-in-a-haystack check. Time to first token is the honest headline here.',
  eval: 'Answer quality on a fixed question set. Higher accuracy is better.',
  agentic: 'Replayed agent sessions: many turns, growing context.',
  image: 'Image generation: seconds per picture at a fixed size.',
};

/** Filters that live behind "More filters" — the four up front answer most questions. */
const MORE_FILTERS = ['version', 'quant', 'workload', 'contributor', 'verification', 'from', 'to'];

@customElement('atlas-results-view')
export class AtlasResultsView extends ViewElement {
  @state() private chooser = false;
  @state() private moreFilters = false;
  @state() private narrow = matchMedia('(max-width: 720px)').matches;
  private mq = matchMedia('(max-width: 720px)');
  private onMq = () => (this.narrow = this.mq.matches);

  override connectedCallback(): void {
    super.connectedCallback();
    this.mq.addEventListener('change', this.onMq);
    document.addEventListener('click', this.onDoc);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.mq.removeEventListener('change', this.onMq);
    document.removeEventListener('click', this.onDoc);
  }
  private onDoc = (e: Event) => {
    if (this.chooser && !(e.target as Element).closest('.col-chooser')) this.chooser = false;
  };

  /**
   * The kind tab in force. No `kind` in the URL means Throughput — what most visitors came
   * for — unless a workload filter already pins the kind; `kind=all` shows everything.
   */
  private kind(): string | null {
    const k = qget(this.q, 'kind');
    if (k === 'all') return null;
    if (k) return k;
    const w = qget(this.q, 'workload');
    if (w) return store.lookups.workloads.get(w)?.kind ?? null;
    return store.index.value.some((r) => r.kind === 'serving') ? 'serving' : null;
  }

  private kindView() {
    const k = this.kind();
    return k ? KIND_VIEWS.find((v) => v.kind === k) : undefined;
  }

  private visibleCols(): Col[] {
    const v = qget(this.q, 'cols');
    const keys = v ? v.split(',') : (this.kindView()?.cols ?? DEFAULT_COLS);
    return keys.map((k) => COLS.find((c) => c.key === k)).filter((c): c is Col => !!c);
  }

  private filtered(): IndexRow[] {
    const q = this.q;
    const f = (k: string) => qget(q, k);
    const search = f('q') ?? '';
    const kind = this.kind();
    return store.index.value.filter(
      (r) =>
        (!f('engine') || r.engine.id === f('engine')) &&
        (!f('version') || r.engine.version === f('version')) &&
        (!f('model') || r.model.id === f('model')) &&
        (!f('quant') || r.model.quant_id === f('quant')) &&
        (!f('hardware') || r.hardware.id === f('hardware')) &&
        (!f('workload') || r.workload_id === f('workload')) &&
        (!kind || r.kind === kind) &&
        (!f('contributor') || r.provenance.login === f('contributor')) &&
        (!f('verification') || r.verification_level === f('verification')) &&
        inDateRange(r.provenance.submitted_at ?? r.provenance.started_at, f('from'), f('to')) &&
        matchesQuery(
          `${r.run_id} ${r.engine.id} ${r.engine.version} ${r.model.id} ${r.model.quant_id} ${r.hardware.id} ${r.workload_id} ${r.provenance.login} ${r.config_id}`,
          search,
        ),
    );
  }

  private sorted(rows: IndexRow[], sort: SortSpec): IndexRow[] {
    const col = COLS.find((c) => c.key === sort.key);
    if (!col) return rows;
    return sortRows(rows, col.value, sort.dir);
  }

  private exportCsv(rows: IndexRow[], cols: Col[]): void {
    const csv = toCsv(rows, [
      { key: 'run_id', label: 'run_id', value: (r) => r.run_id },
      ...cols.map((c) => ({ key: c.key, label: c.label, value: (r: IndexRow) => c.value(r) })),
    ]);
    download(`atlas-results-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
  }

  private insightsDisclosure(rows: IndexRow[]): TemplateResult | typeof nothing {
    const body = this.insights(rows);
    if (body === nothing) return nothing;
    return html`<details class="disclosure boxed mt-4">
      <summary>
        ${icon('chevronRight')}<span class="t">Charts for this selection</span
        ><span class="m">distribution, leaders and activity over the rows above</span>
      </summary>
      <div class="body">${body}</div>
    </details>`;
  }

  /** Charts over whatever the filters currently select: distribution, leaders, activity. */
  private insights(rows: IndexRow[]): TemplateResult | typeof nothing {
    if (rows.length < 3) return nothing;
    const wanted = qget(this.q, 'chart');
    const withData = METRICS.filter((m) => rows.some((r) => m.fromRow(r) !== null));
    if (!withData.length) return nothing;
    const metric =
      (wanted ? withData.find((m) => m.key === wanted) : undefined) ??
      withData.find((m) => m.key === 'decode_tok_s_per_request') ??
      withData[0]!;
    const values = rows.map((r) => metric.fromRow(r)).filter((v): v is number => v !== null);
    const hist = histogramBuild(values, {
      label: `${metric.short}${metric.unit ? ` (${metric.unit})` : ''}`,
      fmt: (v) => metric.fmt(v),
    });
    const activity = activityBuild(
      rows.map((r) => r.provenance.submitted_at ?? r.provenance.started_at),
      { label: 'runs' },
    );
    const best = rows
      .filter((r) => metric.fromRow(r) !== null)
      .sort((a, b) =>
        metric.better === 'higher'
          ? metric.fromRow(b)! - metric.fromRow(a)!
          : metric.fromRow(a)! - metric.fromRow(b)!,
      )
      .slice(0, 8);
    const leaders = barList(
      best.map((r) => ({
        label: `${r.model.id}/${r.model.quant_id} · ${r.hardware.id}`,
        title: `${r.engine.id} ${r.engine.version} · ${r.model.id}/${r.model.quant_id} · ${r.hardware.id} · ${r.workload_id}`,
        value: metric.fromRow(r),
        text: metric.fmt(metric.fromRow(r)),
        href: href('run', r.run_id),
      })),
      {
        // "lower is better" bars: scale so the best (smallest) is longest
        max:
          metric.better === 'lower' ? Math.max(...best.map((r) => metric.fromRow(r)!)) : undefined,
        ariaLabel: `${metric.better === 'lower' ? 'Best (lowest)' : 'Top'} runs by ${metric.label}`,
      },
    );
    const picker = selectField(
      'Metric',
      metric.key,
      withData.map((m) => ({ value: m.key, label: m.label })),
      (v) => setQuery({ chart: v === 'decode_tok_s_per_request' ? null : v }),
      { allowEmpty: false, small: true },
    );
    return html`<div class="insights">
      ${
        hist
          ? html`<section class="card tight">
              <div class="card-head">
                <h3>Distribution</h3>
                <span class="muted small">${fmtInt(values.length)} runs carry ${metric.label}</span>
                <span class="spacer"></span>
                ${picker}
              </div>
              <atlas-chart
                .build=${hist}
                .height=${190}
                .key=${`${metric.key}:${rows.length}`}
                .chartTitle=${`Distribution of ${metric.label}`}
                .subtitle=${`${fmtInt(values.length)} runs · Inference Atlas results`}
              ></atlas-chart>
            </section>`
          : nothing
      }
      <section class="card tight">
        <div class="card-head">
          <h3>${metric.better === 'lower' ? 'Best' : 'Top'} runs</h3>
          <span class="muted small"
            >by ${metric.label}${metric.unit ? ` (${metric.unit})` : ''}</span
          >
        </div>
        ${leaders}
      </section>
      ${
        activity
          ? html`<section class="card tight">
              <div class="card-head">
                <h3>Activity</h3>
                <span class="muted small">submissions over time</span>
              </div>
              <atlas-chart
                .build=${activity}
                .height=${190}
                .key=${rows.length}
                .chartTitle=${'Submissions over time'}
                .subtitle=${`${fmtInt(rows.length)} runs · Inference Atlas results`}
              ></atlas-chart>
            </section>`
          : nothing
      }
    </div>`;
  }

  private cell(c: Col, r: IndexRow): TemplateResult {
    if (c.render) return c.render(r);
    if (c.metric) {
      const v = c.metric.fromRow(r);
      return v === null
        ? html`<span class="null">–</span>`
        : html`<span
            >${c.metric.fmt(v)}${c.metric.unit ? html`<span class="unit">${c.metric.unit}</span>` : nothing}</span
          >`;
    }
    const v = c.value(r);
    return html`${v ?? html`<span class="null">–</span>`}`;
  }

  override render() {
    const q = this.q;
    const all = store.index.value;
    const rows0 = this.filtered();
    const sort = parseSort(qget(q, 'sort'), this.kindView()?.sort ?? { key: 'date', dir: 'desc' });
    const rows = this.sorted(rows0, sort);
    const cols = this.visibleCols();
    const template = cols.map((c) => `${c.width}px`).join(' ');
    const f = (k: string) => qget(q, k);
    const opts = (vals: Iterable<string>) =>
      uniqueSorted(vals).map((v) => ({ value: v, label: v }));
    const filterRows = store.index.value;
    const active = [
      'engine',
      'version',
      'model',
      'quant',
      'hardware',
      'workload',
      'contributor',
      'verification',
      'from',
      'to',
      'q',
    ].filter((k) => f(k));

    const kindCount = new Map<string, number>();
    for (const r of all) kindCount.set(r.kind, (kindCount.get(r.kind) ?? 0) + 1);
    const moreActive = MORE_FILTERS.filter((k) => f(k)).length;
    const showMore = this.moreFilters || moreActive > 0;

    const rowTpl = (r: IndexRow) =>
      html`<a
        class="rg-row"
        href=${href('run', r.run_id)}
        style=${this.narrow ? '' : `grid-template-columns:${template}`}
      >
        ${cols.map((c) => html`<span class="c ${c.num ? 'num' : ''} ${c.primary ? 'primary' : ''} ${c.metric && c.metric.fromRow(r) === null ? 'is-null' : ''}" data-label=${c.label}>${this.cell(c, r)}</span>`)}
      </a>`;

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Results</div>
        <div class="row-wrap" style="justify-content:space-between">
          <h1>${fmtInt(rows.length)} of ${fmtInt(all.length)} runs</h1>
          <div class="head-actions">
            <button class="btn btn-sm" @click=${() => copyText(location.href, 'Permalink copied')}>
              ${icon('link')} Permalink
            </button>
            <button class="btn btn-sm" @click=${() => this.exportCsv(rows, cols)}>
              ${icon('download')} CSV
            </button>
            <div class="col-chooser">
              <button
                class="btn btn-sm"
                @click=${() => (this.chooser = !this.chooser)}
                aria-expanded=${this.chooser}
              >
                ${icon('table')} Columns
              </button>
              ${
                this.chooser
                  ? html`<div class="menu">
                      ${COLS.map(
                        (c) =>
                          html`<label
                            ><input
                              type="checkbox"
                              .checked=${cols.includes(c)}
                              @change=${(e: Event) => {
                                const on = (e.target as HTMLInputElement).checked;
                                const keys = COLS.filter((x) =>
                                  x === c ? on : cols.includes(x),
                                ).map((x) => x.key);
                                setQuery({
                                  cols:
                                    keys.join(',') === DEFAULT_COLS.join(',')
                                      ? null
                                      : keys.join(','),
                                });
                              }}
                            />
                            ${c.label}</label
                          >`,
                      )}
                      <button
                        class="btn btn-ghost btn-xs"
                        style="grid-column:1/-1"
                        @click=${() => setQuery({ cols: null })}
                      >
                        Reset to default
                      </button>
                    </div>`
                  : nothing
              }
            </div>
          </div>
        </div>
      </div>

      <div class="seg kind-tabs mb-3" role="tablist" aria-label="Kind of test">
        ${KIND_VIEWS.filter((v) => kindCount.has(v.kind)).map(
          (v) =>
            html`<button
              role="tab"
              aria-pressed=${this.kind() === v.kind}
              @click=${() => setQuery({ kind: v.kind, sort: null, cols: null, workload: null })}
            >
              ${v.label} <span class="count">${fmtInt(kindCount.get(v.kind)!)}</span>
            </button>`,
        )}
        <button
          role="tab"
          aria-pressed=${this.kind() === null}
          @click=${() => setQuery({ kind: 'all', sort: null, cols: null })}
        >
          All <span class="count">${fmtInt(all.length)}</span>
        </button>
      </div>
      ${
        this.kindView()
          ? html`<p class="small muted mb-3 kind-note">${KIND_NOTES[this.kind()!] ?? ''}</p>`
          : nothing
      }

      <div class="filters mb-3">
        <div class="search-input" style="min-width:220px">
          ${icon('search')}<input
            class="input"
            type="search"
            placeholder="Search runs…"
            .value=${f('q') ?? ''}
            @input=${(e: Event) => setQuery({ q: (e.target as HTMLInputElement).value || null })}
          />
        </div>
        ${selectField('Model', f('model'), opts(filterRows.map((r) => r.model.id)), (v) => setQuery({ model: v, quant: null }))}
        ${selectField('Hardware', f('hardware'), opts(filterRows.map((r) => r.hardware.id)), (v) => setQuery({ hardware: v }))}
        ${selectField('Engine', f('engine'), opts(filterRows.map((r) => r.engine.id)), (v) => setQuery({ engine: v, version: null }))}
        <button
          class="btn btn-sm ${showMore ? 'active' : ''}"
          aria-expanded=${showMore}
          @click=${() => (this.moreFilters = !showMore)}
        >
          ${icon('filter')} More filters${moreActive ? ` · ${moreActive}` : ''}
        </button>
        ${active.length ? html`<button class="btn btn-ghost btn-sm" @click=${() => setQuery(Object.fromEntries(active.map((k) => [k, null])))}>${icon('x')} Clear ${active.length}</button>` : nothing}
      </div>
      ${
        showMore
          ? html`<div class="filters mb-3 more-filters">
              ${selectField('Version', f('version'), opts(filterRows.filter((r) => !f('engine') || r.engine.id === f('engine')).map((r) => r.engine.version)), (v) => setQuery({ version: v }))}
              ${selectField('Quant', f('quant'), opts(filterRows.filter((r) => !f('model') || r.model.id === f('model')).map((r) => r.model.quant_id)), (v) => setQuery({ quant: v }))}
              ${selectField('Workload', f('workload'), opts(filterRows.map((r) => r.workload_id)), (v) => setQuery({ workload: v }))}
              ${selectField('Contributor', f('contributor'), opts(filterRows.map((r) => r.provenance.login)), (v) => setQuery({ contributor: v }))}
              ${selectField('Verification', f('verification'), opts(filterRows.map((r) => r.verification_level)), (v) => setQuery({ verification: v }))}
              <label class="field"
                ><span class="label">From</span
                ><input
                  class="input"
                  type="date"
                  .value=${f('from') ?? ''}
                  @change=${(e: Event) => setQuery({ from: (e.target as HTMLInputElement).value || null })}
              /></label>
              <label class="field"
                ><span class="label">To</span
                ><input
                  class="input"
                  type="date"
                  .value=${f('to') ?? ''}
                  @change=${(e: Event) => setQuery({ to: (e.target as HTMLInputElement).value || null })}
              /></label>
            </div>`
          : nothing
      }
      ${
        rows.length === 0
          ? emptyState({
              title: all.length === 0 ? 'No results yet' : 'No runs match these filters',
              text:
                all.length === 0
                  ? 'The first measurement on the map will show up here.'
                  : 'Loosen a filter, or add the measurement you were looking for.',
              action: html`<a class="btn btn-primary" href="#/gaps"
                >${icon('flag')} Find a gap to fill</a
              >`,
            })
          : html`<div class="rgrid">
                <div class="rg-scroll">
                  <div class="rg-inner">
                    ${
                      this.narrow
                        ? nothing
                        : html`<div class="rg-head" style="grid-template-columns:${template}">
                            ${cols.map(
                              (c) =>
                                html`<button
                                  type="button"
                                  class="c ${c.num ? 'num' : ''} ${sort.key === c.key ? 'active' : ''}"
                                  style="border:0;background:none"
                                  aria-sort=${sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : nothing}
                                  title=${c.metric ? `${c.metric.label}${c.metric.unit ? ` (${c.metric.unit})` : ''}` : c.label}
                                  @click=${() => setQuery({ sort: serializeSort(toggleSort(sort, c.key, c.num ? 'desc' : 'asc')) })}
                                >
                                  ${c.label}${c.metric?.unit ? html`<span class="unit">${c.metric.unit}</span>` : nothing}
                                  ${sortIcon(sort.key === c.key, sort.dir)}
                                </button>`,
                            )}
                          </div>`
                    }
                    ${
                      this.narrow || rows.length < 60
                        ? rows.map(rowTpl)
                        : html`<lit-virtualizer
                            .items=${rows}
                            .renderItem=${rowTpl}
                            .keyFunction=${(r: IndexRow) => r.run_id}
                          ></lit-virtualizer>`
                    }
                  </div>
                </div>
              </div>
              <p class="xs muted mt-2">
                Best first. Click a column to sort by it, a row for the full recipe.
              </p>
              ${this.insightsDisclosure(rows)}`
      }
    </div>`;
  }
}

export function openRun(id: string): void {
  navigate(href('run', id));
}
