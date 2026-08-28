/** Stateless template helpers shared by every view. */
import { html, nothing, render, svg, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import type {
  CoverageLevel,
  Distribution,
  ResolvedConditions,
  VerificationLevel,
  WorkloadKind,
} from '@atlas/core';
import { href, modelHref } from '../router.js';
import { store } from '../store.js';
import { copyText } from '../util/clipboard.js';
import { vendorClass } from '../util/colors.js';
import { absDateTime, relTime } from '../util/dates.js';
import { fmtMs, fmtTokS, fmtSignedPct, isNum } from '../util/format.js';
import { distSummary, type MetricCardData } from '../util/metrics.js';
import { icon } from './icons.js';

/* ------------------------------------------------------------------ people */

export interface AvatarOpts {
  userId?: number | null;
  avatarUrl?: string | null;
  size?: 'sm' | 'md' | 'lg' | '';
}

/**
 * Avatars come from the compiled data (`avatar_url`), or from the numeric user id the build
 * resolved (`avatars.githubusercontent.com/u/<id>`, DESIGN §12). Never from api.github.com.
 */
export function avatarSrc(login: string, opts: AvatarOpts = {}): string | null {
  if (opts.avatarUrl) return opts.avatarUrl;
  if (typeof opts.userId === 'number')
    return `https://avatars.githubusercontent.com/u/${opts.userId}?s=64&v=4`;
  return null;
}

export function avatar(login: string, opts: AvatarOpts = {}): TemplateResult {
  const src = avatarSrc(login, opts);
  const cls = `avatar ${opts.size ?? ''}`;
  if (src)
    return html`<span class=${cls} title=${login}><img src=${src} alt="" loading="lazy" /></span>`;
  return html`<span class=${cls} title=${login}>${login.slice(0, 2)}</span>`;
}

export function who(login: string, opts: AvatarOpts = {}): TemplateResult {
  return html`<a class="who" href=${href('contributors', login)}
    >${avatar(login, opts)}<span>${login}</span></a
  >`;
}

/* ------------------------------------------------------------------ badges */

export function evBadge(level: CoverageLevel, label?: string): TemplateResult {
  return html`<span class="ev-badge"><i class="ev ${level}"></i>${label ?? level}</span>`;
}

export function verifBadge(level: VerificationLevel | string): TemplateResult {
  return html`<span class="verif ${level}">${level}</span>`;
}

/**
 * Run-conditions tag. Deliberately neutral: in this app colour means evidence, and a shared
 * box is a fact about a run, not a defect. The asserted detail rides in the title; what was
 * MEASURED (vs asserted) is rendered separately by `condMeasured`.
 */
export function condTag(c: ResolvedConditions): TemplateResult {
  if (c.dedicated === null)
    return html`<span
      class="tag"
      title="This run did not record conditions in a machine-readable form. The run's notes are the only record."
      >conditions not recorded</span
    >`;
  return c.dedicated
    ? html`<span
        class="tag"
        title=${c.detail ? `Box was dedicated: ${c.detail}` : 'Box was dedicated'}
        >${icon('box')} dedicated box</span
      >`
    : html`<span
        class="tag"
        title=${c.detail ? `Box was not dedicated: ${c.detail}` : 'Box was not dedicated'}
        >${icon('users')} shared box</span
      >`;
}

/** Whether isolation was measured or only asserted — the distinction the vocabulary draws. */
export function condMeasured(c: ResolvedConditions): TemplateResult | typeof nothing {
  if (c.isolationCheck)
    return html`<div
      class="xs muted"
      style="margin-top:2px"
      title=${`Isolation check: ${c.isolationCheck}`}
    >
      isolation measured
    </div>`;
  if (c.dedicated !== null)
    return html`<div
      class="xs muted"
      style="margin-top:2px"
      title="The contributor stated the conditions; no isolation check was recorded as measured."
    >
      asserted, not measured
    </div>`;
  return nothing;
}

export function kindTag(kind: WorkloadKind | string): TemplateResult {
  return html`<span class="tag kind-${kind}">${kind}</span>`;
}

export function hashChip(
  value: string | null | undefined,
  opts: { href?: string; title?: string; short?: number } = {},
): TemplateResult {
  if (!value) return html`<span class="faint">–</span>`;
  const text = opts.short ? value.slice(0, opts.short) : value;
  if (opts.href) {
    const ext = opts.href.startsWith('http');
    return html`<a
      class="hash link"
      href=${opts.href}
      title=${opts.title ?? value}
      target=${ext ? '_blank' : nothing}
      rel=${ext ? 'noopener' : nothing}
      >${text}</a
    >`;
  }
  return html`<span class="hash" title=${opts.title ?? value}>${text}</span>`;
}

export function vendorDot(vendor: string | null | undefined): TemplateResult {
  return html`<i class="vendor-dot ${vendorClass(vendor)}"></i>`;
}

/* ------------------------------------------------------------------ registry labels (linked) */

export function modelName(id: string): string {
  return store.lookups.models.get(id)?.model.name ?? id;
}
export function hardwareName(id: string): string {
  return store.lookups.hardware.get(id)?.name ?? id;
}
export function engineName(id: string): string {
  return store.lookups.engines.get(id)?.meta.name ?? id;
}
export function workloadName(id: string): string {
  return store.lookups.workloads.get(id)?.name ?? id;
}

export function modelLink(id: string, quant?: string | null): TemplateResult {
  return html`<a class="reg-link mono" href=${modelHref(id)} title=${modelName(id)}>${id}</a>${
      quant ? html`<span class="muted">/</span><span class="quant">${quant}</span>` : nothing
    }`;
}
export function hardwareLink(id: string, count = 1): TemplateResult {
  const hw = store.lookups.hardware.get(id);
  return html`<a
    class="reg-link row"
    style="display:inline-flex;gap:5px"
    href=${href('hardware', id)}
    title=${hw?.name ?? id}
    >${vendorDot(hw?.vendor)}<span>${id}</span>${count > 1 ? html`<span class="tag mono">×${count}</span>` : nothing}</a
  >`;
}
export function engineLink(id: string, version?: string | null): TemplateResult {
  return html`<a class="reg-link" href=${href('engines', id)} title=${engineName(id)}>${id}</a>${
      version ? html` <span class="mono muted">${version}</span>` : nothing
    }`;
}
export function workloadLink(id: string): TemplateResult {
  return html`<a class="reg-link" href=${href('workloads', id)} title=${workloadName(id)}
    >${id}</a
  >`;
}
export function runLink(runId: string, text?: string): TemplateResult {
  return html`<a class="hash link" href=${href('run', runId)} title=${runId}
    >${text ?? runId.slice(0, 16)}</a
  >`;
}

/* ------------------------------------------------------------------ dates */

export function when(iso: string | null | undefined): TemplateResult {
  if (!iso) return html`<span class="faint">–</span>`;
  return html`<time datetime=${iso} title=${absDateTime(iso)}>${relTime(iso)}</time>`;
}

/* ------------------------------------------------------------------ states */

export function emptyState(opts: {
  title: string;
  text?: string;
  action?: TemplateResult;
  compact?: boolean;
}): TemplateResult {
  return html`<div class="empty ${opts.compact ? 'compact' : ''}">
    ${
      opts.compact
        ? nothing
        : html`<div class="glyph" aria-hidden="true">
            <i></i><i></i><i></i><i></i><i class="on"></i><i></i><i></i><i></i><i></i>
          </div>`
    }
    <div>
      <h3>${opts.title}</h3>
      ${opts.text ? html`<p>${opts.text}</p>` : nothing}
    </div>
    ${opts.action ?? nothing}
  </div>`;
}

export function errorBox(message: string): TemplateResult {
  return html`<div class="error-box">${icon('alert')} ${message}</div>`;
}

export function skeletonLines(n = 4, widths: number[] = [90, 70, 80, 50]): TemplateResult {
  return html`${Array.from({ length: n }, (_, i) => html`<div class="skeleton sk-line" style="width:${widths[i % widths.length]}%"></div>`)}`;
}
export function skeletonBlock(height = 200): TemplateResult {
  return html`<div class="skeleton sk-block" style="height:${height}px"></div>`;
}

/* ------------------------------------------------------------------ code / copy */

export function copyBtn(
  text: string | (() => string),
  label = 'Copy',
  opts: { cls?: string; done?: string } = {},
): TemplateResult {
  return html`<button
    class="btn btn-sm ${opts.cls ?? ''}"
    type="button"
    @click=${(e: Event) => {
      e.stopPropagation();
      void copyText(typeof text === 'function' ? text() : text, opts.done ?? 'Copied to clipboard');
    }}
  >
    ${icon('copy')} ${label}
  </button>`;
}

export function codeBlock(
  code: string,
  opts: { lang?: string; copy?: boolean; maxHeight?: number | 'none'; cls?: string } = {},
): TemplateResult {
  const style = opts.maxHeight
    ? { '--code-max': opts.maxHeight === 'none' ? 'none' : `${opts.maxHeight}px` }
    : {};
  return html`<div class="codeblock ${opts.cls ?? ''}" style=${styleMap(style)}>
    ${opts.copy === false ? nothing : html`<span class="copy">${copyBtn(code, 'Copy', { cls: 'btn-xs' })}</span>`}
    <pre data-lang=${opts.lang ?? ''}><code>${code}</code></pre>
  </div>`;
}

/* ------------------------------------------------------------------ key/value */

export type KvRow = [label: string, value: unknown] | null | undefined | false;

export function kv(rows: KvRow[]): TemplateResult {
  return html`<dl class="kv">
    ${rows.filter(Boolean).map((r) => {
      const [k, v] = r as [string, unknown];
      return html`<dt>${k}</dt>
        <dd>
          ${v === null || v === undefined || v === '' ? html`<span class="faint">–</span>` : v}
        </dd>`;
    })}
  </dl>`;
}

/* ------------------------------------------------------------------ metrics */

export function rangeBar(
  d: Distribution | null | undefined,
  fmt: (v: number | null | undefined) => string = fmtMs,
): TemplateResult | typeof nothing {
  const s = distSummary(d);
  if (!s) return nothing;
  const lo = s.min ?? s.p50 ?? s.mean;
  const hi = s.max ?? s.p95 ?? s.p50 ?? s.mean;
  if (!isNum(lo) || !isNum(hi)) return nothing;
  const span = Math.max(hi - lo, 1e-9);
  const pos = (v: number) => `${((v - lo) / span) * 100}%`;
  return html`<div
      class="rangebar"
      title="min ${fmt(s.min)} · p50 ${fmt(s.p50)} · p95 ${fmt(s.p95)} · max ${fmt(s.max)}"
    >
      <div class="span" style="left:0;right:0"></div>
      ${isNum(s.p50) ? html`<div class="p50" style="left:${pos(s.p50)}"></div>` : nothing}
      ${isNum(s.p95) ? html`<div class="p95" style="left:${pos(s.p95)}"></div>` : nothing}
    </div>
    <div class="row xs muted mono" style="justify-content:space-between;margin-top:3px">
      <span>${fmt(lo)}</span><span>${s.p50 !== null ? `p50 ${fmt(s.p50)}` : ''}</span
      ><span>${fmt(hi)}</span>
    </div>`;
}

export function metricCard(c: MetricCardData, opts: { hero?: boolean } = {}): TemplateResult {
  const fmt = c.unit === 'ms' ? fmtMs : c.unit === 'tok/s' ? fmtTokS : undefined;
  return html`<div class="metric ${opts.hero ? 'hero' : ''}">
    <span class="k">${c.label}</span>
    <span class="v ${c.value === null ? 'na' : ''}"
      >${c.text}${c.unit && c.value !== null ? html`<span class="unit">${c.unit}</span>` : nothing}</span
    >
    ${c.dist ? rangeBar(c.dist, fmt) : nothing}
  </div>`;
}

export function hbar(
  label: string | TemplateResult,
  frac: number | null,
  text: string,
  colorVar?: string,
): TemplateResult {
  const w = frac === null ? 0 : Math.max(0, Math.min(1, frac)) * 100;
  return html`<div class="hbar">
    <span class="ellipsis" title=${typeof label === 'string' ? label : ''}>${label}</span>
    <div class="track">
      <div
        class="fill"
        style=${styleMap({ width: `${w}%`, background: colorVar ? `var(${colorVar})` : '' })}
      ></div>
    </div>
    <span class="val">${text}</span>
  </div>`;
}

/**
 * Inline sparkline for telemetry tiles: value against an implicit ordinal x, scaled to its
 * own min–max so shape (rising power, flat utilisation) survives at 100×26. Gaps stay gaps.
 */
export function sparkline(
  values: Array<number | null>,
  opts: { width?: number; height?: number; colorVar?: string } = {},
): TemplateResult {
  const w = opts.width ?? 100;
  const h = opts.height ?? 26;
  const colorVar = opts.colorVar ?? '--chart-1';
  const nums = values.filter(isNum);
  if (nums.length === 0) return html`${nothing}`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const pad = 3;
  const span = max - min || 1;
  const x = (i: number) => (values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 2) + 1);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const segs: string[] = [];
  values.forEach((v, i) => {
    segs.push(isNum(v) ? `${segs.length && isNum(values[i - 1]) ? 'L' : 'M'}${x(i)} ${y(v)}` : '');
  });
  const path = segs.join(' ').trim();
  const last = [...values].reverse().find(isNum);
  const lastIdx = values.length - 1 - [...values].reverse().findIndex(isNum);
  return html`<svg
    class="sparkline"
    width=${w}
    height=${h}
    viewBox=${`0 0 ${w} ${h}`}
    aria-hidden="true"
  >
    ${
      path
        ? svg`<path d=${path} fill="none" stroke=${`var(${colorVar})`} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>`
        : nothing
    }
    ${isNum(last) ? svg`<circle cx=${x(lastIdx)} cy=${y(last)} r="2.5" fill=${`var(${colorVar})`}></circle>` : nothing}
  </svg>`;
}

export function deltaTag(
  d: { pct: number; better: boolean; same: boolean } | null,
): TemplateResult {
  if (!d) return html`<span class="delta same">–</span>`;
  const cls = classMap({
    delta: true,
    better: d.better,
    worse: !d.better && !d.same,
    same: d.same,
  });
  return html`<span class=${cls}
    >${d.same ? '=' : d.pct > 0 ? icon('arrowUp') : icon('arrowDown')}${fmtSignedPct(d.pct)}</span
  >`;
}

/* ------------------------------------------------------------------ tooltip */

let tipEl: HTMLDivElement | null = null;
export function showTip(x: number, y: number, content: TemplateResult): void {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  render(content, tipEl);
  tipEl.style.display = 'block';
  const rect = tipEl.getBoundingClientRect();
  const pad = 12;
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
  tipEl.style.left = `${Math.max(4, left)}px`;
  tipEl.style.top = `${Math.max(4, top)}px`;
}
export function hideTip(): void {
  if (tipEl) tipEl.style.display = 'none';
}

/* ------------------------------------------------------------------ misc */

export function extLink(url: string, text: string | TemplateResult): TemplateResult {
  return html`<a href=${url} target="_blank" rel="noopener">${text} ${icon('external', 'xs')}</a>`;
}

export function sortIcon(active: boolean, dir: 'asc' | 'desc'): TemplateResult {
  if (!active) return html`<span class="sort">${icon('sort')}</span>`;
  return html`<span class="sort">${icon(dir === 'asc' ? 'arrowUp' : 'arrowDown')}</span>`;
}

export function segmented<T extends string>(
  options: Array<{ value: T; label: string }>,
  value: T,
  onChange: (v: T) => void,
  cls = '',
): TemplateResult {
  return html`<div class="seg ${cls}" role="group">
    ${options.map(
      (o) =>
        html`<button
          type="button"
          aria-pressed=${o.value === value}
          @click=${() => onChange(o.value)}
        >
          ${o.label}
        </button>`,
    )}
  </div>`;
}

export function selectField(
  label: string,
  value: string | null,
  options: Array<{ value: string; label: string; disabled?: boolean }>,
  onChange: (v: string | null) => void,
  opts: { allLabel?: string; small?: boolean; allowEmpty?: boolean } = {},
): TemplateResult {
  return html`<label class="field">
    <span class="label">${label}</span>
    <select
      class="select ${opts.small ? 'sm' : ''}"
      @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value || null)}
    >
      ${opts.allowEmpty === false ? nothing : html`<option value="" ?selected=${!value}>${opts.allLabel ?? 'All'}</option>`}
      ${options.map((o) => html`<option value=${o.value} ?selected=${o.value === value} ?disabled=${o.disabled}>${o.label}</option>`)}
    </select>
  </label>`;
}
