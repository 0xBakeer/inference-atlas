import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import type { Gap } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import { icon } from '../components/icons.js';
import { emptyState, selectField, skeletonLines, vendorDot } from '../components/ui.js';
import { href, modelHref, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { matchesQuery, uniqueSorted } from '../util/filters.js';
import { fmtInt } from '../util/format.js';
import { ViewElement } from './view-base.js';

@customElement('atlas-gaps-view')
export class AtlasGapsView extends ViewElement {
  override connectedCallback(): void {
    super.connectedCallback();
    void store.loadGaps();
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
    const shown = rows.slice(0, Number(f('n') ?? 50));
    const weights = store.site.wanted.weights;
    const spec = (g: Gap) => ({
      engine_id: g.engine_id,
      engine_version: g.engine_version,
      model_id: g.model_id,
      quant_id: g.quant_id,
      hardware_id: g.hardware_id,
      hw_count: g.hw_count,
      workload_ids: g.workload_ids,
    });

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Wanted</div>
        <div class="row-wrap" style="justify-content:space-between">
          <h1>${fmtInt(rows.length)} gap${rows.length === 1 ? '' : 's'} in the queue</h1>
          <div class="head-actions">
            <a class="btn btn-sm" href="#/contribute">${icon('sparkle')} Build your own packet</a>
          </div>
        </div>
        <p class="lede">
          Every row is a cell nobody has measured, ranked by how much the map would learn from it.
          Each one opens a packet that a coding agent — or you — can execute end to end.
        </p>
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
          'Engine',
          f('engine'),
          uniqueSorted(gaps.map((g) => g.engine_id)).map((v) => ({ value: v, label: v })),
          (v) => setQuery({ engine: v }),
        )}
        ${selectField(
          'Model',
          f('model'),
          uniqueSorted(gaps.map((g) => g.model_id)).map((v) => ({ value: v, label: v })),
          (v) => setQuery({ model: v }),
        )}
        ${selectField(
          'Hardware',
          f('hardware'),
          uniqueSorted(gaps.map((g) => g.hardware_id)).map((v) => ({ value: v, label: v })),
          (v) => setQuery({ hardware: v }),
        )}
        ${selectField(
          'Vendor',
          f('vendor'),
          uniqueSorted(reg.hardware.map((h) => h.vendor)).map((v) => ({ value: v, label: v })),
          (v) => setQuery({ vendor: v }),
        )}
        ${selectField(
          'Level',
          f('level'),
          uniqueSorted(gaps.map((g) => g.level)).map((v) => ({ value: v, label: v })),
          (v) => setQuery({ level: v }),
        )}
      </div>

      ${
        gaps.length === 0
          ? emptyState({
              title: 'The wanted queue has not been built',
              text: 'The build step writes gaps.json from the registry cross product. Until then, every grey square on the atlas is a gap — click one.',
              action: html`<a class="btn btn-primary" href="#/">${icon('grid')} Open the atlas</a>`,
            })
          : rows.length === 0
            ? emptyState({ title: 'Nothing matches', text: 'Loosen a filter.' })
            : html`<div class="card flush">
                <div style="padding:0 var(--sp-4)">
                  ${shown.map(
                    (g, i) =>
                      html`<div class="gap-row">
                        <span class="rank">${i + 1}</span>
                        <div class="what">
                          <div class="line">
                            <a href=${href('engines', g.engine_id)}>${g.engine_id}</a>
                            <span class="muted">${g.engine_version}</span>
                            <span class="faint">·</span>
                            <a class="mono" href=${modelHref(g.model_id)}>${g.model_id}</a
                            ><span class="muted">/${g.quant_id}</span>
                            <span class="faint">·</span>
                            ${vendorDot(store.lookups.hardware.get(g.hardware_id)?.vendor)}
                            <a href=${href('hardware', g.hardware_id)}>${g.hardware_id}</a>
                            ${g.level !== 'none' ? html`<span class="tag warn">${g.level}</span>` : nothing}
                          </div>
                          <div class="why">
                            ${g.reasons.map((r) => html`<span class="tag">${r}</span>`)}
                            <span class="muted"
                              >· ${g.workload_ids.length}
                              workload${g.workload_ids.length === 1 ? '' : 's'}</span
                            >
                          </div>
                        </div>
                        <span class="row" style="gap:6px">
                          <span class="score" title="wanted score">${g.score.toFixed(0)}</span>
                          <a
                            class="btn btn-sm btn-ghost"
                            href=${`#/explore?engine=${g.engine_id}&version=${g.engine_version}&model=${encodeURIComponent(g.model_id)}&quant=${g.quant_id}&hardware=${g.hardware_id}`}
                            title="Open in the explorer"
                            >${icon('sparkle')}</a
                          >
                          ${addButton(spec(g), { label: 'Add', size: 'sm' })}
                        </span>
                      </div>`,
                  )}
                </div>
                ${
                  rows.length > shown.length
                    ? html`<div
                        style="padding:var(--sp-3) var(--sp-4);border-top:1px solid var(--line)"
                      >
                        <button
                          class="btn btn-sm"
                          @click=${() => setQuery({ n: String(shown.length + 50) })}
                        >
                          Show 50 more of ${fmtInt(rows.length - shown.length)}
                        </button>
                      </div>`
                    : nothing
                }
              </div>`
      }

      <section class="mt-6">
        <div class="section-title"><h2>How gaps are scored</h2></div>
        <div class="card">
          <p class="small" style="max-width:70ch">
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
      </section>
    </div>`;
  }
}
