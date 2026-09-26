import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { Gap } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import { icon } from '../components/icons.js';
import { barList } from '../components/stat-charts.js';
import { emptyState, selectField, skeletonLines, vendorDot } from '../components/ui.js';
import { vendorClass } from '../util/colors.js';
import { href, modelHref, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { matchesQuery, uniqueSorted } from '../util/filters.js';
import { fmtInt } from '@atlas/core';
import { ViewElement } from './view-base.js';

/**
 * A gap's reasons in a few words. The build writes one reason per scoring rule, so a top gap
 * carries eight of them; the reader wants the two that matter and the rest on hover.
 */
function whyShort(g: Gap): { lead: string[]; rest: string[] } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of g.reasons) {
    const t = r
      .replace(/^featured hardware .*/, 'wanted device')
      .replace(/^featured model .*/, 'wanted model')
      .replace(/^featured engine .*/, 'wanted engine')
      .replace(/^newest (\S+) minor.*/, 'newest $1')
      .replace(/^(.*) has never been measured$/, (_m, x: string) =>
        x === g.hardware_id
          ? 'device never measured'
          : x === g.engine_id
            ? 'engine never measured'
            : x.startsWith(g.model_id)
              ? 'model never measured'
              : 'never measured',
      )
      .replace(/^(\d+) workloads?$/, '$1 workloads');
    if (/^\d+ workloads$/.test(t)) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return { lead: out.slice(0, 2), rest: out.slice(2) };
}

@customElement('atlas-gaps-view')
export class AtlasGapsView extends ViewElement {
  override connectedCallback(): void {
    super.connectedCallback();
    void store.loadGaps();
  }

  /** Where the queue concentrates: gaps per device and per engine, under the current filters. */
  private queueCharts(rows: Gap[]): TemplateResult | typeof nothing {
    if (rows.length < 3) return nothing;
    const count = (key: (g: Gap) => string) => {
      const m = new Map<string, number>();
      for (const g of rows) m.set(key(g), (m.get(key(g)) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    };
    const byHw = count((g) => g.hardware_id);
    const byEngine = count((g) => g.engine_id);
    const byModel = count((g) => g.model_id);
    return html`<div class="insights">
      <section class="card tight">
        <div class="card-head">
          <h3>By device</h3>
          <span class="muted small">a box like this would help most</span>
        </div>
        ${barList(
          byHw.map(([id, n]) => ({
            label: store.lookups.hardware.get(id)?.name ?? id,
            value: n,
            text: fmtInt(n),
            color: `var(--${vendorClass(store.lookups.hardware.get(id)?.vendor)})`,
            href: `#/gaps?hardware=${id}`,
          })),
          { ariaLabel: 'Open gaps per device' },
        )}
      </section>
      <section class="card tight">
        <div class="card-head">
          <h3>By engine</h3>
          <span class="muted small">in the current queue</span>
        </div>
        ${barList(
          byEngine.map(([id, n]) => ({
            label: store.lookups.engines.get(id)?.meta.name ?? id,
            value: n,
            text: fmtInt(n),
            color: 'var(--chart-2)',
            href: `#/gaps?engine=${id}`,
          })),
          { ariaLabel: 'Open gaps per engine' },
        )}
      </section>
      <section class="card tight">
        <div class="card-head">
          <h3>By model</h3>
          <span class="muted small">most wanted first</span>
        </div>
        ${barList(
          byModel.map(([id, n]) => ({
            label: store.lookups.models.get(id)?.model.name ?? id,
            value: n,
            text: fmtInt(n),
            color: 'var(--chart-1)',
            href: `#/gaps?model=${encodeURIComponent(id)}`,
          })),
          { ariaLabel: 'Open gaps per model' },
        )}
      </section>
    </div>`;
  }

  override render() {
    const reg = store.registry.value;
    const gaps = store.gaps.value;
    if (!reg || gaps === null) return html`<div class="page">${skeletonLines(8)}</div>`;
    const q = this.q;
    const f = (k: string) => qget(q, k);
    const search = f('q') ?? '';
    const rows = gaps.filter(
      (g) =>
        (!f('engine') || g.engine_id === f('engine')) &&
        (!f('model') || g.model_id === f('model')) &&
        (!f('hardware') || g.hardware_id === f('hardware')) &&
        (!f('vendor') || store.lookups.hardware.get(g.hardware_id)?.vendor === f('vendor')) &&
        (!f('level') || g.level === f('level')) &&
        matchesQuery(
          `${g.engine_id} ${g.engine_version} ${g.model_id} ${g.quant_id} ${g.hardware_id} ${g.reasons.join(' ')}`,
          search,
        ),
    );
    const shown = rows.slice(0, Number(f('n') ?? 25));
    const weights = store.site.wanted.weights;
    const active = ['engine', 'model', 'hardware', 'vendor', 'level', 'q'].filter((k) => f(k));
    const spec = (g: Gap) => ({
      engine_id: g.engine_id,
      engine_version: g.engine_version,
      model_id: g.model_id,
      quant_id: g.quant_id,
      hardware_id: g.hardware_id,
      hw_count: g.hw_count,
      workload_ids: g.workload_ids,
    });
    const devices = new Set(rows.map((g) => g.hardware_id)).size;
    const modelsN = new Set(rows.map((g) => g.model_id)).size;
    const enginesN = new Set(rows.map((g) => g.engine_id)).size;
    const lk = store.lookups;

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Wanted</div>
        <div class="row-wrap" style="justify-content:space-between">
          <h1>Pick a square nobody has measured</h1>
          <div class="head-actions">
            <a class="btn btn-sm" href="#/contribute">${icon('sparkle')} Build your own packet</a>
          </div>
        </div>
        <p class="lede">
          Every row is a model, a quantization, a device and an engine that nobody has put a number
          on yet, ranked by how much the map would learn from it. Each one opens a packet that a
          coding agent — or you — can run end to end in about twenty minutes.
        </p>
      </div>

      <div class="stats-strip mb-5">
        <div class="stat">
          <div class="v">${fmtInt(rows.length)}</div>
          <div class="k">gaps in the queue</div>
        </div>
        <div class="stat">
          <div class="v">${devices}</div>
          <div class="k">devices wanted</div>
        </div>
        <div class="stat">
          <div class="v">${modelsN}</div>
          <div class="k">models</div>
        </div>
        <div class="stat">
          <div class="v">${enginesN}</div>
          <div class="k">engines</div>
        </div>
        <div class="stat">
          <div class="v">${shown[0] ? shown[0].score.toFixed(0) : '–'}</div>
          <div class="k">top wanted score</div>
        </div>
      </div>

      <div class="filters mb-3">
        <div class="search-input" style="min-width:220px">
          ${icon('search')}<input
            class="input"
            type="search"
            placeholder="Search gaps…"
            .value=${search}
            @input=${(e: Event) => setQuery({ q: (e.target as HTMLInputElement).value || null })}
          />
        </div>
        ${selectField(
          'Hardware',
          f('hardware'),
          uniqueSorted(gaps.map((g) => g.hardware_id)).map((v) => ({
            value: v,
            label: lk.hardware.get(v)?.name ?? v,
          })),
          (v) => setQuery({ hardware: v }),
        )}
        ${selectField(
          'Model',
          f('model'),
          uniqueSorted(gaps.map((g) => g.model_id)).map((v) => ({
            value: v,
            label: lk.models.get(v)?.model.name ?? v,
          })),
          (v) => setQuery({ model: v }),
        )}
        ${selectField(
          'Engine',
          f('engine'),
          uniqueSorted(gaps.map((g) => g.engine_id)).map((v) => ({
            value: v,
            label: lk.engines.get(v)?.meta.name ?? v,
          })),
          (v) => setQuery({ engine: v }),
        )}
        ${selectField(
          'Vendor',
          f('vendor'),
          uniqueSorted(reg.hardware.map((h) => h.vendor)).map((v) => ({ value: v, label: v })),
          (v) => setQuery({ vendor: v }),
        )}
        ${active.length ? html`<button class="btn btn-ghost btn-sm" @click=${() => setQuery(Object.fromEntries([...active, 'n'].map((k) => [k, null])))}>${icon('x')} Clear</button>` : nothing}
      </div>

      ${this.queueCharts(rows)}
      ${
        gaps.length === 0
          ? emptyState({
              title: 'The wanted queue has not been built',
              text: 'The build step writes gaps.json from the registry cross product. Until then, every grey square on the atlas is a gap — click one.',
              action: html`<a class="btn btn-primary" href="#/">${icon('grid')} Open the atlas</a>`,
            })
          : rows.length === 0
            ? emptyState({ title: 'Nothing matches', text: 'Loosen a filter.' })
            : html`<div class="table-wrap">
                  <table class="table gaps-table">
                    <thead>
                      <tr>
                        <th class="num">#</th>
                        <th>Model / quant</th>
                        <th>Device</th>
                        <th>Engine</th>
                        <th>Why it matters</th>
                        <th class="num">Tests</th>
                        <th class="num">Score</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${shown.map((g, i) => {
                        const why = whyShort(g);
                        const hw = lk.hardware.get(g.hardware_id);
                        return html`<tr>
                          <td class="num rank ${i < 3 ? 'top' : ''}">${i + 1}</td>
                          <td class="primary">
                            <a href=${modelHref(g.model_id)}
                              >${lk.models.get(g.model_id)?.model.name ?? g.model_id}</a
                            >
                            <span class="mono xs muted">/${g.quant_id}</span>
                          </td>
                          <td>
                            <span class="row" style="gap:6px"
                              >${vendorDot(hw?.vendor)}
                              <a href=${href('hardware', g.hardware_id)}
                                >${hw?.name ?? g.hardware_id}</a
                              >${g.hw_count > 1 ? html` <span class="muted">×${g.hw_count}</span>` : nothing}</span
                            >
                          </td>
                          <td>
                            <a href=${href('engines', g.engine_id)}
                              >${lk.engines.get(g.engine_id)?.meta.name ?? g.engine_id}</a
                            >
                            <span class="mono xs muted ver" title=${g.engine_version}
                              >${g.engine_version}</span
                            >
                          </td>
                          <td class="why" title=${g.reasons.join('\n')}>
                            ${why.lead.map((r) => html`<span class="chip static">${r}</span>`)}
                            ${why.rest.length ? html`<span class="xs muted">+${why.rest.length}</span>` : nothing}
                            ${g.level !== 'none' ? html`<span class="tag warn">${g.level}</span>` : nothing}
                          </td>
                          <td class="num" title=${g.workload_ids.join(', ')}>
                            ${g.workload_ids.length}
                          </td>
                          <td class="num score">${g.score.toFixed(0)}</td>
                          <td class="right nowrap">
                            <a
                              class="btn btn-xs btn-ghost"
                              href=${`#/explore?engine=${g.engine_id}&version=${g.engine_version}&model=${encodeURIComponent(g.model_id)}&quant=${g.quant_id}&hardware=${g.hardware_id}`}
                              title="Open in the explorer"
                              >${icon('sparkle')}</a
                            >
                            ${addButton(spec(g), { label: 'Add', size: 'sm' })}
                          </td>
                        </tr>`;
                      })}
                    </tbody>
                  </table>
                </div>
                ${
                  rows.length > shown.length
                    ? html`<div class="row mt-3" style="gap:8px">
                        <button
                          class="btn btn-sm"
                          @click=${() => setQuery({ n: String(shown.length + 25) })}
                        >
                          Show 25 more
                        </button>
                        <span class="xs muted"
                          >${fmtInt(shown.length)} of ${fmtInt(rows.length)}</span
                        >
                      </div>`
                    : nothing
                }`
      }

      <details class="disclosure boxed mt-6">
        <summary>
          ${icon('chevronRight')}<span class="t">How gaps are scored</span
          ><span class="m"
            >the registry cross product, minus what has runs, plus a weight per reason</span
          >
        </summary>
        <div class="body">
          <p class="small" style="max-width:80ch;line-height:1.55">
            The build crosses every model × quant × device × engine minor the registry says is
            physically possible (the quant lists the engine, the engine supports the format, the
            engine has a platform the device can host), subtracts cells that have runs, and adds
            points for each reason below. Requests from the issue form count too. The top
            ${store.site.wanted.max_gaps ?? 500} are published.
          </p>
          <div class="row-wrap mt-3">
            ${Object.entries(weights).map(([k, v]) => html`<span class="tag" title=${k}>${k.replace(/_/g, ' ')} <b class="mono" style="margin-left:4px">+${v}</b></span>`)}
          </div>
        </div>
      </details>
    </div>`;
  }
}
