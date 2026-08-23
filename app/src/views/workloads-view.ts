import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Workload } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import { icon } from '../components/icons.js';
import { runsTable } from '../components/runs-table.js';
import { codeBlock, emptyState, kindTag, kv, skeletonLines } from '../components/ui.js';
import { href, navigate, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { fmtInt } from '../util/format.js';
import { ViewElement } from './view-base.js';

const KINDS = ['serving', 'sweep', 'prefill', 'longctx', 'eval'] as const;

function paramsSummary(w: Workload): string {
  const p = w.params ?? {};
  const bits: string[] = [];
  for (const k of [
    'concurrency',
    'input_tokens',
    'output_tokens',
    'num_requests',
    'repeat',
    'temperature',
  ])
    if (p[k] !== undefined && p[k] !== null)
      bits.push(`${k.replace('_tokens', '').replace('num_requests', 'n')}=${String(p[k])}`);
  if (w.sweep)
    for (const [axis, vals] of Object.entries(w.sweep))
      bits.push(`${axis}: ${(vals ?? []).join('/')}`);
  if (w.eval) bits.push(`suite=${w.eval.suite} · ${w.eval.scorer}`);
  return bits.join(' · ');
}

@customElement('atlas-workloads-view')
export class AtlasWorkloadsView extends ViewElement {
  @property({ attribute: false }) itemId: string | null = null;

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(6)}</div>`;
    return this.itemId ? this.detail(this.itemId) : this.list();
  }

  private list(): TemplateResult {
    const reg = store.registry.value!;
    const kind = qget(this.q, 'kind');
    const rows = reg.workloads.filter((w) => !kind || w.kind === kind);
    const cellsWith = (id: string) =>
      new Set(store.index.value.filter((r) => r.workload_id === id).map((r) => r.cell_id)).size;
    const runsWith = (id: string) => store.index.value.filter((r) => r.workload_id === id).length;
    const grouped = KINDS.map((k) => ({ kind: k, items: rows.filter((w) => w.kind === k) })).filter(
      (g) => g.items.length,
    );
    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Registry · workloads</div>
        <h1>${fmtInt(rows.length)} pinned workload${rows.length === 1 ? '' : 's'}</h1>
        <p class="lede">
          A workload is an immutable, versioned definition: dataset, concurrency, token counts,
          seed, what metrics it must produce. Two runs on the same workload id are comparable by
          construction.
        </p>
      </div>
      <div class="row-wrap mb-4">
        <button class="chip" aria-pressed=${!kind} @click=${() => setQuery({ kind: null })}>
          all <span class="count">${reg.workloads.length}</span>
        </button>
        ${KINDS.map((k) => html`<button class="chip" aria-pressed=${kind === k} @click=${() => setQuery({ kind: k })}>${k} <span class="count">${reg.workloads.filter((w) => w.kind === k).length}</span></button>`)}
      </div>
      ${grouped.map(
        (g) =>
          html`<section class="mb-5">
            <div class="section-title">
              <h2>${kindTag(g.kind)} ${g.kind}</h2>
              <span class="meta">${g.items.length}</span>
            </div>
            <div class="table-wrap">
              <table class="table cards">
                <thead>
                  <tr>
                    <th>id</th>
                    <th>name</th>
                    <th>parameters</th>
                    <th>dataset</th>
                    <th class="num">cells</th>
                    <th class="num">runs</th>
                  </tr>
                </thead>
                <tbody>
                  ${g.items.map(
                    (w) =>
                      html`<tr class="clickable" @click=${() => navigate(href('workloads', w.id))}>
                        <td class="mono xs primary">${w.id}</td>
                        <td data-label="name">${w.name}</td>
                        <td class="mono xs muted wrap" data-label="params">${paramsSummary(w)}</td>
                        <td class="mono xs" data-label="dataset">
                          ${w.dataset_id ?? html`<span class="null">–</span>`}
                        </td>
                        <td class="num" data-label="cells">${cellsWith(w.id)}</td>
                        <td class="num" data-label="runs">${runsWith(w.id)}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          </section>`,
      )}
    </div>`;
  }

  private detail(id: string): TemplateResult {
    const reg = store.registry.value!;
    const w = store.lookups.workloads.get(id);
    if (!w)
      return html`<div class="page">
        ${emptyState({ title: `No workload “${id}”`, text: 'Workloads live under workloads/<id>.json and are immutable once published.', action: html`<a class="btn" href="#/workloads">All workloads</a>` })}
      </div>`;
    const runs = store.index.value
      .filter((r) => r.workload_id === id)
      .sort((a, b) =>
        (b.provenance.submitted_at ?? '').localeCompare(a.provenance.submitted_at ?? ''),
      );
    const cells = new Set(runs.map((r) => r.cell_id));
    const dataset = reg.datasets.find((d) => d.id === w.dataset_id);
    const featured = reg.site.featured ?? {};
    const defaultSpec = {
      engine_id: featured.engines?.[0] ?? reg.engines[0]?.meta.id ?? null,
      model_id: featured.models?.[0] ?? null,
      hardware_id: featured.hardware?.[0] ?? null,
      workload_ids: [id],
    };
    return html`<div class="page">
      <div class="page-head">
        <div class="row-wrap xs muted">
          <a href="#/workloads">Workloads</a> ${icon('chevronRight')}
          <span class="mono">${w.id}</span>
        </div>
        <div class="row-wrap" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h1 class="row" style="gap:10px">${kindTag(w.kind)} ${w.name}</h1>
            <p class="lede mt-2">${w.description ?? ''}</p>
          </div>
          <div class="head-actions">
            <a class="btn btn-sm" href=${`#/?rows=model&cols=hardware&kind=${w.kind}`}
              >${icon('grid')} On the atlas</a
            >
            <a class="btn btn-sm" href=${`#/results?workload=${w.id}`}
              >${icon('table')} ${runs.length} runs</a
            >
            ${addButton(defaultSpec, { label: 'Run it somewhere', size: 'sm' })}
          </div>
        </div>
      </div>
      <div class="split">
        <section class="card">
          <div class="card-head"><h3>Definition</h3></div>
          ${kv([
            ['id', html`<span class="mono">${w.id}</span>`],
            ['kind', kindTag(w.kind)],
            [
              'dataset',
              w.dataset_id
                ? html`<span class="mono">${w.dataset_id}</span
                    >${dataset ? html` <span class="xs muted">· ${dataset.kind} · ${dataset.count} items · ${dataset.licence}</span>` : nothing}`
                : null,
            ],
            ['parameters', html`<span class="mono xs">${paramsSummary(w) || '–'}</span>`],
            w.sweep
              ? [
                  'sweep',
                  html`<span class="mono xs"
                    >${Object.entries(w.sweep)
                      .map(([a, v]) => `${a}: ${(v ?? []).join(', ')}`)
                      .join(' · ')}</span
                  >`,
                ]
              : null,
            w.eval
              ? [
                  'eval',
                  html`<span class="mono xs"
                    >suite ${w.eval.suite} · scorer
                    ${w.eval.scorer}${w.eval.pass_threshold != null ? ` · pass ≥ ${w.eval.pass_threshold}` : ''}${w.eval.max_output_tokens ? ` · max ${w.eval.max_output_tokens} tok` : ''}</span
                  >`,
                ]
              : null,
            [
              'metrics required',
              html`<span class="row-wrap" style="gap:3px"
                >${w.metrics_required.map((m) => html`<span class="tag mono">${m}</span>`)}</span
              >`,
            ],
            ['immutable', w.immutable === false ? 'no' : 'yes'],
            ['created', w.created ?? null],
            [
              'supersedes',
              w.supersedes
                ? html`<a href=${href('workloads', w.supersedes)} class="mono">${w.supersedes}</a>`
                : null,
            ],
            [
              'measured in',
              `${cells.size} cell${cells.size === 1 ? '' : 's'} · ${runs.length} run${runs.length === 1 ? '' : 's'}`,
            ],
            w.notes ? ['notes', w.notes] : null,
          ])}
        </section>
        <section>
          <div class="section-title"><h2>JSON</h2></div>
          ${codeBlock(JSON.stringify(w, null, 2), { lang: 'json', maxHeight: 520 })}
        </section>
      </div>
      <section class="mt-5">
        <div class="section-title">
          <h2>Runs</h2>
          <span class="meta">${runs.length}</span>
        </div>
        ${runs.length ? runsTable(runs, { limit: 40 }) : emptyState({ compact: true, title: 'Nobody has run this workload yet', text: 'Pick a cell on the atlas and add it, or use the button above for a featured cell.' })}
      </section>
    </div>`;
  }
}
