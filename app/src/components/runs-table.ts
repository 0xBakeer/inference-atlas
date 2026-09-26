/**
 * Runs table used by the heatmap drawer, the registry detail pages and contributor profiles.
 *
 * Runs are split by workload kind, one tab each, because a throughput run, a prefill run and
 * an eval have nothing in common to put in one column: mixing them gave a "headline" column
 * where tok/s, milliseconds and percentages sat in random order. Each tab has columns that
 * mean one thing, the setup (concurrency, prompt / answer length) spelled out, and is sorted
 * best-first by its main number.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { fmtMs, fmtPct, fmtTokS, isNum } from '@atlas/core';
import type { WorkloadKind } from '@atlas/core';
import type { IndexRow } from '../data/types.js';
import { href, navigate } from '../router.js';
import { store } from '../store.js';
import { fmtTokens, shapeLabel, workloadShape } from '../util/recipe.js';
import { AtlasElement } from './base.js';
import { avatar, verifBadge, when } from './ui.js';

type Hide = 'engine' | 'model' | 'quant' | 'hardware' | 'by' | 'when';

interface Col {
  key: string;
  label: string;
  /** Shown under the header — what the number means. */
  sub?: string;
  num?: boolean;
  better?: 'higher' | 'lower';
  value?: (r: IndexRow) => number | null;
  cell: (r: IndexRow) => unknown;
}

interface KindTab {
  kind: WorkloadKind;
  label: string;
  cols: Col[];
}

const n = (v: unknown): number | null => (isNum(v) ? v : null);
const dash = html`<span class="null">–</span>`;
const numCell = (v: number | null, fmt: (v: number) => string, unit: string) =>
  v === null ? dash : html`${fmt(v)}<span class="unit">${unit}</span>`;

const outCol: Col = {
  key: 'output',
  label: 'Total tok/s',
  sub: 'all requests',
  num: true,
  better: 'higher',
  value: (r) => n(r.metrics.output_tok_s),
  cell: (r) => numCell(n(r.metrics.output_tok_s), fmtTokS, 'tok/s'),
};
const perUserCol: Col = {
  key: 'per_user',
  label: 'Per user',
  sub: 'tok/s each',
  num: true,
  better: 'higher',
  value: (r) => n(r.metrics.decode_tok_s_per_request),
  cell: (r) => numCell(n(r.metrics.decode_tok_s_per_request), fmtTokS, 'tok/s'),
};
const ttftCol: Col = {
  key: 'ttft',
  label: 'First token',
  sub: 'p50 wait',
  num: true,
  better: 'lower',
  value: (r) => n(r.metrics.ttft_p50),
  cell: (r) => numCell(n(r.metrics.ttft_p50), fmtMs, 'ms'),
};
const successCol: Col = {
  key: 'success',
  label: 'Success',
  num: true,
  better: 'higher',
  value: (r) => n(r.metrics.success_rate),
  cell: (r) => (n(r.metrics.success_rate) === null ? dash : fmtPct(r.metrics.success_rate, 0)),
};

function workloadOf(r: IndexRow) {
  return store.lookups.workloads.get(r.workload_id) ?? null;
}

const setupCol: Col = {
  key: 'setup',
  label: 'Setup',
  sub: 'concurrency · prompt / answer',
  cell: (r) => {
    const w = workloadOf(r);
    const label = shapeLabel(workloadShape(w));
    return html`<span title=${`${w?.name ?? ''}\n${r.workload_id}`}
      >${label || r.workload_id}</span
    >`;
  },
};
const promptCol: Col = {
  key: 'prompt',
  label: 'Prompt',
  sub: 'tokens',
  num: true,
  value: (r) => workloadShape(workloadOf(r)).input[0] ?? null,
  cell: (r) => {
    const s = workloadShape(workloadOf(r));
    return html`<span title=${r.workload_id}
      >${s.input.length > 1 ? `${fmtTokens(Math.min(...s.input))}→${fmtTokens(Math.max(...s.input))}` : fmtTokens(s.input[0])}</span
    >`;
  },
};
const evalCol: Col = {
  key: 'eval',
  label: 'Eval',
  cell: (r) => {
    const w = workloadOf(r);
    return html`<span title=${r.workload_id}>${w?.name ?? r.workload_id}</span>`;
  },
};

export const KIND_TABS: KindTab[] = [
  {
    kind: 'serving',
    label: 'Throughput',
    cols: [setupCol, outCol, perUserCol, ttftCol, successCol],
  },
  { kind: 'sweep', label: 'Sweeps', cols: [setupCol, outCol, perUserCol, ttftCol] },
  { kind: 'prefill', label: 'Prompt processing', cols: [promptCol, ttftCol, outCol] },
  { kind: 'longctx', label: 'Long context', cols: [promptCol, ttftCol, perUserCol, successCol] },
  {
    kind: 'eval',
    label: 'Quality evals',
    cols: [
      evalCol,
      {
        key: 'accuracy',
        label: 'Accuracy',
        num: true,
        better: 'higher',
        value: (r) => n(r.metrics.accuracy),
        cell: (r) => (n(r.metrics.accuracy) === null ? dash : fmtPct(r.metrics.accuracy, 1)),
      },
      successCol,
    ],
  },
  { kind: 'agentic', label: 'Agentic', cols: [evalCol, outCol, perUserCol, ttftCol, successCol] },
  {
    kind: 'image',
    label: 'Images',
    cols: [
      {
        key: 's_per_image',
        label: 'Time per image',
        num: true,
        better: 'lower',
        value: (r) => n(r.metrics.s_per_image_p50),
        cell: (r) => numCell(n(r.metrics.s_per_image_p50), (v) => v.toFixed(2), 's'),
      },
      successCol,
    ],
  },
];

@customElement('atlas-runs-table')
export class AtlasRunsTable extends AtlasElement {
  @property({ attribute: false }) rows: IndexRow[] = [];
  @property({ attribute: false }) hide: Hide[] = [];
  @property({ type: Number }) limit = 0;
  @state() private tab: WorkloadKind | null = null;
  @state() private sort: { key: string; dir: 1 | -1 } | null = null;
  @state() private expanded = false;

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('rows')) {
      this.expanded = false;
      if (this.tab && !this.rows.some((r) => r.kind === this.tab)) this.tab = null;
    }
  }

  private tabs(): Array<KindTab & { count: number }> {
    const counts = new Map<string, number>();
    for (const r of this.rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    return KIND_TABS.filter((t) => counts.has(t.kind)).map((t) => ({
      ...t,
      count: counts.get(t.kind)!,
    }));
  }

  private sorted(rows: IndexRow[], t: KindTab): IndexRow[] {
    const byKey = this.sort ? t.cols.find((c) => c.key === this.sort!.key) : null;
    const col = byKey?.value ? byKey : t.cols.find((c) => c.better && c.value);
    if (!col?.value) return rows;
    const dir = byKey && this.sort ? this.sort.dir : col.better === 'lower' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.value!(a);
      const vb = col.value!(b);
      if (va === null) return vb === null ? 0 : 1;
      if (vb === null) return -1;
      return (va - vb) * dir;
    });
  }

  private headerClick(c: Col): void {
    if (!c.value) return;
    const cur = this.sort?.key === c.key ? this.sort : null;
    const def = c.better === 'lower' ? 1 : -1;
    this.sort = { key: c.key, dir: cur ? (cur.dir === 1 ? -1 : 1) : (def as 1 | -1) };
  }

  override render() {
    const rows = this.rows;
    if (rows.length === 0) return html`<p class="small muted">No runs yet.</p>`;
    const tabs = this.tabs();
    const t = tabs.find((x) => x.kind === this.tab) ?? tabs[0];
    if (!t) return html`<p class="small muted">No runs yet.</p>`;
    const hide = new Set(this.hide);
    const list = this.sorted(
      rows.filter((r) => r.kind === t.kind),
      t,
    );
    const limit = this.limit && !this.expanded ? this.limit : list.length;
    const shown = list.slice(0, limit);
    const sortKey = this.sort?.key ?? t.cols.find((c) => c.better && c.value)?.key;
    return html`${
        tabs.length > 1
          ? html`<div class="seg runs-tabs" role="tablist">
              ${tabs.map(
                (x) =>
                  html`<button
                    role="tab"
                    aria-pressed=${x.kind === t.kind}
                    @click=${() => {
                      this.tab = x.kind;
                      this.sort = null;
                      this.expanded = false;
                    }}
                  >
                    ${x.label} <span class="count">${x.count}</span>
                  </button>`,
              )}
            </div>`
          : nothing
      }
      <div class="table-wrap">
        <table class="table cards runs-table">
          <thead>
            <tr>
              ${t.cols.map(
                (c) =>
                  html`<th
                    class="${c.num ? 'num' : ''} ${c.value ? 'sortable' : ''}"
                    aria-sort=${sortKey === c.key ? 'descending' : nothing}
                    @click=${() => this.headerClick(c)}
                  >
                    ${c.label}${sortKey === c.key ? html`<span class="sort">↓</span>` : nothing}
                    ${c.sub ? html`<span class="th-sub">${c.sub}</span>` : nothing}
                  </th>`,
              )}
              ${hide.has('model') ? (hide.has('quant') ? nothing : html`<th>Quant</th>`) : html`<th>Model / quant</th>`}
              ${hide.has('hardware') ? nothing : html`<th>Hardware</th>`}
              ${hide.has('engine') ? nothing : html`<th>Engine</th>`}
              ${hide.has('by') ? nothing : html`<th>By</th>`}
              ${hide.has('when') ? nothing : html`<th>When</th>`}
            </tr>
          </thead>
          <tbody>
            ${shown.map(
              (r) =>
                html`<tr class="clickable" @click=${() => navigate(href('run', r.run_id))}>
                  ${t.cols.map(
                    (c, i) =>
                      html`<td
                        class="${c.num ? 'num' : ''} ${i === 0 ? 'primary' : ''}"
                        data-label=${c.label}
                      >
                        ${i === 0 ? html`<a href=${href('run', r.run_id)} @click=${(e: Event) => e.stopPropagation()}>${c.cell(r)}</a>` : c.cell(r)}
                      </td>`,
                  )}
                  ${
                    hide.has('model')
                      ? hide.has('quant')
                        ? nothing
                        : html`<td class="mono xs" data-label="quant">${r.model.quant_id}</td>`
                      : html`<td class="mono xs" data-label="model">
                          ${r.model.id}<span class="muted">/${r.model.quant_id}</span>
                        </td>`
                  }
                  ${hide.has('hardware') ? nothing : html`<td class="xs" data-label="hardware">${store.lookups.hardware.get(r.hardware.id)?.name ?? r.hardware.id}${r.hardware.count > 1 ? ` ×${r.hardware.count}` : ''}</td>`}
                  ${hide.has('engine') ? nothing : html`<td class="xs" data-label="engine"><span class="nowrap">${store.lookups.engines.get(r.engine.id)?.meta.name ?? r.engine.id}</span> <span class="mono muted ver" title=${r.engine.version}>${r.engine.version}</span></td>`}
                  ${hide.has('by') ? nothing : html`<td data-label="by"><span class="row" style="gap:6px">${avatar(r.provenance.login, { userId: r.provenance.user_id, avatarUrl: r.provenance.avatar_url, size: 'sm' })}${r.provenance.login}${r.verification_level !== 'self-reported' ? verifBadge(r.verification_level) : nothing}</span></td>`}
                  ${
                    hide.has('when')
                      ? nothing
                      : html`<td data-label="when" class="xs muted nowrap">
                          ${when(r.provenance.submitted_at ?? r.provenance.started_at)}
                        </td>`
                  }
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${
        list.length > shown.length
          ? html`<button class="btn btn-ghost btn-sm mt-2" @click=${() => (this.expanded = true)}>
              Show all ${list.length} ${t.label.toLowerCase()} runs
            </button>`
          : nothing
      }`;
  }
}

export function runsTable(
  rows: IndexRow[],
  opts: { hide?: Hide[]; limit?: number } = {},
): TemplateResult {
  return html`<atlas-runs-table
    .rows=${rows}
    .hide=${opts.hide ?? []}
    .limit=${opts.limit ?? 0}
  ></atlas-runs-table>`;
}
