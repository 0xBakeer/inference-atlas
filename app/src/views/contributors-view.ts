import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { icon } from '../components/icons.js';
import { runsTable } from '../components/runs-table.js';
import {
  avatar,
  emptyState,
  extLink,
  hardwareLink,
  kindTag,
  kv,
  skeletonLines,
  when,
} from '../components/ui.js';
import type { ContributorRow } from '../data/types.js';
import { loginKey } from '@atlas/core';
import { href } from '../router.js';
import { store } from '../store.js';
import { absDate } from '../util/dates.js';
import { fmtInt, fmtNum } from '../util/format.js';
import { headlineMetric } from '../util/metrics.js';
import { ViewElement } from './view-base.js';

interface Badge {
  id: string;
  label: string;
  desc: string;
  earned: (c: ContributorRow, runsCount: number) => boolean;
  ic: string;
}

const BADGES: Badge[] = [
  {
    id: 'first',
    label: 'First light',
    desc: 'Filled an empty cell',
    earned: (c) => c.cells_filled >= 1,
    ic: 'flag',
  },
  {
    id: 'ten',
    label: 'Ten squares',
    desc: 'Filled ten cells',
    earned: (c) => c.cells_filled >= 10,
    ic: 'grid',
  },
  {
    id: 'reproducer',
    label: 'Reproducer',
    desc: 'Reproduced somebody else’s measurement',
    earned: (c) => c.reproductions >= 1,
    ic: 'refresh',
  },
  {
    id: 'sweeper',
    label: 'Sweeper',
    desc: 'Contributed sweep points',
    earned: (c) => (c.breakdown?.sweep_points ?? 0) >= 5,
    ic: 'layers',
  },
  {
    id: 'evaluator',
    label: 'Evaluator',
    desc: 'Ran an eval suite',
    earned: (c) => (c.breakdown?.eval_runs ?? 0) >= 1,
    ic: 'check',
  },
  {
    id: 'gotcha',
    label: 'Field notes',
    desc: 'Recorded ten gotchas',
    earned: (c) => (c.breakdown?.gotchas ?? 0) >= 10,
    ic: 'bulb',
  },
  {
    id: 'multi',
    label: 'Multi-device',
    desc: 'Runs on two or more devices',
    earned: (c) => c.hardware_ids.length >= 2,
    ic: 'cpu',
  },
  {
    id: 'registrar',
    label: 'Registrar',
    desc: 'Added hardware, a model or an engine',
    earned: (c) =>
      (c.breakdown?.registry_hardware ?? 0) +
        (c.breakdown?.registry_models ?? 0) +
        (c.breakdown?.registry_engines ?? 0) >
      0,
    ic: 'box',
  },
];

@customElement('atlas-contributors-view')
export class AtlasContributorsView extends ViewElement {
  @property({ attribute: false }) login: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void store.loadContributors();
  }

  override render() {
    const reg = store.registry.value;
    const list = store.contributors.value;
    if (!reg || list === null) return html`<div class="page">${skeletonLines(8)}</div>`;
    return this.login ? this.profile(this.login, list) : this.leaderboard(list);
  }

  private leaderboard(list: ContributorRow[]): TemplateResult {
    const rows = [...list].sort((a, b) => b.points - a.points || b.runs - a.runs);
    const w = store.site.scoring.weights;
    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Community</div>
        <h1>${fmtInt(rows.length)} contributor${rows.length === 1 ? '' : 's'}</h1>
        <p class="lede">
          Every result file is owned by the GitHub login in it. Points reward filling empty squares
          (${w.fill_empty_cell}), reproducing others (${w.reproduction}), sweeps, evals, gotchas,
          and registering new hardware (${w.new_hardware}), models (${w.new_model}) and engines
          (${w.new_engine}) — with diminishing returns for piling runs into one cell.
        </p>
      </div>
      ${
        rows.length === 0
          ? emptyState({
              title: 'Nobody on the map yet — be the first',
              text: 'The first pull request with a result file puts a name, an avatar and points here. Every gap in the queue ships with a packet a coding agent can run end to end.',
              action: html`<div class="row" style="justify-content:center">
                <a class="btn btn-primary" href="#/gaps">${icon('flag')} Pick a gap to fill</a>
                <a class="btn" href="#/contribute">How contributing works</a>
              </div>`,
            })
          : html`<div class="table-wrap">
              <table class="table cards">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>contributor</th>
                    <th class="num">points</th>
                    <th class="num">runs</th>
                    <th class="num">cells filled</th>
                    <th class="num">reproductions</th>
                    <th>hardware</th>
                    <th>first · last</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(
                    (c, i) =>
                      html`<tr
                        class="lb-row clickable"
                        @click=${() => (location.hash = href('contributors', c.login))}
                      >
                        <td class="rank ${i < 3 ? 'top' : ''}">${i + 1}</td>
                        <td class="primary">
                          <span class="row" style="gap:8px"
                            >${avatar(c.login, { userId: c.user_id, avatarUrl: c.avatar_url, size: 'md' })}<span
                              >${c.login}</span
                            ></span
                          >
                        </td>
                        <td class="num points" data-label="points">
                          ${fmtNum(c.points, c.points % 1 ? 1 : 0)}
                        </td>
                        <td class="num" data-label="runs">${c.runs}</td>
                        <td class="num" data-label="cells">${c.cells_filled}</td>
                        <td class="num" data-label="reproductions">${c.reproductions}</td>
                        <td data-label="hardware">
                          <span class="row-wrap" style="gap:3px"
                            >${c.hardware_ids.slice(0, 4).map((h) => html`<span class="tag mono">${h}</span>`)}${c.hardware_ids.length > 4 ? html`<span class="tag">+${c.hardware_ids.length - 4}</span>` : nothing}</span
                          >
                        </td>
                        <td class="xs muted" data-label="active">
                          ${absDate(c.first_seen)} · ${when(c.last_seen)}
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
    </div>`;
  }

  private profile(typed: string, list: ContributorRow[]): TemplateResult {
    // A login in a URL can be spelled with any casing; GitHub treats them as one person.
    const key = loginKey(typed);
    const c = list.find((x) => loginKey(x.login) === key);
    const runs = store.index.value
      .filter((r) => loginKey(r.provenance.login) === key)
      .sort((a, b) =>
        (b.provenance.submitted_at ?? '').localeCompare(a.provenance.submitted_at ?? ''),
      );
    if (!c && runs.length === 0) {
      return html`<div class="page">
        ${emptyState({ title: `No contributor “${typed}”`, text: 'Nobody with this login has a result file on main yet.', action: html`<a class="btn" href="#/contributors">Leaderboard</a>` })}
      </div>`;
    }
    // Whatever the URL said, show the spelling the data carries.
    const login = c?.login ?? runs[0]?.provenance.login ?? typed;
    const cc: ContributorRow = c ?? {
      login,
      user_id: null,
      runs: runs.length,
      cells_filled: new Set(runs.map((r) => r.cell_id)).size,
      reproductions: 0,
      hardware_ids: [...new Set(runs.map((r) => r.hardware.id))],
      first_seen: null,
      last_seen: null,
      points: 0,
      breakdown: {
        cells_filled: 0,
        reproductions: 0,
        additional_runs: 0,
        sweep_points: 0,
        eval_runs: 0,
        gotchas: 0,
        registry_hardware: 0,
        registry_models: 0,
        registry_engines: 0,
        registry_quants: 0,
        registry_workloads: 0,
      },
    };
    const engines = [...new Set(runs.map((r) => r.engine.id))];
    const rank =
      [...list].sort((a, b) => b.points - a.points).findIndex((x) => loginKey(x.login) === key) + 1;
    const earned = BADGES.filter((b) => b.earned(cc, runs.length));
    const keyMetrics = store.site.coverage.key_metrics;
    const bd = cc.breakdown;
    return html`<div class="page">
      <div class="page-head">
        <div class="row-wrap xs muted">
          <a href="#/contributors">Contributors</a> ${icon('chevronRight')} ${login}
        </div>
        <div class="row-wrap" style="gap:16px;align-items:center">
          ${avatar(login, { userId: cc.user_id, avatarUrl: cc.avatar_url, size: 'lg' })}
          <div>
            <h1>${login} ${rank ? html`<span class="tag">#${rank}</span>` : nothing}</h1>
            <div class="row-wrap small muted mt-1">
              ${extLink(`https://github.com/${login}`, `github.com/${login}`)} ·
              <span class="points">${fmtNum(cc.points, cc.points % 1 ? 1 : 0)} points</span>
              · ${cc.runs} runs · ${cc.cells_filled} cells · ${cc.reproductions} reproductions
              ${cc.first_seen ? html`· since ${absDate(cc.first_seen)}` : nothing}
            </div>
          </div>
        </div>
        ${earned.length ? html`<div class="badge-row mt-2">${earned.map((b) => html`<span class="badge" title=${b.desc}>${icon(b.ic)} ${b.label}</span>`)}</div>` : nothing}
      </div>

      <div class="split facts-quants">
        <div class="stack">
          <section class="card">
            <div class="card-head"><h3>Points breakdown</h3></div>
            ${kv([
              ['cells filled', bd.cells_filled],
              ['reproductions', bd.reproductions],
              ['additional runs', bd.additional_runs],
              ['sweep points', bd.sweep_points],
              ['eval runs', bd.eval_runs],
              ['gotchas', bd.gotchas],
              [
                'registry',
                `${bd.registry_hardware} hw · ${bd.registry_models} models · ${bd.registry_engines} engines · ${bd.registry_quants} quants · ${bd.registry_workloads} workloads`,
              ],
            ])}
          </section>
          <section class="card">
            <div class="card-head"><h3>Hardware</h3></div>
            ${cc.hardware_ids.length ? html`<div class="col" style="gap:6px">${cc.hardware_ids.map((h) => html`<div>${hardwareLink(h)}</div>`)}</div>` : html`<span class="muted small">–</span>`}
            <div class="card-head mt-4"><h3>Engines</h3></div>
            ${engines.length ? html`<div class="row-wrap" style="gap:4px">${engines.map((e) => html`<a class="tag mono" href=${href('engines', e)} style="color:inherit">${e}</a>`)}</div>` : html`<span class="muted small">–</span>`}
          </section>
          <section class="card">
            <div class="card-head"><h3>Badges</h3></div>
            <div class="col" style="gap:6px">
              ${BADGES.map((b) => html`<div class="row small" style="opacity:${earned.includes(b) ? 1 : 0.45}">${icon(b.ic)} <b>${b.label}</b> <span class="muted">— ${b.desc}</span> ${earned.includes(b) ? icon('check') : nothing}</div>`)}
            </div>
          </section>
        </div>
        <div class="stack">
          <section>
            <div class="section-title">
              <h2>Timeline</h2>
              <span class="meta">${runs.length} runs</span>
            </div>
            <div class="timeline">
              ${runs.slice(0, 40).map((r) => {
                const hl = headlineMetric(r, keyMetrics);
                return html`<div class="tl-item">
                  <div class="when">
                    ${absDate(r.provenance.submitted_at ?? r.provenance.started_at)} ·
                    ${when(r.provenance.submitted_at ?? r.provenance.started_at)}
                  </div>
                  <a href=${href('run', r.run_id)} class="row-wrap" style="color:inherit;gap:6px">
                    ${kindTag(r.kind)}
                    <span class="mono xs">${r.engine.id} ${r.engine.version}</span> ·
                    <span class="mono xs">${r.model.id}/${r.model.quant_id}</span> ·
                    <span class="mono xs">${r.hardware.id}</span>
                    ${hl ? html`<span class="mono" style="font-weight:500;margin-left:auto">${hl.def.fmt(hl.value)}<span class="unit">${hl.def.unit}</span></span>` : nothing}
                  </a>
                </div>`;
              })}
            </div>
          </section>
          <section>
            <div class="section-title"><h2>All runs</h2></div>
            ${runsTable(runs, { hide: ['by'], limit: 50 })}
          </section>
        </div>
      </div>
    </div>`;
  }
}
