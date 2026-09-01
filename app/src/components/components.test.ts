import { computeCoverage } from '@atlas/core';
import { render } from 'lit';
import { describe, expect, it, beforeAll } from 'vitest';
import { buildHeatMatrix, buildLookups, possibleCells } from '../data/derive.js';
import { fixtureRegistry, fixtureRow } from '../data/fixture.js';
import { normalizeIndex } from '@atlas/core';
import { store } from '../store.js';
import './heatmap.js';
import './param-form.js';
import './add-modal.js';
import './packet-preview.js';
import { sparkline } from './ui.js';
import {
  addSpec,
  closeAdd,
  decodeAddSpec,
  encodeAddSpec,
  openAdd,
  packetRegistry,
} from './add-modal.js';
import type { AtlasHeatmap } from './heatmap.js';
import type { AtlasParamForm } from './param-form.js';
import type { AtlasAddModal } from './add-modal.js';

const reg = fixtureRegistry();
const possible = possibleCells(reg);
const cell = possible.find(
  (c) => c.engine_id === 'vllm' && c.quant_id === 'fp8' && c.engine_minor === '0.27',
)!;
const index = normalizeIndex([fixtureRow({ cell_id: cell.cell_id })]);

beforeAll(() => {
  store.registry.value = reg;
  store.index.value = index;
  store.coverage.value = computeCoverage(
    index,
    { engineVersions: { vllm: ['0.26.1', '0.27.1'], 'mlx-lm': ['0.28.4'] } },
    { site: reg.site },
  );
});

async function mount<T extends HTMLElement>(
  tag: string,
  props: Record<string, unknown> = {},
): Promise<T> {
  const el = document.createElement(tag) as T & { updateComplete: Promise<unknown> };
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('atlas-heatmap', () => {
  it('renders one button per possible square and dispatches cell-select', async () => {
    const m = buildHeatMatrix(
      reg,
      buildLookups(reg),
      possible,
      store.coverage.value,
      index,
      'model',
      'hardware',
      {},
      reg.site.coverage.key_metrics,
    );
    const el = await mount<AtlasHeatmap>('atlas-heatmap', { matrix: m });
    const buttons = el.querySelectorAll('button.hm-cell');
    expect(buttons.length).toBe(2);
    const covered = el.querySelector('button.hm-cell.level-single')!;
    expect(covered).toBeTruthy();
    expect(covered.querySelector('.n')?.textContent).toBe('1');
    let detail: unknown = null;
    el.addEventListener('cell-select', (e) => (detail = (e as CustomEvent).detail));
    (covered as HTMLButtonElement).click();
    expect(detail).toBeTruthy();
    expect((detail as { cell: { runs: number } }).cell.runs).toBe(1);
    el.remove();
  });
});

describe('atlas-param-form', () => {
  it('renders typed controls, marks non-defaults and emits args-change', async () => {
    const version = {
      schema_version: 1 as const,
      engine_id: 'vllm',
      version: '0.27.1',
      extraction_method: 'hand-seeded' as const,
      params: [
        {
          name: 'gpu-memory-utilization',
          type: 'float' as const,
          default: 0.9,
          group: 'memory',
          impact: 'high' as const,
        },
        {
          name: 'enable-prefix-caching',
          type: 'bool' as const,
          default: null,
          group: 'caching',
          impact: 'high' as const,
        },
        {
          name: 'dtype',
          type: 'enum' as const,
          default: 'auto',
          choices: ['auto', 'bf16'],
          group: 'model',
          impact: 'low' as const,
        },
        {
          name: 'port',
          type: 'int' as const,
          default: 8000,
          group: 'server',
          impact: 'low' as const,
        },
      ],
    };
    const el = await mount<AtlasParamForm>('atlas-param-form', {
      version,
      args: { 'gpu-memory-utilization': 0.44 },
      dropParams: ['port'],
    });
    expect(el.querySelectorAll('.param-row').length).toBe(3); // port dropped
    expect(el.querySelector('.param-row.changed .name')?.textContent).toContain(
      'gpu-memory-utilization',
    );
    expect(el.querySelector('input[type=number]')).toBeTruthy();
    expect(el.querySelector('.switch input[type=checkbox]')).toBeTruthy();
    expect(el.querySelector('select.select')).toBeTruthy();
    let next: unknown = null;
    el.addEventListener('args-change', (e) => (next = (e as CustomEvent).detail));
    const sel = el.querySelector('select.select') as HTMLSelectElement;
    sel.value = 'bf16';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(next).toEqual({ 'gpu-memory-utilization': 0.44, dtype: 'bf16' });
    el.remove();
  });
});

describe('add modal', () => {
  it('round-trips the URL encoding', () => {
    const spec = {
      kind: 'cell' as const,
      engine_id: 'vllm',
      engine_version: '0.27.1',
      model_id: 'Qwen/Qwen3-8B',
      quant_id: 'fp8',
      hardware_id: 'nvidia-rtx-4090',
      workload_ids: ['a', 'b'],
      args: { 'max-model-len': 4096 },
    };
    const dec = decodeAddSpec(encodeAddSpec(spec))!;
    expect(dec.engine_id).toBe('vllm');
    expect(dec.workload_ids).toEqual(['a', 'b']);
    expect(dec.args).toEqual({ 'max-model-len': 4096 });
    expect(decodeAddSpec('new-hardware|||||||RTX 5080')!.target_name).toBe('RTX 5080');
  });
  it('opens with a packet whose markdown carries the essential steps, toggles workloads, closes on Escape', async () => {
    const el = await mount<AtlasAddModal>('atlas-add-modal');
    openAdd({
      engine_id: 'vllm',
      engine_version: '0.27.1',
      model_id: 'Qwen/Qwen3-8B',
      quant_id: 'fp8',
      hardware_id: 'nvidia-rtx-4090',
      workload_ids: ['serve-single-i256-o256-v1'],
    });
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
    expect(el.querySelector('.add-dialog')).toBeTruthy();
    expect(el.querySelector('#add-title')?.textContent).toContain('Qwen/Qwen3-8B');
    const md = el.querySelector('.add-md')!.textContent ?? '';
    expect(md).toContain('atlas-bench hwinfo --json');
    expect(md).toContain('git clone');
    expect(md).toContain('pnpm validate');
    expect(md).toContain('gh pr create');
    expect(md).toContain('Never edit a number by hand');
    expect(md).toContain('serve Qwen/Qwen3-8B-FP8');
    // toggle the eval workload on
    const chips = [...el.querySelectorAll('.add-workloads .chip')] as HTMLButtonElement[];
    const evalChip = chips.find((c) => c.textContent?.includes('eval-math-v1'))!;
    evalChip.click();
    await el.updateComplete;
    expect(el.querySelectorAll('.add-workloads .chip[aria-pressed="true"]').length).toBe(2);
    expect(el.querySelector('.add-md')!.textContent).toContain('eval-math-v1');
    // escape closes
    el.querySelector('.modal')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await el.updateComplete;
    expect(addSpec.value).toBeNull();
    expect(el.querySelector('.add-dialog')).toBeNull();
    closeAdd();
    el.remove();
  });
  it('builds a packet registry from the store', () => {
    const pr = packetRegistry();
    expect(pr.engines.map((e) => e.meta.id)).toEqual(['vllm', 'mlx-lm']);
    expect(pr.models[0]!.quants.length).toBe(3);
  });
});

describe('sparkline', () => {
  it('draws one path, restarting after gaps so a missing sensor reading stays a gap', () => {
    const host = document.createElement('div');
    render(sparkline([1, 2, null, 4]), host);
    const d = host.querySelector('path')!.getAttribute('d')!;
    expect(d.startsWith('M')).toBe(true);
    expect(d.match(/M/g)).toHaveLength(2);
    // the latest reading gets the emphasis dot
    expect(host.querySelector('circle')).not.toBeNull();
  });

  it('renders nothing when no value was measured', () => {
    const host = document.createElement('div');
    render(sparkline([null, null]), host);
    expect(host.querySelector('svg')).toBeNull();
  });
});
