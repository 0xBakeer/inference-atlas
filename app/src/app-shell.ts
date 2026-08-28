import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { addSpec, closeAdd, decodeAddSpec } from './components/add-modal.js';
import { AtlasElement } from './components/base.js';
import { paletteOpen } from './components/command-palette.js';
import { icon } from './components/icons.js';
import { when } from './components/ui.js';
import { modelIdFromSegments, route, type Route } from './router.js';
import { watch } from './signal.js';
import { siteFallback, store } from './store.js';
import { theme, toggleTheme } from './theme.js';
import { toasts } from './util/clipboard.js';
import { applyEvidenceColors } from './util/colors.js';
import { absDateTime, relTime } from './util/dates.js';
import { shortSha } from './util/format.js';

import './components/add-modal.js';
import './components/command-palette.js';
import './views/atlas-view.js';
import './views/explore-view.js';
import './views/results-view.js';
import './views/run-view.js';
import './views/compare-view.js';
import './views/pareto-view.js';
import './views/timeline-view.js';
import './views/evals-view.js';
import './views/parallelism-view.js';
import './views/models-view.js';
import './views/hardware-view.js';
import './views/engines-view.js';
import './views/workloads-view.js';
import './views/contributors-view.js';
import './views/gaps-view.js';
import './views/contribute-view.js';
import './views/about-view.js';

@customElement('atlas-app')
export class AtlasApp extends AtlasElement {
  @state() private drawer = false;
  @state() private openGroup: string | null = null;
  private lastPath = '';

  constructor() {
    super();
    watch(
      this,
      route,
      store.status,
      store.registry,
      store.manifest,
      store.stats,
      theme,
      toasts,
      addSpec,
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    applyEvidenceColors(siteFallback);
    void store.boot().then(() => applyEvidenceColors(store.site));
    document.addEventListener('click', this.onDocClick);
    document.addEventListener('keydown', this.onKeyDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.onDocClick);
    document.removeEventListener('keydown', this.onKeyDown);
  }

  private onDocClick = (e: Event) => {
    if (this.openGroup && !(e.target as Element).closest('.nav-group')) this.openGroup = null;
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    this.drawer = false;
    this.openGroup = null;
  };

  protected override willUpdate(_changed: PropertyValues): void {
    const r = route.value;
    if (r.path !== this.lastPath) {
      this.lastPath = r.path;
      this.drawer = false;
      this.openGroup = null;
      window.scrollTo({ top: 0 });
    }
    // URL-addressable Add dialog
    const add = r.query.get('add');
    if (add && !addSpec.value) {
      const spec = decodeAddSpec(add);
      if (spec) addSpec.value = spec;
    } else if (!add && addSpec.value) {
      addSpec.value = null;
    }
    document.title = this.titleFor(r);
  }

  private titleFor(r: Route): string {
    const site = store.site.site.title;
    const seg = r.segments[0];
    if (!seg) return site;
    const name = seg.charAt(0).toUpperCase() + seg.slice(1);
    // model ids are HF repo ids and span two segments (`#/models/<owner>/<name>`)
    const item = seg === 'models' ? modelIdFromSegments(r.segments) : (r.segments[1] ?? null);
    return item ? `${item} · ${name} · ${site}` : `${name} · ${site}`;
  }

  private view(r: Route): TemplateResult {
    const [a, b] = r.segments;
    switch (a) {
      case undefined:
        return html`<atlas-atlas-view></atlas-atlas-view>`;
      case 'explore':
        return html`<atlas-explore-view></atlas-explore-view>`;
      case 'results':
        return html`<atlas-results-view></atlas-results-view>`;
      case 'run':
        return html`<atlas-run-view .runId=${b ?? ''}></atlas-run-view>`;
      case 'compare':
        return html`<atlas-compare-view></atlas-compare-view>`;
      case 'pareto':
        return html`<atlas-pareto-view></atlas-pareto-view>`;
      case 'timeline':
        return html`<atlas-timeline-view></atlas-timeline-view>`;
      case 'evals':
        return html`<atlas-evals-view></atlas-evals-view>`;
      case 'parallelism':
        return html`<atlas-parallelism-view></atlas-parallelism-view>`;
      case 'models':
        return html`<atlas-models-view
          .itemId=${modelIdFromSegments(r.segments)}
        ></atlas-models-view>`;
      case 'hardware':
        return html`<atlas-hardware-view .itemId=${b ?? null}></atlas-hardware-view>`;
      case 'engines':
        return html`<atlas-engines-view .itemId=${b ?? null}></atlas-engines-view>`;
      case 'workloads':
        return html`<atlas-workloads-view .itemId=${b ?? null}></atlas-workloads-view>`;
      case 'contributors':
        return html`<atlas-contributors-view .login=${b ?? null}></atlas-contributors-view>`;
      case 'gaps':
        return html`<atlas-gaps-view></atlas-gaps-view>`;
      case 'contribute':
        return html`<atlas-contribute-view></atlas-contribute-view>`;
      case 'about':
        return html`<atlas-about-view></atlas-about-view>`;
      default:
        return html`<div class="page">
          <div class="empty">
            <div>
              <h3>There is no page at <code>#/${r.segments.join('/')}</code></h3>
              <p>The map is over here.</p>
            </div>
            <a class="btn" href="#/">${icon('grid')} Back to the atlas</a>
          </div>
        </div>`;
    }
  }

  private isCurrent(routeHash: string, r: Route): boolean {
    const p = routeHash.replace(/^#/, '');
    if (p === '/') return r.path === '/';
    return r.path === p || r.path.startsWith(p + '/');
  }

  private nav(r: Route): TemplateResult {
    const site = store.site;
    const primary = site.nav.filter((n) => n.primary);
    const groups = new Map<string, typeof site.nav>();
    for (const n of site.nav) {
      if (n.primary || !n.group) continue;
      const g = groups.get(n.group) ?? [];
      g.push(n);
      groups.set(n.group, g);
    }
    return html`<nav class="nav-links" aria-label="Primary">
      ${primary.map((n) => html`<a class="nav-link" href=${n.route} aria-current=${this.isCurrent(n.route, r) ? 'page' : nothing}>${n.label}</a>`)}
      ${[...groups.entries()].map(
        ([g, items]) =>
          html`<div class="nav-group">
            <button
              class="nav-link"
              type="button"
              aria-haspopup="true"
              aria-expanded=${this.openGroup === g}
              aria-current=${items.some((n) => this.isCurrent(n.route, r)) ? 'page' : nothing}
              @click=${() => (this.openGroup = this.openGroup === g ? null : g)}
            >
              ${g} ${icon('chevronDown', 'xs')}
            </button>
            ${
              this.openGroup === g
                ? html`<div class="nav-menu" role="menu">
                    ${items.map((n) => html`<a role="menuitem" href=${n.route} aria-current=${this.isCurrent(n.route, r) ? 'page' : nothing}>${n.label}</a>`)}
                  </div>`
                : nothing
            }
          </div>`,
      )}
    </nav>`;
  }

  private drawerTpl(r: Route): TemplateResult {
    const site = store.site;
    const groups = new Map<string, typeof site.nav>();
    for (const n of site.nav) {
      const g = n.primary ? 'Main' : (n.group ?? 'More');
      const list = groups.get(g) ?? [];
      list.push(n);
      groups.set(g, list);
    }
    return html`<div class="backdrop" @click=${() => (this.drawer = false)}></div>
      <div class="nav-drawer" role="dialog" aria-modal="true" aria-label="Navigation">
        <div class="row" style="justify-content:space-between">
          <span class="brand"
            ><span class="mark"
              ><i></i><i class="a"></i><i></i><i></i><i class="b"></i><i></i><i></i><i></i
              ><i class="c"></i></span
            ><span class="word">${site.site.title}</span></span
          >
          <button
            class="btn btn-ghost btn-icon"
            @click=${() => (this.drawer = false)}
            aria-label="Close menu"
          >
            ${icon('x')}
          </button>
        </div>
        ${[...groups.entries()].map(
          ([g, items]) =>
            html`<div class="eyebrow group-label plain">${g}</div>
              ${items.map((n) => html`<a href=${n.route} aria-current=${this.isCurrent(n.route, r) ? 'page' : nothing}>${n.label}</a>`)}`,
        )}
        <hr class="rule" />
        <a href=${store.site.links?.repo ?? '#'} target="_blank" rel="noopener"
          >${icon('github')} GitHub</a
        >
        <a href="#/about">${icon('info')} About</a>
      </div>`;
  }

  override render() {
    const r = route.value;
    const site = store.site;
    const status = store.status.value;
    const manifest = store.manifest.value;
    const stats = store.stats.value;
    const repo = site.links?.repo ?? `https://github.com/${site.repo.owner}/${site.repo.name}`;
    const built = manifest?.built_at ?? stats?.last_updated ?? null;

    return html`<div class="shell">
      <header class="topnav">
        <div class="topnav-inner">
          <button
            class="btn btn-ghost btn-icon nav-burger"
            type="button"
            aria-label="Open menu"
            @click=${() => (this.drawer = true)}
          >
            ${icon('menu')}
          </button>
          <a class="brand" href="#/">
            <span class="mark" aria-hidden="true"
              ><i></i><i class="a"></i><i></i><i></i><i class="b"></i><i></i><i class="d"></i><i></i
              ><i class="c"></i
            ></span>
            <span class="word">Inference <em>Atlas</em></span>
          </a>
          ${this.nav(r)}
          <div class="nav-right">
            ${
              built
                ? html`<span class="data-stamp" title=${`Data built ${absDateTime(built)}`}
                    ><span class="dot"></span>data ${relTime(built)}</span
                  >`
                : nothing
            }
            <button
              class="search-trigger"
              type="button"
              @click=${() => (paletteOpen.value = true)}
              aria-label="Search (Cmd/Ctrl K)"
            >
              ${icon('search')} <span class="hint">Search</span> <kbd>⌘K</kbd>
            </button>
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              @click=${toggleTheme}
              aria-label=${theme.value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title="Toggle theme"
            >
              ${icon(theme.value === 'dark' ? 'sun' : 'moon')}
            </button>
            <a
              class="btn btn-ghost btn-icon"
              href=${repo}
              target="_blank"
              rel="noopener"
              aria-label="GitHub repository"
              title="GitHub"
              >${icon('github')}</a
            >
          </div>
        </div>
      </header>

      <main id="main">
        ${
          status === 'error'
            ? html`<div class="boot">
                <h2>The compiled data did not load</h2>
                <p class="muted mt-2">${store.error.value}</p>
                <p class="small muted mt-3">
                  Run <code>pnpm build:data</code> at the repository root, then reload. On GitHub
                  Pages this means the build workflow has not published <code>data/</code> yet.
                </p>
                <button class="btn mt-4" @click=${() => location.reload()}>
                  ${icon('refresh')} Reload
                </button>
              </div>`
            : status === 'ready'
              ? this.view(r)
              : html`<div class="boot">
                  <div class="bootgrid" aria-hidden="true">
                    ${Array.from({ length: 48 }, () => html`<i></i>`)}
                  </div>
                  <p class="muted">Loading the map…</p>
                </div>`
        }
      </main>

      <footer class="footer">
        <div class="footer-inner">
          <span class="mark-line"
            ><span class="mark brand" style="gap:0"
              ><span class="mark"
                ><i></i><i class="a"></i><i></i><i></i><i class="b"></i><i></i><i></i><i></i
                ><i class="c"></i></span></span
            >${site.site.title}</span
          >
          <span>Code MIT · data CC-BY-4.0</span>
          ${manifest?.commit ? html`<span>build <a href=${`${repo}/commit/${manifest.commit}`} target="_blank" rel="noopener" class="mono">${shortSha(manifest.commit)}</a></span>` : nothing}
          ${built ? html`<span>data built ${when(built)}</span>` : nothing}
          <span class="spacer"></span>
          <a href=${repo} target="_blank" rel="noopener">GitHub</a>
          <a
            href=${site.links?.spec ?? `${repo}/blob/main/docs/SPEC.md`}
            target="_blank"
            rel="noopener"
            >Spec</a
          >
          <a
            href=${site.links?.agents ?? `${repo}/blob/main/AGENTS.md`}
            target="_blank"
            rel="noopener"
            >AGENTS.md</a
          >
          <a
            href=${site.links?.data_licence ?? `${repo}/blob/main/DATA_LICENSE`}
            target="_blank"
            rel="noopener"
            >Data licence</a
          >
          <a href="#/about">About</a>
        </div>
      </footer>

      ${this.drawer ? this.drawerTpl(r) : nothing}
      <atlas-command-palette></atlas-command-palette>
      <atlas-add-modal @close=${closeAdd}></atlas-add-modal>
      <div class="toasts" aria-live="polite">
        ${toasts.value.map((t) => html`<div class="toast ${t.kind}">${t.kind === 'ok' ? icon('check') : t.kind === 'error' ? icon('alert') : icon('info')} ${t.text}</div>`)}
      </div>
    </div>`;
  }
}
