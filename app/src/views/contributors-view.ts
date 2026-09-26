import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '../components/chart.js';
import { icon } from '../components/icons.js';
import { runsTable } from '../components/runs-table.js';
import { activityBuild, barList } from '../components/stat-charts.js';
import {
  avatar,
  emptyState,
  extLink,
  hardwareLink,
  kv,
  skeletonLines,
  sparkline,
  when,
} from '../components/ui.js';
import type { ContributorRow, IndexRow } from '../data/types.js';
import { fmtInt, fmtMs, fmtNum, fmtPct, fmtTokS, loginKey } from '@atlas/core';
import { href, modelHref } from '../router.js';
import { store } from '../store.js';
import {
  firstAppearances,
  periodStats,
  weeklyCounts,
  type NewsItem,
  type NewsKind,
} from '../util/community.js';
import { absDate } from '../util/dates.js';
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
    const index = store.index.value;
    const month = periodStats(index, 30);
    const news = firstAppearances(index).slice(0, 24);
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
          : html`<div class="stats-strip mb-5">
                ${this.stat(month.runs, 'runs · last 30 days')}
                ${this.stat(month.contributors, 'people active · 30 days')}
                ${this.stat(month.cells, 'squares filled · 30 days')}
                ${this.stat(month.models, 'models first measured · 30 days')}
                ${this.stat(month.hardware, 'devices first measured · 30 days')}
              </div>

              <div class="split facts-wide community-split">
                <section>
                  <div class="section-title">
                    <h2>What's new</h2>
                    <span class="meta">first appearances on the map</span>
                  </div>
                  ${this.newsFeed(news)}
                </section>
                <div class="stack">${this.leaderboardCharts(rows)}</div>
              </div>

              <section class="mt-5">
                <div class="section-title">
                  <h2>Leaderboard</h2>
                  <span class="meta">by points · click a card for the full profile</span>
                </div>
                <div class="contributor-grid">
                  ${rows.map((c, i) => this.contributorCard(c, i + 1))}
                </div>
              </section>`
      }
    </div>`;
  }

  private stat(v: number, k: string): TemplateResult {
    return html`<div class="stat">
      <div class="v">${fmtInt(v)}</div>
      <div class="k">${k}</div>
    </div>`;
  }

  /** New models, devices, engines and people, grouped by day. */
  private newsFeed(news: NewsItem[]): TemplateResult {
    if (!news.length) return html`<p class="small muted">Nothing yet.</p>`;
    const days = new Map<string, NewsItem[]>();
    for (const n of news) days.set(n.date, [...(days.get(n.date) ?? []), n]);
    const lk = store.lookups;
    const label = (n: NewsItem): TemplateResult => {
      switch (n.kind) {
        case 'model':
          return html`<a href=${modelHref(n.id)}>${lk.models.get(n.id)?.model.name ?? n.id}</a>
            <span class="muted">first measured</span>`;
        case 'hardware':
          return html`<a href=${href('hardware', n.id)}>${lk.hardware.get(n.id)?.name ?? n.id}</a>
            <span class="muted">first measured</span>`;
        case 'engine':
          return html`<a href=${href('engines', n.id)}
              >${lk.engines.get(n.id)?.meta.name ?? n.id}</a
            >
            <span class="muted">first measured</span>`;
        case 'contributor':
          return html`<a href=${href('contributors', n.id)}>${n.id}</a>
            <span class="muted">joined the map</span>`;
        default:
          return html`${n.id}`;
      }
    };
    const ic: Record<NewsKind, string> = {
      model: 'box',
      hardware: 'cpu',
      engine: 'zap',
      cell: 'grid',
      contributor: 'users',
    };
    return html`<div class="news">
      ${[...days.entries()].map(
        ([day, items]) =>
          html`<div class="news-day">
            <div class="news-date">${absDate(day)} <span class="faint">· ${when(day)}</span></div>
            <div class="news-items">
              ${items.map(
                (n) =>
                  html`<div class="news-item">
                    <span class="ic ${n.kind}">${icon(ic[n.kind])}</span>
                    <span class="what">${label(n)}</span>
                    <span class="by xs muted"
                      >${n.kind === 'contributor' ? nothing : html`by <a href=${href('contributors', n.by)}>${n.by}</a> ·`}
                      <a href=${href('run', n.run_id)}>run</a></span
                    >
                  </div>`,
              )}
            </div>
          </div>`,
      )}
    </div>`;
  }

  /** One contributor at a glance: the numbers, the devices, the badges, the rhythm. */
  private contributorCard(c: ContributorRow, rank: number): TemplateResult {
    const runs = store.index.value.filter(
      (r) => loginKey(r.provenance.login) === loginKey(c.login),
    );
    const earned = BADGES.filter((b) => b.earned(c, runs.length));
    const weeks = weeklyCounts(runs, 12);
    const bd = c.breakdown;
    const models = new Set(runs.map((r) => r.model.id)).size;
    const engines = [...new Set(runs.map((r) => r.engine.id))];
    return html`<a class="contributor-tile" href=${href('contributors', c.login)}>
      <div class="ct-head">
        ${avatar(c.login, { userId: c.user_id, avatarUrl: c.avatar_url, size: 'lg' })}
        <div class="min-w-0">
          <div class="row" style="gap:8px">
            <span class="login ellipsis">${c.login}</span>
            <span class="rank ${rank <= 3 ? 'top' : ''}">#${rank}</span>
          </div>
          <div class="points">
            ${fmtNum(c.points, c.points % 1 ? 1 : 0)} <span class="muted xs">points</span>
          </div>
        </div>
        <div class="spark">
          ${sparkline(weeks, { width: 88, height: 28 })}
          <span class="xs faint">12 weeks</span>
        </div>
      </div>
      <div class="ct-tiles">
        <div><b>${fmtInt(c.runs)}</b><span>runs</span></div>
        <div><b>${fmtInt(c.cells_filled)}</b><span>squares</span></div>
        <div><b>${fmtInt(models)}</b><span>models</span></div>
        <div><b>${fmtInt(bd.eval_runs)}</b><span>evals</span></div>
        <div><b>${fmtInt(bd.gotchas)}</b><span>gotchas</span></div>
        <div><b>${fmtInt(c.reproductions)}</b><span>repros</span></div>
      </div>
      <div class="ct-tags">
        ${c.hardware_ids.slice(0, 3).map((h) => html`<span class="tag">${store.lookups.hardware.get(h)?.name ?? h}</span>`)}
        ${c.hardware_ids.length > 3 ? html`<span class="tag">+${c.hardware_ids.length - 3}</span>` : nothing}
        ${engines.slice(0, 4).map((e) => html`<span class="tag mono">${e}</span>`)}
        ${engines.length > 4 ? html`<span class="tag">+${engines.length - 4}</span>` : nothing}
      </div>
      <div class="ct-foot">
        <span class="badges"
          >${earned.map((b) => html`<span class="badge" title=${`${b.label} — ${b.desc}`}>${icon(b.ic)}</span>`)}</span
        >
        <span class="xs muted"
          >${c.first_seen ? html`since ${absDate(c.first_seen)}` : nothing}${c.last_seen ? html` · last ${when(c.last_seen)}` : nothing}</span
        >
      </div>
    </a>`;
  }

  /** Points at a glance plus the map's overall submission rhythm. */
  private leaderboardCharts(rows: ContributorRow[]): TemplateResult | typeof nothing {
    if (!rows.length) return nothing;
    const top = rows.slice(0, 10);
    const activity = activityBuild(
      store.index.value.map((r) => r.provenance.submitted_at ?? r.provenance.started_at),
      { label: 'runs' },
    );
    return html`${
        activity
          ? html`<section class="card tight">
              <div class="card-head">
                <h3>Community activity</h3>
                <span class="muted small">all submissions over time</span>
              </div>
              <atlas-chart
                .build=${activity}
                .height=${200}
                .key=${store.index.value.length}
                .chartTitle=${'Community activity'}
                .subtitle=${'all submissions over time · Inference Atlas'}
              ></atlas-chart>
            </section>`
          : nothing
      }
      <section class="card tight">
        <div class="card-head">
          <h3>Points</h3>
          <span class="muted small">top ${top.length}</span>
        </div>
        ${barList(
          top.map((c) => ({
            label: html`<span class="row" style="gap:6px;min-width:0"
              >${avatar(c.login, { userId: c.user_id, avatarUrl: c.avatar_url, size: 'sm' })}<span
                class="ellipsis"
                >${c.login}</span
              ></span
            >`,
            title: `${c.login} — ${fmtNum(c.points, c.points % 1 ? 1 : 0)} points`,
            value: c.points,
            text: fmtNum(c.points, c.points % 1 ? 1 : 0),
            color: 'var(--accent)',
            href: href('contributors', c.login),
          })),
          { ariaLabel: 'Points per contributor' },
        )}
      </section>`;
  }

  private profile(typed: string, list: ContributorRow[]): TemplateResult {
    // A login in a URL can be spelled with any casing; GitHub treats them as one person.
    const key = loginKey(typed);
    const c = list.find((x) => loginKey(x.login) === key);
    const runs = store.index.value
      .filter((r) => loginKey(r.provenance.login) === key)
      .sort((a, b) =>
        (b.provenance.submitted_at ?? b.provenance.started_at ?? '').localeCompare(
          a.provenance.submitted_at ?? a.provenance.started_at ?? '',
        ),
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
    const modelCounts = new Map<string, number>();
    for (const r of runs) modelCounts.set(r.model.id, (modelCounts.get(r.model.id) ?? 0) + 1);
    const models = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]);
    const rank =
      [...list].sort((a, b) => b.points - a.points).findIndex((x) => loginKey(x.login) === key) + 1;
    const earned = BADGES.filter((b) => b.earned(cc, runs.length));
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

      <div class="stats-strip mb-5">
        ${this.stat(Math.round(cc.points), 'points')} ${this.stat(cc.runs, 'runs')}
        ${this.stat(cc.cells_filled, 'squares filled')}
        ${this.stat(cc.reproductions, 'reproductions')} ${this.stat(bd.eval_runs, 'evals')}
        ${this.stat(bd.gotchas, 'gotchas recorded')} ${this.stat(bd.sweep_points, 'sweep points')}
      </div>

      <div class="split facts-quants">
        <div class="stack">
          <section class="card">
            <div class="card-head"><h3>Where they measure</h3></div>
            <div class="eyebrow plain mb-1">Hardware</div>
            ${cc.hardware_ids.length ? html`<div class="col" style="gap:4px">${cc.hardware_ids.map((h) => html`<div>${hardwareLink(h)}</div>`)}</div>` : html`<span class="muted small">–</span>`}
            <div class="eyebrow plain mt-3 mb-1">Engines</div>
            ${engines.length ? html`<div class="row-wrap" style="gap:4px">${engines.map((e) => html`<a class="tag mono" href=${href('engines', e)} style="color:inherit">${e}</a>`)}</div>` : html`<span class="muted small">–</span>`}
            <div class="eyebrow plain mt-3 mb-1">Models</div>
            ${
              models.length
                ? html`<div class="row-wrap" style="gap:4px">
                    ${models.slice(0, 12).map(([m, n]) => html`<a class="tag" href=${modelHref(m)} style="color:inherit">${store.lookups.models.get(m)?.model.name ?? m} <span class="muted">${n}</span></a>`)}
                    ${models.length > 12 ? html`<span class="tag">+${models.length - 12}</span>` : nothing}
                  </div>`
                : html`<span class="muted small">–</span>`
            }
          </section>
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
            <div class="card-head"><h3>Badges</h3></div>
            <div class="col" style="gap:6px">
              ${BADGES.map((b) => html`<div class="row small" style="opacity:${earned.includes(b) ? 1 : 0.45}">${icon(b.ic)} <b>${b.label}</b> <span class="muted">— ${b.desc}</span> ${earned.includes(b) ? icon('check') : nothing}</div>`)}
            </div>
          </section>
        </div>
        <div class="stack">
          ${(() => {
            const activity = activityBuild(
              runs.map((r) => r.provenance.submitted_at ?? r.provenance.started_at),
              { label: 'runs' },
            );
            return activity
              ? html`<section class="card tight">
                  <div class="card-head">
                    <h3>Activity</h3>
                    <span class="muted small">submissions over time</span>
                  </div>
                  <atlas-chart
                    .build=${activity}
                    .height=${180}
                    .key=${runs.length}
                    .chartTitle=${`Activity — ${login}`}
                    .subtitle=${`${runs.length} runs · Inference Atlas`}
                    .credit=${login}
                  ></atlas-chart>
                </section>`
              : nothing;
          })()}
          ${this.highlights(runs)}
          <section>
            <div class="section-title">
              <h2>All runs</h2>
              <span class="meta">${runs.length} · one tab per kind of test, best first</span>
            </div>
            ${runsTable(runs, { hide: ['by'], limit: 25 })}
          </section>
        </div>
      </div>
    </div>`;
  }

  /** The runs worth showing first: the best number this person has put on the map, per kind. */
  private highlights(runs: IndexRow[]): TemplateResult | typeof nothing {
    const best = (
      label: string,
      filter: (r: IndexRow) => boolean,
      value: (r: IndexRow) => number | null,
      better: 'higher' | 'lower',
      fmt: (v: number) => string,
      unit: string,
    ) => {
      const cands = runs.filter(filter).filter((r) => value(r) !== null);
      if (!cands.length) return null;
      const r = cands.sort((a, b) =>
        better === 'higher' ? value(b)! - value(a)! : value(a)! - value(b)!,
      )[0]!;
      return { label, r, text: fmt(value(r)!), unit };
    };
    const items = [
      best(
        'Highest throughput',
        (r) => r.kind === 'serving',
        (r) => r.metrics.output_tok_s ?? null,
        'higher',
        fmtTokS,
        'tok/s',
      ),
      best(
        'Fastest per user',
        (r) => r.kind === 'serving',
        (r) => r.metrics.decode_tok_s_per_request ?? null,
        'higher',
        fmtTokS,
        'tok/s',
      ),
      best(
        'Best eval',
        (r) => r.kind === 'eval',
        (r) => r.metrics.accuracy ?? null,
        'higher',
        (v) => fmtPct(v, 1),
        '',
      ),
      best(
        'Fastest first token',
        (r) => r.kind === 'prefill' || r.kind === 'longctx',
        (r) => r.metrics.ttft_p50 ?? null,
        'lower',
        fmtMs,
        'ms',
      ),
    ].filter((x): x is NonNullable<typeof x> => !!x);
    if (!items.length) return nothing;
    return html`<section>
      <div class="section-title">
        <h2>Highlights</h2>
        <span class="meta">their best number of each kind</span>
      </div>
      <div class="highlight-grid">
        ${items.map(
          (h) =>
            html`<a class="highlight" href=${href('run', h.r.run_id)}>
              <span class="k">${h.label}</span>
              <span class="v">${h.text}<span class="unit">${h.unit}</span></span>
              <span class="xs muted ellipsis">${h.r.model.id}/${h.r.model.quant_id}</span>
              <span class="xs muted ellipsis"
                >${store.lookups.hardware.get(h.r.hardware.id)?.name ?? h.r.hardware.id} ·
                ${h.r.engine.id} · ${h.r.workload_id}</span
              >
            </a>`,
        )}
      </div>
    </section>`;
  }
}
