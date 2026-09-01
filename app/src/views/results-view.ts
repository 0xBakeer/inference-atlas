import { html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '@lit-labs/virtualizer';
import { icon } from '../components/icons.js';
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

const COLS: Col[] = [
  {
    key: 'engine',
    label: 'Engine',
    width: 150,
    value: (r) => `${r.engine.id} ${r.engine.version}`,
    render: (r) =>
      html`<span class="mono xs"
        >${r.engine.id} <span class="muted">${r.engine.version}</span></span
      >`,
    primary: true,
  },
  {
    key: 'model',
    label: 'Model / quant',
    width: 230,
    value: (r) => `${r.model.id}/${r.model.quant_id}`,
    render: (r) =>
      html`<span class="mono xs"
        >${r.model.id}<span class="muted">/${r.model.quant_id}</span></span
      >`,
  },
  {
    key: 'hardware',
    label: 'Hardware',
    width: 180,
    value: (r) => r.hardware.id,
    render: (r) =>
      html`<span class="mono xs"
        >${r.hardware.id}${r.hardware.count > 1 ? ` ×${r.hardware.count}` : ''}</span
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
  ...METRICS.map<Col>((m) => ({
    key: m.key,
    label: m.short,
    width: 104,
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
  'engine',
  'model',
  'hardware',
  'workload',
  'kind',
  'decode_tok_s_per_request',
  'output_tok_s',
  'ttft_p50',
  'ttft_p95',
  'tpot_p50',
  'success_rate',
  'accuracy',
  'vram_peak_gb',
  'contributor',
  'verification',
  'date',
];

@customElement('atlas-results-view')
export class AtlasResultsView extends ViewElement {
  @state() private chooser = false;
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

  private visibleCols(): Col[] {
    const v = qget(this.q, 'cols');
    const keys = v ? v.split(',') : DEFAULT_COLS;
    return keys.map((k) => COLS.find((c) => c.key === k)).filter((c): c is Col => !!c);
  }

  private filtered(): IndexRow[] {
    const q = this.q;
    const f = (k: string) => qget(q, k);
    const search = f('q') ?? '';
    return store.index.value.filter(
      (r) =>
        (!f('engine') || r.engine.id === f('engine')) &&
        (!f('version') || r.engine.version === f('version')) &&
        (!f('model') || r.model.id === f('model')) &&
        (!f('quant') || r.model.quant_id === f('quant')) &&
        (!f('hardware') || r.hardware.id === f('hardware')) &&
        (!f('workload') || r.workload_id === f('workload')) &&
        (!f('kind') || r.kind === f('kind')) &&
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
    const sort = parseSort(qget(q, 'sort'), { key: 'date', dir: 'desc' });
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
      'kind',
      'contributor',
      'verification',
      'from',
      'to',
      'q',
    ].filter((k) => f(k));

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
        ${selectField('Engine', f('engine'), opts(filterRows.map((r) => r.engine.id)), (v) => setQuery({ engine: v, version: null }))}
        ${selectField('Version', f('version'), opts(filterRows.filter((r) => !f('engine') || r.engine.id === f('engine')).map((r) => r.engine.version)), (v) => setQuery({ version: v }))}
        ${selectField('Model', f('model'), opts(filterRows.map((r) => r.model.id)), (v) => setQuery({ model: v, quant: null }))}
        ${selectField('Quant', f('quant'), opts(filterRows.filter((r) => !f('model') || r.model.id === f('model')).map((r) => r.model.quant_id)), (v) => setQuery({ quant: v }))}
        ${selectField('Hardware', f('hardware'), opts(filterRows.map((r) => r.hardware.id)), (v) => setQuery({ hardware: v }))}
        ${selectField('Workload', f('workload'), opts(filterRows.map((r) => r.workload_id)), (v) => setQuery({ workload: v }))}
        ${selectField('Kind', f('kind'), opts(filterRows.map((r) => r.kind)), (v) => setQuery({ kind: v }))}
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
        ${active.length ? html`<button class="btn btn-ghost btn-sm" @click=${() => setQuery(Object.fromEntries(active.map((k) => [k, null])))}>${icon('x')} Clear ${active.length}</button>` : nothing}
      </div>

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
                Sort by any column; metric columns sort descending first. Click a row for the full
                record. ${rows.length >= 60 ? 'The table is virtualised.' : ''}
              </p>`
      }
    </div>`;
  }
}

export function openRun(id: string): void {
  navigate(href('run', id));
}
