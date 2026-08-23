/**
 * The "Add measurement" dialog — SPEC §7. One packet, four renderings, all from
 * `@atlas/core`'s `buildPacket`, so what a contributor copies from the site is exactly what
 * `pnpm packet` would print. URL-addressable through the `add=` query parameter.
 */
import { html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { buildPacket } from '@atlas/core';
import type {
  Args,
  EngineVersion,
  Packet,
  PacketKind,
  PacketRegistry,
  PacketSpec,
} from '@atlas/core';
import { route, setQuery } from '../router.js';
import { signal, watch } from '../signal.js';
import { store } from '../store.js';
import { copyText } from '../util/clipboard.js';
import { AtlasElement } from './base.js';
import './packet-preview.js';
import { icon } from './icons.js';
import { engineName, hardwareName, kindTag, modelName } from './ui.js';

export type AddSpec = PacketSpec;

export const addSpec = signal<AddSpec | null>(null);

/* ------------------------------------------------------------ URL encoding */

export function encodeAddSpec(spec: AddSpec): string {
  const parts = [
    spec.kind ?? 'cell',
    spec.engine_id ?? '',
    spec.engine_version ?? '',
    spec.model_id ?? '',
    spec.quant_id ?? '',
    spec.hardware_id ?? '',
    (spec.workload_ids ?? []).join(','),
    spec.target_name ?? '',
  ];
  let s = parts.join('|');
  if (spec.args && Object.keys(spec.args).length)
    s += '|' + encodeURIComponent(JSON.stringify(spec.args));
  return s;
}

export function decodeAddSpec(s: string): AddSpec | null {
  if (!s) return null;
  const p = s.split('|');
  const kind = (p[0] || 'cell') as PacketKind;
  let args: Args | undefined;
  if (p[8]) {
    try {
      args = JSON.parse(decodeURIComponent(p[8])) as Args;
    } catch {
      args = undefined;
    }
  }
  return {
    kind,
    engine_id: p[1] || null,
    engine_version: p[2] || null,
    model_id: p[3] || null,
    quant_id: p[4] || null,
    hardware_id: p[5] || null,
    workload_ids: p[6] ? p[6].split(',').filter(Boolean) : [],
    target_name: p[7] || null,
    args,
  };
}

export function openAdd(spec: AddSpec): void {
  addSpec.value = spec;
  setQuery({ add: encodeAddSpec(spec) });
}

export function closeAdd(): void {
  addSpec.value = null;
  if (route.value.query.has('add')) setQuery({ add: null });
}

/** Reusable "Add measurement" button. */
export function addButton(
  spec: AddSpec,
  opts: { label?: string; primary?: boolean; size?: 'xs' | 'sm' | ''; title?: string } = {},
): TemplateResult {
  const cls = `btn btn-add ${opts.primary ? 'btn-primary' : ''} ${opts.size ? 'btn-' + opts.size : ''}`;
  return html`<button
    type="button"
    class=${cls}
    title=${opts.title ?? 'Open the measurement packet for this cell'}
    @click=${(e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      openAdd(spec);
    }}
  >
    ${icon('flag')} ${opts.label ?? 'Add measurement'}
  </button>`;
}

/* ------------------------------------------------------------ packet registry */

export function packetRegistry(versionFiles: EngineVersion[] = []): PacketRegistry {
  const reg = store.registry.value;
  if (!reg) return { hardware: [], engines: [], models: [], workloads: [] };
  return {
    hardware: reg.hardware,
    engines: reg.engines.map((e) => ({
      meta: {
        ...e.meta,
        versions_available: e.versions.length ? e.versions : e.meta.versions_available,
      },
      versions: versionFiles.filter((v) => v.engine_id === e.meta.id),
    })),
    models: reg.models.map((m) => ({ model: m.model, quants: m.quants })),
    workloads: reg.workloads,
  };
}

/* ------------------------------------------------------------ the dialog */

@customElement('atlas-add-modal')
export class AtlasAddModal extends AtlasElement {
  @state() private workloads: string[] = [];
  @state() private versionFile: EngineVersion | null = null;
  @state() private specKey = '';
  private lastFocus: Element | null = null;
  private defaultsReg: unknown = null;

  constructor() {
    super();
    watch(this, addSpec, store.registry);
  }

  protected override willUpdate(_changed: PropertyValues): void {
    const spec = addSpec.value;
    const key = spec ? encodeAddSpec(spec) : '';
    if (key !== this.specKey) {
      this.specKey = key;
      this.versionFile = null;
      if (spec) {
        this.defaultsReg = store.registry.value;
        this.workloads = this.defaultWorkloads(spec);
        if (spec.engine_id && spec.engine_version) {
          void store.engineVersion(spec.engine_id, spec.engine_version).then((vf) => {
            if (encodeAddSpec(addSpec.value ?? {}) === key) this.versionFile = vf;
          });
        }
        this.lastFocus = document.activeElement;
        requestAnimationFrame(() => {
          (this.querySelector('.dialog') as HTMLElement | null)?.focus();
        });
      } else if (this.lastFocus instanceof HTMLElement) {
        this.lastFocus.focus();
        this.lastFocus = null;
      }
    } else if (spec && this.defaultsReg !== store.registry.value && store.registry.value) {
      // opened from the URL before the registry arrived: apply the workload defaults now
      this.defaultsReg = store.registry.value;
      if (this.workloads.length === 0) this.workloads = this.defaultWorkloads(spec);
    }
  }

  private defaultWorkloads(spec: AddSpec): string[] {
    const reg = store.registry.value;
    if (spec.workload_ids && spec.workload_ids.length) return [...spec.workload_ids];
    if (!reg || (spec.kind && spec.kind !== 'cell')) return [];
    const featured = (reg.site.featured?.workloads ?? []).filter((w) =>
      reg.workloads.some((x) => x.id === w),
    );
    if (featured.length) return featured;
    const def = reg.site.atlas.default_workload_id;
    if (def && reg.workloads.some((w) => w.id === def)) return [def];
    return reg.workloads
      .filter((w) => w.kind === 'serving')
      .slice(0, 1)
      .map((w) => w.id);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeAdd();
      return;
    }
    if (e.key === 'Tab') {
      const dialog = this.querySelector('.dialog');
      if (!dialog) return;
      const focusables = [
        ...dialog.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  private buildPacket(spec: AddSpec): Packet {
    const reg = packetRegistry(this.versionFile ? [this.versionFile] : []);
    return buildPacket({ ...spec, workload_ids: this.workloads }, reg, store.site);
  }

  private toggleWorkload(id: string): void {
    this.workloads = this.workloads.includes(id)
      ? this.workloads.filter((w) => w !== id)
      : [...this.workloads, id];
  }

  override render() {
    const spec = addSpec.value;
    if (!spec) return nothing;
    const reg = store.registry.value;
    const packet = this.buildPacket(spec);
    const kind = spec.kind ?? 'cell';
    const title =
      kind === 'cell'
        ? 'Add a measurement'
        : kind === 'new-hardware'
          ? 'Register new hardware'
          : kind === 'new-model'
            ? 'Register a new model'
            : 'Register a new engine';
    const fileBase =
      `atlas-packet-${spec.engine_id ?? kind}-${spec.model_id ?? ''}-${spec.hardware_id ?? ''}`.replace(
        /-+$/,
        '',
      );

    return html`<div class="backdrop modal-backdrop" @click=${closeAdd}></div>
      <div class="modal" @keydown=${this.onKey}>
        <div
          class="dialog add-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-title"
          tabindex="-1"
        >
          <div class="dialog-head">
            <div class="grow">
              <div class="eyebrow plain">${icon('flag')} ${title}</div>
              <h2 id="add-title" class="add-title">
                ${
                  kind === 'cell'
                    ? html`<span class="mono">${spec.engine_id}</span>
                        <span class="mono muted">${spec.engine_version ?? 'latest'}</span>
                        <span class="sep">·</span>
                        <span class="mono">${spec.model_id}</span><span class="muted">/</span
                        ><span class="mono">${spec.quant_id}</span>
                        <span class="sep">·</span>
                        <span class="mono">${spec.hardware_id}</span>`
                    : html`${spec.target_name ?? 'Describe what you are adding'}`
                }
              </h2>
              ${
                kind === 'cell'
                  ? html`<div class="small muted mt-1">
                      ${engineName(spec.engine_id ?? '')} · ${modelName(spec.model_id ?? '')} ·
                      ${hardwareName(spec.hardware_id ?? '')}
                      ${packet.json.cell.cell_id ? html`· cell <span class="hash">${packet.json.cell.cell_id}</span>` : nothing}
                    </div>`
                  : nothing
              }
            </div>
            <button
              class="btn btn-ghost btn-icon"
              type="button"
              aria-label="Close"
              @click=${closeAdd}
            >
              ${icon('x')}
            </button>
          </div>

          ${
            kind === 'cell' && reg
              ? html`<div class="add-workloads">
                  <span class="label">Workloads in this packet</span>
                  <div class="row-wrap">
                    ${reg.workloads.map(
                      (w) =>
                        html`<button
                          type="button"
                          class="chip"
                          aria-pressed=${this.workloads.includes(w.id)}
                          title=${w.description ?? w.name}
                          @click=${() => this.toggleWorkload(w.id)}
                        >
                          ${this.workloads.includes(w.id) ? icon('check') : nothing} ${w.id}
                          ${kindTag(w.kind)}
                        </button>`,
                    )}
                    ${reg.workloads.length === 0 ? html`<span class="muted small">No workloads registered yet.</span>` : nothing}
                  </div>
                </div>`
              : nothing
          }

          <div class="dialog-body">
            <atlas-packet-preview .packet=${packet} .fileBase=${fileBase}></atlas-packet-preview>
          </div>

          <div class="dialog-foot">
            <span class="xs muted grow">
              ${packet.json.cell.cell_id ? html`cell <span class="hash">${packet.json.cell.cell_id}</span>` : nothing}
              ${this.workloads.length ? html`· ${this.workloads.length} workload${this.workloads.length === 1 ? '' : 's'}` : nothing}
              · branch <span class="hash">${packet.json.branch}</span>
            </span>
            <button class="btn" type="button" @click=${closeAdd}>Close</button>
            <button
              class="btn btn-primary"
              type="button"
              @click=${() => copyText(packet.markdown, 'Agent prompt copied')}
            >
              ${icon('copy')} Copy agent prompt
            </button>
          </div>
        </div>
      </div>`;
  }
}
