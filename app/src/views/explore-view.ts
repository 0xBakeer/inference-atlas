import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { canonicalizeArgs, cellId, engineMinor, renderServeCommand } from '@atlas/core';
import type { Args, EngineMeta, EngineVersion, Model, Quant, ResultRecord } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import {
  resolveSelection,
  type CellChangeEvent,
  type CellSelection,
} from '../components/cell-picker.js';
import '../components/cell-picker.js';
import '../components/param-form.js';
import { icon } from '../components/icons.js';
import {
  codeBlock,
  emptyState,
  evBadge,
  hashChip,
  kindTag,
  metricCard,
  skeletonLines,
  verifBadge,
  when,
  who,
} from '../components/ui.js';
import type { IndexRow } from '../data/types.js';
import { href, qget, setQuery } from '../router.js';
import { store } from '../store.js';
import { copyText } from '../util/clipboard.js';
import { shortSha } from '../util/format.js';
import { blockCards, headlineMetric } from '../util/metrics.js';
import { nearestNeighbours } from '../util/neighbours.js';
import { ViewElement } from './view-base.js';

/** Mirrors core's model-ref resolution (not exported there) for the Copy-serve-command button. */
export function modelRefFor(
  meta: EngineMeta | null,
  model: Model | null,
  quant: Quant | null,
): string {
  if (!meta) return quant?.hf_id ?? model?.hf_id ?? '<model>';
  switch (meta.serve.model_ref) {
    case 'ollama_tag':
      return quant?.ollama_tag ?? `${model?.id ?? '<model>'}:latest`;
    case 'gguf_path':
      return quant?.files?.[0] ? `./models/${quant.files[0]}` : './models/<file>.gguf';
    case 'local_path':
    case 'mlx_path':
    case 'engine_dir':
      return `./models/${quant?.hf_id ?? model?.hf_id ?? '<model>'}`;
    default:
      return quant?.hf_id ?? model?.hf_id ?? '<model>';
  }
}

function parseArgs(s: string | null): Args {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Args) : {};
  } catch {
    return {};
  }
}

@customElement('atlas-explore-view')
export class AtlasExploreView extends ViewElement {
  @state() private versionFile: EngineVersion | null | undefined = undefined;
  @state() private cellRuns = new Map<string, ResultRecord>();
  @state() private tab = '';
  private versionKey = '';
  private runsKey = '';

  private selection(): CellSelection {
    const q = this.q;
    return resolveSelection(
      {
        engine: qget(q, 'engine'),
        version: qget(q, 'version'),
        model: qget(q, 'model'),
        quant: qget(q, 'quant'),
        hardware: qget(q, 'hardware'),
      },
      { requireAll: true },
    );
  }

  private get args(): Args {
    return parseArgs(qget(this.q, 'args'));
  }

  protected override willUpdate(_c: PropertyValues): void {
    const reg = store.registry.value;
    if (!reg) return;
    const sel = this.selection();
    const vk = `${sel.engine}/${sel.version}`;
    if (vk !== this.versionKey) {
      this.versionKey = vk;
      this.versionFile = undefined;
      if (sel.engine && sel.version) {
        void store.engineVersion(sel.engine, sel.version).then((vf) => {
          if (this.versionKey === vk) this.versionFile = vf;
        });
      } else this.versionFile = null;
    }
    // fetch every full run in this cell (needed for args_canonical of neighbours + metric blocks)
    const cell = this.cell(sel);
    if (cell && cell !== this.runsKey) {
      this.runsKey = cell;
      this.cellRuns = new Map();
      const rows = store.index.value.filter((r) => r.cell_id === cell);
      for (const r of rows) {
        void store.run(r).then((rec) => {
          if (rec && this.runsKey === cell) {
            const next = new Map(this.cellRuns);
            next.set(rec.run_id, rec);
            this.cellRuns = next;
          }
        });
      }
    }
  }

  private cell(sel: CellSelection): string | null {
    if (!sel.engine || !sel.version || !sel.model || !sel.quant || !sel.hardware) return null;
    return cellId({
      model_id: sel.model,
      quant_id: sel.quant,
      hardware_id: sel.hardware,
      hw_count: 1,
      engine_id: sel.engine,
      engine_minor: engineMinor(sel.version),
    });
  }

  private onCell(e: CellChangeEvent): void {
    const s = e.detail;
    setQuery({
      engine: s.engine,
      version: s.version,
      model: s.model,
      quant: s.quant,
      hardware: s.hardware,
    });
  }

  private onArgs(e: CustomEvent<Args>): void {
    const a = e.detail;
    setQuery({ args: Object.keys(a).length ? JSON.stringify(a) : null });
  }

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(8)}</div>`;
    const sel = this.selection();
    const lk = store.lookups;
    const engine = sel.engine ? (lk.engines.get(sel.engine) ?? null) : null;
    const modelEntry = sel.model ? (lk.models.get(sel.model) ?? null) : null;
    const quant =
      modelEntry && sel.quant ? (modelEntry.quants.find((q) => q.id === sel.quant) ?? null) : null;
    const hw = sel.hardware ? (lk.hardware.get(sel.hardware) ?? null) : null;
    const args = this.args;
    const dtype = qget(this.q, 'dtype');
    const vf = this.versionFile ?? null;

    const canon =
      sel.quant && engine
        ? canonicalizeArgs({
            engine_id: engine.meta.id,
            engine_version: sel.version,
            args,
            quant_id: sel.quant,
            dtype,
            params: vf?.params ?? null,
            drop_params: engine.meta.drop_params,
            param_aliases: engine.meta.param_aliases ?? null,
          })
        : null;
    const cell = this.cell(sel);
    const cellRows = cell ? store.index.value.filter((r) => r.cell_id === cell) : [];
    const matching = canon ? cellRows.filter((r) => r.config_id === canon.configId) : [];
    const cov = cell ? store.coverage.value[cell] : undefined;
    const serve = engine
      ? renderServeCommand(
          engine.meta,
          modelRefFor(engine.meta, modelEntry?.model ?? null, quant),
          args,
        )
      : '';

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Config explorer</div>
        <h1>Pick a configuration. See if anyone has measured it.</h1>
        <p class="lede">
          The fingerprint updates on every keystroke — it is the same <code>config_id</code> the
          validator computes, so a match here is a match in the data.
        </p>
      </div>

      <div class="two-pane">
        <div class="col" style="gap:var(--sp-4)">
          <div class="card">
            <div class="card-head">
              <h3>Cell</h3>
              <span class="muted small">only compatible combinations</span>
            </div>
            <atlas-cell-picker .value=${sel} @cell-change=${this.onCell}></atlas-cell-picker>
            <label class="field mt-3">
              <span class="label">dtype</span>
              <input
                class="input sm mono"
                type="text"
                placeholder="auto"
                .value=${dtype ?? ''}
                @input=${(e: Event) => setQuery({ dtype: (e.target as HTMLInputElement).value || null })}
              />
            </label>
            ${
              quant
                ? html`<div class="xs muted mt-2">
                    ${quant.format} · ${quant.bits}
                    bit${quant.size_gb ? ` · ${quant.size_gb} GB weights` : ''}${hw?.memory_gb && quant.size_gb && quant.size_gb > hw.memory_gb ? html` · <span style="color:var(--danger)">does not fit in ${hw.memory_gb} GB</span>` : ''}
                  </div>`
                : nothing
            }
          </div>

          <div class="card">
            <div class="card-head">
              <h3>Flags</h3>
              <span class="muted small">${engine?.meta.name ?? ''} ${sel.version ?? ''}</span>
              <span class="spacer"></span>
              ${Object.keys(args).length ? html`<button class="btn btn-ghost btn-sm" @click=${() => setQuery({ args: null })}>Reset all</button>` : nothing}
            </div>
            ${
              this.versionFile === undefined
                ? skeletonLines(6)
                : html`<atlas-param-form
                    .version=${vf}
                    .args=${args}
                    .dropParams=${engine?.meta.drop_params ?? []}
                    @args-change=${this.onArgs}
                  ></atlas-param-form>`
            }
            ${vf ? nothing : this.freeArgs(args)}
          </div>
        </div>

        <div class="col" style="gap:var(--sp-4)">
          ${
            canon
              ? html`<div class="config-id-card">
                  <div class="row">
                    <div class="grow">
                      <div class="k">config_id</div>
                      <div class="id">${canon.configId}</div>
                    </div>
                    <button
                      class="btn btn-sm"
                      style="background:transparent;color:inherit;border-color:currentColor;opacity:.8"
                      @click=${() => copyText(canon.configId, 'config_id copied')}
                    >
                      ${icon('copy')} Copy
                    </button>
                  </div>
                  <div class="canon">
                    ${canon.canonical.split(';').map((kv, i) => html`${i ? html`<span style="opacity:.4">;</span>` : ''}<b>${kv.split('=')[0]}</b>=${kv.slice(kv.indexOf('=') + 1)}`)}
                  </div>
                  <div class="row mt-2 xs" style="opacity:.7;gap:12px">
                    <span>cell <span class="mono">${cell ?? '–'}</span></span>
                    <span
                      >${Object.keys(canon.resolved).length - 2} non-default
                      flag${Object.keys(canon.resolved).length - 2 === 1 ? '' : 's'}</span
                    >
                    ${cov ? html`<span>${evBadge(cov.level)}</span>` : html`<span>cell has no runs</span>`}
                  </div>
                </div>`
              : nothing
          }
          ${matching.length ? this.tested(matching, cellRows) : this.untested(canon?.canonical ?? null, cellRows, sel, args, dtype, serve, engine?.meta ?? null, vf)}
          ${
            engine
              ? html`<div class="card">
                  <div class="card-head">
                    <h3>Serve command</h3>
                    <span class="spacer"></span
                    >${addButton({ engine_id: sel.engine, engine_version: sel.version, model_id: sel.model, quant_id: sel.quant, hardware_id: sel.hardware, args, dtype }, { label: 'Add measurement', size: 'sm' })}
                  </div>
                  ${codeBlock(serve, { lang: 'bash' })}
                </div>`
              : nothing
          }
        </div>
      </div>
    </div>`;
  }

  /** Fallback editor when no version file exists: name=value lines. */
  private freeArgs(args: Args): TemplateResult {
    const text = Object.entries(args)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n');
    return html`<label class="field mt-3">
      <span class="label">Flags, one per line as name=value</span>
      <textarea
        class="textarea"
        .value=${text}
        @change=${(e: Event) => {
          const next: Args = {};
          for (const line of (e.target as HTMLTextAreaElement).value.split('\n')) {
            const i = line.indexOf('=');
            if (i <= 0) continue;
            const k = line.slice(0, i).trim();
            const raw = line.slice(i + 1).trim();
            let v: Args[string] = raw;
            if (raw === 'true') v = true;
            else if (raw === 'false') v = false;
            else if (raw !== '' && !Number.isNaN(Number(raw))) v = Number(raw);
            else if (/^[[{]/.test(raw)) {
              try {
                v = JSON.parse(raw);
              } catch {
                v = raw;
              }
            }
            next[k] = v;
          }
          setQuery({ args: Object.keys(next).length ? JSON.stringify(next) : null });
        }}
      ></textarea>
    </label>`;
  }

  private tested(matching: IndexRow[], _cellRows: IndexRow[]): TemplateResult {
    const workloads = [...new Set(matching.map((r) => r.workload_id))];
    const tab = workloads.includes(this.tab) ? this.tab : workloads[0]!;
    const rows = matching.filter((r) => r.workload_id === tab);
    const keyMetrics = store.site.coverage.key_metrics;
    return html`<div class="card flush">
      <div class="card-head" style="border-bottom:0;padding-bottom:0">
        <div class="tested-banner yes grow">
          ${icon('check')} Tested — ${matching.length} run${matching.length === 1 ? '' : 's'} with
          exactly this configuration
        </div>
      </div>
      <div class="tabs" style="padding:0 var(--sp-4)">
        ${workloads.map((w) => html`<button class="tab" role="tab" aria-selected=${w === tab} @click=${() => (this.tab = w)}>${w} <span class="count">${matching.filter((r) => r.workload_id === w).length}</span></button>`)}
      </div>
      <div style="padding:var(--sp-4)" class="col" style="gap:var(--sp-4)">
        ${rows.map((r) => {
          const rec = this.cellRuns.get(r.run_id);
          const cards = rec ? blockCards(rec.metrics) : [];
          const hl = headlineMetric(r, keyMetrics);
          const repoUrl = `${store.site.repo.host ?? 'https://github.com'}/${store.site.repo.owner}/${store.site.repo.name}`;
          return html`<div class="col" style="gap:10px;margin-bottom:var(--sp-4)">
            <div class="row-wrap" style="justify-content:space-between">
              <div class="row-wrap">
                ${who(r.provenance.login, { userId: r.provenance.user_id, avatarUrl: r.provenance.avatar_url })}
                ${verifBadge(r.verification_level)} ${kindTag(r.kind)}
                <span class="xs muted"
                  >${when(r.provenance.submitted_at ?? r.provenance.started_at)}</span
                >
                ${r.provenance.commit ? hashChip(r.provenance.commit, { href: `${repoUrl}/commit/${r.provenance.commit}`, short: 7, title: 'adding commit' }) : nothing}
                ${r.provenance.pr ? html`<a class="hash link" href=${`${repoUrl}/pull/${r.provenance.pr}`} target="_blank" rel="noopener">PR #${r.provenance.pr}</a>` : nothing}
              </div>
              <div class="row">
                <a class="btn btn-sm" href=${href('run', r.run_id)}
                  >Open run ${icon('arrowRight')}</a
                >
                <a class="btn btn-sm" href=${`#/compare?runs=${r.run_id}`}
                  >${icon('compare')} Compare</a
                >
                ${addButton({ engine_id: r.engine.id, engine_version: r.engine.version, model_id: r.model.id, quant_id: r.model.quant_id, hardware_id: r.hardware.id, args: rec?.args ?? {}, workload_ids: [r.workload_id] }, { label: 'Reproduce', size: 'sm' })}
              </div>
            </div>
            ${
              cards.length
                ? html`<div class="metric-grid">
                    ${cards.slice(0, 8).map((c, i) => metricCard(c, { hero: i === 0 }))}
                  </div>`
                : rec
                  ? html`<div class="muted small">
                      ${hl ? `${hl.def.label}: ${hl.def.fmt(hl.value)} ${hl.def.unit}` : 'No metrics recorded.'}
                    </div>`
                  : skeletonLines(3)
            }
            ${
              rec?.raw?.payload
                ? html`<details class="json-view">
                    <summary>${icon('chevronRight')} Raw payload</summary>
                    ${codeBlock(JSON.stringify(rec.raw.payload, null, 2), { lang: 'json', maxHeight: 320 })}
                  </details>`
                : nothing
            }
          </div>`;
        })}
      </div>
    </div>`;
  }

  private untested(
    canonical: string | null,
    cellRows: IndexRow[],
    sel: CellSelection,
    args: Args,
    dtype: string | null,
    serve: string,
    meta: EngineMeta | null,
    vf: EngineVersion | null,
  ): TemplateResult {
    const recs = cellRows
      .map((r) => this.cellRuns.get(r.run_id))
      .filter((r): r is ResultRecord => !!r);
    const loading = recs.length < cellRows.length;
    const neighbours = canonical
      ? nearestNeighbours(canonical, recs, (r) => r.args_canonical, 8)
      : [];
    const keyMetrics = store.site.coverage.key_metrics;
    const site = store.site;
    const repoUrl = `${site.repo.host ?? 'https://github.com'}/${site.repo.owner}/${site.repo.name}`;
    const issue = `${repoUrl}/issues/new?template=request-config.yml&title=${encodeURIComponent(`Request: ${sel.engine} ${sel.version} ${sel.model}/${sel.quant} on ${sel.hardware}`)}&engine=${encodeURIComponent(sel.engine ?? '')}&engine_version=${encodeURIComponent(sel.version ?? '')}&model=${encodeURIComponent(sel.model ?? '')}&quant=${encodeURIComponent(sel.quant ?? '')}&hardware=${encodeURIComponent(sel.hardware ?? '')}&args=${encodeURIComponent(JSON.stringify(args))}&labels=wanted,request`;
    const spec = {
      engine_id: sel.engine,
      engine_version: sel.version,
      model_id: sel.model,
      quant_id: sel.quant,
      hardware_id: sel.hardware,
      args,
      dtype,
    };

    // "differs only because defaults changed": a neighbour whose explicit args canonicalize to our id under our version file
    const defaultsNote = (rec: ResultRecord): boolean => {
      if (!meta || !vf || rec.engine.version === sel.version) return false;
      const c = canonicalizeArgs({
        engine_id: meta.id,
        engine_version: sel.version,
        args: rec.args,
        quant_id: rec.model.quant_id,
        dtype: rec.model.dtype ?? null,
        params: vf.params,
        drop_params: meta.drop_params,
        param_aliases: meta.param_aliases ?? null,
      });
      return canonical !== null && c.canonical === canonical;
    };

    return html`<div class="card">
      <div class="tested-banner no">
        ${icon('flag')} Nobody has measured exactly this configuration yet.
      </div>
      <div class="row-wrap mt-3">
        ${addButton(spec, { label: 'Add measurement', primary: true })}
        <button class="btn" @click=${() => copyText(serve, 'Serve command copied')}>
          ${icon('copy')} Copy serve command
        </button>
        <a class="btn" href=${issue} target="_blank" rel="noopener"
          >${icon('github')} Request this config</a
        >
      </div>
      ${
        cellRows.length
          ? html`<div class="mt-4">
              <div class="section-title">
                <h2>Nearest neighbours</h2>
                <span class="meta">same cell, sorted by how many flags differ</span>
              </div>
              ${loading ? skeletonLines(3) : nothing}
              <div class="col">
                ${neighbours.map((n) => {
                  const r = n.item;
                  const row = cellRows.find((x) => x.run_id === r.run_id);
                  const hl = row ? headlineMetric(row, keyMetrics) : null;
                  const mine = canonical
                    ? Object.fromEntries(
                        canonical
                          .split(';')
                          .map((kv) => [kv.split('=')[0]!, kv.slice(kv.indexOf('=') + 1)]),
                      )
                    : {};
                  const theirs = Object.fromEntries(
                    r.args_canonical
                      .split(';')
                      .map((kv) => [kv.split('=')[0]!, kv.slice(kv.indexOf('=') + 1)]),
                  );
                  return html`<a class="neighbour" href=${href('run', r.run_id)}>
                    <span class="row-wrap" style="gap:6px">
                      <span class="mono xs">${r.workload_id}</span> ${kindTag(r.kind)}
                      <span class="xs muted"
                        >${r.engine.version} · ${r.provenance.github_login} ·
                        ${when(r.provenance.submitted_at ?? r.provenance.started_at)}</span
                      >
                      ${r.provenance.commit ? html`<span class="hash">${shortSha(r.provenance.commit)}</span>` : nothing}
                    </span>
                    <span class="row" style="gap:8px">
                      ${hl ? html`<span class="mono" style="font-weight:500">${hl.def.fmt(hl.value)}<span class="unit">${hl.def.unit}</span></span>` : nothing}
                      <span class="dist"
                        >${n.distance === 0 ? 'identical flags' : `${n.distance} flag${n.distance === 1 ? '' : 's'} differ`}</span
                      >
                    </span>
                    <span class="diffs">
                      ${n.differing.map((k) => html`<span class="tag mono" title=${`${k}: theirs ${theirs[k] ?? 'unset'} → yours ${mine[k] ?? 'unset'}`}>${k}: ${theirs[k] ?? '∅'} → ${mine[k] ?? '∅'}</span>`)}
                      ${defaultsNote(r) ? html`<span class="tag info">differs only because defaults changed in ${sel.version}</span>` : nothing}
                    </span>
                  </a>`;
                })}
              </div>
            </div>`
          : html`<p class="small muted mt-3">
              This cell (${sel.model}/${sel.quant} on ${sel.hardware} with ${sel.engine}
              ${sel.version ? engineMinor(sel.version) : ''}) has no runs at all, so there is
              nothing to compare against.
            </p>`
      }
      ${cellRows.length === 0 && canonical ? emptyState({ compact: true, title: 'Be the first', text: 'The packet on the Add button carries these exact flags.' }) : nothing}
    </div>`;
  }
}
