import { describe, expect, it } from 'vitest';
import { computeCoverage, emptyCell, isReleaseVersion, minorsBehind } from './coverage.js';
import { cellId } from './ids.js';
import type { CompiledIndexRow, CoverageRegistry } from './index.js';

const registry: CoverageRegistry = {
  engineVersions: { vllm: ['0.24.0', '0.25.1', '0.26.1', '0.27.1'], llamacpp: ['b7000'] },
};

function row(
  over: Partial<CompiledIndexRow> & { login: string; tok_s?: number | null },
): CompiledIndexRow {
  const engineMinorValue = over.engine?.minor ?? '0.27';
  const model = over.model ?? { id: 'Qwen/Qwen3-8B', quant_id: 'fp8' };
  const hardware = over.hardware ?? { id: 'nvidia-rtx-4090', count: 1 };
  const cell_id =
    over.cell_id ??
    cellId({
      model_id: model.id,
      quant_id: model.quant_id,
      hardware_id: hardware.id,
      hw_count: hardware.count,
      engine_id: over.engine?.id ?? 'vllm',
      engine_minor: engineMinorValue,
    });
  return {
    run_id: `${over.config_id ?? 'c'.repeat(16)}--serve-v1--${over.login.slice(0, 6).padEnd(6, '0')}`,
    cell_id,
    config_id: over.config_id ?? 'c'.repeat(16),
    workload_id: over.workload_id ?? 'serve-v1',
    kind: 'serving',
    engine: over.engine ?? { id: 'vllm', version: '0.27.1', minor: '0.27' },
    model,
    hardware,
    metrics: { output_tok_s: over.tok_s === undefined ? 100 : over.tok_s },
    provenance: { login: over.login, submitted_at: '2026-08-01T00:00:00Z' },
    verification_level: over.verification_level ?? 'self-reported',
    path: 'results/x.json',
  };
}

describe('minorsBehind', () => {
  it('counts registered minors newer than the one measured', () => {
    expect(minorsBehind('0.27', ['0.24.0', '0.25.1', '0.26.1', '0.27.1'])).toBe(0);
    expect(minorsBehind('0.26', ['0.24.0', '0.25.1', '0.26.1', '0.27.1'])).toBe(1);
    expect(minorsBehind('0.24', ['0.24.0', '0.25.1', '0.26.1', '0.27.1'])).toBe(3);
  });
  it('orders build numbers numerically, not lexicographically', () => {
    expect(minorsBehind('b9000', ['b7000', 'b9000', 'b10000'])).toBe(1);
  });
  it('accepts a full version as well as a bare minor', () => {
    expect(minorsBehind('0.26.1', ['0.24.0', '0.25.1', '0.26.1', '0.27.1'])).toBe(1);
  });
  it('never calls a development build behind a release', () => {
    // vLLM's Qwen3.8-Flash-Next branch build: setuptools-scm with no reachable tag reports
    // 0.1.devN+g<sha>, so the leading 0.1 is a placeholder, not release 0.1.
    expect(minorsBehind('0.1.dev20073+g8e685d198', ['0.1.dev20073+g8e685d198', '0.27.1'])).toBe(0);
    expect(minorsBehind('0.0.0.dev0+qwen38.27b.g561c8f3', ['0.5.4'])).toBe(0);
  });
  it('never calls an opaque build identifier behind another one', () => {
    expect(minorsBehind('b50-035e227', ['b50-035e227', 'b7000'])).toBe(0);
    expect(minorsBehind('960652b', ['960652b'])).toBe(0);
  });
  it('does not let a development build make a release look behind', () => {
    expect(minorsBehind('0.27', ['0.27.1', '0.28.0rc1', '99.0.dev1+gdeadbee'])).toBe(0);
  });
});

describe('isReleaseVersion', () => {
  it('accepts dotted releases and monotonic build numbers', () => {
    for (const v of ['0.27.1', 'v1.2.3', '2026.08.1', '0.0.14', 'b7000', '7000'])
      expect(isReleaseVersion(v), v).toBe(true);
  });
  it('rejects development, pre-release and opaque builds', () => {
    for (const v of [
      '0.1.dev20073+g8e685d198',
      '0.0.0.dev0+qwen38.27b.g561c8f3',
      '0.28.0rc1',
      '1.0.0-beta.2',
      'b50-035e227',
      '960652b',
    ])
      expect(isReleaseVersion(v), v).toBe(false);
  });
});

describe('coverage levels', () => {
  it('is single for one contributor', () => {
    const cells = computeCoverage([row({ login: 'alice' })], registry);
    expect(Object.values(cells)[0]?.level).toBe('single');
  });

  it('is reproduced when two logins agree on the same config and workload', () => {
    const cells = computeCoverage(
      [row({ login: 'alice', tok_s: 100 }), row({ login: 'bob', tok_s: 108 })],
      registry,
    );
    const cell = Object.values(cells)[0]!;
    expect(cell.level).toBe('reproduced');
    expect(cell.logins).toEqual(['alice', 'bob']);
    expect(cell.runs).toBe(2);
  });

  it('is disputed when they disagree by more than the configured margin', () => {
    const cells = computeCoverage(
      [row({ login: 'alice', tok_s: 100 }), row({ login: 'bob', tok_s: 180 })],
      registry,
    );
    const cell = Object.values(cells)[0]!;
    expect(cell.level).toBe('disputed');
    expect(cell.disputes?.[0]?.metric).toBe('output_tok_s');
    expect(cell.disputes?.[0]?.run_ids).toHaveLength(2);
  });

  it('does not call it a dispute when the configs differ', () => {
    const cells = computeCoverage(
      [
        row({ login: 'alice', tok_s: 100 }),
        row({ login: 'bob', tok_s: 180, config_id: 'd'.repeat(16) }),
      ],
      registry,
    );
    expect(Object.values(cells)[0]?.level).toBe('single');
  });

  it('does not call it a dispute when one person ran it twice', () => {
    const cells = computeCoverage(
      [row({ login: 'alice', tok_s: 100 }), row({ login: 'alice', tok_s: 180 })],
      registry,
    );
    expect(Object.values(cells)[0]?.level).toBe('single');
  });

  it('is stale when the only evidence is two minors behind', () => {
    const engine = { id: 'vllm', version: '0.25.1', minor: '0.25' };
    const cells = computeCoverage([row({ login: 'alice', engine })], registry);
    const cell = Object.values(cells)[0]!;
    expect(cell.level).toBe('stale');
    expect(cell.minors_behind).toBe(2);
  });

  it('does not call a development build stale', () => {
    // The only build that runs the model is a fork of the engine, and it reports a
    // placeholder version. There is no newer release that could supersede it.
    const engine = { id: 'vllm', version: '0.1.dev20073+g8e685d198', minor: '0.1' };
    const forkRegistry: CoverageRegistry = {
      engineVersions: { vllm: ['0.1.dev20073+g8e685d198', '0.26.1', '0.27.1'] },
    };
    const cells = computeCoverage([row({ login: 'alice', engine })], forkRegistry);
    const cell = Object.values(cells)[0]!;
    expect(cell.level).toBe('single');
    expect(cell.minors_behind).toBeUndefined();
  });

  it('still calls a real release stale when the engine has moved on', () => {
    const engine = { id: 'vllm', version: '0.25.1', minor: '0.25' };
    const forkRegistry: CoverageRegistry = {
      engineVersions: { vllm: ['0.1.dev20073+g8e685d198', '0.25.1', '0.26.1', '0.27.1'] },
    };
    const cells = computeCoverage([row({ login: 'alice', engine })], forkRegistry);
    expect(Object.values(cells)[0]?.level).toBe('stale');
    expect(Object.values(cells)[0]?.minors_behind).toBe(2);
  });

  it('lets a dispute outrank staleness', () => {
    const engine = { id: 'vllm', version: '0.24.0', minor: '0.24' };
    const cells = computeCoverage(
      [row({ login: 'alice', engine, tok_s: 100 }), row({ login: 'bob', engine, tok_s: 200 })],
      registry,
    );
    expect(Object.values(cells)[0]?.level).toBe('disputed');
  });

  it('picks the best run by the first key metric present', () => {
    const cells = computeCoverage(
      [row({ login: 'alice', tok_s: 100 }), row({ login: 'bob', tok_s: 140 })],
      registry,
    );
    expect(Object.values(cells)[0]?.best?.metrics.output_tok_s).toBe(140);
  });

  it('groups runs of different cells apart', () => {
    const cells = computeCoverage(
      [
        row({ login: 'alice' }),
        row({ login: 'alice', hardware: { id: 'nvidia-rtx-5090', count: 1 } }),
      ],
      registry,
    );
    expect(Object.keys(cells)).toHaveLength(2);
  });

  it('describes an untested square as none', () => {
    const cell = emptyCell({
      cell_id: 'abc123abc123',
      model_id: 'Qwen/Qwen3-8B',
      quant_id: 'fp8',
      hardware_id: 'nvidia-rtx-4090',
      hw_count: 1,
      engine_id: 'vllm',
      engine_minor: '0.27',
    });
    expect(cell.level).toBe('none');
    expect(cell.runs).toBe(0);
    expect(cell.best).toBeNull();
  });
});
