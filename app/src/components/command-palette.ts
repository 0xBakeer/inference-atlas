/** Cmd/Ctrl-K search over pages, models, hardware, engines, workloads, contributors and runs. */
import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { href, navigate } from '../router.js';
import { signal, watch } from '../signal.js';
import { store } from '../store.js';
import { fuzzyScore } from '../util/filters.js';
import { AtlasElement } from './base.js';
import { icon } from './icons.js';

export const paletteOpen = signal(false);

interface Item {
  group: string;
  label: string;
  sub: string;
  hash: string;
  ic: string;
  keywords: string;
}

const PAGES: Array<[string, string, string]> = [
  ['Atlas', '#/', 'grid'],
  ['Explore configurations', '#/explore', 'sparkle'],
  ['Results table', '#/results', 'table'],
  ['Compare runs', '#/compare', 'compare'],
  ['Pareto frontier', '#/pareto', 'scatter'],
  ['Timeline across engine versions', '#/timeline', 'clock'],
  ['Eval leaderboard', '#/evals', 'check'],
  ['Parallelism sweeps', '#/parallelism', 'layers'],
  ['Models', '#/models', 'box'],
  ['Hardware', '#/hardware', 'cpu'],
  ['Engines', '#/engines', 'zap'],
  ['Workloads', '#/workloads', 'play'],
  ['Contributors', '#/contributors', 'users'],
  ['Wanted gaps', '#/gaps', 'flag'],
  ['Contribute', '#/contribute', 'flag'],
  ['About', '#/about', 'info'],
];

@customElement('atlas-command-palette')
export class AtlasCommandPalette extends AtlasElement {
  @state() private q = '';
  @state() private sel = 0;

  constructor() {
    super();
    watch(this, paletteOpen, store.registry, store.contributors);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onGlobalKey);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onGlobalKey);
  }

  private onGlobalKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      paletteOpen.value = !paletteOpen.value;
      if (paletteOpen.value) {
        this.q = '';
        this.sel = 0;
        void store.loadContributors();
        requestAnimationFrame(() => this.querySelector('input')?.focus());
      }
    } else if (e.key === 'Escape' && paletteOpen.value) {
      paletteOpen.value = false;
    }
  };

  private items(): Item[] {
    const reg = store.registry.value;
    const out: Item[] = PAGES.map(([label, hash, ic]) => ({
      group: 'Pages',
      label,
      sub: hash,
      hash,
      ic,
      keywords: label,
    }));
    if (reg) {
      for (const m of reg.models)
        out.push({
          group: 'Models',
          label: m.model.name,
          sub: m.model.id,
          hash: href('models', m.model.id),
          ic: 'box',
          keywords: `${m.model.id} ${m.model.name} ${m.model.family ?? ''} ${m.model.vendor}`,
        });
      for (const h of reg.hardware)
        out.push({
          group: 'Hardware',
          label: h.name,
          sub: h.id,
          hash: href('hardware', h.id),
          ic: 'cpu',
          keywords: `${h.id} ${h.name} ${h.vendor} ${(h.aliases ?? []).join(' ')}`,
        });
      for (const e of reg.engines)
        out.push({
          group: 'Engines',
          label: e.meta.name,
          sub: e.meta.id,
          hash: href('engines', e.meta.id),
          ic: 'zap',
          keywords: `${e.meta.id} ${e.meta.name}`,
        });
      for (const w of reg.workloads)
        out.push({
          group: 'Workloads',
          label: w.name,
          sub: w.id,
          hash: href('workloads', w.id),
          ic: 'play',
          keywords: `${w.id} ${w.name} ${w.kind}`,
        });
    }
    for (const c of store.contributors.value ?? [])
      out.push({
        group: 'Contributors',
        label: c.login,
        sub: `${c.runs} runs`,
        hash: href('contributors', c.login),
        ic: 'users',
        keywords: c.login,
      });
    for (const r of store.index.value)
      out.push({
        group: 'Runs',
        label: `${r.engine.id} ${r.engine.version} · ${r.model.id}/${r.model.quant_id} · ${r.hardware.id}`,
        sub: r.workload_id,
        hash: href('run', r.run_id),
        ic: 'file',
        keywords: `${r.run_id} ${r.engine.id} ${r.model.id} ${r.model.quant_id} ${r.hardware.id} ${r.workload_id} ${r.provenance.login}`,
      });
    return out;
  }

  private results(): Item[] {
    const q = this.q.trim();
    const all = this.items();
    if (!q) return all.filter((i) => i.group === 'Pages').slice(0, 12);
    return all
      .map((i) => ({
        i,
        s: Math.max(
          fuzzyScore(i.label, q),
          fuzzyScore(i.keywords, q) * 0.9,
          fuzzyScore(i.sub, q) * 0.95,
        ),
      }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.i);
  }

  private go(item: Item): void {
    paletteOpen.value = false;
    navigate(item.hash);
  }

  private onKey(e: KeyboardEvent, res: Item[]): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.sel = Math.min(res.length - 1, this.sel + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.sel = Math.max(0, this.sel - 1);
    } else if (e.key === 'Enter') {
      const it = res[this.sel];
      if (it) this.go(it);
    }
  }

  override render() {
    if (!paletteOpen.value) return nothing;
    const res = this.results();
    let lastGroup = '';
    return html`<div class="backdrop" @click=${() => (paletteOpen.value = false)}></div>
      <div class="palette" role="dialog" aria-label="Search">
        <div class="box">
          <div class="pal-input">
            ${icon('search')}
            <input
              type="text"
              placeholder="Search models, hardware, engines, runs, contributors…"
              .value=${this.q}
              @input=${(e: Event) => {
                this.q = (e.target as HTMLInputElement).value;
                this.sel = 0;
              }}
              @keydown=${(e: KeyboardEvent) => this.onKey(e, res)}
              aria-label="Search"
            />
            <kbd>esc</kbd>
          </div>
          <div class="pal-list" role="listbox">
            ${res.length === 0 ? html`<div class="pal-group">No matches for “${this.q}”</div>` : nothing}
            ${res.map((it, i) => {
              const head =
                it.group !== lastGroup ? html`<div class="pal-group">${it.group}</div>` : nothing;
              lastGroup = it.group;
              return html`${head}<a
                  class="pal-item"
                  role="option"
                  aria-selected=${i === this.sel}
                  href=${it.hash}
                  @mouseenter=${() => (this.sel = i)}
                  @click=${(e: Event) => {
                    e.preventDefault();
                    this.go(it);
                  }}
                  >${icon(it.ic)} <span class="ellipsis">${it.label}</span
                  ><span class="sub">${it.sub}</span></a
                >`;
            })}
          </div>
          <div class="pal-foot">
            <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span
            ><span><kbd>⌘K</kbd> toggle</span>
          </div>
        </div>
      </div>`;
  }
}
