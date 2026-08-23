import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { EngineVersion } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import { icon } from '../components/icons.js';
import '../components/mini-coverage.js';
import { fmtDefault } from '../components/param-form.js';
import { runsTable } from '../components/runs-table.js';
import {
  codeBlock,
  emptyState,
  extLink,
  kv,
  selectField,
  skeletonLines,
} from '../components/ui.js';
import { engineMinors, engineRunsOn, quantRunsOn } from '../data/derive.js';
import { href, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { versionDiff } from '../util/diff.js';
import { fmtInt } from '../util/format.js';
import { ViewElement } from './view-base.js';

@customElement('atlas-engines-view')
export class AtlasEnginesView extends ViewElement {
  @property({ attribute: false }) itemId: string | null = null;
  @state() private files = new Map<string, EngineVersion | null>();

  protected override willUpdate(_c: PropertyValues): void {
    const id = this.itemId;
    const e = id ? store.lookups.engines.get(id) : null;
    if (!e) return;
    for (const v of e.versions) {
      const k = `${id}/${v}`;
      if (!this.files.has(k)) {
        this.files = new Map(this.files).set(k, null);
        void store
          .engineVersion(id!, v)
          .then((vf) => (this.files = new Map(this.files).set(k, vf)));
      }
    }
  }

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
      if (pc.engine_id !== id) continue;
      p++;
      if (cov[pc.cell_id]) c++;
    }
    return { p, c };
  }

  private list(): TemplateResult {
    const reg = store.registry.value!;
    const runCount = (id: string) => store.index.value.filter((r) => r.engine.id === id).length;
    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Registry · engines</div>
        <div class="row-wrap" style="justify-content:space-between">
          <h1>
            ${fmtInt(reg.engines.length)} engines,
            ${fmtInt(reg.engines.reduce((n, e) => n + e.versions.length, 0))} versions
          </h1>
          ${addButton({ kind: 'new-engine' }, { label: 'Add an engine', size: 'sm' })}
        </div>
        <p class="lede">
          Every engine version carries its own flag schema with real defaults. Defaults are
          load-bearing: the fingerprint drops any flag equal to its version's default, which is why
          the same command line can be two different configurations on two versions.
        </p>
      </div>
      <div class="reg-list">
        ${reg.engines.map((e) => {
          const { p, c } = this.covOf(e.meta.id);
          return html`<a class="reg-card" href=${href('engines', e.meta.id)}>
            <span class="name">${e.meta.name}</span>
            <span class="id"
              >${e.meta.id} · ${e.meta.api} api · port ${e.meta.default_port ?? '–'}</span
            >
            <span class="small muted" style="line-height:1.4">${e.meta.description ?? ''}</span>
            <span class="facts">
              <span
                >${e.versions.length}
                version${e.versions.length === 1 ? '' : 's'}${e.versions.length ? ` · latest ${e.versions.at(-1)}` : ''}</span
              >
              <span>${runCount(e.meta.id)} run${runCount(e.meta.id) === 1 ? '' : 's'}</span>
            </span>
            <span class="tags"
              >${e.meta.platforms.map((pl) => html`<span class="tag">${pl}</span>`)}</span
            >
            <span class="cov"
              ><i class="bar"><i style="width:${(c / Math.max(1, p)) * 100}%"></i></i>${c}/${p}
              cells</span
            >
          </a>`;
        })}
      </div>
    </div>`;
  }

  private detail(id: string): TemplateResult {
    const reg = store.registry.value!;
    const e = store.lookups.engines.get(id);
    if (!e) {
      return html`<div class="page">
        ${emptyState({ title: `No engine “${id}” in the registry`, text: 'Engines live under engines/<id>/meta.json plus one versions/<version>.json per release.', action: html`<div class="row">${addButton({ kind: 'new-engine', target_name: id }, { label: 'Register this engine' })}<a class="btn" href="#/engines">All engines</a></div>` })}
      </div>`;
    }
    const meta = e.meta;
    const runs = store.index.value
      .filter((r) => r.engine.id === id)
      .sort((a, b) =>
        (b.provenance.submitted_at ?? '').localeCompare(a.provenance.submitted_at ?? ''),
      );
    const { p, c } = this.covOf(id);
    const versions = e.versions;
    const q = this.q;
    const from = versions.includes(qget(q, 'from') ?? '')
      ? qget(q, 'from')!
      : (versions.at(-2) ?? versions[0] ?? null);
    const to = versions.includes(qget(q, 'to') ?? '') ? qget(q, 'to')! : (versions.at(-1) ?? null);
    const fromFile = from ? this.files.get(`${id}/${from}`) : null;
    const toFile = to ? this.files.get(`${id}/${to}`) : null;
    const diff =
      fromFile && toFile && from !== to ? versionDiff(fromFile.params, toFile.params) : null;
    const hw = reg.hardware.filter((h) => engineRunsOn(e, h));
    const quants = reg.models.flatMap((m) =>
      m.quants.filter((qq) => quantRunsOn(qq, e)).map((qq) => ({ m, qq })),
    );
    // gaps: featured hardware × model/quant without runs on the latest version
    const latest = engineMinors(e).at(-1);
    const featured = reg.site.featured ?? {};
    const gaps = latest
      ? quants
          .flatMap(({ m, qq }) =>
            hw.map((h) => ({ model: m.model.id, quant: qq.id, hardware: h.id })),
          )
          .filter(
            (g) =>
              !(
                store.lookups.hardware.get(g.hardware)?.memory_gb &&
                (store.lookups.quants.get(`${g.model}/${g.quant}`)?.size_gb ?? 0) >
                  store.lookups.hardware.get(g.hardware)!.memory_gb!
              ),
          )
          .filter(
            (g) =>
              !runs.some(
                (r) =>
                  r.model.id === g.model &&
                  r.model.quant_id === g.quant &&
                  r.hardware.id === g.hardware,
              ),
          )
          .sort(
            (a, b) =>
              ((featured.hardware ?? []).includes(b.hardware) ? 2 : 0) +
              ((featured.models ?? []).includes(b.model) ? 1 : 0) -
              (((featured.hardware ?? []).includes(a.hardware) ? 2 : 0) +
                ((featured.models ?? []).includes(a.model) ? 1 : 0)),
          )
      : [];

    return html`<div class="page">
      <div class="page-head">
        <div class="row-wrap xs muted">
          <a href="#/engines">Engines</a> ${icon('chevronRight')}
          <span class="mono">${meta.id}</span>
        </div>
        <div class="row-wrap" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h1>${meta.name}</h1>
            <p class="lede mt-2">${meta.description ?? ''}</p>
          </div>
          <div class="head-actions">
            <a class="btn btn-sm" href=${`#/?rows=model&cols=hardware&engine=${meta.id}`}
              >${icon('grid')} On the atlas</a
            >
            <a class="btn btn-sm" href=${`#/explore?engine=${meta.id}`}
              >${icon('sparkle')} Explore flags</a
            >
            <a class="btn btn-sm" href=${`#/results?engine=${meta.id}`}
              >${icon('table')} ${runs.length} runs</a
            >
          </div>
        </div>
      </div>

      <div class="split facts-wide">
        <section class="card">
          <div class="card-head"><h3>Meta</h3></div>
          ${kv([
            ['id', html`<span class="mono">${meta.id}</span>`],
            ['repo', extLink(meta.repo, meta.repo.replace('https://github.com/', ''))],
            ['docs', meta.docs ? extLink(meta.docs, meta.docs.replace(/^https?:\/\//, '')) : null],
            [
              'api',
              `${meta.api} · port ${meta.default_port ?? '–'} · health ${meta.health?.path ?? '/health'}`,
            ],
            [
              'platforms',
              html`<span class="row-wrap" style="gap:3px"
                >${meta.platforms.map((pl) => html`<span class="tag">${pl}</span>`)}</span
              >`,
            ],
            [
              'quant formats',
              html`<span class="row-wrap" style="gap:3px"
                >${meta.quant_formats.map((f) => html`<span class="tag mono">${f}</span>`)}</span
              >`,
            ],
            [
              'install',
              html`<span class="col" style="gap:2px"
                >${meta.install.map((i) => html`<span class="mono xs">${i.method}${i.image ? ` · ${i.image}` : ''}${i.package ? ` · ${i.package}` : ''}${i.command ? ` · ${i.command}` : ''}${i.arch?.length ? ` (${i.arch.join(', ')})` : ''}</span>`)}</span
              >`,
            ],
            [
              'serve',
              html`<span class="mono xs">${meta.serve.command_template}</span>
                <span class="xs muted">model_ref = ${meta.serve.model_ref}</span>`,
            ],
            [
              'dropped from fingerprint',
              html`<span class="mono xs">${meta.drop_params.join(', ')}</span>`,
            ],
            [
              'aliases',
              meta.param_aliases && Object.keys(meta.param_aliases).length
                ? html`<span class="mono xs"
                    >${Object.entries(meta.param_aliases)
                      .map(([a, b]) => `${a} → ${b}`)
                      .join(' · ')}</span
                  >`
                : null,
            ],
            [
              'version source',
              meta.version_source
                ? `${meta.version_source.kind}${meta.version_source.repo ? ` · ${meta.version_source.repo}` : ''}${meta.version_source.package ? ` · ${meta.version_source.package}` : ''}`
                : null,
            ],
            [
              'runs on',
              html`<span class="row-wrap" style="gap:3px"
                >${hw.map((h) => html`<a class="tag mono" href=${href('hardware', h.id)} style="color:inherit">${h.id}</a>`)}</span
              >`,
            ],
            ['coverage', `${c} of ${p} possible cells measured`],
            meta.notes ? ['notes', meta.notes] : null,
          ])}
        </section>

        <section>
          <div class="section-title">
            <h2>Versions</h2>
            <span class="meta"
              >${versions.length} registered · each minor is its own square on the map</span
            >
          </div>
          <div class="table-wrap">
            <table class="table cards">
              <thead>
                <tr>
                  <th>version</th>
                  <th>minor</th>
                  <th class="num">flags</th>
                  <th>extraction</th>
                  <th>released</th>
                  <th class="num">runs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${[...versions].reverse().map((v) => {
                  const f = this.files.get(`${id}/${v}`);
                  const n = runs.filter((r) => r.engine.version === v).length;
                  const minor = engineMinors(e).find((m) => m.version === v)?.minor ?? '';
                  return html`<tr>
                    <td class="mono primary">${v}</td>
                    <td class="mono xs muted" data-label="minor">${minor}</td>
                    <td class="num" data-label="flags">
                      ${f ? f.params.length : (e.param_counts?.[v] ?? html`<span class="null">…</span>`)}
                    </td>
                    <td class="xs" data-label="extraction">
                      ${f?.extraction_method ?? ''}${f?.extracted_at ? html` <span class="muted">${f.extracted_at.slice(0, 10)}</span>` : nothing}
                    </td>
                    <td class="xs" data-label="released">${f?.released ?? ''}</td>
                    <td class="num" data-label="runs">${n}</td>
                    <td class="right" data-label="">
                      <a class="btn btn-xs" href=${`#/explore?engine=${meta.id}&version=${v}`}
                        >flags ${icon('arrowRight')}</a
                      >
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>
          ${
            versions.length > 1
              ? html`<div class="card mt-4 version-diff">
                  <div class="card-head">
                    <h3>What changed</h3>
                    <span class="spacer"></span>
                    ${selectField(
                      'from',
                      from,
                      versions.map((v) => ({ value: v, label: v })),
                      (v) => setQuery({ from: v }),
                      { allowEmpty: false, small: true },
                    )}
                    <span class="muted" style="padding-top:14px">→</span>
                    ${selectField(
                      'to',
                      to,
                      versions.map((v) => ({ value: v, label: v })),
                      (v) => setQuery({ to: v }),
                      { allowEmpty: false, small: true },
                    )}
                  </div>
                  ${
                    !diff
                      ? from === to
                        ? html`<p class="small muted">Pick two different versions.</p>`
                        : skeletonLines(3)
                      : html`<div class="split-3">
                            <div>
                              <div class="eyebrow plain mb-2">
                                Added <span class="count">${diff.added.length}</span>
                              </div>
                              ${diff.added.length ? diff.added.map((pp) => html`<div class="mono xs added">+ ${pp.name} <span class="muted">= ${fmtDefault(pp)}</span></div>`) : html`<span class="xs muted">none</span>`}
                            </div>
                            <div>
                              <div class="eyebrow plain mb-2">
                                Removed <span class="count">${diff.removed.length}</span>
                              </div>
                              ${diff.removed.length ? diff.removed.map((pp) => html`<div class="mono xs removed">− ${pp.name}</div>`) : html`<span class="xs muted">none</span>`}
                            </div>
                            <div>
                              <div class="eyebrow plain mb-2">
                                Default changed
                                <span class="count">${diff.defaultChanged.length}</span>
                              </div>
                              ${
                              diff.defaultChanged.length
                                ? diff.defaultChanged.map(
                                    (d) =>
                                      html`<div class="mono xs">
                                        ${d.name}:
                                        <span class="muted">${JSON.stringify(d.from)}</span> →
                                        <b>${JSON.stringify(d.to)}</b>
                                      </div>`,
                                  )
                                : html`<span class="xs muted">none</span>`
                            }
                              ${diff.typeChanged.map((d) => html`<div class="mono xs">${d.name}: type ${d.from} → ${d.to}</div>`)}
                            </div>
                          </div>
                          ${diff.defaultChanged.length ? html`<p class="xs muted mt-3">A changed default means the same explicit flags can produce a different <code>config_id</code> on each version. The explorer marks neighbours that differ only for that reason.</p>` : nothing}`
                  }
                </div>`
              : nothing
          }
        </section>
      </div>

      <section class="mt-5">
        <div class="section-title">
          <h2>Coverage</h2>
          <span class="meta">model × hardware with ${meta.name}</span>
        </div>
        <atlas-mini-coverage
          .rowKey=${'model'}
          .colKey=${'hardware'}
          .filters=${{ engine: meta.id }}
        ></atlas-mini-coverage>
      </section>

      <section class="mt-5">
        <div class="section-title">
          <h2>Runs</h2>
          <span class="meta">${runs.length}</span>
        </div>
        ${runsTable(runs, { hide: ['engine'], limit: 30 })}
      </section>

      <section class="mt-5">
        <div class="section-title">
          <h2>Gaps</h2>
          <span class="meta"
            >${fmtInt(gaps.length)} model/quant × device combinations without a run on
            ${latest?.version ?? 'the latest version'}</span
          >
        </div>
        ${
          gaps.length
            ? html`<div class="missing-list">
                  ${gaps.slice(0, 12).map(
                    (g) =>
                      html`<div class="missing-row">
                        <span class="grow"
                          ><span class="mono xs">${g.model}/${g.quant}</span>
                          <span class="faint">·</span>
                          <span class="mono xs">${g.hardware}</span></span
                        >
                        ${addButton({ engine_id: meta.id, engine_version: latest!.version, model_id: g.model, quant_id: g.quant, hardware_id: g.hardware }, { label: 'Add', size: 'sm' })}
                      </div>`,
                  )}
                </div>
                ${gaps.length > 12 ? html`<p class="xs muted mt-2">…and ${fmtInt(gaps.length - 12)} more. <a href=${`#/gaps?engine=${meta.id}`}>See them in the wanted queue</a>.</p>` : nothing}`
            : html`<p class="small muted">No gaps on the latest version.</p>`
        }
      </section>
      ${meta.serve.notes ? html`<section class="mt-4">${codeBlock(`# ${meta.serve.notes}`, { lang: 'text', copy: false })}</section>` : nothing}
    </div>`;
  }
}
