import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Hardware } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import { icon } from '../components/icons.js';
import '../components/mini-coverage.js';
import { runsTable } from '../components/runs-table.js';
import {
  emptyState,
  extLink,
  kv,
  skeletonLines,
  sortIcon,
  vendorDot,
  who,
} from '../components/ui.js';
import { engineRunsOn, quantRunsOn } from '../data/derive.js';
import { href, modelHref, navigate, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { matchesQuery, parseSort, serializeSort, sortRows, toggleSort } from '../util/filters.js';
import { fmtInt, fmtNum, fmtTokS, fmtUsd } from '../util/format.js';
import { ViewElement } from './view-base.js';

@customElement('atlas-hardware-view')
export class AtlasHardwareView extends ViewElement {
  @property({ attribute: false }) itemId: string | null = null;

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(6)}</div>`;
    return this.itemId ? this.detail(this.itemId) : this.list();
  }

  private covOf(id: string) {
    let p = 0;
    let c = 0;
    const cov = store.coverage.value;
    for (const pc of store.possible) {
      if (pc.hardware_id !== id) continue;
      p++;
      if (cov[pc.cell_id]) c++;
    }
    return { p, c };
  }

  private list(): TemplateResult {
    const reg = store.registry.value!;
    const q = this.q;
    const search = qget(q, 'q') ?? '';
    const vendor = qget(q, 'vendor');
    const kind = qget(q, 'kind');
    const sort = parseSort(qget(q, 'sort'), { key: 'name', dir: 'asc' });
    const runCount = (id: string) => store.index.value.filter((r) => r.hardware.id === id).length;
    const acc: Record<string, (h: Hardware) => string | number | null | undefined> = {
      name: (h) => h.name,
      vendor: (h) => h.vendor,
      memory: (h) => h.memory_gb,
      bandwidth: (h) => h.memory_bandwidth_gbs,
      tflops: (h) => h.compute?.fp16_tflops ?? h.compute?.bf16_tflops ?? h.compute?.fp32_tflops,
      tdp: (h) => h.tdp_w,
      price: (h) => h.msrp_usd,
      year: (h) => h.release_year,
      runs: (h) => runCount(h.id),
      coverage: (h) => this.covOf(h.id).c,
    };
    let rows = reg.hardware.filter(
      (h) =>
        matchesQuery(`${h.id} ${h.name} ${h.vendor} ${(h.aliases ?? []).join(' ')}`, search) &&
        (!vendor || h.vendor === vendor) &&
        (!kind || h.kind === kind),
    );
    rows = sortRows(rows, acc[sort.key] ?? acc.name!, sort.dir);
    const th = (key: string, label: string, num = false) =>
      html`<th
        class="sortable ${num ? 'num' : ''}"
        aria-sort=${sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : nothing}
        @click=${() => setQuery({ sort: serializeSort(toggleSort(sort, key, num ? 'desc' : 'asc')) })}
      >
        ${label}${sortIcon(sort.key === key, sort.dir)}
      </th>`;
    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Registry · hardware</div>
        <div class="row-wrap" style="justify-content:space-between">
          <h1>${fmtInt(rows.length)} device${rows.length === 1 ? '' : 's'}</h1>
          ${addButton({ kind: 'new-hardware' }, { label: 'Add hardware', size: 'sm' })}
        </div>
        <p class="lede">
          Memory bandwidth is the number that matters for single-stream decode: dense decode tok/s ≈
          bandwidth ÷ weight GB. Each device page shows that ceiling for every registered quant.
        </p>
      </div>
      <div class="filters mb-3">
        <div class="search-input" style="min-width:220px">
          ${icon('search')}<input
            class="input"
            type="search"
            placeholder="Search devices…"
            .value=${search}
            @input=${(e: Event) => setQuery({ q: (e.target as HTMLInputElement).value || null })}
          />
        </div>
        <label class="field"
          ><span class="label">Vendor</span
          ><select
            class="select"
            @change=${(e: Event) => setQuery({ vendor: (e.target as HTMLSelectElement).value || null })}
          >
            <option value="">All</option>
            ${[...new Set(reg.hardware.map((h) => h.vendor))].sort().map((v) => html`<option value=${v} ?selected=${v === vendor}>${v}</option>`)}
          </select></label
        >
        <label class="field"
          ><span class="label">Kind</span
          ><select
            class="select"
            @change=${(e: Event) => setQuery({ kind: (e.target as HTMLSelectElement).value || null })}
          >
            <option value="">All</option>
            ${['gpu', 'soc', 'cpu', 'accelerator'].map((v) => html`<option value=${v} ?selected=${v === kind}>${v}</option>`)}
          </select></label
        >
      </div>
      <div class="table-wrap">
        <table class="table cards">
          <thead>
            <tr>
              ${th('name', 'device')}${th('vendor', 'vendor')}${th('memory', 'memory', true)}${th('bandwidth', 'bandwidth', true)}${th('tflops', 'fp16 TFLOPS', true)}${th('tdp', 'TDP', true)}${th('price', 'MSRP', true)}${th('year', 'year', true)}${th('runs', 'runs', true)}${th('coverage', 'cells', true)}
            </tr>
          </thead>
          <tbody>
            ${rows.map((h) => {
              const { p, c } = this.covOf(h.id);
              return html`<tr class="clickable" @click=${() => navigate(href('hardware', h.id))}>
                <td class="primary">
                  <span class="row" style="gap:8px"
                    >${vendorDot(h.vendor)}<span>${h.name}</span
                    ><span class="mono xs muted">${h.id}</span></span
                  >
                </td>
                <td data-label="vendor">${h.vendor}</td>
                <td class="num" data-label="memory">
                  ${h.memory_gb ?? '–'}<span class="unit">GB</span>
                </td>
                <td class="num" data-label="bandwidth">
                  ${h.memory_bandwidth_gbs ?? '–'}<span class="unit">GB/s</span>
                </td>
                <td class="num" data-label="TFLOPS">${acc.tflops!(h) ?? '–'}</td>
                <td class="num" data-label="TDP">${h.tdp_w ?? '–'}<span class="unit">W</span></td>
                <td class="num" data-label="MSRP">${fmtUsd(h.msrp_usd)}</td>
                <td class="num" data-label="year">${h.release_year ?? '–'}</td>
                <td class="num" data-label="runs">${runCount(h.id)}</td>
                <td class="num" data-label="cells">${c}<span class="unit">/ ${p}</span></td>
              </tr>`;
            })}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  private detail(id: string): TemplateResult {
    const reg = store.registry.value!;
    const h = store.lookups.hardware.get(id);
    if (!h) {
      return html`<div class="page">
        ${emptyState({ title: `No device “${id}” in the registry`, text: 'If you own it: capture it with the harness and register it from the captured output. Never type specs by hand.', action: html`<div class="row">${addButton({ kind: 'new-hardware', target_name: id }, { label: 'Register this device' })}<a class="btn" href="#/hardware">All hardware</a></div>` })}
      </div>`;
    }
    const runs = store.index.value
      .filter((r) => r.hardware.id === id)
      .sort((a, b) =>
        (b.provenance.submitted_at ?? '').localeCompare(a.provenance.submitted_at ?? ''),
      );
    const { p, c } = this.covOf(id);
    const owners = [...new Set(runs.map((r) => r.provenance.login))];
    const contributors = store.contributors.value;
    const ownersFromContribs = contributors
      ? contributors.filter((x) => x.hardware_ids.includes(id)).map((x) => x.login)
      : [];
    const allOwners = [...new Set([...owners, ...ownersFromContribs])];
    const bw = h.memory_bandwidth_gbs ?? null;
    // ceiling table: every registered quant that fits, with the theoretical dense decode ceiling
    const ceilings = reg.models
      .flatMap((m) => m.quants.map((qq) => ({ m, qq })))
      .filter(({ qq }) => qq.size_gb != null && (!h.memory_gb || qq.size_gb! <= h.memory_gb))
      .map(({ m, qq }) => {
        const weight =
          m.model.moe && m.model.active_params_b
            ? (qq.size_gb! * m.model.active_params_b) / m.model.params_b
            : qq.size_gb!;
        const ceiling = bw ? bw / weight : null;
        const measured = runs
          .filter((r) => r.model.id === m.model.id && r.model.quant_id === qq.id)
          .map((r) => r.metrics.decode_tok_s_per_request ?? null)
          .filter((v): v is number => v !== null);
        return { m, qq, weight, ceiling, best: measured.length ? Math.max(...measured) : null };
      })
      .sort(
        (a, b) =>
          (b.best !== null ? 1 : 0) - (a.best !== null ? 1 : 0) ||
          (b.ceiling ?? 0) - (a.ceiling ?? 0),
      );
    const engines = reg.engines.filter((e) => engineRunsOn(e, h));
    // gaps: engine × model/quant without runs, top few
    const gaps: Array<{ engine: string; version: string; model: string; quant: string }> = [];
    for (const e of engines) {
      const v = e.versions.at(-1);
      if (!v) continue;
      for (const m of reg.models)
        for (const qq of m.quants) {
          if (!quantRunsOn(qq, e)) continue;
          if (h.memory_gb && qq.size_gb && qq.size_gb > h.memory_gb) continue;
          if (
            runs.some(
              (r) =>
                r.engine.id === e.meta.id &&
                r.model.id === m.model.id &&
                r.model.quant_id === qq.id,
            )
          )
            continue;
          gaps.push({ engine: e.meta.id, version: v, model: m.model.id, quant: qq.id });
        }
    }
    const featured = reg.site.featured ?? {};
    gaps.sort(
      (a, b) =>
        ((featured.models ?? []).includes(b.model) ? 2 : 0) +
        ((featured.engines ?? []).includes(b.engine) ? 1 : 0) -
        (((featured.models ?? []).includes(a.model) ? 2 : 0) +
          ((featured.engines ?? []).includes(a.engine) ? 1 : 0)),
    );

    return html`<div class="page">
      <div class="page-head">
        <div class="row-wrap xs muted">
          <a href="#/hardware">Hardware</a> ${icon('chevronRight')}
          <span class="mono">${h.id}</span>
        </div>
        <div class="row-wrap" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h1 class="row" style="gap:10px">${vendorDot(h.vendor)} ${h.name}</h1>
            <p class="lede mt-2">${h.notes ?? ''}</p>
          </div>
          <div class="head-actions">
            <a class="btn btn-sm" href=${`#/?rows=model&cols=engine&hardware=${h.id}`}
              >${icon('grid')} On the atlas</a
            >
            <a class="btn btn-sm" href=${`#/results?hardware=${h.id}`}
              >${icon('table')} ${runs.length} runs</a
            >
          </div>
        </div>
      </div>

      <div class="spec-card mb-4">
        ${[
          ['memory', h.memory_gb, 'GB', h.memory_type ?? ''],
          ['bandwidth', h.memory_bandwidth_gbs, 'GB/s', ''],
          [
            'fp16',
            h.compute?.fp16_tflops ?? h.compute?.bf16_tflops,
            'TFLOPS',
            h.compute?.arch ?? '',
          ],
          ['fp8', h.compute?.fp8_tflops, 'TFLOPS', ''],
          ['fp4', h.compute?.fp4_tflops, 'TFLOPS', ''],
          ['TDP', h.tdp_w, 'W', ''],
          ['MSRP', h.msrp_usd, 'USD', h.release_year ? `${h.release_year}` : ''],
        ]
          .filter(([, v]) => v != null)
          .map(
            ([k, v, u, sub]) =>
              html`<div class="spec">
                <div class="k">${k}</div>
                <div class="v">
                  ${typeof v === 'number' ? fmtNum(v, v % 1 ? 1 : 0) : v}<span class="unit"
                    >${u}</span
                  >
                </div>
                ${sub ? html`<div class="xs muted">${sub}</div>` : nothing}
              </div>`,
          )}
      </div>

      <div class="split facts-wide">
        <section class="card">
          <div class="card-head"><h3>Spec</h3></div>
          ${kv([
            ['id', html`<span class="mono">${h.id}</span>`],
            ['vendor / kind', `${h.vendor} · ${h.kind}`],
            ['form factor', h.form_factor ?? null],
            ['aliases', (h.aliases ?? []).length ? (h.aliases ?? []).join(', ') : null],
            [
              'arch',
              h.compute?.arch
                ? `${h.compute.arch}${h.compute.sm ? ` (sm ${h.compute.sm})` : ''}`
                : null,
            ],
            ['cores', h.compute?.cores ?? null],
            ['cloud price', h.typical_cloud_usd_per_h ? `$${h.typical_cloud_usd_per_h}/h` : null],
            [
              'detect',
              h.detect
                ? html`<span class="mono xs"
                    >${Object.entries(h.detect)
                      .filter(([, v]) => (Array.isArray(v) ? v.length : v != null))
                      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' | ') : v}`)
                      .join(' · ')}</span
                  >`
                : null,
            ],
            ...Object.entries(h.links ?? {})
              .filter(([, v]) => v)
              .map(([k, v]) => [k, extLink(v!, v!)] as [string, TemplateResult]),
            [
              'engines that run here',
              html`<span class="row-wrap" style="gap:3px"
                >${engines.map((e) => html`<a class="tag mono" href=${href('engines', e.meta.id)} style="color:inherit">${e.meta.id}</a>`)}</span
              >`,
            ],
            ['coverage', `${c} of ${p} possible cells measured`],
            [
              'owned by',
              allOwners.length
                ? html`<span class="row-wrap"
                    >${allOwners.map((l) => who(l, { size: 'sm' }))}</span
                  >`
                : html`<span class="faint">nobody has reported runs from this device yet</span>`,
            ],
          ])}
        </section>

        <section class="card">
          <div class="card-head">
            <h3>Bandwidth ceiling</h3>
            <span class="muted small">dense decode ≈ bandwidth ÷ weight GB</span>
          </div>
          <p class="small muted mb-3">
            ${
              bw
                ? html`At ${bw} GB/s, a single stream cannot decode faster than the weights can be
                  read once per token. The ceiling below is that bound (MoE uses active weights);
                  speculative decoding is the only way past it. Measured numbers are the best
                  single-stream decode on this device.`
                : 'No bandwidth figure is registered for this device, so no ceiling can be computed — a pull request with the vendor figure would fix that.'
            }
          </p>
          ${
            ceilings.length
              ? html`<div class="ceiling table-wrap" style="max-height:360px">
                  <table>
                    <thead>
                      <tr>
                        <th>model / quant</th>
                        <th class="num">weights</th>
                        <th class="num">ceiling</th>
                        <th class="num">measured</th>
                        <th class="num">of ceiling</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${ceilings.slice(0, 40).map(
                        (x) =>
                          html`<tr>
                            <td>
                              <a href=${modelHref(x.m.model.id)} style="color:inherit"
                                >${x.m.model.id}</a
                              ><span class="muted">/${x.qq.id}</span>
                            </td>
                            <td class="num">${fmtNum(x.weight, 1)} GB</td>
                            <td class="num">
                              ${x.ceiling === null ? '–' : `${fmtTokS(x.ceiling)}`}
                            </td>
                            <td class="num">
                              ${x.best === null ? html`<span class="faint">–</span>` : html`<b>${fmtTokS(x.best)}</b>`}
                            </td>
                            <td class="num">
                              ${x.best !== null && x.ceiling ? `${Math.round((x.best / x.ceiling) * 100)}%` : ''}
                            </td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>`
              : nothing
          }
        </section>
      </div>

      <section class="mt-5">
        <div class="section-title">
          <h2>Coverage</h2>
          <span class="meta">model × engine on this device</span>
        </div>
        <atlas-mini-coverage
          .rowKey=${'model'}
          .colKey=${'engine'}
          .filters=${{ hardware: h.id }}
        ></atlas-mini-coverage>
      </section>

      <section class="mt-5">
        <div class="section-title">
          <h2>Runs</h2>
          <span class="meta">${runs.length}</span>
        </div>
        ${runsTable(runs, { hide: ['hardware'], limit: 30 })}
      </section>

      <section class="mt-5">
        <div class="section-title">
          <h2>Gaps</h2>
          <span class="meta"
            >${fmtInt(gaps.length)} engine × model/quant combinations that fit in memory and have no
            run</span
          >
        </div>
        ${
          gaps.length
            ? html`<div class="missing-list">
                  ${gaps.slice(0, 12).map(
                    (g) =>
                      html`<div class="missing-row">
                        <span class="grow"
                          ><span class="mono xs">${g.engine} ${g.version}</span>
                          <span class="faint">·</span>
                          <span class="mono xs">${g.model}/${g.quant}</span></span
                        >
                        ${addButton({ engine_id: g.engine, engine_version: g.version, model_id: g.model, quant_id: g.quant, hardware_id: h.id }, { label: 'Add', size: 'sm' })}
                      </div>`,
                  )}
                </div>
                ${gaps.length > 12 ? html`<p class="xs muted mt-2">…and ${fmtInt(gaps.length - 12)} more. <a href=${`#/gaps?hardware=${h.id}`}>See them in the wanted queue</a>.</p>` : nothing}`
            : html`<p class="small muted">Everything that fits has been measured at least once.</p>`
        }
      </section>
    </div>`;
  }
}
