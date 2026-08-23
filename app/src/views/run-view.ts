import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { renderServeCommand } from '@atlas/core';
import type { EngineVersion, ResultRecord } from '@atlas/core';
import { addButton } from '../components/add-modal.js';
import '../components/chart.js';
import '../components/run-picker.js';
import { icon } from '../components/icons.js';
import {
  sweepAxisOf,
  sweepChartBuild,
  sweepHasMetric,
  sweepX,
  sweepY,
  type SweepMetric,
} from '../components/sweep-chart.js';
import {
  codeBlock,
  copyBtn,
  emptyState,
  engineLink,
  hardwareLink,
  hashChip,
  hbar,
  kindTag,
  kv,
  metricCard,
  modelLink,
  skeletonBlock,
  skeletonLines,
  verifBadge,
  when,
  who,
  workloadLink,
} from '../components/ui.js';
import { href, navigate } from '../router.js';
import { store } from '../store.js';
import { cssVar } from '../util/colors.js';
import { absDateTime } from '../util/dates.js';
import { fmtInt, fmtMs, fmtNum, fmtPct, fmtTokS, shortSha } from '../util/format.js';
import { blockCards } from '../util/metrics.js';
import { fmtDefault, isDefault } from '../components/param-form.js';
import { modelRefFor } from './explore-view.js';
import { ViewElement } from './view-base.js';

@customElement('atlas-run-view')
export class AtlasRunView extends ViewElement {
  @property({ attribute: false }) runId = '';
  @state() private rec: ResultRecord | null | undefined = undefined;
  @state() private vf: EngineVersion | null = null;
  @state() private itemFilter: 'all' | 'correct' | 'incorrect' = 'all';
  @state() private sweepMetric: SweepMetric = 'throughput';
  private loadedFor = '';

  protected override willUpdate(_c: PropertyValues): void {
    if (this.runId && this.runId !== this.loadedFor && store.registry.value) {
      this.loadedFor = this.runId;
      this.rec = undefined;
      const row = store.rowById(this.runId);
      void store.run(row ?? { run_id: this.runId }).then((rec) => {
        if (this.loadedFor !== this.runId) return;
        this.rec = rec;
        if (rec)
          void store.engineVersion(rec.engine.id, rec.engine.version).then((vf) => (this.vf = vf));
      });
    }
  }

  private repoUrl(): string {
    const s = store.site;
    return `${s.repo.host ?? 'https://github.com'}/${s.repo.owner}/${s.repo.name}`;
  }

  override render() {
    if (!store.registry.value) return html`<div class="page">${skeletonLines(8)}</div>`;
    if (this.rec === undefined)
      return html`<div class="page">${skeletonLines(3)}${skeletonBlock(240)}</div>`;
    const rec = this.rec;
    if (!rec) {
      return html`<div class="page">
        ${emptyState({ title: 'No run with this id', text: `“${this.runId}” is not in the compiled index. It may have been renamed, or the data has not been rebuilt since it was added.`, action: html`<a class="btn" href="#/results">${icon('table')} Browse results</a>` })}
      </div>`;
    }
    const row = store.rowById(rec.run_id);
    const repo = this.repoUrl();
    const prov = rec.provenance;
    const cards = blockCards(rec.metrics);
    const lk = store.lookups;
    const engine = lk.engines.get(rec.engine.id) ?? null;
    const model = lk.models.get(rec.model.id) ?? null;
    const quant = model?.quants.find((q) => q.id === rec.model.quant_id) ?? null;
    const serve =
      rec.serve_command ??
      (engine
        ? renderServeCommand(
            engine.meta,
            modelRefFor(engine.meta, model?.model ?? null, quant),
            rec.args,
          )
        : '');
    const workload = lk.workloads.get(rec.workload_id) ?? null;
    const issueUrl = `${repo}/issues/new?title=${encodeURIComponent(`Problem with run ${rec.run_id}`)}&body=${encodeURIComponent(`Run: ${location.href}\nFile: ${row?.path ?? ''}\n\nWhat looks wrong:\n`)}&labels=data-issue`;
    const reproduceSpec = {
      engine_id: rec.engine.id,
      engine_version: rec.engine.version,
      model_id: rec.model.id,
      quant_id: rec.model.quant_id,
      hardware_id: rec.hardware.id,
      hw_count: rec.hardware.count,
      args: rec.args,
      dtype: rec.model.dtype ?? null,
      workload_ids: [rec.workload_id],
    };

    return html`<div class="page">
      <div class="run-head">
        <div class="row-wrap xs muted">
          <a href="#/results">Results</a> ${icon('chevronRight')}
          <span class="mono">${rec.run_id}</span>
          ${copyBtn(rec.run_id, '', { cls: 'btn-xs btn-ghost', done: 'run_id copied' })}
        </div>
        <div class="title">
          <span
            ><a href=${href('engines', rec.engine.id)}>${engine?.meta.name ?? rec.engine.id}</a>
            <span class="ver">${rec.engine.version}</span></span
          >
          <span class="sep">·</span>
          <span
            ><a href=${href('models', rec.model.id)}>${model?.model.name ?? rec.model.id}</a
            ><span class="ver">/${rec.model.quant_id}</span></span
          >
          <span class="sep">·</span>
          <span
            ><a href=${href('hardware', rec.hardware.id)}
              >${lk.hardware.get(rec.hardware.id)?.name ?? rec.hardware.id}</a
            >${rec.hardware.count > 1 ? html`<span class="ver"> ×${rec.hardware.count}</span>` : nothing}</span
          >
        </div>
        <div class="meta">
          ${kindTag(rec.kind)} ${workloadLink(rec.workload_id)}
          ${workload ? html`<span class="muted">${workload.name}</span>` : nothing}
          ${verifBadge(rec.verification.level)}
          ${rec.verification.reproduced_by?.length ? html`<span class="xs muted">reproduced by ${rec.verification.reproduced_by.join(', ')}</span>` : nothing}
          <span class="xs muted"
            >cell ${hashChip(rec.cell_id)} config
            ${hashChip(rec.config_id, { href: `#/explore?engine=${rec.engine.id}&version=${rec.engine.version}&model=${rec.model.id}&quant=${rec.model.quant_id}&hardware=${rec.hardware.id}&args=${encodeURIComponent(JSON.stringify(rec.args))}`, title: 'open in the explorer' })}</span
          >
        </div>
        <div class="row-wrap mt-2">
          ${addButton(reproduceSpec, { label: 'Reproduce', primary: true, title: 'Open the packet for this exact configuration and workload' })}
          <a class="btn" href=${`#/compare?runs=${rec.run_id}`}>${icon('compare')} Compare with…</a>
          <a class="btn" href=${issueUrl} target="_blank" rel="noopener"
            >${icon('alert')} Report a problem</a
          >
          ${row?.path ? html`<a class="btn btn-ghost" href=${`${repo}/blob/${store.site.repo.default_branch}/${row.path}`} target="_blank" rel="noopener">${icon('github')} Source file</a>` : nothing}
        </div>
      </div>

      <div class="split" style="grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr)">
        <div class="stack">
          ${
            cards.length
              ? html`<section>
                  <div class="section-title">
                    <h2>Metrics</h2>
                    <span class="meta"
                      >${rec.kind === 'longctx' || rec.kind === 'sweep' ? 'headline; per-point numbers below' : ''}</span
                    >
                  </div>
                  <div class="metric-grid">
                    ${cards.map((c, i) => metricCard(c, { hero: i === 0 }))}
                  </div>
                </section>`
              : rec.kind !== 'eval'
                ? html`<section>
                    <div class="callout">
                      No aggregate metrics were recorded for this
                      run${rec.sweep?.length ? ' — the numbers live in the sweep points below' : ''}.
                    </div>
                  </section>`
                : nothing
          }
          ${rec.sweep?.length ? this.sweep(rec) : nothing}
          ${rec.scores ? this.scores(rec) : nothing}
          ${rec.failures?.length ? this.failures(rec) : nothing}
          ${rec.gotchas?.length ? this.gotchas(rec) : nothing} ${this.args(rec, serve)}
          ${this.raw(rec)}
        </div>

        <aside class="stack">
          <section class="card">
            <div class="card-head"><h3>Provenance</h3></div>
            <div class="prov-card">
              ${who(prov.github_login, { userId: prov.github_user_id, avatarUrl: row?.provenance.avatar_url, size: 'lg' })}
              <div>
                ${kv([
                  [
                    'commit',
                    prov.commit
                      ? hashChip(prov.commit, { href: `${repo}/commit/${prov.commit}`, short: 7 })
                      : html`<span class="faint">not yet stamped by the build</span>`,
                  ],
                  [
                    'PR',
                    prov.pr
                      ? html`<a href=${`${repo}/pull/${prov.pr}`} target="_blank" rel="noopener"
                          >#${prov.pr}</a
                        >`
                      : html`<span class="faint">–</span>`,
                  ],
                  [
                    'started',
                    html`<span title=${absDateTime(prov.started_at)}
                      >${absDateTime(prov.started_at)}</span
                    >`,
                  ],
                  prov.finished_at ? ['finished', absDateTime(prov.finished_at)] : null,
                  ['submitted', when(prov.submitted_at)],
                  [
                    'method',
                    html`<span class="tag">${prov.method}</span
                      >${prov.agent ? html` <span class="tag">${prov.agent.name}${prov.agent.model ? ` · ${prov.agent.model}` : ''}</span>` : nothing}`,
                  ],
                  [
                    'user id',
                    prov.github_user_id ?? html`<span class="faint">resolved by CI</span>`,
                  ],
                ])}
              </div>
            </div>
            ${prov.notes ? html`<p class="small mt-3" style="line-height:1.5">${prov.notes}</p>` : nothing}
          </section>

          <section class="card">
            <div class="card-head"><h3>Environment</h3></div>
            ${kv([
              ['engine', engineLink(rec.engine.id, rec.engine.version)],
              rec.engine.container
                ? ['container', html`<span class="mono xs">${rec.engine.container}</span>`]
                : null,
              rec.engine.install_method ? ['install', rec.engine.install_method] : null,
              rec.engine.commit
                ? ['engine commit', html`<span class="mono xs">${rec.engine.commit}</span>`]
                : null,
              ['model', modelLink(rec.model.id, rec.model.quant_id)],
              rec.model.hf_id
                ? [
                    'weights',
                    html`<a
                      href=${`https://huggingface.co/${rec.model.hf_id}`}
                      target="_blank"
                      rel="noopener"
                      class="mono xs"
                      >${rec.model.hf_id}</a
                    >`,
                  ]
                : null,
              rec.model.revision
                ? ['revision', html`<span class="mono xs">${rec.model.revision}</span>`]
                : null,
              ['dtype', rec.model.dtype ?? 'auto'],
              ['hardware', hardwareLink(rec.hardware.id, rec.hardware.count)],
              rec.hardware.driver ? ['driver', rec.hardware.driver] : null,
              rec.hardware.cuda ? ['CUDA', rec.hardware.cuda] : null,
              rec.hardware.rocm ? ['ROCm', rec.hardware.rocm] : null,
              rec.hardware.host?.cpu ? ['host CPU', rec.hardware.host.cpu] : null,
              rec.hardware.host?.ram_gb ? ['host RAM', `${rec.hardware.host.ram_gb} GB`] : null,
              rec.hardware.host?.os
                ? [
                    'OS',
                    `${rec.hardware.host.os}${rec.hardware.host.arch ? ` (${rec.hardware.host.arch})` : ''}`,
                  ]
                : null,
              rec.workload?.resolved_params
                ? [
                    'workload params',
                    html`<span class="mono xs"
                      >${Object.entries(rec.workload.resolved_params)
                        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                        .join(' ')}</span
                    >`,
                  ]
                : null,
              rec.derived?.tokens_per_watt
                ? ['tok/W', fmtNum(rec.derived.tokens_per_watt, 2)]
                : null,
              rec.derived?.tok_s_per_gb_bandwidth
                ? ['tok/s per GB/s', fmtNum(rec.derived.tok_s_per_gb_bandwidth, 3)]
                : null,
              rec.derived?.bandwidth_efficiency
                ? ['bandwidth efficiency', fmtPct(rec.derived.bandwidth_efficiency)]
                : null,
            ])}
          </section>

          <section class="card">
            <div class="card-head"><h3>Compare with…</h3></div>
            <atlas-run-picker
              .exclude=${[rec.run_id]}
              @pick=${(e: CustomEvent<string>) => navigate(`#/compare?runs=${rec.run_id},${e.detail}`)}
            ></atlas-run-picker>
            <p class="xs muted mt-2">
              Runs in the same cell make the most useful comparisons: same model, quant, hardware
              and engine minor.
            </p>
          </section>
        </aside>
      </div>
    </div>`;
  }

  private sweep(rec: ResultRecord): TemplateResult {
    const pts = rec.sweep!;
    const axis = sweepAxisOf(pts);
    const metrics: SweepMetric[] = (['throughput', 'ttft', 'tpot'] as SweepMetric[]).filter((m) =>
      sweepHasMetric(pts, m),
    );
    const metric = metrics.includes(this.sweepMetric)
      ? this.sweepMetric
      : (metrics[0] ?? 'throughput');
    const color = cssVar('--seq-4');
    return html`<section>
      <div class="section-title">
        <h2>
          ${axis === 'concurrency' ? 'Parallelism sweep' : axis === 'input_tokens' ? 'Depth sweep' : 'Sweep'}
        </h2>
        <span class="meta">${pts.length} points</span>
        <span class="spacer"></span>
        <div class="seg sm">
          ${metrics.map((m) => html`<button aria-pressed=${m === metric} @click=${() => (this.sweepMetric = m)}>${m === 'throughput' ? 'tok/s' : m === 'ttft' ? 'TTFT' : 'TPOT'}</button>`)}
        </div>
      </div>
      <div class="card">
        <atlas-chart
          .build=${sweepChartBuild([{ label: rec.run_id.slice(0, 8), color, points: pts }], metric, axis)}
          .height=${240}
          .key=${metric}
        ></atlas-chart>
        ${
          axis === 'concurrency' && metrics.includes('ttft') && metric === 'throughput'
            ? html`<div class="mt-3">
                <div class="eyebrow plain mb-2">TTFT p50 at each point</div>
                <atlas-chart
                  .build=${sweepChartBuild([{ label: 'TTFT', color: cssVar('--warn'), points: pts }], 'ttft', axis)}
                  .height=${160}
                ></atlas-chart>
              </div>`
            : nothing
        }
      </div>
      <div class="table-wrap mt-3">
        <table class="table cards">
          <thead>
            <tr>
              <th>${axis.replace('_', ' ')}</th>
              <th class="num">decode / output tok/s</th>
              <th class="num">TTFT p50</th>
              <th class="num">TPOT p50</th>
              <th class="num">success</th>
              <th class="num">VRAM</th>
              <th>label</th>
            </tr>
          </thead>
          <tbody>
            ${pts.map(
              (p) =>
                html`<tr>
                  <td class="num primary" data-label=${axis}>${fmtInt(sweepX(p, axis))}</td>
                  <td class="num" data-label="tok/s">
                    ${sweepY(p, 'throughput') === null ? html`<span class="null">–</span>` : fmtTokS(sweepY(p, 'throughput'))}
                  </td>
                  <td class="num" data-label="TTFT">
                    ${sweepY(p, 'ttft') === null ? html`<span class="null">–</span>` : fmtMs(sweepY(p, 'ttft'))}
                  </td>
                  <td class="num" data-label="TPOT">
                    ${sweepY(p, 'tpot') === null ? html`<span class="null">–</span>` : fmtMs(sweepY(p, 'tpot'))}
                  </td>
                  <td class="num" data-label="success">
                    ${p.metrics.success_rate == null ? html`<span class="null">–</span>` : fmtPct(p.metrics.success_rate, 0)}
                  </td>
                  <td class="num" data-label="VRAM">
                    ${p.metrics.vram_peak_gb == null ? html`<span class="null">–</span>` : `${fmtNum(p.metrics.vram_peak_gb, 1)} GB`}
                  </td>
                  <td data-label="label" class="muted xs">${p.label ?? ''}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  private scores(rec: ResultRecord): TemplateResult {
    const s = rec.scores!;
    const items = s.items ?? [];
    const shown = items
      .filter((it) => this.itemFilter === 'all' || (this.itemFilter === 'correct') === it.correct)
      .slice(0, 200);
    const cats = Object.entries(s.by_category ?? {});
    const diffs = Object.entries(s.by_difficulty ?? {});
    return html`<section>
      <div class="section-title">
        <h2>Eval scores</h2>
        <span class="meta">suite ${s.suite}</span>
      </div>
      <div class="metric-grid">
        <div class="metric hero">
          <span class="k">Accuracy</span><span class="v">${fmtPct(s.accuracy)}</span
          ><span class="sub">${s.correct} / ${s.total} correct</span>
        </div>
        ${
          s.avg_latency_ms != null
            ? html`<div class="metric">
                <span class="k">Avg latency</span
                ><span class="v">${fmtMs(s.avg_latency_ms)}<span class="unit">ms</span></span>
              </div>`
            : nothing
        }
        ${
          s.avg_output_tokens != null
            ? html`<div class="metric">
                <span class="k">Avg output</span
                ><span class="v">${fmtInt(s.avg_output_tokens)}<span class="unit">tok</span></span>
              </div>`
            : nothing
        }
        ${s.failures != null ? html`<div class="metric"><span class="k">Failures</span><span class="v">${s.failures}</span></div>` : nothing}
      </div>
      ${
        cats.length || diffs.length
          ? html`<div class="split mt-3">
              ${
                cats.length
                  ? html`<div class="card tight">
                      <div class="eyebrow plain mb-2">By category</div>
                      ${cats.map(([k, v]) => hbar(k, v.total ? v.correct / v.total : 0, `${v.correct}/${v.total}`))}
                    </div>`
                  : nothing
              }
              ${
                diffs.length
                  ? html`<div class="card tight">
                      <div class="eyebrow plain mb-2">By difficulty</div>
                      ${diffs.map(([k, v]) => hbar(k, v.total ? v.correct / v.total : 0, `${v.correct}/${v.total}`))}
                    </div>`
                  : nothing
              }
            </div>`
          : nothing
      }
      ${
        items.length
          ? html`<div class="row mt-3 mb-2">
                <span class="small muted">${items.length} items</span>
                <span class="spacer"></span>
                <div class="seg sm">
                  ${(['all', 'correct', 'incorrect'] as const).map((f) => html`<button aria-pressed=${this.itemFilter === f} @click=${() => (this.itemFilter = f)}>${f}</button>`)}
                </div>
              </div>
              <div class="table-wrap" style="max-height:480px">
                <table class="table eval-item-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>id</th>
                      <th>category</th>
                      <th>difficulty</th>
                      <th>predicted</th>
                      <th>expected</th>
                      <th class="num">latency</th>
                      <th class="num">tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${shown.map(
                      (it) =>
                        html`<tr>
                          <td><i class="ok-dot ${it.correct ? '' : 'bad'}"></i></td>
                          <td class="mono xs">${it.id}</td>
                          <td class="xs">${it.category ?? ''}</td>
                          <td class="xs">${it.difficulty ?? ''}</td>
                          <td class="pred" title=${it.predicted ?? ''}>${it.predicted ?? ''}</td>
                          <td class="exp" title=${it.expected ?? ''}>${it.expected ?? ''}</td>
                          <td class="num">${it.latency_ms == null ? '–' : fmtMs(it.latency_ms)}</td>
                          <td class="num">${it.output_tokens ?? '–'}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
              ${shown.length < items.filter((it) => this.itemFilter === 'all' || (this.itemFilter === 'correct') === it.correct).length ? html`<p class="xs muted mt-1">Showing the first 200 — the raw payload has everything.</p>` : nothing}`
          : nothing
      }
    </section>`;
  }

  private failures(rec: ResultRecord): TemplateResult {
    return html`<section>
      <div class="section-title">
        <h2>Failures</h2>
        <span class="meta">${rec.failures!.length} recorded — a failure is a valid result</span>
      </div>
      <div class="col">
        ${rec.failures!.map(
          (f) =>
            html`<div class="failure">
              <span class="tag danger">${f.category}</span>
              <span class="xs muted nowrap">at ${f.at} · ×${f.count}</span>
              <span class="msg"
                >${f.message ?? ''}${f.sample_request_id ? html` <span class="muted">(${f.sample_request_id})</span>` : nothing}</span
              >
            </div>`,
        )}
      </div>
    </section>`;
  }

  private gotchas(rec: ResultRecord): TemplateResult {
    const ic = { info: 'info', warn: 'warn', blocker: 'alert' } as const;
    return html`<section>
      <div class="section-title">
        <h2>Gotchas</h2>
        <span class="meta">what you had to know to make this run work</span>
      </div>
      <div class="col">
        ${rec.gotchas!.map(
          (g) =>
            html`<div class="gotcha ${g.severity}">
              <span
                class="sev"
                style=${g.severity === 'blocker' ? 'color:var(--danger)' : g.severity === 'warn' ? 'color:var(--warn)' : 'color:var(--link)'}
                title=${g.severity}
                >${icon(ic[g.severity])}</span
              >
              <span
                >${g.text}${g.link ? html` <a href=${g.link} target="_blank" rel="noopener">${icon('external')}</a>` : nothing}</span
              >
            </div>`,
        )}
      </div>
    </section>`;
  }

  private args(rec: ResultRecord, serve: string): TemplateResult {
    const params = this.vf?.params ?? [];
    const byName = new Map(params.map((p) => [p.name, p]));
    const entries = Object.entries(rec.args);
    return html`<section>
      <div class="section-title">
        <h2>Arguments</h2>
        <span class="meta">${entries.length} passed · canonical fingerprint below</span>
      </div>
      ${
        entries.length
          ? html`<div class="table-wrap">
              <table class="table args-table cards">
                <thead>
                  <tr>
                    <th>flag</th>
                    <th>value</th>
                    <th>default in ${rec.engine.version}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${entries.map(([k, v]) => {
                    const p = byName.get(k);
                    const def = p ? isDefault(p, v) : false;
                    return html`<tr class=${def ? '' : 'non-default'}>
                      <td class="name mono xs primary" data-label="flag">${k}</td>
                      <td class="mono xs" data-label="value">
                        ${typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </td>
                      <td class="mono xs muted" data-label="default">
                        ${p ? fmtDefault(p) : html`<span class="faint">unknown flag</span>`}
                      </td>
                      <td class="default-marker" data-label="">
                        ${p ? (def ? 'equals default — dropped from fingerprint' : html`<span class="tag accent">non-default</span>`) : ''}
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>`
          : html`<p class="small muted">No flags beyond the defaults.</p>`
      }
      <div class="mt-3">
        <div class="eyebrow plain mb-2">Canonical</div>
        ${codeBlock(rec.args_canonical, { lang: 'text' })}
      </div>
      ${
        serve
          ? html`<div class="mt-3">
              <div class="eyebrow plain mb-2">
                Serve
                command${rec.serve_command ? '' : ' (rendered from args — the exact command line was not recorded)'}
              </div>
              ${codeBlock(serve, { lang: 'bash' })}
            </div>`
          : nothing
      }
    </section>`;
  }

  private raw(rec: ResultRecord): TemplateResult {
    const json = JSON.stringify(rec, null, 2);
    return html`<section>
      <details class="json-view">
        <summary>
          ${icon('chevronRight')} Raw record
          <span class="muted xs"
            >${rec.raw?.harness ? `${rec.raw.harness} ${rec.raw.harness_version ?? ''}` : ''}
            ${rec.raw?.truncated ? '· payload truncated' : ''}
            ${rec.raw?.sha256 ? `· sha256 ${shortSha(rec.raw.sha256)}` : ''}</span
          >
        </summary>
        ${codeBlock(json, { lang: 'json', maxHeight: 520 })}
      </details>
    </section>`;
  }
}
