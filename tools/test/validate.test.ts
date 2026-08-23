/**
 * `validate` against a real repository on disk.
 *
 * The shape of every test is the same: start from a fixture that validates clean, break
 * exactly one thing, and assert that exactly the expected code fires. That is the only way
 * to know the check is looking at what it claims to be looking at — a test that asserts
 * "some error happened" passes when the file fails to parse for an unrelated reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResultRecord } from '@atlas/core';
import { validateRepo } from '../src/validate.js';
import { SOURCE_ROOT, makeFixtureRepo, makeResult } from './helpers/fixture-repo.js';
import type { FixtureRepo } from './helpers/fixture-repo.js';

let repo: FixtureRepo;

/** Codes of the issues at a given level — what every assertion below reads. */
function codes(
  outcome: ReturnType<typeof validateRepo>,
  level: 'error' | 'warn' = 'error',
): string[] {
  return outcome.issues.filter((i) => i.level === level).map((i) => i.code);
}

beforeEach(() => {
  repo = makeFixtureRepo();
});

afterEach(() => {
  repo.dispose();
});

describe('happy path', () => {
  it('accepts a fixture repository with one well-formed result', () => {
    repo.writeResult(makeResult(repo));
    const outcome = validateRepo({ root: repo.root });
    expect(codes(outcome)).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.counts.results).toBe(1);
  });

  it('validates the real repository without errors', () => {
    const outcome = validateRepo({ root: SOURCE_ROOT });
    expect(outcome.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(outcome.ok).toBe(true);
  });
});

describe('recomputed identity', () => {
  const mutate = (change: (result: ResultRecord) => void): ReturnType<typeof validateRepo> => {
    const result = makeResult(repo);
    change(result);
    repo.writeResult(result);
    return validateRepo({ root: repo.root });
  };

  it('catches a hand-edited config_id', () => {
    expect(codes(mutate((r) => (r.config_id = '0'.repeat(16))))).toContain('config-id-mismatch');
  });

  it('catches a hand-edited cell_id', () => {
    expect(codes(mutate((r) => (r.cell_id = 'deadbeefcafe')))).toContain('cell-id-mismatch');
  });

  it('catches an args_canonical that does not match args', () => {
    const outcome = mutate((r) => {
      r.args_canonical = '@dtype=auto;@quant=fp8';
    });
    expect(codes(outcome)).toContain('args-canonical-mismatch');
  });

  it('catches a run_id that does not derive from the login and start time', () => {
    // Change the login without recomputing: the run_id no longer follows from it, and the
    // filename no longer matches the run_id either.
    const result = makeResult(repo);
    repo.writeResult(result);
    const path = `results/vllm/qwen3-8b/nvidia-rtx-4090/${result.run_id}.json`;
    const stored = repo.read<ResultRecord>(path);
    stored.provenance.github_login = 'someone-else';
    repo.write(path, stored);
    expect(codes(validateRepo({ root: repo.root }))).toContain('run-id-mismatch');
  });

  it('catches a result filed under the wrong directory', () => {
    const result = makeResult(repo);
    repo.write(`results/vllm/qwen3-8b/apple-m2-max-32gb/${result.run_id}.json`, result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('wrong-path');
  });

  it('catches a filename that is not the run_id', () => {
    const result = makeResult(repo);
    repo.write('results/vllm/qwen3-8b/nvidia-rtx-4090/my-run.json', result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('wrong-path');
  });
});

describe('referential integrity', () => {
  it('rejects an unknown model', () => {
    const result = makeResult(repo);
    result.model.id = 'no-such-model';
    repo.write(`results/vllm/no-such-model/nvidia-rtx-4090/${result.run_id}.json`, result);
    const outcome = validateRepo({ root: repo.root });
    expect(codes(outcome)).toContain('unknown-model');
  });

  it('rejects an unknown hardware id', () => {
    const result = makeResult(repo);
    result.hardware.id = 'no-such-gpu';
    repo.write(`results/vllm/qwen3-8b/no-such-gpu/${result.run_id}.json`, result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('unknown-hardware');
  });

  it('rejects a kind that does not mirror the workload', () => {
    // eval-math-v1 is an eval workload; the result claims to be a serving run.
    const result = makeResult(repo, { workloadId: 'eval-math-v1', kind: 'serving' });
    repo.writeResult(result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('kind-mismatch');
  });

  it('rejects an engine the quantization does not list', () => {
    // mlx-4bit exists for this model but names mlx-lm, not vLLM.
    const result = makeResult(repo, { quantId: 'mlx-4bit' });
    repo.writeResult(result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('quant-engine-mismatch');
  });

  it('warns rather than fails when the engine version file is missing', () => {
    const result = makeResult(repo);
    result.engine.version = '0.27.9';
    repo.writeResult(makeResult(repo)); // keep a valid one alongside
    repo.write(`results/vllm/qwen3-8b/nvidia-rtx-4090/${result.run_id}.json`, result);
    const outcome = validateRepo({ root: repo.root });
    expect(codes(outcome, 'warn')).toContain('unknown-engine-version');
  });

  it('rejects an unknown workload when the registry has workloads', () => {
    const result = makeResult(repo, { workloadId: 'no-such-workload-v1' });
    repo.writeResult(result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('unknown-workload');
  });

  it('only warns about an unknown workload while workloads/ is empty', () => {
    const bare = makeFixtureRepo({ withoutWorkloads: true });
    try {
      bare.writeResult(makeResult(bare));
      const outcome = validateRepo({ root: bare.root });
      expect(codes(outcome)).not.toContain('unknown-workload');
      expect(codes(outcome, 'warn')).toContain('unknown-workload');
    } finally {
      bare.dispose();
    }
  });
});

describe('duplicates and payloads', () => {
  it('rejects two files carrying the same run_id', () => {
    const result = makeResult(repo);
    repo.writeResult(result);
    repo.write(`results/vllm/qwen3-8b/apple-m2-max-32gb/${result.run_id}.json`, result);
    const outcome = validateRepo({ root: repo.root });
    expect(codes(outcome)).toContain('duplicate-run-id');
  });

  it('rejects an untruncated raw payload over 100 KB', () => {
    const result = makeResult(repo);
    result.raw = { harness: 'atlas-bench', payload: { blob: 'x'.repeat(120 * 1024) } };
    repo.writeResult(result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('raw-payload-too-large');
  });

  it('accepts an oversized payload that declares itself truncated', () => {
    const result = makeResult(repo);
    result.raw = {
      harness: 'atlas-bench',
      payload: { blob: 'x'.repeat(120 * 1024) },
      truncated: true,
    };
    repo.writeResult(result);
    expect(codes(validateRepo({ root: repo.root }))).not.toContain('raw-payload-too-large');
  });

  it('rejects a stray JSON file in a registry directory', () => {
    repo.write('results/notes.json', { note: 'not a result' });
    expect(codes(validateRepo({ root: repo.root }))).toContain('unmapped-file');
  });

  it('rejects a file that does not match its schema', () => {
    const result = makeResult(repo) as unknown as Record<string, unknown>;
    delete result.verification;
    repo.write(`results/vllm/qwen3-8b/nvidia-rtx-4090/${String(result.run_id)}.json`, result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('schema');
  });
});

describe('plausibility', () => {
  it('rejects a decode rate above what memory bandwidth allows', () => {
    // An 8B model in fp8 is ~8 GB; the 4090 has 1008 GB/s, so ~126 tok/s is the ceiling
    // and 5000 tok/s single-stream is physically impossible.
    const result = makeResult(repo, { decodeTokS: 5000 });
    repo.writeResult(result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('bandwidth-ceiling-exceeded');
  });

  it('rejects peak VRAM above the device memory', () => {
    const result = makeResult(repo);
    result.metrics!.vram_peak_gb = 96;
    repo.writeResult(result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('vram-exceeds-device-memory');
  });

  it('rejects request counts that do not add up', () => {
    const result = makeResult(repo);
    result.metrics!.requests_failed = 3;
    repo.writeResult(result);
    expect(codes(validateRepo({ root: repo.root }))).toContain('request-counts-mismatch');
  });
});

describe('cross-checking existing results', () => {
  it('flags a result that disagrees with the same configuration by more than the threshold', () => {
    repo.writeResult(makeResult(repo, { login: 'alice', decodeTokS: 100, outputTokS: 100 }));
    repo.writeResult(
      makeResult(repo, {
        login: 'bob',
        startedAt: '2026-08-01T12:00:00Z',
        decodeTokS: 40,
        outputTokS: 40,
      }),
    );
    const outcome = validateRepo({ root: repo.root });
    const review = outcome.issues.filter((i) => i.code === 'needs-review');
    expect(review.length).toBe(2);
    expect(review[0]!.related?.length).toBe(1);
  });

  it('says nothing when two runs of the same configuration agree', () => {
    repo.writeResult(makeResult(repo, { login: 'alice', decodeTokS: 100, outputTokS: 100 }));
    repo.writeResult(
      makeResult(repo, {
        login: 'bob',
        startedAt: '2026-08-01T12:00:00Z',
        decodeTokS: 96,
        outputTokS: 96,
      }),
    );
    const outcome = validateRepo({ root: repo.root });
    expect(outcome.issues.map((i) => i.code)).not.toContain('needs-review');
  });
});

describe('reporting', () => {
  it('narrows the report to --changed but still finds repository-wide problems', () => {
    const kept = makeResult(repo, { login: 'alice' });
    const broken = makeResult(repo, { login: 'bob', startedAt: '2026-08-01T12:00:00Z' });
    broken.cell_id = 'deadbeefcafe';
    repo.writeResult(kept);
    const brokenPath = repo.writeResult(broken);

    const all = validateRepo({ root: repo.root });
    expect(codes(all)).toContain('cell-id-mismatch');

    const narrowed = validateRepo({ root: repo.root, changed: [`./${brokenPath}`] });
    expect(codes(narrowed)).toEqual(['cell-id-mismatch']);

    const elsewhere = validateRepo({
      root: repo.root,
      changed: ['results/vllm/qwen3-8b/nvidia-rtx-4090/other.json'],
    });
    expect(elsewhere.issues).toEqual([]);
    expect(elsewhere.ok).toBe(true);
  });

  it('fails on warnings under --strict', () => {
    const result = makeResult(repo);
    result.provenance.github_user_id = 12345;
    repo.writeResult(result);
    expect(validateRepo({ root: repo.root }).ok).toBe(true);
    expect(validateRepo({ root: repo.root, strict: true }).ok).toBe(false);
  });
});
