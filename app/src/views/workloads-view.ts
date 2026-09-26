import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Dataset, Workload, WorkloadKind } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import '../components/chart.js';
import { icon } from '../components/icons.js';
import { runsTable } from '../components/runs-table.js';
import {
  barList,
  bestPerGroup,
  firstMetricWithData,
  histogramBuild,
} from '../components/stat-charts.js';
import { codeBlock, emptyState, kindTag, skeletonLines } from '../components/ui.js';
import type { IndexRow } from '../data/types.js';
import { href, modelHref, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { vendorClass } from '../util/colors.js';
import { fmtTokens, shapeLabel, workloadShape } from '../util/recipe.js';
import { fmtInt, headlineMetric, METRIC_BY_KEY } from '@atlas/core';
import { ViewElement } from './view-base.js';

const KINDS: WorkloadKind[] = [
  'serving',
  'sweep',
  'prefill',
  'longctx',
  'eval',
  'agentic',
  'image',
];

/** What each kind of test is for, in one line, and which number to read first. */
const KIND_INFO: Record<WorkloadKind, { label: string; what: string; number: string }> = {
  serving: {
    label: 'Throughput',
    what: 'A fixed load: N requests at once, each with a set prompt and answer length. The everyday shape of a chat or API server.',
    number: 'Total tok/s across all requests, and the speed one user sees.',
  },
  sweep: {
    label: 'Sweeps',
    what: 'The same request shape at rising concurrency, 1 → 2 → 4 … so you can see where throughput stops climbing and latency starts to hurt.',
    number: 'Peak tok/s and the concurrency where it peaks.',
  },
  prefill: {
    label: 'Prompt processing',
    what: 'One very long prompt, a tiny answer. Measures how fast the engine reads text in — what a RAG or document workflow waits on.',
    number: 'Time to first token; lower is better.',
  },
  longctx: {
    label: 'Long context',
    what: 'A needle hidden in a long haystack. Checks that the engine still finds it at 32k, 128k or more, and how long that takes.',
    number: 'Time to first token, and whether the needle was found.',
  },
  eval: {
    label: 'Quality evals',
    what: 'A pinned question set with a fixed scorer at temperature 0. Tells you whether the quantization, the engine or a flag broke the answers.',
    number: 'Accuracy; higher is better.',
  },
  agentic: {
    label: 'Agentic',
    what: 'Replayed coding-agent sessions: many turns, tool calls, and a context that grows with every step.',
    number: 'Tokens per second across the session and per turn.',
  },
  image: {
    label: 'Images',
    what: 'Text-to-image and image editing at a fixed size and step count.',
    number: 'Seconds per image; lower is better.',
  },
};

/** The workload's setup in plain words: "16 concurrent · 128 in / 128 out" or "140 items · code-exec". */
export function workloadSetup(w: Workload, dataset?: Dataset | null): string {
  if (w.kind === 'eval') {
    const n = dataset?.count ?? (w.params.num_requests as number | null);
    return [n ? `${fmtInt(n)} items` : null, w.eval?.scorer ? `${w.eval.scorer} scorer` : null]
      .filter(Boolean)
      .join(' · ');
  }
  if (w.kind === 'image') {
    const n = w.params.num_requests as number | null;
    return [n ? `${n} images` : null, w.params.repeat ? `×${String(w.params.repeat)}` : null]
      .filter(Boolean)
      .join(' · ');
  }
  return shapeLabel(workloadShape(w));
}

@customElement('atlas-workloads-view')
export class AtlasWorkloadsView extends ViewElement {
  @property({ attribute: false }) itemId: string | null = null;

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(6)}</div>`;
    return this.itemId ? this.detail(this.itemId) : this.list();
  }

  private runsOf(id: string): IndexRow[] {
    return store.index.value.filter((r) => r.workload_id === id);
  }

  /* ---------------------------------------------------------------- list */

  private list(): TemplateResult {
    const reg = store.registry.value!;
    const kindQ = qget(this.q, 'kind') as WorkloadKind | null;
    const present = KINDS.filter((k) => reg.workloads.some((w) => w.kind === k));
    const kind = kindQ && present.includes(kindQ) ? kindQ : null;
    const groups = (kind ? [kind] : present).map((k) => ({
      kind: k,
      items: reg.workloads
        .filter((w) => w.kind === k)
        .sort(
          (a, b) => this.runsOf(b.id).length - this.runsOf(a.id).length || a.id.localeCompare(b.id),
        ),
    }));
    const measured = reg.workloads.filter((w) => this.runsOf(w.id).length).length;
    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Registry · workloads</div>
        <h1>${fmtInt(reg.workloads.length)} pinned tests</h1>
        <p class="lede">
          A workload is a frozen test: the dataset, how many requests at once, how long the prompts
          and answers are, the seed, and which numbers it must produce. Two runs of the same
          workload id are comparable by construction — that is what makes the map a map.
        </p>
      </div>

      <div class="stats-strip mb-5">
        <div class="stat">
          <div class="v">${present.length}</div>
          <div class="k">kinds of test</div>
        </div>
        <div class="stat">
          <div class="v">${measured}</div>
          <div class="k">workloads with runs</div>
        </div>
        <div class="stat">
          <div class="v">${reg.workloads.length - measured}</div>
          <div class="k">never run</div>
        </div>
        <div class="stat">
          <div class="v">${reg.datasets.length}</div>
          <div class="k">datasets</div>
        </div>
      </div>

      <div class="seg kind-tabs mb-4" role="tablist">
        <button role="tab" aria-pressed=${!kind} @click=${() => setQuery({ kind: null })}>
          All <span class="count">${reg.workloads.length}</span>
        </button>
        ${present.map(
          (k) =>
            html`<button
              role="tab"
              aria-pressed=${kind === k}
              @click=${() => setQuery({ kind: k })}
            >
              ${KIND_INFO[k].label}
              <span class="count">${reg.workloads.filter((w) => w.kind === k).length}</span>
            </button>`,
        )}
      </div>

      ${groups.map(
        (g) =>
          html`<section class="mb-6">
            <div class="kind-intro">
              <div class="section-title">
                <h2>${KIND_INFO[g.kind].label}</h2>
                ${kindTag(g.kind)}
                <span class="meta"
                  >${g.items.length} workload${g.items.length === 1 ? '' : 's'}</span
                >
              </div>
              <p class="what">${KIND_INFO[g.kind].what}</p>
              <p class="number">${icon('gauge')} ${KIND_INFO[g.kind].number}</p>
            </div>
            <div class="workload-grid">${g.items.map((w) => this.workloadCard(w))}</div>
          </section>`,
      )}
    </div>`;
  }

  private workloadCard(w: Workload): TemplateResult {
    const reg = store.registry.value!;
    const runs = this.runsOf(w.id);
    const dataset = reg.datasets.find((d) => d.id === w.dataset_id) ?? null;
    const cells = new Set(runs.map((r) => r.cell_id)).size;
    const devices = new Set(runs.map((r) => r.hardware.id)).size;
    let best: { text: string; label: string; row: IndexRow } | null = null;
    for (const r of runs) {
      // Prompt processing is judged by how fast the first token arrives, not by output tok/s.
      const hl =
        w.kind === 'prefill'
          ? (() => {
              const def = METRIC_BY_KEY.ttft_p50!;
              const v = def.fromRow(r);
              return v === null ? null : { def, value: v };
            })()
          : headlineMetric(r, store.site.coverage.key_metrics);
      if (!hl) continue;
      const better =
        !best ||
        (hl.def.better === 'higher'
          ? hl.value > hl.def.fromRow(best.row)!
          : hl.value < hl.def.fromRow(best.row)!);
      if (better)
        best = {
          text: `${hl.def.fmt(hl.value)}${hl.def.unit ? ` ${hl.def.unit}` : ''}`,
          label: hl.def.short,
          row: r,
        };
    }
    return html`<a
      class="workload-card ${runs.length ? '' : 'empty'}"
      href=${href('workloads', w.id)}
    >
      <div class="wc-head">
        <span class="wc-name">${w.name}</span>
        <span class="mono xs muted">${w.id}</span>
      </div>
      <div class="wc-setup">${workloadSetup(w, dataset) || html`<span class="faint">–</span>`}</div>
      ${dataset ? html`<div class="wc-dataset xs muted">${icon('layers')} ${dataset.name} · ${fmtInt(dataset.count)} ${dataset.kind === 'eval' ? 'questions' : 'prompts'}</div>` : nothing}
      <div class="wc-foot">
        ${
          best
            ? html`<span class="wc-best"
                ><b>${best.text}</b>
                <span class="xs muted"
                  >best ${best.label.toLowerCase()} ·
                  ${store.lookups.models.get(best.row.model.id)?.model.name ?? best.row.model.id}</span
                ></span
              >`
            : html`<span class="xs faint">nobody has run this yet</span>`
        }
        <span class="wc-counts xs muted"
          >${fmtInt(runs.length)} run${runs.length === 1 ? '' : 's'} · ${cells}
          cell${cells === 1 ? '' : 's'} · ${devices} device${devices === 1 ? '' : 's'}</span
        >
      </div>
    </a>`;
  }

  /* ---------------------------------------------------------------- detail */

  private detail(id: string): TemplateResult {
    const reg = store.registry.value!;
    const w = store.lookups.workloads.get(id);
    if (!w)
      return html`<div class="page">
        ${emptyState({ title: `No workload “${id}”`, text: 'Workloads live under workloads/<id>.json and are immutable once published.', action: html`<a class="btn" href="#/workloads">All workloads</a>` })}
      </div>`;
    const runs = this.runsOf(id);
    const cells = new Set(runs.map((r) => r.cell_id));
    const devices = new Set(runs.map((r) => r.hardware.id));
    const models = new Set(runs.map((r) => `${r.model.id}/${r.model.quant_id}`));
    const dataset = reg.datasets.find((d) => d.id === w.dataset_id) ?? null;
    const shape = workloadShape(w);
    const info = KIND_INFO[w.kind] ?? KIND_INFO.serving;
    const featured = reg.site.featured ?? {};
    const defaultSpec = {
      engine_id: featured.engines?.[0] ?? reg.engines[0]?.meta.id ?? null,
      model_id: featured.models?.[0] ?? null,
      hardware_id: featured.hardware?.[0] ?? null,
      workload_ids: [id],
    };
    const repo = `${store.site.repo.host ?? 'https://github.com'}/${store.site.repo.owner}/${store.site.repo.name}`;
    const p = w.params ?? {};
    const facts: Array<[string, string]> = [];
    if (shape.concurrency.length)
      facts.push([
        shape.concurrency.length > 1 ? 'concurrency swept' : 'concurrent requests',
        shape.concurrency.length > 1 ? shape.concurrency.join(', ') : String(shape.concurrency[0]),
      ]);
    if (shape.input.length)
      facts.push([
        shape.input.length > 1 ? 'prompt lengths' : 'prompt length',
        `${shape.input.map(fmtTokens).join(', ')} tokens`,
      ]);
    if (shape.output !== null) facts.push(['answer length', `${fmtTokens(shape.output)} tokens`]);
    if (shape.requests !== null) facts.push(['requests', fmtInt(shape.requests)]);
    if (p.repeat && Number(p.repeat) > 1) facts.push(['repeats', String(p.repeat)]);
    if (p.temperature !== undefined && p.temperature !== null)
      facts.push(['temperature', String(p.temperature)]);
    if (p.seed !== undefined && p.seed !== null) facts.push(['seed', String(p.seed)]);
    if (p.warmup_requests) facts.push(['warm-up requests', String(p.warmup_requests)]);
    if (p.timeout_s) facts.push(['timeout', `${String(p.timeout_s)} s`]);
    if (w.eval) {
      facts.push(['scorer', w.eval.scorer]);
      if (w.eval.max_output_tokens)
        facts.push(['max answer', `${fmtInt(w.eval.max_output_tokens)} tokens`]);
      if (w.eval.pass_threshold != null)
        facts.push(['pass threshold', String(w.eval.pass_threshold)]);
      if (w.eval.judge_model) facts.push(['judge model', w.eval.judge_model]);
    }

    return html`<div class="page">
      <div class="page-head">
        <div class="row-wrap xs muted">
          <a href="#/workloads">Workloads</a> ${icon('chevronRight')}
          <a href=${`#/workloads?kind=${w.kind}`}>${info.label}</a> ${icon('chevronRight')}
          <span class="mono">${w.id}</span>
        </div>
        <div class="row-wrap" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h1 class="row" style="gap:10px">${kindTag(w.kind)} ${w.name}</h1>
            <p class="lede mt-2">${w.description ?? info.what}</p>
          </div>
          <div class="head-actions">
            <a class="btn btn-sm" href=${`#/results?kind=${w.kind}&workload=${w.id}`}
              >${icon('table')} ${runs.length} runs</a
            >
            ${addButton(defaultSpec, { label: 'Run it somewhere', size: 'sm', primary: true })}
          </div>
        </div>
      </div>

      <div class="stats-strip mb-5">
        <div class="stat">
          <div class="v">${fmtInt(runs.length)}</div>
          <div class="k">runs</div>
        </div>
        <div class="stat">
          <div class="v">${cells.size}</div>
          <div class="k">cells measured</div>
        </div>
        <div class="stat">
          <div class="v">${models.size}</div>
          <div class="k">model / quant pairs</div>
        </div>
        <div class="stat">
          <div class="v">${devices.size}</div>
          <div class="k">devices</div>
        </div>
        ${
          dataset
            ? html`<div class="stat">
                <div class="v">${fmtInt(dataset.count)}</div>
                <div class="k">${dataset.kind === 'eval' ? 'questions' : 'prompts'} in the set</div>
              </div>`
            : nothing
        }
      </div>

      <div class="split">
        <section class="card">
          <div class="card-head">
            <h3>How the test works</h3>
            <span class="muted small">${info.number}</span>
          </div>
          <p class="small" style="line-height:1.55">${info.what}</p>
          <dl class="facts mt-3">
            ${facts.map(
              ([k, v]) =>
                html`<div class="fact">
                  <dt>${k}</dt>
                  <dd>${v}</dd>
                </div>`,
            )}
          </dl>
          ${
            w.eval?.categories?.length
              ? html`<div class="eyebrow plain mt-3 mb-1">Categories</div>
                  <div class="row-wrap" style="gap:3px">
                    ${w.eval.categories.map((c) => html`<span class="chip static">${c}</span>`)}
                  </div>`
              : nothing
          }
          <div class="eyebrow plain mt-3 mb-1">Numbers it must report</div>
          <div class="row-wrap" style="gap:3px">
            ${w.metrics_required.map((m) => html`<span class="tag mono">${m}</span>`)}
          </div>
          ${w.notes ? html`<p class="xs muted mt-3" style="line-height:1.5">${w.notes}</p>` : nothing}
        </section>

        <section class="card">
          <div class="card-head">
            <h3>${dataset ? 'The dataset' : 'Dataset'}</h3>
            ${dataset ? html`<span class="muted small mono">${dataset.id}</span>` : nothing}
          </div>
          ${
            dataset
              ? html`<div class="dataset-name">${dataset.name}</div>
                  <p class="small" style="line-height:1.55">${dataset.description ?? ''}</p>
                  <div class="sc-facts mt-2">
                    <span
                      ><b>${fmtInt(dataset.count)}</b>
                      ${dataset.kind === 'eval' ? 'questions' : 'items'}</span
                    >
                    <span><b>${dataset.kind}</b></span>
                    <span>${dataset.licence}</span>
                    ${dataset.created ? html`<span>created ${dataset.created}</span>` : nothing}
                  </div>
                  ${
                    dataset.categories?.length
                      ? html`<div class="row-wrap mt-2" style="gap:3px">
                          ${dataset.categories.map((c) => html`<span class="chip static">${c}</span>`)}
                        </div>`
                      : nothing
                  }
                  <div class="row-wrap mt-3">
                    <a
                      class="btn btn-xs"
                      href=${`${repo}/tree/${store.site.repo.default_branch}/datasets/${dataset.id}`}
                      target="_blank"
                      rel="noopener"
                      >${icon('github')} Browse the
                      ${dataset.kind === 'eval' ? 'questions' : 'prompts'}</a
                    >
                    ${dataset.generator ? html`<span class="xs muted">generated by <span class="mono">${dataset.generator}</span></span>` : nothing}
                  </div>`
              : html`<p class="small muted">This workload does not use a pinned dataset.</p>`
          }
        </section>
      </div>

      ${this.detailCharts(runs)}

      <section class="mt-5">
        <div class="section-title">
          <h2>Every run</h2>
          <span class="meta">${runs.length} · best first · click a row for the full recipe</span>
        </div>
        ${runs.length ? runsTable(runs, { limit: 30 }) : emptyState({ compact: true, title: 'Nobody has run this workload yet', text: 'Pick a cell on the atlas and add it, or use the button above for a featured cell.' })}
      </section>

      <details class="disclosure boxed mt-5">
        <summary>
          ${icon('chevronRight')}<span class="t">Definition</span
          ><span class="m"
            >the pinned JSON · immutable ${w.immutable === false ? 'no' : 'yes'} · created
            ${w.created ?? '–'}${w.supersedes ? ` · supersedes ${w.supersedes}` : ''}</span
          >
        </summary>
        <div class="body">
          ${codeBlock(JSON.stringify(w, null, 2), { lang: 'json', maxHeight: 520 })}
        </div>
      </details>
    </div>`;
  }

  /** Best per device, best per model, and how the numbers spread — all on this one workload. */
  private detailCharts(runs: IndexRow[]): TemplateResult | typeof nothing {
    const metric = firstMetricWithData(runs);
    if (!metric || runs.length < 2) return nothing;
    const byDevice = bestPerGroup(runs, (r) => r.hardware.id, metric).slice(0, 10);
    const byModel = bestPerGroup(runs, (r) => `${r.model.id}/${r.model.quant_id}`, metric).slice(
      0,
      10,
    );
    const values = runs.map((r) => metric.fromRow(r)).filter((v): v is number => v !== null);
    const hist = histogramBuild(values, {
      label: `${metric.short}${metric.unit ? ` (${metric.unit})` : ''}`,
      fmt: (v) => metric.fmt(v),
    });
    const max = metric.better === 'lower' ? Math.max(...values) : undefined;
    return html`<div class="insights mt-5">
      ${
        byDevice.length > 1
          ? html`<section class="card tight">
              <div class="card-head">
                <h3>Best per device</h3>
                <span class="muted small"
                  >${metric.label}${metric.unit ? ` (${metric.unit})` : ''}</span
                >
              </div>
              ${barList(
                byDevice.map((b) => ({
                  label: store.lookups.hardware.get(b.id)?.name ?? b.id,
                  title: `${b.id} — ${metric.fmt(b.value)} ${metric.unit} (${b.row.engine.id} ${b.row.engine.version}, ${b.row.model.id}/${b.row.model.quant_id})`,
                  value: b.value,
                  text: metric.fmt(b.value),
                  note: store.lookups.models.get(b.row.model.id)?.model.name ?? b.row.model.id,
                  color: `var(--${vendorClass(store.lookups.hardware.get(b.id)?.vendor)})`,
                  href: href('run', b.row.run_id),
                })),
                { max, ariaLabel: `Best ${metric.label} per device` },
              )}
            </section>`
          : nothing
      }
      ${
        byModel.length > 1
          ? html`<section class="card tight">
              <div class="card-head">
                <h3>Best per model</h3>
                <span class="muted small"
                  >${metric.label}${metric.unit ? ` (${metric.unit})` : ''}</span
                >
              </div>
              ${barList(
                byModel.map((b) => ({
                  label: `${store.lookups.models.get(b.row.model.id)?.model.name ?? b.row.model.id} / ${b.row.model.quant_id}`,
                  title: `${b.id} — ${metric.fmt(b.value)} ${metric.unit} on ${b.row.hardware.id} with ${b.row.engine.id}`,
                  value: b.value,
                  text: metric.fmt(b.value),
                  note: store.lookups.hardware.get(b.row.hardware.id)?.name ?? b.row.hardware.id,
                  href: modelHref(b.row.model.id),
                })),
                { max, ariaLabel: `Best ${metric.label} per model` },
              )}
            </section>`
          : nothing
      }
      ${
        hist
          ? html`<section class="card tight">
              <div class="card-head">
                <h3>How the numbers spread</h3>
                <span class="muted small">${fmtInt(values.length)} runs by ${metric.label}</span>
              </div>
              <atlas-chart
                .build=${hist}
                .height=${200}
                .key=${values.length}
                .chartTitle=${`${metric.label} — distribution`}
              ></atlas-chart>
            </section>`
          : nothing
      }
    </div>`;
  }
}
