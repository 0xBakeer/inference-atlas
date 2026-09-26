import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { buildPacket } from '@atlas/core';
import type { EngineVersion, PacketKind } from '@atlas/core';
import { addButton, decodeAddSpec, openAdd, packetRegistry } from '../components/add-modal.js';
import {
  resolveSelection,
  type CellChangeEvent,
  type CellSelection,
} from '../components/cell-picker.js';
import '../components/cell-picker.js';
import '../components/packet-preview.js';
import { icon } from '../components/icons.js';
import { barList } from '../components/stat-charts.js';
import { codeBlock, kindTag, skeletonLines } from '../components/ui.js';
import { href, qget, qlist, setQuery } from '../router.js';
import { store } from '../store.js';
import { ViewElement } from './view-base.js';

@customElement('atlas-contribute-view')
export class AtlasContributeView extends ViewElement {
  @state() private vf: EngineVersion | null = null;
  @state() private newKind: PacketKind = 'new-hardware';
  @state() private newName = '';
  @state() private openKinds = new Set<string>();
  private vfKey = '';

  private selection(): CellSelection {
    const q = this.q;
    const cell = qget(q, 'cell');
    const fromCell = cell ? decodeAddSpec(cell) : null;
    return resolveSelection(
      {
        engine: qget(q, 'engine') ?? fromCell?.engine_id ?? null,
        version: qget(q, 'version') ?? fromCell?.engine_version ?? null,
        model: qget(q, 'model') ?? fromCell?.model_id ?? null,
        quant: qget(q, 'quant') ?? fromCell?.quant_id ?? null,
        hardware: qget(q, 'hardware') ?? fromCell?.hardware_id ?? null,
      },
      { requireAll: true },
    );
  }

  private workloads(): string[] {
    const reg = store.registry.value;
    const w = qlist(this.q, 'w');
    if (w.length === 1 && w[0] === '-') return [];
    if (w.length) return w;
    const cell = qget(this.q, 'cell');
    const fromCell = cell ? decodeAddSpec(cell) : null;
    if (fromCell?.workload_ids?.length) return fromCell.workload_ids;
    const featured = (reg?.site.featured?.workloads ?? []).filter((x) =>
      reg?.workloads.some((y) => y.id === x),
    );
    if (featured.length) return featured;
    const def = reg?.site.atlas.default_workload_id;
    return def ? [def] : [];
  }

  protected override willUpdate(_c: PropertyValues): void {
    if (!store.registry.value) return;
    const sel = this.selection();
    const k = `${sel.engine}/${sel.version}`;
    if (k !== this.vfKey && sel.engine && sel.version) {
      this.vfKey = k;
      void store.engineVersion(sel.engine, sel.version).then((vf) => {
        if (this.vfKey === k) this.vf = vf;
      });
    }
  }

  override render() {
    const reg = store.registry.value;
    if (!reg) return html`<div class="page">${skeletonLines(8)}</div>`;
    const site = store.site;
    const repo = `${site.repo.host ?? 'https://github.com'}/${site.repo.owner}/${site.repo.name}`;
    const sel = this.selection();
    const workloads = this.workloads();
    const packet = buildPacket(
      {
        engine_id: sel.engine,
        engine_version: sel.version,
        model_id: sel.model,
        quant_id: sel.quant,
        hardware_id: sel.hardware,
        workload_ids: workloads,
      },
      packetRegistry(this.vf ? [this.vf] : []),
      site,
    );
    const harness = site.packet?.harness_command ?? 'uv run atlas-bench';

    return html`<div class="page">
      <div class="page-head">
        <div class="eyebrow">Contribute</div>
        <h1>Fill a square in twenty minutes</h1>
        <p class="lede">
          There is no backend to register with. A measurement is one JSON file you own, added to
          <code>results/</code> by pull request. CI checks the schema, recomputes the ids, verifies
          that the login in the file is yours, and sanity-checks the physics.
        </p>
      </div>

      <ol class="steps mb-6">
        <li class="step">
          <span class="n">1</span>
          <div>
            <h3>Pick a square</h3>
            <p>
              A square is a model, a quantization, a device and an engine version nobody has
              measured. The queue ranks them by how much the map would learn.
            </p>
            <a class="btn btn-primary btn-sm" href="#/gaps">${icon('flag')} Open the queue</a>
          </div>
        </li>
        <li class="step">
          <span class="n">2</span>
          <div>
            <h3>Run the packet on the box</h3>
            <p>
              Every square comes with a packet: what to install, which flags, which tests, where the
              file goes. Paste it into a coding agent, or run the harness yourself.
            </p>
            ${codeBlock(`${harness} hwinfo --json\n${harness} run --spec task.json\npnpm validate`, { lang: 'bash', maxHeight: 'none', copy: false })}
          </div>
        </li>
        <li class="step">
          <span class="n">3</span>
          <div>
            <h3>Open the pull request</h3>
            <p>
              The result is one JSON file you own. CI checks the schema, recomputes the ids, checks
              the login is yours and sanity-checks the physics. Merged, it is on the map.
            </p>
            <a
              class="btn btn-sm"
              href=${`${repo}/issues/new?template=request-config.yml`}
              target="_blank"
              rel="noopener"
              >${icon('github')} No hardware? Request it instead</a
            >
          </div>
        </li>
      </ol>

      ${this.coverageChart()}

      <section class="mb-6">
        <div class="section-title">
          <h2>Packet builder</h2>
          <span class="meta">choose a cell and the workloads; the brief updates live</span>
        </div>
        <div class="builder">
          <div class="card">
            <atlas-cell-picker
              .value=${sel}
              @cell-change=${(e: CellChangeEvent) => setQuery({ engine: e.detail.engine, version: e.detail.version, model: e.detail.model, quant: e.detail.quant, hardware: e.detail.hardware, cell: null })}
            ></atlas-cell-picker>
            <div class="field mt-3">
              <span class="label">Workloads</span>
              ${(['serving', 'sweep', 'prefill', 'longctx', 'eval', 'agentic', 'image'] as const)
                .filter((k) => reg.workloads.some((w) => w.kind === k))
                .map((k) => {
                  const ws = reg.workloads.filter((w) => w.kind === k);
                  const allOn = ws.every((w) => workloads.includes(w.id));
                  const picked = ws.filter((w) => workloads.includes(w.id)).length;
                  const open = this.openKinds.has(k) || picked > 0;
                  return html`<div class="wl-group ${open ? 'open' : ''}">
                    <div class="wl-head">
                      <button
                        class="wl-kind"
                        title=${open ? `Hide the ${k} workloads` : `Show the ${k} workloads`}
                        @click=${() => {
                          const next = new Set(this.openKinds);
                          if (open) next.delete(k);
                          else next.add(k);
                          this.openKinds = next;
                        }}
                      >
                        ${icon(open ? 'chevronDown' : 'chevronRight')} ${kindTag(k)}
                        <span class="xs muted">${picked}/${ws.length}</span>
                      </button>
                      <button
                        class="btn btn-xs btn-ghost"
                        title=${allOn ? `Deselect every ${k} workload` : `Select every ${k} workload`}
                        @click=${() =>
                          setQuery({
                            w:
                              (allOn
                                ? workloads.filter((x) => !ws.some((w) => w.id === x))
                                : [...new Set([...workloads, ...ws.map((w) => w.id)])]
                              ).join(',') || '-',
                            cell: null,
                          })}
                      >
                        ${allOn ? 'none' : 'all'}
                      </button>
                    </div>
                    <div class="row-wrap wl-chips" style="gap:3px">
                      ${ws.map(
                        (w) =>
                          html`<button
                            class="chip"
                            aria-pressed=${workloads.includes(w.id)}
                            title=${w.description ?? w.name}
                            @click=${() => setQuery({ w: (workloads.includes(w.id) ? workloads.filter((x) => x !== w.id) : [...workloads, w.id]).join(',') || '-', cell: null })}
                          >
                            ${workloads.includes(w.id) ? icon('check') : nothing} ${w.id}
                          </button>`,
                      )}
                    </div>
                  </div>`;
                })}
            </div>
            <div class="row-wrap mt-3">
              ${addButton({ engine_id: sel.engine, engine_version: sel.version, model_id: sel.model, quant_id: sel.quant, hardware_id: sel.hardware, workload_ids: workloads }, { label: 'Open as dialog', size: 'sm' })}
              <a
                class="btn btn-sm"
                href=${`#/explore?engine=${sel.engine}&version=${sel.version}&model=${sel.model}&quant=${sel.quant}&hardware=${sel.hardware}`}
                >${icon('sparkle')} Tune flags in the explorer</a
              >
            </div>
            <p class="xs muted mt-3">
              cell <span class="hash">${packet.json.cell.cell_id ?? '–'}</span> · branch
              <span class="hash">${packet.json.branch}</span>
            </p>
          </div>
          <div class="card packet-panel">
            <atlas-packet-preview
              .packet=${packet}
              .fileBase=${`atlas-packet-${sel.engine}-${sel.model}-${sel.hardware}`}
            ></atlas-packet-preview>
          </div>
        </div>
      </section>

      <section class="mb-6">
        <div class="section-title">
          <h2>Add new hardware, a model or an engine</h2>
          <span class="meta"
            >a registry addition is a PR that adds a JSON file, never a code change</span
          >
        </div>
        <div class="card">
          <div class="filters">
            <div class="field">
              <span class="label">What</span>
              <div class="seg">
                ${(['new-hardware', 'new-model', 'new-engine'] as PacketKind[]).map((k) => html`<button aria-pressed=${this.newKind === k} @click=${() => (this.newKind = k)}>${k.replace('new-', '')}</button>`)}
              </div>
            </div>
            <label class="field grow" style="min-width:240px"
              ><span class="label">Name or id</span
              ><input
                class="input"
                type="text"
                placeholder=${this.newKind === 'new-hardware' ? 'e.g. nvidia-rtx-5080 or “RTX 5080 16 GB”' : this.newKind === 'new-model' ? 'e.g. qwen3-14b or Qwen/Qwen3-14B' : 'e.g. ktransformers'}
                .value=${this.newName}
                @input=${(e: Event) => (this.newName = (e.target as HTMLInputElement).value)}
            /></label>
            <button
              class="btn btn-primary"
              @click=${() => openAdd({ kind: this.newKind, target_name: this.newName || null })}
            >
              ${icon('flag')} Generate packet
            </button>
          </div>
          <p class="small muted mt-3">
            ${
              this.newKind === 'new-hardware'
                ? html`The packet tells the agent to capture the machine with
                    <code>${harness} hwinfo --json</code> and write
                    <code>hardware/&lt;id&gt;.json</code> from the capture — specifications from the
                    vendor, <code>null</code> where unsure, detect strings exactly as printed.`
                : this.newKind === 'new-model'
                  ? html`Model facts come from the Hugging Face <code>config.json</code> and model
                      card, not the launch post; each quantization you intend to run becomes
                      <code>models/&lt;id&gt;/quants/&lt;quant&gt;.json</code>.`
                  : html`Engines need <code>meta.json</code> (install, serve template, api,
                      drop_params, platforms, quant formats) and one
                      <code>versions/&lt;version&gt;.json</code> with the flags that exact build
                      accepts and their real defaults.`
            }
          </p>
        </div>
      </section>

      <section>
        <div class="section-title">
          <h2>The rules, in one breath</h2>
          <span class="meta"
            >the long version is
            <a
              href=${site.links?.agents ?? `${repo}/blob/main/AGENTS.md`}
              target="_blank"
              rel="noopener"
              >AGENTS.md</a
            >, the binding contract
            <a
              href=${site.links?.spec ?? `${repo}/blob/main/docs/SPEC.md`}
              target="_blank"
              rel="noopener"
              >docs/SPEC.md</a
            ></span
          >
        </div>
        <ol class="rules">
          <li>
            <b>Only add files you own.</b> Never touch another contributor's result — CI rejects it.
          </li>
          <li><b>Never edit a number by hand.</b> Fix the run, not the measurement.</li>
          <li>
            <b>Never silently lower the configuration.</b> If it does not fit, that failure is the
            result.
          </li>
          <li><b>Failures are wanted.</b> An OOM you dropped makes the map lie.</li>
          <li><b>Idle box.</b> Say what else was resident in <code>provenance.notes</code>.</li>
          <li><b>Capture hardware, do not type it.</b></li>
          <li>
            <b>Leave the CI fields null.</b> <code>github_user_id</code>, <code>commit</code>,
            <code>pr</code>.
          </li>
          <li><b>Record the gotchas.</b> They outlive the number.</li>
        </ol>
      </section>
    </div>`;
  }

  /** Where a contribution moves the needle most: how covered each engine's territory is. */
  private coverageChart(): TemplateResult | typeof nothing {
    const reg = store.registry.value;
    if (!reg || !store.possible.length) return nothing;
    const cov = store.coverage.value;
    const per = new Map<string, { covered: number; possible: number }>();
    for (const pc of store.possible) {
      const e = per.get(pc.engine_id) ?? { covered: 0, possible: 0 };
      e.possible++;
      if (cov[pc.cell_id]) e.covered++;
      per.set(pc.engine_id, e);
    }
    const rows = [...per.entries()]
      .map(([id, x]) => ({ id, ...x, frac: x.covered / Math.max(1, x.possible) }))
      .sort((a, b) => a.frac - b.frac)
      .slice(0, 10);
    if (!rows.length) return nothing;
    return html`<section class="mb-6">
      <div class="section-title">
        <h2>Where the map is emptiest</h2>
        <span class="meta">cells measured per engine — least covered first</span>
      </div>
      <div class="card tight">
        ${barList(
          rows.map((r) => ({
            label: store.lookups.engines.get(r.id)?.meta.name ?? r.id,
            title: `${r.id} — ${r.covered} of ${r.possible} possible cells measured`,
            value: r.frac,
            frac: r.frac,
            text: `${r.covered}/${r.possible}`,
            color: 'var(--ev-single)',
            href: href('engines', r.id),
          })),
          { max: 1, ariaLabel: 'Coverage per engine' },
        )}
      </div>
    </section>`;
  }
}
