/**
 * Engine → version → model → quant → hardware selects, restricted to compatible combinations
 * (quant lists the engine, engine supports the quant format, engine has a platform the device
 * can host). Emits `cell-change` with the full selection.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Hardware, Quant } from '@atlas/core';
import { engineRunsOn, latestVersion, quantRunsOn } from '../data/derive.js';
import type { RegistryEngine, RegistryModel } from '../data/types.js';
import { store } from '../store.js';
import { AtlasElement } from './base.js';
import { selectField } from './ui.js';

export interface CellSelection {
  engine: string | null;
  version: string | null;
  model: string | null;
  quant: string | null;
  hardware: string | null;
}

export type CellChangeEvent = CustomEvent<CellSelection>;

/** Fill in missing/invalid parts of a selection with sensible, compatible defaults. */
export function resolveSelection(
  sel: Partial<CellSelection>,
  opts: { requireAll?: boolean } = {},
): CellSelection {
  const reg = store.registry.value;
  const out: CellSelection = {
    engine: sel.engine ?? null,
    version: sel.version ?? null,
    model: sel.model ?? null,
    quant: sel.quant ?? null,
    hardware: sel.hardware ?? null,
  };
  if (!reg) return out;
  const featured = reg.site.featured ?? {};
  const lk = store.lookups;

  let engine = out.engine ? (lk.engines.get(out.engine) ?? null) : null;
  if (!engine && opts.requireAll) {
    engine =
      (featured.engines ?? []).map((id) => lk.engines.get(id)).find(Boolean) ??
      reg.engines[0] ??
      null;
  }
  out.engine = engine?.meta.id ?? null;
  if (engine) {
    if (!out.version || !engine.versions.includes(out.version)) out.version = latestVersion(engine);
  } else {
    out.version = null;
  }

  const modelOk = (m: RegistryModel) => !engine || m.quants.some((q) => quantRunsOn(q, engine!));
  let model = out.model ? (lk.models.get(out.model) ?? null) : null;
  if (model && !modelOk(model)) model = null;
  if (!model && opts.requireAll) {
    model =
      (featured.models ?? []).map((id) => lk.models.get(id)).find((m) => m && modelOk(m)) ??
      reg.models.find(modelOk) ??
      null;
  }
  out.model = model?.model.id ?? null;

  const quantOk = (q: Quant) => !engine || quantRunsOn(q, engine);
  let quant = model && out.quant ? (model.quants.find((q) => q.id === out.quant) ?? null) : null;
  if (quant && !quantOk(quant)) quant = null;
  if (!quant && model && opts.requireAll) quant = model.quants.find(quantOk) ?? null;
  out.quant = quant?.id ?? null;

  const hwOk = (h: Hardware) => !engine || engineRunsOn(engine, h);
  let hw = out.hardware ? (lk.hardware.get(out.hardware) ?? null) : null;
  if (hw && !hwOk(hw)) hw = null;
  if (!hw && opts.requireAll) {
    hw =
      (featured.hardware ?? []).map((id) => lk.hardware.get(id)).find((h) => h && hwOk(h)) ??
      reg.hardware.find(hwOk) ??
      null;
  }
  out.hardware = hw?.id ?? null;
  return out;
}

@customElement('atlas-cell-picker')
export class AtlasCellPicker extends AtlasElement {
  @property({ attribute: false }) value: CellSelection = {
    engine: null,
    version: null,
    model: null,
    quant: null,
    hardware: null,
  };
  @property({ type: Boolean }) compact = false;
  /** Which selects to show (all by default). */
  @property({ attribute: false }) fields: Array<keyof CellSelection> = [
    'engine',
    'version',
    'model',
    'quant',
    'hardware',
  ];
  /** When false, each select gets an "Any" option. */
  @property({ type: Boolean }) required = true;

  private emit(patch: Partial<CellSelection>): void {
    const next = resolveSelection({ ...this.value, ...patch }, { requireAll: this.required });
    // changing the engine may invalidate model/quant/hardware; resolveSelection already fixed it
    this.dispatchEvent(
      new CustomEvent('cell-change', { detail: next, bubbles: true }) as CellChangeEvent,
    );
  }

  override render(): TemplateResult | typeof nothing {
    const reg = store.registry.value;
    if (!reg) return nothing;
    const lk = store.lookups;
    const v = this.value;
    const engine: RegistryEngine | null = v.engine ? (lk.engines.get(v.engine) ?? null) : null;
    const model: RegistryModel | null = v.model ? (lk.models.get(v.model) ?? null) : null;
    const show = new Set(this.fields);
    const opt = { allowEmpty: !this.required, allLabel: 'Any', small: this.compact };

    const models = reg.models.filter(
      (m) => !engine || m.quants.some((q) => quantRunsOn(q, engine)),
    );
    const quants = model ? model.quants.filter((q) => !engine || quantRunsOn(q, engine)) : [];
    const hardware = reg.hardware.filter((h) => !engine || engineRunsOn(engine, h));

    return html`<div class="cell-picker ${this.compact ? 'filters' : 'col'}">
      ${
        show.has('engine')
          ? selectField(
              'Engine',
              v.engine,
              reg.engines.map((e) => ({ value: e.meta.id, label: e.meta.name })),
              (x) => this.emit({ engine: x, version: null }),
              opt,
            )
          : nothing
      }
      ${
        show.has('version')
          ? selectField(
              'Version',
              v.version,
              (engine?.versions ?? [])
                .slice()
                .reverse()
                .map((ver) => ({ value: ver, label: ver })),
              (x) => this.emit({ version: x }),
              {
                ...opt,
                allLabel: 'Latest',
              },
            )
          : nothing
      }
      ${
        show.has('model')
          ? selectField(
              'Model',
              v.model,
              models.map((m) => ({ value: m.model.id, label: `${m.model.name}` })),
              (x) => this.emit({ model: x, quant: null }),
              opt,
            )
          : nothing
      }
      ${
        show.has('quant')
          ? selectField(
              'Quantization',
              v.quant,
              quants.map((q) => ({
                value: q.id,
                label: `${q.id} · ${q.bits} bit${q.size_gb ? ` · ${q.size_gb} GB` : ''}`,
              })),
              (x) => this.emit({ quant: x }),
              opt,
            )
          : nothing
      }
      ${
        show.has('hardware')
          ? selectField(
              'Hardware',
              v.hardware,
              hardware.map((h) => ({ value: h.id, label: `${h.name}` })),
              (x) => this.emit({ hardware: x }),
              opt,
            )
          : nothing
      }
    </div>`;
  }
}
