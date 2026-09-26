import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { Dataset, Workload } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import '../components/chart.js';
import { icon } from '../components/icons.js';
import { barList, histogramBuild } from '../components/stat-charts.js';
import { emptyState, selectField, skeletonLines } from '../components/ui.js';
import { resolveSelection } from '../components/cell-picker.js';
import type { IndexRow } from '../data/types.js';
import { href, modelHref, navigate, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { seqStep } from '../util/colors.js';
import { fmtInt, fmtPct } from '@atlas/core';
import { ViewElement } from './view-base.js';

/** "eval-code-v1" → "code"; the suite's short name for headers and chips. */
export function suiteShort(id: string): string {
  return id.replace(/^eval-/, '').replace(/-v\d+$/, '');
}

/** First sentence of a description, for a card. */
function firstSentence(text: string | null | undefined): string {
  if (!text) return '';
  const m = /^(.{20,220}?[.!?])(\s|$)/.exec(text);
  return m ? m[1]! : text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

interface SuiteStats {
  w: Workload;
  dataset: Dataset | null;
  runs: IndexRow[];
  best: IndexRow | null;
  mean: number | null;
  pairs: number;
}

@customElement('atlas-evals-view')
export class AtlasEvalsView extends ViewElement {
  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(6)}</div>`;
    const q = this.q;
    const hardware = qget(q, 'hardware');
    const engine = qget(q, 'engine');
    const showAll = q.get('all') === '1';
    const suites = reg.workloads.filter((w) => w.kind === 'eval');
    const evalRows = store.index.value.filter(
      (r) =>
        r.kind === 'eval' &&
        (!hardware || r.hardware.id === hardware) &&
        (!engine || r.engine.id === engine),
    );
    const anyRows = store.index.value.filter(
      (r) => (!hardware || r.hardware.id === hardware) && (!engine || r.engine.id === engine),
    );
    const pairs = new Map<string, { model: string; quant: string }>();
    const source = showAll
      ? reg.models.flatMap((m) => m.quants.map((qq) => ({ model: m.model.id, quant: qq.id })))
      : anyRows.map((r) => ({ model: r.model.id, quant: r.model.quant_id }));
    for (const p of source) pairs.set(`${p.model}/${p.quant}`, p);
    const rows = [...pairs.values()];
    const best = (model: string, quant: string, suite: string) => {
      const rs = evalRows.filter(
        (r) =>
          r.model.id === model &&
          r.model.quant_id === quant &&
          r.workload_id === suite &&
          r.metrics.accuracy != null,
      );
      if (!rs.length) return null;
      return rs.reduce((a, b) => ((b.metrics.accuracy ?? 0) > (a.metrics.accuracy ?? 0) ? b : a));
    };
    const score = (p: { model: string; quant: string }) => {
      const vals = suites
        .map((s) => best(p.model, p.quant, s.id)?.metrics.accuracy ?? null)
        .filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : -1;
    };
    rows.sort((a, b) => score(b) - score(a) || a.model.localeCompare(b.model));

    const stats: SuiteStats[] = suites
      .map((w) => {
        const rs = evalRows.filter((r) => r.workload_id === w.id && r.metrics.accuracy != null);
        const accs = rs.map((r) => r.metrics.accuracy!);
        return {
          w,
          dataset: reg.datasets.find((d) => d.id === w.dataset_id) ?? null,
          runs: rs,
          best: rs.length
            ? rs.reduce((a, b) => ((b.metrics.accuracy ?? 0) > (a.metrics.accuracy ?? 0) ? b : a))
            : null,
          mean: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
          pairs: new Set(rs.map((r) => `${r.model.id}/${r.model.quant_id}`)).size,
        };
      })
      .sort((a, b) => b.runs.length - a.runs.length || a.w.id.localeCompare(b.w.id));
    const allAcc = evalRows.map((r) => r.metrics.accuracy).filter((v): v is number => v != null);
    const overallMean = allAcc.length ? allAcc.reduce((a, b) => a + b, 0) / allAcc.length : null;
    const evaluated = new Set(evalRows.map((r) => `${r.model.id}/${r.model.quant_id}`)).size;

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Evals</div>
        <h1>Did it still answer correctly?</h1>
        <p class="lede">
          Speed means nothing if the quantized model, the engine or a flag broke the answers. Every
          eval suite is a pinned question set with a fixed scorer, run at temperature 0, so a score
          on one box is comparable to the same suite on any other.
        </p>
      </div>

      <div class="stats-strip mb-5">
        <div class="stat">
          <div class="v">${suites.length}</div>
          <div class="k">suites</div>
        </div>
        <div class="stat">
          <div class="v">${fmtInt(evalRows.length)}</div>
          <div class="k">eval runs</div>
        </div>
        <div class="stat">
          <div class="v">${fmtInt(evaluated)}</div>
          <div class="k">model / quant pairs scored</div>
        </div>
        <div class="stat">
          <div class="v">${overallMean === null ? '–' : fmtPct(overallMean, 0)}</div>
          <div class="k">mean accuracy, all runs</div>
        </div>
        <div class="stat">
          <div class="v">${stats.filter((s) => s.runs.length === 0).length}</div>
          <div class="k">suites nobody has run</div>
        </div>
      </div>

      <div class="filters mb-4">
        ${selectField(
          'Hardware',
          hardware,
          reg.hardware.map((h) => ({ value: h.id, label: h.name })),
          (v) => setQuery({ hardware: v }),
        )}
        ${selectField(
          'Engine',
          engine,
          reg.engines.map((e) => ({ value: e.meta.id, label: e.meta.name })),
          (v) => setQuery({ engine: v }),
        )}
        <label class="switch" style="padding-bottom:6px"
          ><input
            type="checkbox"
            .checked=${showAll}
            @change=${(e: Event) => setQuery({ all: (e.target as HTMLInputElement).checked })}
          /><span class="track"></span>Every registered model/quant</label
        >
      </div>

      ${
        suites.length === 0
          ? emptyState({
              title: 'No eval workloads registered',
              text: 'Eval suites are pinned workloads of kind "eval" under workloads/.',
            })
          : html`
              <section class="mb-6">
                <div class="section-title">
                  <h2>The suites</h2>
                  <span class="meta"
                    >what each one tests, how it is scored, and the best score so far · most run
                    first</span
                  >
                </div>
                <div class="suite-grid">${stats.map((s) => this.suiteCard(s))}</div>
              </section>

              ${this.charts(stats, evalRows, rows, score)}

              <section class="mt-6">
                <div class="section-title">
                  <h2>Score matrix</h2>
                  <span class="meta"
                    >best accuracy per model/quant and suite · click a score for the run, a flag to
                    add the missing one</span
                  >
                  <span class="spacer"></span>
                  <span class="legend-inline">
                    <span class="xs muted">0%</span>
                    ${[0, 1, 2, 3, 4, 5].map((s) => html`<i class="sw" style="background:var(--seq-${s});margin-right:0"></i>`)}
                    <span class="xs muted">100%</span>
                  </span>
                </div>
                ${
                  rows.length === 0
                    ? emptyState({
                        title:
                          store.index.value.length === 0 ? 'No eval runs yet' : 'No runs match',
                        text: 'Loosen the filters or show every registered model/quant — each empty cell opens a ready-made packet.',
                        action: html`<button
                          class="btn btn-primary"
                          @click=${() => setQuery({ all: true })}
                        >
                          Show every registered model/quant
                        </button>`,
                      })
                    : this.matrix(rows, suites, best, score, engine, hardware)
                }
              </section>
            `
      }
    </div>`;
  }

  private suiteCard(s: SuiteStats): TemplateResult {
    const w = s.w;
    const d = s.dataset;
    const what = firstSentence(d?.description) || firstSentence(w.description) || '';
    const cats = w.eval?.categories ?? d?.categories ?? [];
    return html`<article class="suite-card ${s.runs.length ? '' : 'empty'}">
      <div class="sc-head">
        <a class="sc-name" href=${href('workloads', w.id)}>${w.name}</a>
        <span class="mono xs muted">${w.id}</span>
      </div>
      <p class="sc-what">${what || html`<span class="faint">No description yet.</span>`}</p>
      <div class="sc-facts">
        <span title="questions in the set"><b>${d ? fmtInt(d.count) : '–'}</b> items</span>
        <span title="how answers are scored"><b>${w.eval?.scorer ?? '–'}</b> scorer</span>
        ${w.eval?.max_output_tokens ? html`<span><b>${fmtInt(w.eval.max_output_tokens)}</b> max tokens</span>` : nothing}
        ${d?.licence ? html`<span>${d.licence}</span>` : nothing}
      </div>
      ${
        cats.length
          ? html`<div class="sc-cats">
              ${cats.slice(0, 6).map((c) => html`<span class="chip static">${c}</span>`)}
              ${cats.length > 6 ? html`<span class="chip static">+${cats.length - 6}</span>` : nothing}
            </div>`
          : nothing
      }
      <div class="sc-result">
        ${
          s.best
            ? html`<div class="best">
                  <span class="k">best so far</span>
                  <a class="v" href=${href('run', s.best.run_id)}
                    >${fmtPct(s.best.metrics.accuracy, 1)}</a
                  >
                  <span class="who ellipsis" title=${`${s.best.model.id}/${s.best.model.quant_id}`}
                    >${store.lookups.models.get(s.best.model.id)?.model.name ?? s.best.model.id}
                    <span class="muted">/${s.best.model.quant_id}</span></span
                  >
                </div>
                <div class="mean">
                  <span class="k">mean</span>
                  <span class="v">${s.mean === null ? '–' : fmtPct(s.mean, 0)}</span>
                  <span class="muted xs"
                    >${s.runs.length} run${s.runs.length === 1 ? '' : 's'} · ${s.pairs}
                    model${s.pairs === 1 ? '' : 's'}</span
                  >
                </div>`
            : html`<div class="best">
                <span class="k">nobody has run this suite</span>
                <span class="muted xs">every score on it will be a first</span>
              </div>`
        }
      </div>
      <div class="sc-links">
        <a class="btn btn-xs" href=${href('workloads', w.id)}>${icon('file')} Suite</a>
        ${d ? html`<a class="btn btn-xs btn-ghost" href=${`${this.repo()}/tree/${store.site.repo.default_branch}/datasets/${d.id}`} target="_blank" rel="noopener">${icon('github')} Questions</a>` : nothing}
        ${s.runs.length ? html`<a class="btn btn-xs btn-ghost" href=${`#/results?kind=eval&workload=${w.id}`}>${icon('table')} ${s.runs.length} runs</a>` : nothing}
      </div>
    </article>`;
  }

  private repo(): string {
    const s = store.site;
    return `${s.repo.host ?? 'https://github.com'}/${s.repo.owner}/${s.repo.name}`;
  }

  private charts(
    stats: SuiteStats[],
    evalRows: IndexRow[],
    rows: Array<{ model: string; quant: string }>,
    score: (p: { model: string; quant: string }) => number,
  ): TemplateResult | typeof nothing {
    const measured = stats.filter((s) => s.mean !== null);
    if (!measured.length) return nothing;
    const hardest = [...measured].sort((a, b) => a.mean! - b.mean!).slice(0, 12);
    const accs = evalRows.map((r) => r.metrics.accuracy).filter((v): v is number => v != null);
    const hist = histogramBuild(
      accs.map((v) => v * 100),
      { label: 'accuracy (%)', fmt: (v) => `${Math.round(v)}%`, bins: 20 },
    );
    const scored = rows
      .map((p) => ({ ...p, sc: score(p) }))
      .filter((p) => p.sc >= 0)
      .slice(0, 12);
    return html`<div class="insights">
      <section class="card tight">
        <div class="card-head">
          <h3>Hardest suites</h3>
          <span class="muted small">mean accuracy across every run · lowest first</span>
        </div>
        ${barList(
          hardest.map((s) => ({
            label: s.w.name,
            title: `${s.w.id} — mean ${fmtPct(s.mean, 1)} over ${s.runs.length} runs`,
            value: s.mean,
            text: fmtPct(s.mean, 0),
            note: `${s.runs.length} runs`,
            color: `var(--seq-${Math.max(1, seqStep(s.mean) ?? 1)})`,
            href: href('workloads', s.w.id),
          })),
          { max: 1, ariaLabel: 'Mean accuracy per suite' },
        )}
      </section>
      ${
        hist
          ? html`<section class="card tight">
              <div class="card-head">
                <h3>How scores spread</h3>
                <span class="muted small">${fmtInt(accs.length)} eval runs by accuracy</span>
              </div>
              <atlas-chart
                .build=${hist}
                .height=${200}
                .key=${accs.length}
                .chartTitle=${'Eval accuracy distribution'}
                .subtitle=${`${fmtInt(accs.length)} eval runs · Inference Atlas`}
              ></atlas-chart>
            </section>`
          : nothing
      }
      ${
        scored.length >= 2
          ? html`<section class="card tight">
              <div class="card-head">
                <h3>Best models overall</h3>
                <span class="muted small">mean accuracy across the suites they ran</span>
              </div>
              ${barList(
                scored.map((p) => ({
                  label: `${store.lookups.models.get(p.model)?.model.name ?? p.model} / ${p.quant}`,
                  title: `${p.model}/${p.quant} — mean ${fmtPct(p.sc, 1)}`,
                  value: p.sc,
                  text: fmtPct(p.sc, 1),
                  color: `var(--seq-${Math.max(1, seqStep(p.sc) ?? 1)})`,
                  href: modelHref(p.model),
                })),
                { max: 1, ariaLabel: 'Mean eval accuracy per model/quant' },
              )}
            </section>`
          : nothing
      }
    </div>`;
  }

  private matrix(
    rows: Array<{ model: string; quant: string }>,
    suites: Workload[],
    best: (m: string, q: string, s: string) => IndexRow | null,
    score: (p: { model: string; quant: string }) => number,
    engine: string | null,
    hardware: string | null,
  ): TemplateResult {
    return html`<div class="table-wrap eval-matrix">
        <table class="table">
          <thead>
            <tr>
              <th class="sticky-col">model / quant</th>
              ${suites.map(
                (s) =>
                  html`<th class="center" title=${s.description ?? s.name}>
                    <a href=${href('workloads', s.id)} style="color:inherit">${suiteShort(s.id)}</a>
                  </th>`,
              )}
              <th class="num">mean</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((p) => {
              const sc = score(p);
              return html`<tr>
                <td class="sticky-col">
                  <a href=${modelHref(p.model)} class="ellipsis" title=${`${p.model}/${p.quant}`}
                    >${store.lookups.models.get(p.model)?.model.name ?? p.model}</a
                  ><span class="mono xs muted"> /${p.quant}</span>
                </td>
                ${suites.map((s) => {
                  const b = best(p.model, p.quant, s.id);
                  if (!b) {
                    const sel = resolveSelection(
                      { engine, model: p.model, quant: p.quant, hardware },
                      { requireAll: true },
                    );
                    return html`<td class="center gap">
                      ${
                        sel.engine && sel.hardware
                          ? addButton(
                              {
                                engine_id: sel.engine,
                                engine_version: sel.version,
                                model_id: p.model,
                                quant_id: p.quant,
                                hardware_id: sel.hardware,
                                workload_ids: [s.id],
                              },
                              {
                                label: '',
                                size: 'xs',
                                title: `Add ${s.id} for ${p.model}/${p.quant}`,
                              },
                            )
                          : html`<span class="faint">–</span>`
                      }
                    </td>`;
                  }
                  const step = seqStep(b.metrics.accuracy);
                  const dark = step !== null && step >= 4;
                  return html`<td
                    class="center num clickable"
                    style="background:var(--seq-${step});color:${dark ? 'var(--surface)' : 'var(--ink)'}"
                    title=${`${b.engine.id} ${b.engine.version} on ${b.hardware.id} — click to open`}
                    @click=${() => navigate(href('run', b.run_id))}
                  >
                    ${fmtPct(b.metrics.accuracy, 0)}
                  </td>`;
                })}
                <td class="num">${sc < 0 ? html`<span class="null">–</span>` : fmtPct(sc, 0)}</td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
      <p class="xs muted mt-2">
        ${icon('flag')} opens the packet for that suite; pick a hardware and an engine above to
        enable it.
      </p>`;
  }
}
