/**
 * The terminal app, presented as a landing page. Every word on it comes from the manual under
 * `docs/tui/` — the Markdown is imported at build time, cut into sections, and laid out with
 * the app's own cards, tables and code blocks, so the page can never drift from the docs.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { icon } from '../components/icons.js';
import { codeBlock } from '../components/ui.js';
import { store } from '../store.js';
import { renderMarkdown } from '../util/markdown.js';
import { ViewElement } from './view-base.js';

import readmeMd from '../../../docs/tui/README.md?raw';
import installationMd from '../../../docs/tui/installation.md?raw';
import gettingStartedMd from '../../../docs/tui/getting-started.md?raw';
import keysMd from '../../../docs/tui/keys.md?raw';
import viewsMd from '../../../docs/tui/views.md?raw';
import recipesMd from '../../../docs/tui/recipes.md?raw';
import cliMd from '../../../docs/tui/cli.md?raw';

/* ------------------------------------------------------------------ markdown plumbing */

const DOCS_DIR = 'docs/tui/';

/** GIFs too large to ship with the site are shown as a still frame that links to the GIF. */
const POSTERS = new Set(['tui-03-recipe.gif', 'tui-04-runs-filter.gif']);

interface Section {
  title: string;
  body: string;
}

interface DocImage {
  alt: string;
  file: string;
}

type Block =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; head: string[]; rows: string[][] };

/**
 * Normalise a doc for the small renderer in `util/markdown.ts`: resolve relative links to
 * GitHub, turn `_emphasis_` into `*emphasis*`, drop backslash escapes and fold indented list
 * continuations onto their item. Code spans and fences are left untouched.
 */
function prepare(md: string, repo: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  let inItem = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      inItem = false;
      out.push(raw);
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    // horizontal rules separate sections in the docs; the cards already do that here
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(raw)) {
      inItem = false;
      continue;
    }
    // the renderer splits code spans before it matches links, so a link whose text is a
    // code span (`[`media/`](media/README.md)`) would never form; plain text links fine
    // Likewise `**`b`**` would leak its asterisks: the code span is emphasis enough.
    const line = raw
      .replace(/\[`([^`\]]+)`\]\(/g, '[$1](')
      .replace(/\*\*(`[^`]+`)\*\*/g, '$1')
      .split(/(`[^`]*`)/g)
      .map((p) => {
        if (p.startsWith('`')) return p;
        let t = p.replace(/\]\((?!https?:|#)([^)\s]+)\)/g, (_m, rel: string) => {
          const path = new URL(rel, `https://x/${DOCS_DIR}`).pathname.replace(/^\//, '');
          const frag = rel.includes('#') ? rel.slice(rel.indexOf('#')) : '';
          return `](${repo}/blob/main/${path}${frag})`;
        });
        t = t.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s.,;:)-]|$)/g, '$1*$2*');
        t = t.replace(/\\([<>*_[\]#])/g, '$1');
        return t;
      })
      .join('');
    const isItem = /^\s*(?:[-*]|\d+\.)\s+/.test(line);
    if (!isItem && inItem && /^\s{2,}\S/.test(line) && out.length) {
      out[out.length - 1] += ' ' + line.trim();
      continue;
    }
    inItem = isItem || (inItem && line.trim() !== '');
    out.push(line);
  }
  return out.join('\n');
}

/** Split a document at headings of one level: the text before the first, then each section. */
function splitSections(md: string, level: number): { intro: string; sections: Section[] } {
  const re = new RegExp(`^#{${level}}\\s+(.*)$`);
  const stop = new RegExp(`^#{1,${level}}\\s+`);
  const lines = md.split('\n');
  const intro: string[] = [];
  const sections: Section[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence ? re.exec(line) : null;
    if (m) {
      if (cur) sections.push({ title: cur.title, body: cur.lines.join('\n').trim() });
      cur = { title: m[1]!.trim(), lines: [] };
      continue;
    }
    if (!inFence && cur && stop.test(line) && !re.test(line)) {
      sections.push({ title: cur.title, body: cur.lines.join('\n').trim() });
      cur = null;
    }
    if (cur) cur.lines.push(line);
    else if (!/^#\s+/.test(line)) intro.push(line);
  }
  if (cur) sections.push({ title: cur.title, body: cur.lines.join('\n').trim() });
  return { intro: intro.join('\n').trim(), sections };
}

function section(md: string, title: string, level = 2): string {
  return splitSections(md, level).sections.find((s) => s.title === title)?.body ?? '';
}

function images(md: string): DocImage[] {
  const out: DocImage[] = [];
  for (const m of md.matchAll(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/gm)) {
    out.push({ alt: m[1] ?? '', file: (m[2] ?? '').replace(/^.*\//, '') });
  }
  return out;
}

const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** Cut a section into prose, fenced code and pipe tables; images are dropped (shown aside). */
function tokenize(md: string): Block[] {
  const lines = md.split('\n');
  const blocks: Block[] = [];
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join('\n').trim();
    if (text) blocks.push({ kind: 'prose', text });
    prose = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      blocks.push({ kind: 'code', lang: fence[1] ?? '', code: buf.join('\n') });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|')) rows.push(cells(lines[i++]!));
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) {
      i++;
      continue;
    }
    prose.push(line);
    i++;
  }
  flush();
  return blocks;
}

/** One table cell through the Markdown renderer, unwrapped from its paragraph. */
function inlineHtml(s: string, kbd = false): string {
  const h = renderMarkdown(s)
    .replace(/^<p>/, '')
    .replace(/<\/p>$/, '');
  return kbd ? h.replace(/<code>/g, '<kbd>').replace(/<\/code>/g, '</kbd>') : h;
}

function docTable(b: Extract<Block, { kind: 'table' }>, kbd: boolean): TemplateResult {
  const hasHead = b.head.some((c) => c !== '');
  return html`<div class="table-wrap">
    <table class="table ${kbd ? 'keys' : ''}">
      ${
        hasHead
          ? html`<thead>
              <tr>
                ${b.head.map((c) => html`<th>${unsafeHTML(inlineHtml(c))}</th>`)}
              </tr>
            </thead>`
          : nothing
      }
      <tbody>
        ${b.rows.map(
          (r) =>
            html`<tr>
              ${r.map((c, j) => html`<td class="wrap">${unsafeHTML(inlineHtml(c, kbd && j === 0))}</td>`)}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

/** A section body as app components: `.md` prose, `codeBlock`s with copy buttons, `.table`s. */
function doc(md: string, opts: { kbd?: boolean } = {}): TemplateResult {
  return html`<div class="tui-doc">
    ${tokenize(md).map((b) => {
      switch (b.kind) {
        case 'prose':
          return html`<div class="md">${unsafeHTML(renderMarkdown(b.text))}</div>`;
        case 'code':
          return codeBlock(b.code, { lang: b.lang, maxHeight: 'none' });
        case 'table':
          return docTable(b, opts.kbd ?? false);
      }
    })}
  </div>`;
}

/* ------------------------------------------------------------------ the view */

@customElement('atlas-tui-view')
export class AtlasTuiView extends ViewElement {
  private get repo(): string {
    const site = store.site;
    return (
      site.links?.repo ??
      `${site.repo.host ?? 'https://github.com'}/${site.repo.owner}/${site.repo.name}`
    );
  }

  private docs = new Map<string, string>();

  /** Prepared once per repo URL; the raw imports never change. */
  private md(name: string, raw: string): string {
    const key = `${this.repo}\n${name}`;
    let v = this.docs.get(key);
    if (!v) {
      v = prepare(raw, this.repo);
      this.docs.set(key, v);
    }
    return v;
  }

  private mediaUrl(file: string): string {
    return `${import.meta.env.BASE_URL}tui/${file}`;
  }

  private figure(img: DocImage, opts: { eager?: boolean } = {}): TemplateResult {
    const still = POSTERS.has(img.file);
    const src = this.mediaUrl(still ? img.file.replace(/\.gif$/, '.png') : img.file);
    const gif = `${this.repo}/blob/main/${DOCS_DIR}media/${img.file}?raw=true`;
    return html`<figure class="tui-figure">
      <div class="frame">
        <img
          src=${src}
          alt=${img.alt}
          width="1130"
          height="1030"
          loading=${opts.eager ? 'eager' : 'lazy'}
          decoding="async"
        />
        ${
          still
            ? html`<a class="btn btn-xs still" href=${gif} target="_blank" rel="noopener"
                >${icon('play')} Still frame — watch the recording</a
              >`
            : nothing
        }
      </div>
      <figcaption>${img.alt}</figcaption>
    </figure>`;
  }

  private jump(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private manualLink(file: string): string {
    return `${this.repo}/blob/main/${DOCS_DIR}${file}`;
  }

  override render() {
    const repo = this.repo;
    const manual = `${repo}/tree/main/${DOCS_DIR.replace(/\/$/, '')}`;
    const readme = this.md('readme', readmeMd);
    const installation = this.md('installation', installationMd);
    const gettingStarted = this.md('getting-started', gettingStartedMd);
    const keys = this.md('keys', keysMd);
    const views = this.md('views', viewsMd);
    const recipes = this.md('recipes', recipesMd);
    const cli = this.md('cli', cliMd);

    const readmeTop = splitSections(readme, 2);
    const introParas = readmeTop.intro
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith('!['));
    const tour = images(readme)[0] ?? { alt: 'inference-atlas', file: 'tui-00-tour.gif' };
    const shape = tokenize(section(readme, 'The shape of it in one screen')).find(
      (b) => b.kind === 'code',
    );
    const threeThings = section(readme, 'Three things worth knowing before you start')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const contents = tokenize(section(readme, 'Contents')).find((b) => b.kind === 'table');

    const install = splitSections(installation, 2);
    const installSection = (title: string) => install.sections.find((s) => s.title === title);

    const steps = splitSections(gettingStarted, 2).sections;
    const keySections = splitSections(keys, 2);
    const screenSections = splitSections(views, 2);
    const recipeSections = splitSections(recipes, 2);
    const cliSections = splitSections(cli, 2);
    const cliOptions = splitSections(section(cli, 'Options'), 3);

    const jumps: Array<[string, string]> = [
      ['tui-install', 'Install'],
      ['tui-start', 'Get started'],
      ['tui-keys', 'Keys'],
      ['tui-screens', 'Screens'],
      ['tui-recipes', 'Recipes'],
      ['tui-cli', 'Command line'],
      ['tui-manual', 'Manual'],
    ];

    return html`<div class="page tui">
      <section class="tui-hero">
        <div class="page-head">
          <div class="eyebrow">Terminal</div>
          <h1 class="display">The atlas, <b>in your terminal</b>.</h1>
          <p class="lede">${unsafeHTML(inlineHtml(introParas[0] ?? ''))}</p>
          <div class="md tui-pitch">
            ${introParas.slice(1).map((p) => html`<p>${unsafeHTML(inlineHtml(p))}</p>`)}
          </div>
          <div class="head-actions">
            <button class="btn btn-primary" type="button" @click=${() => this.jump('tui-install')}>
              ${icon('terminal')} Install
            </button>
            <a class="btn" href=${manual} target="_blank" rel="noopener"
              >${icon('file')} The manual on GitHub</a
            >
            <a
              class="btn"
              href=${`${repo}/blob/main/packages/tui/README.md`}
              target="_blank"
              rel="noopener"
              >${icon('github')} Package README</a
            >
          </div>
        </div>
        ${this.figure(tour, { eager: true })}
      </section>

      <div class="stats-strip tui-facts">
        <div class="stat">
          <div class="v">20<small>+</small></div>
          <div class="k">Node.js — the only requirement</div>
        </div>
        <div class="stat">
          <div class="v">~900<small>KB</small></div>
          <div class="k">first data sync, then almost nothing</div>
        </div>
        <div class="stat">
          <div class="v">offline</div>
          <div class="k">after the first sync</div>
        </div>
        <div class="stat">
          <div class="v">0</div>
          <div class="k">Python, Docker or databases</div>
        </div>
        <div class="stat">
          <div class="v"><kbd>g</kbd></div>
          <div class="k">from any run to an install recipe</div>
        </div>
      </div>

      <nav class="tui-jump" aria-label="On this page">
        <span class="eyebrow plain">On this page</span>
        ${jumps.map(([id, label]) => html`<button class="chip" type="button" @click=${() => this.jump(id)}>${label}</button>`)}
      </nav>

      <section>
        <div class="section-title">
          <h2>Three things worth knowing before you start</h2>
        </div>
        <div class="split main-aside tui-intro">
          <div class="tui-grid">
            ${threeThings.map((p) => html`<div class="card"><div class="md">${unsafeHTML(renderMarkdown(p))}</div></div>`)}
          </div>
          ${
            shape && shape.kind === 'code'
              ? html`<div class="card tight tui-shape">
                  <div class="eyebrow plain">The shape of it in one screen</div>
                  ${codeBlock(shape.code, { copy: false, maxHeight: 'none' })}
                </div>`
              : nothing
          }
        </div>
      </section>

      <section id="tui-install">
        <div class="section-title">
          <h2>Install</h2>
          <span class="meta"
            >requirements, the one-line installer, from a checkout, updating, uninstalling</span
          >
        </div>
        <div class="tui-grid">
          ${this.installCard(installSection('The one-line installer'), 'span-2 tui-installer')}
          ${this.installCard(installSection('Requirements'))}
          ${this.installCard(installSection('From a checkout'))}
          ${this.installCard(installSection('Updating'))}
          ${this.installCard(installSection('Verifying the install'))}
          ${this.installCard(installSection('Uninstalling'))}
          ${this.installCard(installSection('What gets written where'), 'span-2')}
        </div>
      </section>

      <section id="tui-start">
        <div class="section-title">
          <h2>Get started</h2>
          <span class="meta">${splitSections(gettingStarted, 2).intro}</span>
        </div>
        <ol class="tui-steps">
          ${steps
            .filter((s) => /^\d+\.\s/.test(s.title))
            .map((s) => {
              const m = /^(\d+)\.\s+(.*)$/.exec(s.title)!;
              const imgs = images(s.body);
              return html`<li class="tui-step">
                <span class="num">${m[1]}</span>
                <div class="card ${imgs.length ? 'with-media' : ''}">
                  <div>
                    <h3>${m[2]}</h3>
                    ${doc(s.body)}
                  </div>
                  ${imgs.length ? html`<div>${imgs.map((i) => this.figure(i))}</div>` : nothing}
                </div>
              </li>`;
            })}
        </ol>
        ${
          section(gettingStarted, 'What next')
            ? html`<div class="card mt-4">
                <h3>What next</h3>
                ${doc(section(gettingStarted, 'What next'))}
              </div>`
            : nothing
        }
      </section>

      <section id="tui-keys">
        <div class="section-title">
          <h2>Keyboard reference</h2>
          <span class="meta"
            >${unsafeHTML(inlineHtml(keySections.intro.split(/\n\s*\n/)[0] ?? '', true))}</span
          >
        </div>
        <div class="tui-grid keys">
          ${keySections.sections.map(
            (s) =>
              html`<div class="card">
                <h3>${unsafeHTML(inlineHtml(s.title, true))}</h3>
                ${doc(s.body, { kbd: true })}
              </div>`,
          )}
        </div>
      </section>

      <section id="tui-screens">
        <div class="section-title">
          <h2>Screens</h2>
          <span class="meta"
            >every recording is the real <code>inference-atlas</code>, driven key by key against the
            live published data</span
          >
        </div>
        <div class="card mb-4 tui-screen no-media">
          <div>${doc(screenSections.intro)}</div>
        </div>
        <div class="tui-screens">
          ${screenSections.sections.map((s) => {
            const imgs = images(s.body);
            return html`<div class="card tui-screen ${imgs.length ? '' : 'no-media'}">
              <div>
                <h3>${unsafeHTML(inlineHtml(s.title, true))}</h3>
                ${doc(s.body)}
              </div>
              ${imgs.length ? html`<div>${imgs.map((i) => this.figure(i))}</div>` : nothing}
            </div>`;
          })}
        </div>
      </section>

      <section id="tui-recipes">
        <div class="section-title">
          <h2>Recipes</h2>
          <span class="meta">one measured run, turned into instructions an agent can follow</span>
        </div>
        <div class="card tui-screen mb-4">
          <div>${doc(recipeSections.intro)}${doc(section(recipes, 'What you get'))}</div>
          <div>${images(recipes).map((i) => this.figure(i))}</div>
        </div>
        <div class="tui-grid">
          ${['Getting it out of the terminal', 'Agent targets', 'Where recipes go'].map((t) =>
            this.plainCard(
              t,
              section(recipes, t),
              t === 'Getting it out of the terminal' ? { kbd: true } : {},
            ),
          )}
          <details class="card tui-details span-2">
            <summary>
              ${icon('chevronRight')}
              <h3>Anatomy — every section of a recipe, in order</h3>
            </summary>
            ${doc(section(recipes, 'Anatomy'))}
          </details>
        </div>
      </section>

      <section id="tui-cli">
        <div class="section-title">
          <h2>Command line</h2>
          <span class="meta">flags, exit codes, using it in scripts</span>
        </div>
        <div class="card tui-screen mb-4">
          <div>${doc(cliSections.intro)}${doc(cliOptions.intro)}</div>
          <div>${images(cli).map((i) => this.figure(i))}</div>
        </div>
        <div class="tui-grid">
          ${cliOptions.sections.map((s) => this.plainCard(s.title, s.body))}
          ${cliSections.sections
            .filter((s) => s.title !== 'Options')
            .map((s) => this.plainCard(s.title, s.body))}
        </div>
      </section>

      <section id="tui-manual">
        <div class="section-title">
          <h2>The full manual</h2>
          <span class="meta">every page, on GitHub</span>
        </div>
        <div class="tui-grid manual">
          ${
            contents && contents.kind === 'table'
              ? contents.rows.map((r) => {
                  const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(r[0] ?? '');
                  const title = link?.[1] ?? r[0] ?? '';
                  const href = link?.[2] ?? manual;
                  return html`<a class="card" href=${href} target="_blank" rel="noopener">
                    <h3>${title} ${icon('external', 'xs')}</h3>
                    <p class="small muted">${unsafeHTML(inlineHtml(r[1] ?? ''))}</p>
                  </a>`;
                })
              : nothing
          }
        </div>
        <p class="row-wrap mt-4">
          <a class="btn" href=${manual} target="_blank" rel="noopener"
            >${icon('file')} docs/tui on GitHub</a
          >
          <a class="btn" href=${this.manualLink('media/README.md')} target="_blank" rel="noopener"
            >${icon('play')} How the recordings were made</a
          >
          <a
            class="btn"
            href=${store.site.links?.agents ?? `${repo}/blob/main/AGENTS.md`}
            target="_blank"
            rel="noopener"
            >${icon('sparkle')} AGENTS.md</a
          >
          <a class="btn btn-primary" href="#/contribute"
            >${icon('flag')} Contribute a measurement</a
          >
        </p>
      </section>
    </div>`;
  }

  private installCard(s: Section | undefined, cls = ''): TemplateResult | typeof nothing {
    if (!s) return nothing;
    return this.plainCard(s.title, s.body, {}, cls);
  }

  private plainCard(
    title: string,
    body: string,
    opts: { kbd?: boolean } = {},
    cls = '',
  ): TemplateResult {
    return html`<div class="card ${cls}">
      <h3>${unsafeHTML(inlineHtml(title, true))}</h3>
      ${doc(body, opts)}
    </div>`;
  }
}
