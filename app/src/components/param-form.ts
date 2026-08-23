/**
 * Engine flag form generated from `data/engines/<id>/<version>.json`. Groups ordered by impact,
 * high-impact groups open, the rest collapsed; typed inputs; defaults shown; "differs from
 * default" marked. Emits `args-change` with the new args object.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { normalizeValue } from '@atlas/core';
import type { ArgValue, Args, EngineParam, EngineVersion, Impact } from '@atlas/core';
import { AtlasElement } from './base.js';
import { icon } from './icons.js';

const IMPACT_RANK: Record<Impact, number> = { high: 0, medium: 1, low: 2 };

function impactOf(p: EngineParam): Impact {
  return p.impact ?? 'low';
}

export function isDefault(p: EngineParam, value: ArgValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (p.default === null || p.default === undefined) return false;
  try {
    return normalizeValue(value, p.type) === normalizeValue(p.default, p.type);
  } catch {
    return false;
  }
}

export function fmtDefault(p: EngineParam): string {
  const d = p.default;
  if (d === null || d === undefined) return 'model-dependent';
  if (typeof d === 'object') return JSON.stringify(d);
  return String(d);
}

@customElement('atlas-param-form')
export class AtlasParamForm extends AtlasElement {
  @property({ attribute: false }) version: EngineVersion | null = null;
  @property({ attribute: false }) args: Args = {};
  @property({ attribute: false }) dropParams: string[] = [];
  @property({ type: Boolean }) showDeprecated = false;
  @state() private filter = '';
  @state() private jsonErrors: Record<string, string> = {};

  private set(name: string, value: ArgValue | undefined): void {
    const next: Args = { ...this.args };
    if (value === undefined) delete next[name];
    else next[name] = value;
    this.dispatchEvent(new CustomEvent('args-change', { detail: next, bubbles: true }));
  }

  private control(p: EngineParam): TemplateResult {
    const raw = this.args[p.name];
    const changed = !isDefault(p, raw);
    const cls = changed ? 'changed' : '';
    switch (p.type) {
      case 'bool': {
        const eff =
          raw === undefined || raw === null ? p.default === true : raw === true || raw === 'true';
        return html`<label class="switch" title=${changed ? 'differs from default' : 'default'}>
          <input
            type="checkbox"
            .checked=${eff}
            @change=${(e: Event) => this.set(p.name, (e.target as HTMLInputElement).checked)}
          />
          <span class="track"></span>
          <span class="xs mono">${eff ? 'true' : 'false'}</span>
        </label>`;
      }
      case 'int':
      case 'float': {
        const [lo, hi] = p.range ?? [null, null];
        return html`<input
          class="input ${cls}"
          type="number"
          .value=${raw === undefined || raw === null ? '' : String(raw)}
          placeholder=${p.default === null || p.default === undefined ? '' : fmtDefault(p)}
          min=${lo ?? nothing}
          max=${hi ?? nothing}
          step=${p.type === 'int' ? '1' : 'any'}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            this.set(p.name, v === '' ? undefined : Number(v));
          }}
        />`;
      }
      case 'enum':
        return html`<select
          class="select ${cls}"
          @change=${(e: Event) => this.set(p.name, (e.target as HTMLSelectElement).value === '' ? undefined : (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${raw === undefined || raw === null}>
            default${p.default !== null && p.default !== undefined ? ` (${fmtDefault(p)})` : ''}
          </option>
          ${(p.choices ?? []).map((c) => html`<option value=${String(c)} ?selected=${raw !== undefined && raw !== null && String(raw) === String(c)}>${String(c)}</option>`)}
        </select>`;
      case 'json':
      case 'list': {
        const text =
          raw === undefined || raw === null
            ? ''
            : typeof raw === 'string'
              ? raw
              : JSON.stringify(raw);
        const err = this.jsonErrors[p.name];
        return html`<div class="col" style="gap:2px;align-items:flex-end;width:100%">
          <textarea
            class="textarea ${cls} ${err ? 'invalid' : ''}"
            style=${err ? 'border-color:var(--danger)' : ''}
            placeholder=${p.type === 'list' ? '["a","b"] or a,b' : fmtDefault(p) === 'model-dependent' ? '{"key": "value"}' : fmtDefault(p)}
            .value=${text}
            @input=${(e: Event) => {
              const v = (e.target as HTMLTextAreaElement).value.trim();
              if (v === '') {
                this.jsonErrors = { ...this.jsonErrors, [p.name]: '' };
                this.set(p.name, undefined);
                return;
              }
              try {
                const parsed = JSON.parse(v) as ArgValue;
                this.jsonErrors = { ...this.jsonErrors, [p.name]: '' };
                this.set(p.name, parsed);
              } catch {
                if (p.type === 'list') {
                  this.jsonErrors = { ...this.jsonErrors, [p.name]: '' };
                  this.set(
                    p.name,
                    v
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  );
                } else {
                  this.jsonErrors = { ...this.jsonErrors, [p.name]: 'not valid JSON' };
                }
              }
            }}
          ></textarea>
          ${err ? html`<span class="xs" style="color:var(--danger)">${err}</span>` : nothing}
        </div>`;
      }
      default:
        return html`<input
          class="input mono ${cls}"
          type="text"
          .value=${raw === undefined || raw === null ? '' : String(raw)}
          placeholder=${fmtDefault(p)}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            this.set(p.name, v === '' ? undefined : v);
          }}
        />`;
    }
  }

  private row(p: EngineParam): TemplateResult {
    const changed = !isDefault(p, this.args[p.name]);
    return html`<div class="param-row ${changed ? 'changed' : ''}">
      <div class="name">
        <i class="imp ${impactOf(p)}" title=${`${impactOf(p)} impact`}></i>
        <span>${p.name}</span>
        ${p.aliases?.length ? html`<span class="tag mono" title="aliases">${p.aliases.join(' ')}</span>` : nothing}
        ${p.deprecated ? html`<span class="tag warn">deprecated</span>` : nothing}
        ${changed ? html`<span class="tag accent" title="This value survives into the fingerprint">≠ default</span>` : nothing}
      </div>
      <div class="ctrl">
        ${this.control(p)}
        ${
          changed
            ? html`<button
                class="btn btn-ghost btn-icon reset"
                type="button"
                title="Reset to default"
                @click=${() => this.set(p.name, undefined)}
              >
                ${icon('x')}
              </button>`
            : html`<span class="def" title="default"
                >${p.type === 'bool' ? '' : `= ${fmtDefault(p)}`}</span
              >`
        }
      </div>
      ${p.help ? html`<div class="help">${p.help}</div>` : nothing}
    </div>`;
  }

  override render(): TemplateResult {
    const v = this.version;
    if (!v)
      return html`<div class="muted small">
        No flag schema for this engine version — flags are free text below.
      </div>`;
    const drop = new Set(this.dropParams);
    const q = this.filter.trim().toLowerCase();
    const params = v.params
      .filter((p) => !drop.has(p.name))
      .filter((p) => this.showDeprecated || !p.deprecated)
      .filter(
        (p) =>
          !q ||
          p.name.includes(q) ||
          (p.help ?? '').toLowerCase().includes(q) ||
          (p.group ?? '').includes(q),
      );
    const groups = new Map<string, EngineParam[]>();
    for (const p of params) {
      const g = p.group ?? 'other';
      const list = groups.get(g) ?? [];
      list.push(p);
      groups.set(g, list);
    }
    const ordered = [...groups.entries()]
      .map(([g, list]) => {
        list.sort(
          (a, b) =>
            IMPACT_RANK[impactOf(a)] - IMPACT_RANK[impactOf(b)] || a.name.localeCompare(b.name),
        );
        const best = Math.min(...list.map((p) => IMPACT_RANK[impactOf(p)]));
        const changed = list.filter((p) => !isDefault(p, this.args[p.name])).length;
        return { g, list, best, changed };
      })
      .sort((a, b) => a.best - b.best || a.g.localeCompare(b.g));
    const changedTotal = params.filter((p) => !isDefault(p, this.args[p.name])).length;

    return html`<div class="param-form">
      <div class="row">
        <div class="search-input grow">
          ${icon('search')}
          <input
            class="input sm"
            type="search"
            placeholder="Filter flags…"
            .value=${this.filter}
            @input=${(e: Event) => (this.filter = (e.target as HTMLInputElement).value)}
          />
        </div>
        <span class="xs muted nowrap">${params.length} flags · ${changedTotal} changed</span>
      </div>
      ${ordered.map(
        ({ g, list, best, changed }) =>
          html`<details class="param-group" ?open=${best === 0 || changed > 0 || !!q}>
            <summary>
              ${icon('chevronRight')} ${g}
              <span class="count">${list.length}${changed ? ` · ${changed} changed` : ''}</span>
              ${best === 0 ? html`<span class="tag accent" style="margin-left:auto">high impact</span>` : best === 1 ? html`<span class="tag" style="margin-left:auto">medium</span>` : html`<span class="tag" style="margin-left:auto">advanced</span>`}
            </summary>
            <div class="body">${list.map((p) => this.row(p))}</div>
          </details>`,
      )}
      ${params.length === 0 ? html`<div class="muted small">No flags match “${this.filter}”.</div>` : nothing}
      <div class="xs muted">
        Dropped from the fingerprint (cannot change a number): ${[...drop].join(', ') || 'none'}.
        <label class="checkbox" style="margin-left:8px"
          ><input
            type="checkbox"
            .checked=${this.showDeprecated}
            @change=${(e: Event) => (this.showDeprecated = (e.target as HTMLInputElement).checked)}
          />
          show deprecated</label
        >
      </div>
    </div>`;
  }
}
