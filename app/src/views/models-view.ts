import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { addButton } from '../components/add-modal.js';
import { icon } from '../components/icons.js';
import '../components/mini-coverage.js';
import { runsTable } from '../components/runs-table.js';
import {
  barList,
  bestPerGroup,
  countPerGroup,
  firstMetricWithData,
} from '../components/stat-charts.js';
import { emptyState, extLink, kv, skeletonLines } from '../components/ui.js';
import { engineMinors, engineRunsOn, quantRunsOn } from '../data/derive.js';
import type { IndexRow, RegistryModel } from '../data/types.js';
import { href, modelHref, qget, qlist, setQuery } from '../router.js';
import { store } from '../store.js';
import { vendorClass } from '../util/colors.js';
import { matchesQuery, uniqueSorted } from '../util/filters.js';
import { fmtInt, fmtParams, fmtTokens } from '../util/format.js';
import { ViewElement } from './view-base.js';

/** CSS variable carrying the vendor hue of a device id. */
function vendorVar(hardwareId: string): string {
  return `var(--${vendorClass(store.lookups.hardware.get(hardwareId)?.vendor)})`;
}

@customElement('atlas-models-view')
export class AtlasModelsView extends ViewElement {
  @property({ attribute: false }) itemId: string | null = null;

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(6)}</div>`;
    return this.itemId ? this.detail(this.itemId) : this.list();
  }

  private coverageOf(
    pred: (pc: {
      model_id: string;
      quant_id: string;
      hardware_id: string;
      engine_id: string;
      cell_id: string;
    }) => boolean,
  ) {
    let p = 0;
    let c = 0;
    const cov = store.coverage.value;
    for (const pc of store.possible) {
      if (!pred(pc)) continue;
      p++;
      if (cov[pc.cell_id]) c++;
    }
    return { p, c };
  }

  private list(): TemplateResult {
    const reg = store.registry.value!;
    const q = this.q;
    const search = qget(q, 'q') ?? '';
    const families = qlist(q, 'family');
    const sizes = qlist(q, 'size');
    const mods = qlist(q, 'modality');
    const lic = qlist(q, 'licence');
    const sizeBucket = (b: number) =>
      b < 10 ? '<10B' : b < 40 ? '10–40B' : b < 100 ? '40–100B' : '100B+';
    const toggle = (key: string, val: string, cur: string[]) =>
      setQuery({
        [key]: (cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val]).join(',') || null,
      });
    const rows = reg.models.filter(
      (m) =>
        matchesQuery(
          `${m.model.id} ${m.model.name} ${m.model.family ?? ''} ${m.model.vendor} ${m.model.architecture ?? ''} ${(m.model.tags ?? []).join(' ')}`,
          search,
        ) &&
        (!families.length || families.includes(m.model.family ?? '')) &&
        (!sizes.length || sizes.includes(sizeBucket(m.model.params_b))) &&
        (!mods.length ||
          mods.some((x) => (m.model.modalities ?? ['text']).includes(x as 'text'))) &&
        (!lic.length || lic.includes(m.model.licence ?? 'unknown')),
    );
    const runCount = (id: string) => store.index.value.filter((r) => r.model.id === id).length;
    const chips = (label: string, key: string, values: string[], cur: string[]) =>
      html`<div class="row-wrap">
        <span class="xs muted" style="min-width:64px">${label}</span
        >${values.map((v) => html`<button class="chip" aria-pressed=${cur.includes(v)} @click=${() => toggle(key, v, cur)}>${v}</button>`)}
      </div>`;
    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Registry · models</div>
        <div class="row-wrap" style="justify-content:space-between">
          <h1>
            ${fmtInt(rows.length)} model${rows.length === 1 ? '' : 's'},
            ${fmtInt(rows.reduce((n, m) => n + m.quants.length, 0))} quantizations
          </h1>
          ${addButton({ kind: 'new-model' }, { label: 'Add a model', size: 'sm' })}
        </div>
        <p class="lede">
          Models are registered first; quantizations are child records. A model is "measured" when
          any of its quants has a run on any device.
        </p>
      </div>
      <div class="col mb-4" style="gap:8px">
        <div class="search-input" style="max-width:360px">
          ${icon('search')}<input
            class="input"
            type="search"
            placeholder="Search models…"
            .value=${search}
            @input=${(e: Event) => setQuery({ q: (e.target as HTMLInputElement).value || null })}
          />
        </div>
        ${chips('family', 'family', uniqueSorted(reg.models.map((m) => m.model.family ?? '').filter(Boolean)), families)}
        ${chips('size', 'size', ['<10B', '10–40B', '40–100B', '100B+'], sizes)}
        ${chips('modality', 'modality', uniqueSorted(reg.models.flatMap((m) => m.model.modalities ?? ['text'])), mods)}
        ${chips('licence', 'licence', uniqueSorted(reg.models.map((m) => m.model.licence ?? 'unknown')), lic)}
      </div>
      ${this.listCharts()}
      ${
        rows.length === 0
          ? emptyState({
              title: 'No models match',
              text: 'Try a different filter — or register the model you were looking for.',
              action: addButton({ kind: 'new-model' }, { label: 'Add a model' }),
            })
          : html`<div class="reg-list">
              ${rows.map((m) => {
                const { p, c } = this.coverageOf((x) => x.model_id === m.model.id);
                return html`<a class="reg-card" href=${modelHref(m.model.id)}>
                  <span class="name"
                    >${m.model.name}
                    ${m.model.moe ? html`<span class="tag">MoE</span>` : nothing}</span
                  >
                  <span class="id mono">${m.model.id}</span>
                  <span class="facts">
                    <span
                      >${fmtParams(m.model.params_b)}${m.model.moe && m.model.active_params_b ? ` (${fmtParams(m.model.active_params_b)} active)` : ''}</span
                    >
                    <span>${fmtTokens(m.model.context_length)} ctx</span>
                    <span>${m.quants.length} quant${m.quants.length === 1 ? '' : 's'}</span>
                    <span>${runCount(m.model.id)} run${runCount(m.model.id) === 1 ? '' : 's'}</span>
                  </span>
                  <span class="tags"
                    >${(m.model.modalities ?? ['text']).map((x) => html`<span class="tag">${x}</span>`)}<span
                      class="tag"
                      >${m.model.licence ?? 'licence ?'}</span
                    >${(m.model.tags ?? []).slice(0, 3).map((t) => html`<span class="tag">${t}</span>`)}</span
                  >
                  <span class="cov"
                    ><i class="bar"><i style="width:${(c / Math.max(1, p)) * 100}%"></i></i
                    >${c}/${p} cells</span
                  >
                </a>`;
              })}
            </div>`
      }
    </div>`;
  }

  /** How this model's quants and devices compare on what was actually measured. */
  private detailCharts(runs: IndexRow[]): TemplateResult | typeof nothing {
    const metric = firstMetricWithData(runs);
    if (!metric) return nothing;
    const lowerMax = (xs: number[]) =>
      metric.better === 'lower' ? Math.max(...xs) : undefined;
    const byQuant = bestPerGroup(runs, (r) => r.model.quant_id, metric).slice(0, 10);
    const byHw = bestPerGroup(runs, (r) => r.hardware.id, metric).slice(0, 10);
    if (!byQuant.length && !byHw.length) return nothing;
    return html`<section class="mt-5">
      <div class="section-title">
        <h2>Measured</h2>
        <span class="meta"
          >best ${metric.label}${metric.unit ? ` (${metric.unit})` : ''} recorded so far</span
        >
      </div>
      <div class="insights">
        ${
          byQuant.length
            ? html`<section class="card tight">
                <div class="card-head">
                  <h3>By quantization</h3>
                  <span class="muted small">${byQuant.length} measured</span>
                </div>
                ${barList(
                  byQuant.map((b) => ({
                    label: b.id,
                    title: `${b.id} — ${metric.fmt(b.value)} ${metric.unit} on ${b.row.hardware.id}`,
                    value: b.value,
                    text: metric.fmt(b.value),
                    note: b.row.hardware.id,
                    href: href('run', b.row.run_id),
                  })),
                  { max: lowerMax(byQuant.map((b) => b.value)), ariaLabel: `Best ${metric.label} per quantization` },
                )}
              </section>`
            : nothing
        }
        ${
          byHw.length
            ? html`<section class="card tight">
                <div class="card-head">
                  <h3>By hardware</h3>
                  <span class="muted small">${byHw.length} devices measured</span>
                </div>
                ${barList(
                  byHw.map((b) => ({
                    label: b.id,
                    title: `${b.id} — ${metric.fmt(b.value)} ${metric.unit} (${b.row.model.quant_id})`,
                    value: b.value,
                    text: metric.fmt(b.value),
                    note: b.row.model.quant_id,
                    color: vendorVar(b.id),
                    href: href('run', b.row.run_id),
                  })),
                  { max: lowerMax(byHw.map((b) => b.value)), ariaLabel: `Best ${metric.label} per device` },
                )}
              </section>`
            : nothing
        }
      </div>
    </section>`;
  }

  /** Measured leaders across the registry — only models that actually have runs. */
  private listCharts(): TemplateResult | typeof nothing {
    const rows = store.index.value;
    const metric = firstMetricWithData(rows);
    if (!metric) return nothing;
    const best = bestPerGroup(rows, (r) => r.model.id, metric).slice(0, 10);
    const counts = countPerGroup(rows, (r) => r.model.id).slice(0, 10);
    if (!best.length) return nothing;
    return html`<div class="insights">
      <section class="card tight">
        <div class="card-head">
          <h3>${metric.better === 'lower' ? 'Best' : 'Fastest'} measured</h3>
          <span class="muted small"
            >best ${metric.label}${metric.unit ? ` (${metric.unit})` : ''} per model</span
          >
        </div>
        ${barList(
          best.map((b) => ({
            label: b.id,
            title: `${b.id} — best ${metric.fmt(b.value)} ${metric.unit} (${b.row.model.quant_id} on ${b.row.hardware.id})`,
            value: b.value,
            text: metric.fmt(b.value),
            note: `${b.row.model.quant_id} · ${b.row.hardware.id}`,
            href: modelHref(b.id),
          })),
          {
            max: metric.better === 'lower' ? Math.max(...best.map((b) => b.value)) : undefined,
            ariaLabel: `Best ${metric.label} per model`,
          },
        )}
      </section>
      <section class="card tight">
        <div class="card-head">
          <h3>Most measured</h3>
          <span class="muted small">runs per model</span>
        </div>
        ${barList(
          counts.map((c) => ({
            label: c.id,
            value: c.count,
            text: fmtInt(c.count),
            color: 'var(--chart-2)',
            href: modelHref(c.id),
          })),
          { ariaLabel: 'Runs per model' },
        )}
      </section>
    </div>`;
  }

  private detail(id: string): TemplateResult {
    const reg = store.registry.value!;
    const entry: RegistryModel | undefined = store.lookups.models.get(id);
    if (!entry) {
      return html`<div class="page">
        ${emptyState({ title: `No model “${id}” in the registry`, text: 'A model id is its Hugging Face repo id, verbatim — models/<owner>/<name>/model.json in the registry. Register it and it appears here.', action: html`<div class="row">${addButton({ kind: 'new-model', target_name: id }, { label: 'Register this model' })}<a class="btn" href="#/models">All models</a></div>` })}
      </div>`;
    }
    const m = entry.model;
    const runs = store.index.value
      .filter((r) => r.model.id === id)
      .sort((a, b) =>
        (b.provenance.submitted_at ?? '').localeCompare(a.provenance.submitted_at ?? ''),
      );
    const { p, c } = this.coverageOf((x) => x.model_id === id);
    // missing: engine × hardware combos for each quant with no runs; show the top few by featured-ness
    const featured = reg.site.featured ?? {};
    const missing: Array<{ quant: string; engine: string; version: string; hardware: string }> = [];
    for (const qq of entry.quants) {
      for (const e of reg.engines) {
        if (!quantRunsOn(qq, e)) continue;
        const latest = engineMinors(e).at(-1);
        if (!latest) continue;
        for (const hw of reg.hardware) {
          if (!engineRunsOn(e, hw)) continue;
          if (
            runs.some(
              (r) =>
                r.model.quant_id === qq.id && r.engine.id === e.meta.id && r.hardware.id === hw.id,
            )
          )
            continue;
          missing.push({
            quant: qq.id,
            engine: e.meta.id,
            version: latest.version,
            hardware: hw.id,
          });
        }
      }
    }
    const score = (x: (typeof missing)[number]) =>
      ((featured.hardware ?? []).includes(x.hardware) ? 2 : 0) +
      ((featured.engines ?? []).includes(x.engine) ? 1 : 0);
    missing.sort((a, b) => score(b) - score(a));

    return html`<div class="page">
      <div class="page-head">
        <div class="row-wrap xs muted">
          <a href="#/models">Models</a> ${icon('chevronRight')} <span class="mono">${m.id}</span>
        </div>
        <div class="row-wrap" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h1>${m.name} ${m.moe ? html`<span class="tag">MoE</span>` : nothing}</h1>
            <p class="lede mt-2">${m.notes ?? ''}</p>
          </div>
          <div class="head-actions">
            <a
              class="btn btn-sm"
              href=${`#/?rows=quant&cols=hardware&model=${encodeURIComponent(m.id)}`}
              >${icon('grid')} On the atlas</a
            >
            <a class="btn btn-sm" href=${`#/results?model=${encodeURIComponent(m.id)}`}
              >${icon('table')} ${runs.length} runs</a
            >
          </div>
        </div>
      </div>

      <div class="split facts-quants">
        <section class="card">
          <div class="card-head"><h3>Facts</h3></div>
          ${kv([
            ['id', html`<span class="mono">${m.id}</span>`],
            [
              'Hugging Face',
              m.hf_id ? extLink(`https://huggingface.co/${m.hf_id}`, m.hf_id) : null,
            ],
            ['vendor', m.vendor],
            ['family', m.family ?? null],
            [
              'parameters',
              `${fmtParams(m.params_b)}${m.moe ? ` total · ${fmtParams(m.active_params_b)} active` : ''}`,
            ],
            m.moe
              ? ['experts', `${m.experts ?? '?'} total · ${m.experts_active ?? '?'} active`]
              : null,
            [
              'architecture',
              m.architecture ? html`<span class="mono xs">${m.architecture}</span>` : null,
            ],
            ['attention', m.attention ?? null],
            ['context', `${fmtTokens(m.context_length)} tokens`],
            ['modalities', (m.modalities ?? ['text']).join(', ')],
            ['licence', m.licence ?? null],
            ['released', m.released ?? null],
            [
              'tags',
              (m.tags ?? []).length
                ? html`<span class="row-wrap" style="gap:4px"
                    >${(m.tags ?? []).map((t) => html`<span class="tag">${t}</span>`)}</span
                  >`
                : null,
            ],
            ...Object.entries(m.links ?? {})
              .filter(([, v]) => v)
              .map(([k, v]) => [k, extLink(v!, v!)] as [string, TemplateResult]),
            ['coverage', `${c} of ${p} possible cells measured`],
          ])}
        </section>

        <section>
          <div class="section-title">
            <h2>Quantizations</h2>
            <span class="meta">${entry.quants.length}</span>
          </div>
          <div class="table-wrap">
            <table class="table cards">
              <thead>
                <tr>
                  <th>quant</th>
                  <th>format</th>
                  <th class="num">bits</th>
                  <th class="num">size</th>
                  <th>engines</th>
                  <th>source</th>
                  <th>weights</th>
                  <th class="num">runs</th>
                </tr>
              </thead>
              <tbody>
                ${entry.quants.map((qq) => {
                  const n = runs.filter((r) => r.model.quant_id === qq.id).length;
                  return html`<tr>
                    <td class="mono primary">${qq.id}</td>
                    <td class="mono xs" data-label="format">${qq.format}</td>
                    <td class="num" data-label="bits">${qq.bits}</td>
                    <td class="num" data-label="size">
                      ${qq.size_gb != null ? `${qq.size_gb} GB` : html`<span class="null">–</span>`}
                    </td>
                    <td data-label="engines">
                      <span class="row-wrap" style="gap:3px"
                        >${qq.engines.map((e) => html`<a class="tag mono" href=${href('engines', e)} style="color:inherit">${e}</a>`)}</span
                      >
                    </td>
                    <td data-label="source">
                      <span class="tag ${qq.source === 'official' ? 'ok' : ''}">${qq.source}</span>
                    </td>
                    <td data-label="weights" class="xs">
                      ${qq.hf_id ? extLink(`https://huggingface.co/${qq.hf_id}`, qq.hf_id) : html`<span class="null">–</span>`}${qq.ollama_tag ? html`<br /><span class="mono muted">${qq.ollama_tag}</span>` : nothing}
                    </td>
                    <td class="num" data-label="runs">${n}</td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>
          ${entry.quants.some((qq) => qq.notes) ? html`<div class="col mt-2" style="gap:4px">${entry.quants.filter((qq) => qq.notes).map((qq) => html`<p class="xs muted"><span class="mono">${qq.id}</span> — ${qq.notes}</p>`)}</div>` : nothing}
        </section>
      </div>

      <section class="mt-5">
        <div class="section-title">
          <h2>Coverage</h2>
          <span class="meta">quantization × hardware, any engine</span>
        </div>
        <atlas-mini-coverage
          .rowKey=${'quant'}
          .colKey=${'hardware'}
          .filters=${{ model: m.id }}
        ></atlas-mini-coverage>
      </section>

      ${this.detailCharts(runs)}

      <section class="mt-5">
        <div class="section-title">
          <h2>Runs</h2>
          <span class="meta">${runs.length}</span>
        </div>
        ${runsTable(runs, { hide: ['model'], limit: 30 })}
      </section>

      <section class="mt-5">
        <div class="section-title">
          <h2>Missing</h2>
          <span class="meta"
            >${fmtInt(missing.length)} engine × hardware combinations with no run, most wanted
            first</span
          >
        </div>
        ${
          missing.length
            ? html`<div class="missing-list">
                  ${missing.slice(0, 12).map(
                    (x) =>
                      html`<div class="missing-row">
                        <span class="grow"
                          ><span class="mono xs">${m.id}/${x.quant}</span>
                          <span class="faint">·</span>
                          <span class="mono xs">${x.engine} ${x.version}</span>
                          <span class="faint">·</span>
                          <span class="mono xs">${x.hardware}</span></span
                        >
                        ${addButton({ engine_id: x.engine, engine_version: x.version, model_id: m.id, quant_id: x.quant, hardware_id: x.hardware }, { label: 'Add', size: 'sm' })}
                      </div>`,
                  )}
                </div>
                ${missing.length > 12 ? html`<p class="xs muted mt-2">…and ${fmtInt(missing.length - 12)} more. <a href=${`#/gaps?model=${encodeURIComponent(m.id)}`}>See them in the wanted queue</a>.</p>` : nothing}`
            : html`<p class="small muted">
                Every possible combination has at least one run. Remarkable.
              </p>`
        }
      </section>
    </div>`;
  }
}
