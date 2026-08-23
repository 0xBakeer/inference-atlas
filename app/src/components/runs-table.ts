/** Compact runs table used by the registry detail pages and contributor profiles. */
import { html, nothing, type TemplateResult } from 'lit';
import type { IndexRow } from '../data/types.js';
import { href, navigate } from '../router.js';
import { store } from '../store.js';
import { headlineMetric } from '../util/metrics.js';
import { avatar, kindTag, verifBadge, when } from './ui.js';

export function runsTable(
  rows: IndexRow[],
  opts: { hide?: Array<'engine' | 'model' | 'hardware' | 'by'>; limit?: number } = {},
): TemplateResult {
  const hide = new Set(opts.hide ?? []);
  const shown = opts.limit ? rows.slice(0, opts.limit) : rows;
  const keyMetrics = store.site.coverage.key_metrics;
  if (rows.length === 0) return html`<p class="small muted">No runs yet.</p>`;
  return html`<div class="table-wrap">
      <table class="table cards">
        <thead>
          <tr>
            ${hide.has('engine') ? nothing : html`<th>engine</th>`}
            ${hide.has('model') ? nothing : html`<th>model / quant</th>`}
            ${hide.has('hardware') ? nothing : html`<th>hardware</th>`}
            <th>workload</th>
            <th class="num">headline</th>
            ${hide.has('by') ? nothing : html`<th>by</th>`}
            <th>verification</th>
            <th>when</th>
          </tr>
        </thead>
        <tbody>
          ${shown.map((r) => {
            const hl = headlineMetric(r, keyMetrics);
            return html`<tr class="clickable" @click=${() => navigate(href('run', r.run_id))}>
              ${hide.has('engine') ? nothing : html`<td class="mono xs primary" data-label="engine">${r.engine.id} <span class="muted">${r.engine.version}</span></td>`}
              ${hide.has('model') ? nothing : html`<td class="mono xs" data-label="model">${r.model.id}<span class="muted">/${r.model.quant_id}</span></td>`}
              ${hide.has('hardware') ? nothing : html`<td class="mono xs" data-label="hardware">${r.hardware.id}</td>`}
              <td data-label="workload">
                <span class="row" style="gap:6px"
                  >${kindTag(r.kind)}<span class="mono xs">${r.workload_id}</span></span
                >
              </td>
              <td class="num" data-label="headline">
                ${hl ? html`${hl.def.fmt(hl.value)}<span class="unit">${hl.def.unit}</span> <span class="xs muted">${hl.def.short}</span>` : html`<span class="null">–</span>`}
              </td>
              ${hide.has('by') ? nothing : html`<td data-label="by"><span class="row" style="gap:6px">${avatar(r.provenance.login, { userId: r.provenance.user_id, avatarUrl: r.provenance.avatar_url, size: 'sm' })}${r.provenance.login}</span></td>`}
              <td data-label="verification">${verifBadge(r.verification_level)}</td>
              <td data-label="when" class="xs">
                ${when(r.provenance.submitted_at ?? r.provenance.started_at)}
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>
    ${opts.limit && rows.length > opts.limit ? html`<p class="xs muted mt-1">Showing ${opts.limit} of ${rows.length}.</p>` : nothing}`;
}
