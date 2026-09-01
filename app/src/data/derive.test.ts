import { cellId, computeCoverage } from '@atlas/core';
import { describe, expect, it } from 'vitest';
import {
  atlasCells,
  buildHeatMatrix,
  buildLookups,
  hardwarePlatforms,
  heatKey,
  measuredCells,
  possibleCells,
} from './derive.js';
import { fixtureRegistry, fixtureRow } from './fixture.js';
import { normalizeIndex, normalizeRegistry } from '@atlas/core';

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
        model_id: 'Qwen/Qwen3-8B',
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

describe('measuredCells', () => {
  const reg = fixtureRegistry();
  const enumerated = possibleCells(reg);
  const tpCellId = cellId({
    model_id: 'Qwen/Qwen3-8B',
    quant_id: 'fp8',
    hardware_id: 'nvidia-rtx-4090',
    hw_count: 2,
    engine_id: 'vllm',
    engine_minor: '0.27',
  });
  const tpIndex = normalizeIndex([
    fixtureRow({
      cell_id: tpCellId,
      run_id: 'cfg0000000000002--serve-single-i256-o256-v1--abc125',
      config_id: 'cfg0000000000002',
      hardware: { id: 'nvidia-rtx-4090', count: 2 },
      metrics: { output_tok_s: 200 },
    }),
  ]);
  const tpCoverage = computeCoverage(
    tpIndex,
    { engineVersions: { vllm: ['0.26.1', '0.27.1'], 'mlx-lm': ['0.28.4'] } },
    { site: reg.site },
  );

  it('adds a measured multi-device cell the cross product cannot enumerate', () => {
    expect(enumerated.some((pc) => pc.cell_id === tpCellId)).toBe(false);
    const extra = measuredCells(reg, tpCoverage, enumerated);
    expect(extra).toHaveLength(1);
    expect(extra[0]!.cell_id).toBe(tpCellId);
    expect(extra[0]!.hw_count).toBe(2);
    // pinned to the newest registered version of the cell's own minor, for the packet
    expect(extra[0]!.engine_version).toBe('0.27.1');
  });

  it('adds nothing for a cell the cross product already has', () => {
    const single = enumerated.find(
      (c) => c.engine_id === 'vllm' && c.quant_id === 'fp8' && c.engine_minor === '0.27',
    )!;
    const cov = computeCoverage(
      normalizeIndex([fixtureRow({ cell_id: single.cell_id })]),
      { engineVersions: { vllm: ['0.26.1', '0.27.1'] } },
      { site: reg.site },
    );
    expect(measuredCells(reg, cov, enumerated)).toHaveLength(0);
  });

  it('skips a cell naming hardware the registry does not have', () => {
    const cov = {
      deadbeef0000: {
        cell_id: 'deadbeef0000',
        model_id: 'Qwen/Qwen3-8B',
        quant_id: 'fp8',
        hardware_id: 'nvidia-rtx-9090',
        hw_count: 2,
        engine_id: 'vllm',
        engine_minor: '0.27',
        runs: 1,
        logins: ['someone'],
        workloads: [],
        configs: [],
        level: 'single' as const,
        best: null,
      },
    };
    expect(measuredCells(reg, cov, enumerated)).toHaveLength(0);
  });

  it('counts the multi-device square on the grid instead of dropping it', () => {
    const before = buildHeatMatrix(
      reg,
      buildLookups(reg),
      enumerated,
      tpCoverage,
      tpIndex,
      'model',
      'hardware',
      {},
      reg.site.coverage.key_metrics,
    );
    expect(before.cells.get(heatKey('Qwen/Qwen3-8B', 'nvidia-rtx-4090'))!.runs).toBe(0);

    const after = buildHeatMatrix(
      reg,
      buildLookups(reg),
      atlasCells(reg, tpCoverage),
      tpCoverage,
      tpIndex,
      'model',
      'hardware',
      {},
      reg.site.coverage.key_metrics,
    );
    const hc = after.cells.get(heatKey('Qwen/Qwen3-8B', 'nvidia-rtx-4090'))!;
    expect(hc.runs).toBe(1);
    expect(hc.covered).toBe(1);
    expect(hc.possible).toBe(5);
    expect(hc.cells.map((c) => c.cell_id)).toEqual([tpCellId]);
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
    expect(m.rows).toEqual(['Qwen/Qwen3-8B']);
    expect(m.cols.sort()).toEqual(['apple-m2-max-32gb', 'nvidia-rtx-4090']);
    const hc = m.cells.get(heatKey('Qwen/Qwen3-8B', 'nvidia-rtx-4090'))!;
    expect(hc.possible).toBe(4);
    expect(hc.covered).toBe(1);
    expect(hc.runs).toBe(2);
    expect(hc.level).toBe('single');
    expect(hc.bestMetric).toBe('output_tok_s');
    expect(hc.bestValue).toBe(120.5);
    expect(m.totalPossible).toBe(6);
    expect(m.totalCovered).toBe(1);
    expect(m.cells.get(heatKey('Qwen/Qwen3-8B', 'apple-m2-max-32gb'))!.runs).toBe(0);
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
    const hc = m.cells.get(heatKey('Qwen/Qwen3-8B', 'nvidia-rtx-4090'))!;
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
      { model: 'Qwen/Qwen3-8B' },
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
