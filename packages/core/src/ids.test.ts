import { describe, expect, it } from 'vitest';
import {
  cellId,
  engineMinor,
  isModelId,
  modelSlug,
  parseResultPath,
  parseRunId,
  resultDir,
  resultPath,
  runId,
} from './ids.js';
import type { CellIdInput } from './ids.js';
import { readJson } from '../test/helpers.js';

interface IdFixture {
  cell_id: Array<{ name: string; input: CellIdInput; expected: string }>;
  run_id: Array<{
    name: string;
    input: { config_id: string; workload_id: string; github_login: string; started_at: string };
    expected: string;
  }>;
  engine_minor: Array<{ input: string; expected: string }>;
  model_slug: Array<{ input: string; expected: string }>;
  result_path: Array<{
    name: string;
    input: { engine_id: string; model_id: string; hardware_id: string; run_id: string };
    expected: string;
  }>;
}

const fixture = readJson<IdFixture>('schemas/fixtures/id-vectors.json');

describe('cell_id', () => {
  it('has at least four golden vectors', () => {
    expect(fixture.cell_id.length).toBeGreaterThanOrEqual(4);
  });
  for (const v of fixture.cell_id) {
    it(v.name, () => expect(cellId(v.input)).toBe(v.expected));
  }
  it('is distinct per engine minor and per device count', () => {
    const ids = new Set(fixture.cell_id.map((v) => v.expected));
    expect(ids.size).toBe(fixture.cell_id.length);
  });
});

describe('run_id', () => {
  it('has at least four golden vectors', () => {
    expect(fixture.run_id.length).toBeGreaterThanOrEqual(4);
  });
  for (const v of fixture.run_id) {
    it(v.name, () =>
      expect(
        runId(v.input.config_id, v.input.workload_id, v.input.github_login, v.input.started_at),
      ).toBe(v.expected),
    );
  }
  it('separates two contributors running the identical configuration', () => {
    const a = runId(
      '1dd64efc5109c652',
      'serve-single-i256-o256-v1',
      'alice',
      '2026-08-16T10:00:00Z',
    );
    const b = runId('1dd64efc5109c652', 'serve-single-i256-o256-v1', 'bob', '2026-08-16T10:00:00Z');
    expect(a).not.toBe(b);
  });
  it('round-trips through parseRunId', () => {
    for (const v of fixture.run_id) {
      const parsed = parseRunId(v.expected);
      expect(parsed).not.toBeNull();
      expect(parsed?.configId).toBe(v.input.config_id);
      expect(parsed?.workloadId).toBe(v.input.workload_id);
    }
  });
  it('rejects things that are not run ids', () => {
    expect(parseRunId('not-a-run-id')).toBeNull();
    expect(parseRunId('zzzz--serve-v1--aaaaaa')).toBeNull();
    expect(parseRunId('1dd64efc5109c652--serve-v1--XYZ123')).toBeNull();
  });
});

describe('engineMinor', () => {
  for (const v of fixture.engine_minor) {
    it(`${v.input} -> ${v.expected}`, () => expect(engineMinor(v.input)).toBe(v.expected));
  }
});

describe('model ids', () => {
  it('accepts a Hugging Face repo id, case and dots included', () => {
    expect(isModelId('Qwen/Qwen3.8-27B')).toBe(true);
    expect(isModelId('google/gemma-4-E2B-it')).toBe(true);
    expect(isModelId('lmstudio-community/gemma-4-E2B-it-MLX-4bit')).toBe(true);
    expect(isModelId('nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16')).toBe(true);
  });

  it('rejects anything that is not exactly one slash between two repo names', () => {
    expect(isModelId('qwen3.8-27b')).toBe(false); // the old kebab-case ids
    expect(isModelId('a/b/c')).toBe(false);
    expect(isModelId('/Qwen3-8B')).toBe(false);
    expect(isModelId('Qwen/')).toBe(false);
    expect(isModelId('.hidden/model')).toBe(false);
    expect(isModelId('Qwen Team/Qwen3-8B')).toBe(false);
  });

  it('slugs a model id down to one branch-safe segment', () => {
    for (const v of fixture.model_slug) {
      expect(modelSlug(v.input)).toBe(v.expected);
    }
  });

  it('slugs case-only variants identically, which is why a slug is never an id', () => {
    expect(modelSlug('Qwen/Qwen3-8B')).toBe(modelSlug('qwen/qwen3-8b'));
    expect(modelSlug('Qwen/Qwen3-8B')).toMatch(/^[a-z0-9.-]+$/);
  });

  it('is hashed verbatim, so two spellings of one repo are two cells', () => {
    const base = {
      quant_id: 'fp8',
      hardware_id: 'nvidia-gb10-dgx-spark',
      hw_count: 1,
      engine_id: 'vllm',
      engine_minor: '0.27',
    };
    expect(cellId({ ...base, model_id: 'Qwen/Qwen3.8-27B' })).not.toBe(
      cellId({ ...base, model_id: 'qwen/qwen3.8-27b' }),
    );
  });
});

describe('resultPath', () => {
  for (const v of fixture.result_path) {
    it(v.name, () =>
      expect(
        resultPath(v.input.engine_id, v.input.model_id, v.input.hardware_id, v.input.run_id),
      ).toBe(v.expected),
    );
  }

  it('spends two path segments on the model id', () => {
    const path = resultPath(
      'vllm',
      'Qwen/Qwen3.8-27B',
      'nvidia-gb10-dgx-spark',
      '1dd64efc5109c652--serve-single-i256-o256-v1--d1b2ff',
    );
    expect(path.split('/')).toHaveLength(6);
    expect(path).toContain('/Qwen/Qwen3.8-27B/');
  });

  it('agrees with resultDir', () => {
    expect(resultPath('vllm', 'Qwen/Qwen3-8B', 'apple-m2-max-32gb', 'x')).toBe(
      `${resultDir('vllm', 'Qwen/Qwen3-8B', 'apple-m2-max-32gb')}/x.json`,
    );
  });
});

describe('parseResultPath', () => {
  it('inverts resultPath for every golden vector', () => {
    for (const v of fixture.result_path) {
      expect(parseResultPath(v.expected)).toEqual({
        engine_id: v.input.engine_id,
        model_id: v.input.model_id,
        hardware_id: v.input.hardware_id,
        run_id: v.input.run_id,
      });
    }
  });

  it('tolerates a leading ./ from a git diff', () => {
    const path = fixture.result_path[0]!.expected;
    expect(parseResultPath(`./${path}`)).toEqual(parseResultPath(path));
  });

  it('rejects paths that are not result files', () => {
    const run = '1dd64efc5109c652--serve-single-i256-o256-v1--d1b2ff';
    // one level short: the old single-segment model directory
    expect(
      parseResultPath(`results/vllm/qwen3.8-27b/nvidia-gb10-dgx-spark/${run}.json`),
    ).toBeNull();
    // not under results/
    expect(
      parseResultPath(`runs/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark/${run}.json`),
    ).toBeNull();
    // file name is not a run id
    expect(
      parseResultPath('results/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark/notes.json'),
    ).toBeNull();
    // not JSON
    expect(
      parseResultPath(`results/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark/${run}.txt`),
    ).toBeNull();
    // an engine id that is not kebab-case
    expect(
      parseResultPath(`results/vLLM/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark/${run}.json`),
    ).toBeNull();
    expect(parseResultPath('results/README.md')).toBeNull();
  });
});
