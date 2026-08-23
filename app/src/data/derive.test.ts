import { cellId, computeCoverage } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import {
  buildHeatMatrix,
  buildLookups,
  hardwarePlatforms,
  heatKey,
  possibleCells,
} from './derive.js';
import { fixtureRegistry, fixtureRow } from './fixture.js';
import { normalizeIndex, normalizeRegistry } from './normalize.js';

describe('possibleCells', () => {
  const reg = fixtureRegistry();
  it('crosses quant x engine x hardware x minor honouring platforms and formats', () => {
    const cells = possibleCells(reg);
    // vllm: bf16, fp8 on the 4090 x 2 minors = 4; mlx-lm: bf16, mlx-4bit on M2 Max x 1 minor = 2
    expect(cells).toHaveLength(6);
    expect(
      cells.filter((c) => c.engine_id === 'vllm').every((c) => c.hardware_id === 'nvidia-rtx-4090'),
    ).toBe(true);
    expect(
      cells
        .filter((c) => c.engine_id === 'mlx-lm')
        .every((c) => c.hardware_id === 'apple-m2-max-32gb'),
    ).toBe(true);
    const one = cells.find(
      (c) => c.engine_id === 'vllm' && c.quant_id === 'fp8' && c.engine_minor === '0.27',
    )!;
    expect(one.cell_id).toBe(
      cellId({
        model_id: 'qwen3-8b',
        quant_id: 'fp8',
        hardware_id: 'nvidia-rtx-4090',
        hw_count: 1,
        engine_id: 'vllm',
        engine_minor: '0.27',
      }),
    );
  });
  it('maps vendors to platforms like the build does', () => {
    expect(
      hardwarePlatforms({
        schema_version: 1,
        id: 'x',
        name: 'x',
        vendor: 'nvidia',
        kind: 'gpu',
        memory_gb: 1,
      }),
    ).toEqual(['linux-cuda', 'windows-cuda']);
    expect(
      hardwarePlatforms({
        schema_version: 1,
        id: 'x',
        name: 'x',
        vendor: 'apple',
        kind: 'soc',
        memory_gb: 1,
      }),
    ).toEqual(['macos-metal', 'macos-cpu']);
    expect(
      hardwarePlatforms({
        schema_version: 1,
        id: 'x',
        name: 'x',
        vendor: 'other',
        kind: 'cpu',
        memory_gb: 1,
      }),
    ).toEqual(['linux-cpu', 'windows-cpu']);
  });
});

describe('buildHeatMatrix', () => {
  const reg = fixtureRegistry();
  const lookups = buildLookups(reg);
  const possible = possibleCells(reg);
  const cell = possible.find(
    (c) => c.engine_id === 'vllm' && c.quant_id === 'fp8' && c.engine_minor === '0.27',
  )!;
  const index = normalizeIndex([
    fixtureRow({ cell_id: cell.cell_id }),
    fixtureRow({
      cell_id: cell.cell_id,
      run_id: 'cfg0000000000001--eval-math-v1--abc124',
      workload_id: 'eval-math-v1',
      kind: 'eval',
      metrics: { accuracy: 0.9 },
    }),
  ]);
  const coverage = computeCoverage(
    index,
    { engineVersions: { vllm: ['0.26.1', '0.27.1'], 'mlx-lm': ['0.28.4'] } },
    { site: reg.site },
  );

  it('aggregates model x hardware with coverage fractions', () => {
    const m = buildHeatMatrix(
      reg,
      lookups,
      possible,
      coverage,
      index,
      'model',
      'hardware',
      {},
      reg.site.coverage.key_metrics,
    );
    expect(m.rows).toEqual(['qwen3-8b']);
    expect(m.cols.sort()).toEqual(['apple-m2-max-32gb', 'nvidia-rtx-4090']);
    const hc = m.cells.get(heatKey('qwen3-8b', 'nvidia-rtx-4090'))!;
    expect(hc.possible).toBe(4);
    expect(hc.covered).toBe(1);
    expect(hc.runs).toBe(2);
    expect(hc.level).toBe('single');
    expect(hc.bestMetric).toBe('output_tok_s');
    expect(hc.bestValue).toBe(120.5);
    expect(m.totalPossible).toBe(6);
    expect(m.totalCovered).toBe(1);
    expect(m.cells.get(heatKey('qwen3-8b', 'apple-m2-max-32gb'))!.runs).toBe(0);
  });
  it('filters by workload kind and engine', () => {
    const m = buildHeatMatrix(
      reg,
      lookups,
      possible,
      coverage,
      index,
      'model',
      'hardware',
      { kind: 'eval' },
      reg.site.coverage.key_metrics,
    );
    const hc = m.cells.get(heatKey('qwen3-8b', 'nvidia-rtx-4090'))!;
    expect(hc.runs).toBe(1);
    expect(hc.bestMetric).toBe('accuracy');
    const m2 = buildHeatMatrix(
      reg,
      lookups,
      possible,
      coverage,
      index,
      'model',
      'hardware',
      { engine: 'mlx-lm' },
      reg.site.coverage.key_metrics,
    );
    expect(m2.cols).toEqual(['apple-m2-max-32gb']);
  });
  it('supports quant rows scoped to a model and workload columns', () => {
    const m = buildHeatMatrix(
      reg,
      lookups,
      possible,
      coverage,
      index,
      'quant',
      'engine_minor',
      { model: 'qwen3-8b' },
      reg.site.coverage.key_metrics,
    );
    expect(m.rows.sort()).toEqual(['bf16', 'fp8', 'mlx-4bit']);
    expect(m.cols.sort()).toEqual(['mlx-lm 0.28', 'vllm 0.26', 'vllm 0.27']);
    const w = buildHeatMatrix(
      reg,
      lookups,
      possible,
      coverage,
      index,
      'hardware',
      'workload',
      {},
      reg.site.coverage.key_metrics,
    );
    expect(w.cols.sort()).toEqual(['eval-math-v1', 'serve-single-i256-o256-v1']);
    expect(w.cells.get(heatKey('nvidia-rtx-4090', 'eval-math-v1'))!.runs).toBe(1);
  });
});

describe('normalizeRegistry', () => {
  it('accepts the build shape (meta spread, versions as objects, quants inline)', () => {
    const reg = normalizeRegistry(
      {
        hardware: [{ id: 'h', name: 'H', vendor: 'nvidia', kind: 'gpu', memory_gb: 1 }],
        engines: [
          {
            id: 'e',
            name: 'E',
            platforms: ['linux-cuda'],
            quant_formats: [],
            install: [],
            serve: {},
            drop_params: [],
            overlay: { params: {} },
            versions: [{ version: '1.0', param_count: 3 }],
          },
        ],
        models: [
          {
            id: 'm',
            name: 'M',
            vendor: 'v',
            params_b: 1,
            context_length: 1,
            quants: [
              {
                id: 'q',
                model_id: 'm',
                format: 'bf16',
                bits: 16,
                engines: ['e'],
                source: 'official',
              },
            ],
          },
        ],
        workloads: [],
      },
      fixtureRegistry().site,
    );
    expect(reg.engines[0]!.meta.id).toBe('e');
    expect(reg.engines[0]!.versions).toEqual(['1.0']);
    expect(reg.engines[0]!.param_counts?.['1.0']).toBe(3);
    expect(reg.engines[0]!.overlay).toEqual({ params: {} });
    expect(reg.models[0]!.quants[0]!.id).toBe('q');
    expect(reg.site.site.title).toBe('Inference Atlas');
  });
});
