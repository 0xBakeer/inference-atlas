import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { addButton } from '../components/add-modal.js';
import { icon } from '../components/icons.js';
import { emptyState, selectField, skeletonLines } from '../components/ui.js';
import { resolveSelection } from '../components/cell-picker.js';
import { href, modelHref, navigate, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { seqStep } from '../util/colors.js';
import { fmtPct } from '../util/format.js';
import { ViewElement } from './view-base.js';

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
    const rows = [...pairs.values()].sort(
      (a, b) => a.model.localeCompare(b.model) || a.quant.localeCompare(b.quant),
    );
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
    // score for ordering rows: mean accuracy across suites
    const score = (p: { model: string; quant: string }) => {
      const vals = suites
        .map((s) => best(p.model, p.quant, s.id)?.metrics.accuracy ?? null)
        .filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : -1;
    };
    rows.sort((a, b) => score(b) - score(a));

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Evals</div>
        <h1>Did it still answer correctly?</h1>
        <p class="lede">
          A serving number without a capability check is incomplete. Rows are model/quant pairs,
          columns are pinned eval suites, cells are the best accuracy measured. Empty cells are gaps
          with a packet attached.
        </p>
      </div>
      <div class="filters mb-3">
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
        <span class="spacer"></span>
        <span class="legend-inline" style="padding-bottom:6px">
          <span class="xs muted">accuracy</span>
          ${[0, 1, 2, 3, 4, 5].map((s) => html`<i class="sw" style="background:var(--seq-${s});margin-right:0"></i>`)}
          <span class="xs muted">0 → 100%</span>
        </span>
      </div>
      ${
        suites.length === 0
          ? emptyState({
              title: 'No eval workloads registered',
              text: 'Eval suites are pinned workloads of kind "eval" under workloads/.',
            })
          : rows.length === 0
            ? emptyState({
                title: store.index.value.length === 0 ? 'No eval runs yet' : 'No runs match',
                text:
                  store.index.value.length === 0
                    ? 'The suites are pinned and waiting. Show every registered model/quant — each empty cell opens a ready-made packet.'
                    : 'Loosen the filters or show every registered model/quant.',
                action: html`<button class="btn btn-primary" @click=${() => setQuery({ all: true })}>
                  Show every registered model/quant
                </button>`,
              })
            : html`<div class="table-wrap">
                  <table class="table">
                    <thead>
                      <tr>
                        <th style="position:sticky;left:0;z-index:2">model / quant</th>
                        ${suites.map((s) => html`<th class="center" title=${s.description ?? s.name}><a href=${href('workloads', s.id)} style="color:inherit">${s.id.replace(/^eval-/, '').replace(/-v\d+$/, '')}</a></th>`)}
                        <th class="num">mean</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rows.map((p) => {
                        const sc = score(p);
                        return html`<tr>
                          <td
                            class="mono xs"
                            style="position:sticky;left:0;background:var(--surface);z-index:1"
                          >
                            <a href=${modelHref(p.model)} style="color:inherit">${p.model}</a
                            ><span class="muted">/${p.quant}</span>
                          </td>
                          ${suites.map((s) => {
                        const b = best(p.model, p.quant, s.id);
                        if (!b) {
                          const sel = resolveSelection(
                            { engine, model: p.model, quant: p.quant, hardware },
                            { requireAll: true },
                          );
                          return html`<td class="center" style="padding:2px 6px">
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
                          style="background:var(--seq-${step});color:${dark ? 'var(--surface)' : 'var(--ink)'};cursor:pointer"
                          title=${`${b.engine.id} ${b.engine.version} on ${b.hardware.id} — click to open`}
                          @click=${() => navigate(href('run', b.run_id))}
                        >
                          ${fmtPct(b.metrics.accuracy, 1)}
                        </td>`;
                      })}
                          <td class="num">
                            ${sc < 0 ? html`<span class="null">–</span>` : fmtPct(sc, 1)}
                          </td>
                        </tr>`;
                      })}
                    </tbody>
                  </table>
                </div>
                <p class="xs muted mt-2">
                  ${evalRows.length} eval
                  run${evalRows.length === 1 ? '' : 's'}${evalRows.length === 0 ? ' — the eval suites exist but nobody has run one yet. Every cell above is a packet.' : ''}.
                  ${icon('flag')} buttons open the packet for that suite.
                </p>`
      }
    </div>`;
  }
}
