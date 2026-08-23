/**
 * A throwaway repository in a temp directory, for the tests that need one.
 *
 * The registry files are *copied from the real repository* rather than invented: a fixture
 * that drifts from the schemas would pass while the thing it stands for fails. What the
 * tests then do is mutate one field of one result and assert on the code that fires, which
 * only means something if the starting point is a repository that really validates.
 *
 * `initGit` turns the fixture into a git repository with a base branch, which is what the
 * ownership tests need: `git diff <base>...HEAD` and `git show <base>:<path>` are the whole
 * mechanism and mocking them would test nothing.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeArgs, cellId, engineMinor, resultPath, runId } from '@atlas/core';
import type { Args, ResultRecord, SiteConfig } from '@atlas/core';

export const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Registry entries the fixture repository is built from — real files, small selection. */
const COPY = [
  'schemas',
  'hardware/nvidia-rtx-4090.json',
  'hardware/nvidia-gb10-dgx-spark.json',
  'hardware/apple-m2-max-32gb.json',
  // The whole engine registry: a quantization names the engines that can load it, and a
  // subset would fail that reference for engines the fixture simply did not copy.
  'engines',
  'models/qwen3-8b/model.json',
  'models/qwen3-8b/quants/fp8.json',
  'models/qwen3-8b/quants/bf16.json',
  'models/qwen3-8b/quants/mlx-4bit.json',
  'workloads/serve-single-i256-o256-v1.json',
  'workloads/eval-math-v1.json',
];

/**
 * Datasets are stubbed rather than copied: `prompts-mixed-v1` is four megabytes and every
 * test builds its own repository. Two rows are enough to exercise the row-shape check, and
 * the record is the same shape the real one has.
 */
const STUB_DATASETS: Array<{
  id: string;
  kind: 'prompts' | 'eval';
  file: string;
  rows: Array<Record<string, unknown>>;
}> = [
  {
    id: 'prompts-mixed-v1',
    kind: 'prompts',
    file: 'prompts.jsonl',
    rows: [
      {
        id: 'mix-0001',
        topic: 'code',
        bucket: 's',
        approx_tokens: 20,
        messages: [{ role: 'user', content: 'hello' }],
      },
      {
        id: 'mix-0002',
        topic: 'math',
        bucket: 's',
        approx_tokens: 22,
        messages: [{ role: 'user', content: 'add 2 and 2' }],
      },
    ],
  },
  {
    id: 'eval-math-v1',
    kind: 'eval',
    file: 'items.jsonl',
    rows: [
      {
        id: 'math-0001',
        category: 'arithmetic',
        difficulty: 'easy',
        prompt: '2+2?',
        answer: '4',
        scorer: 'numeric',
      },
      {
        id: 'math-0002',
        category: 'algebra',
        difficulty: 'easy',
        prompt: 'x+1=3, x?',
        answer: '2',
        scorer: 'numeric',
      },
    ],
  },
];

export interface FixtureOptions {
  /** Extra repository-relative paths to copy from the real repository. */
  copy?: string[];
  /** Leave `workloads/` empty, to exercise the mid-landing tolerance. */
  withoutWorkloads?: boolean;
}

export class FixtureRepo {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  path(relative: string): string {
    return join(this.root, relative);
  }

  read<T>(relative: string): T {
    return JSON.parse(readFileSync(this.path(relative), 'utf8')) as T;
  }

  write(relative: string, data: unknown): string {
    const full = this.path(relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`,
      'utf8',
    );
    return relative;
  }

  remove(relative: string): void {
    rmSync(this.path(relative), { force: true, recursive: true });
  }

  /** Write a result at its canonical path and return that path. */
  writeResult(result: ResultRecord): string {
    const path = resultPath(result.engine.id, result.model.id, result.hardware.id, result.run_id);
    this.write(path, result);
    return path;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, encoding: 'utf8' });
  }

  /** A git repository with one commit on `main`, ready for a branch to be cut off it. */
  initGit(message = 'seed: registries and one result'): void {
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 'seed@users.noreply.github.com');
    this.git('config', 'user.name', 'seed');
    this.git('config', 'commit.gpgsign', 'false');
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
  }

  commit(message: string, author = 'octocat <1+octocat@users.noreply.github.com>'): void {
    this.git('add', '-A');
    this.git('commit', '-q', '--author', author, '-m', message);
  }

  dispose(): void {
    rmSync(this.root, { force: true, recursive: true });
  }
}

export function makeFixtureRepo(options: FixtureOptions = {}): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), 'atlas-fixture-'));
  const repo = new FixtureRepo(root);

  for (const relative of [...COPY, ...(options.copy ?? [])]) {
    if (options.withoutWorkloads && relative.startsWith('workloads/')) continue;
    const from = join(SOURCE_ROOT, relative);
    const to = join(root, relative);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  if (options.withoutWorkloads) mkdirSync(join(root, 'workloads'), { recursive: true });

  // The real site config features ids this fixture does not carry; keep everything else so
  // that thresholds, weights and scoring behave exactly as they do in production.
  const site = JSON.parse(
    readFileSync(join(SOURCE_ROOT, 'site/config.json'), 'utf8'),
  ) as SiteConfig;
  site.featured = {
    hardware: ['nvidia-rtx-4090'],
    models: ['qwen3-8b'],
    engines: ['vllm'],
    workloads: options.withoutWorkloads ? [] : ['serve-single-i256-o256-v1'],
  };
  // The fixture pins its own wanted-queue definition so production edits to
  // `site.wanted.workloads` do not change what these tests consider a gap.
  site.wanted = { ...site.wanted, workloads: site.featured.workloads };
  repo.write('site/config.json', site);

  for (const stub of STUB_DATASETS) {
    repo.write(`datasets/${stub.id}/dataset.json`, {
      schema_version: 1,
      id: stub.id,
      name: `${stub.id} (fixture stub)`,
      kind: stub.kind,
      licence: 'MIT',
      files: [stub.file],
      count: stub.rows.length,
    });
    repo.write(
      `datasets/${stub.id}/${stub.file}`,
      `${stub.rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
  }

  return repo;
}

/* --------------------------------------------------------------------- results */

export interface ResultOptions {
  login?: string;
  startedAt?: string;
  submittedAt?: string;
  engineId?: string;
  version?: string;
  modelId?: string;
  quantId?: string;
  hardwareId?: string;
  workloadId?: string;
  kind?: ResultRecord['kind'];
  args?: Args;
  /** Single-stream decode rate — the metric the atlas ranks these fixtures on. */
  decodeTokS?: number;
  outputTokS?: number | null;
}

/**
 * A valid result with every computed field computed, not typed.
 *
 * The tests mutate what they are testing *after* calling this, which is the only way an
 * assertion like "a wrong cell_id is caught" can mean anything.
 */
export function makeResult(repo: FixtureRepo, options: ResultOptions = {}): ResultRecord {
  const engineId = options.engineId ?? 'vllm';
  const version = options.version ?? '0.27.1';
  const modelId = options.modelId ?? 'qwen3-8b';
  const quantId = options.quantId ?? 'fp8';
  const hardwareId = options.hardwareId ?? 'nvidia-rtx-4090';
  const workloadId = options.workloadId ?? 'serve-single-i256-o256-v1';
  const login = options.login ?? 'octocat';
  const startedAt = options.startedAt ?? '2026-08-01T10:00:00Z';
  const args: Args = options.args ?? { 'max-model-len': 32768 };

  const versionFile = JSON.parse(
    readFileSync(repo.path(`engines/${engineId}/versions/${version}.json`), 'utf8'),
  ) as { params: Array<{ name: string; default: unknown }> };
  const meta = JSON.parse(readFileSync(repo.path(`engines/${engineId}/meta.json`), 'utf8')) as {
    drop_params?: string[];
    param_aliases?: Record<string, string>;
  };
  const quant = JSON.parse(
    readFileSync(repo.path(`models/${modelId}/quants/${quantId}.json`), 'utf8'),
  ) as { hf_id?: string | null };

  const { canonical, configId } = canonicalizeArgs({
    engine_id: engineId,
    engine_version: version,
    args,
    quant_id: quantId,
    dtype: null,
    params: versionFile.params as never,
    drop_params: meta.drop_params ?? [],
    param_aliases: meta.param_aliases ?? null,
  });

  const id = runId(configId, workloadId, login, startedAt);

  return {
    schema_version: 1,
    run_id: id,
    config_id: configId,
    cell_id: cellId({
      model_id: modelId,
      quant_id: quantId,
      hardware_id: hardwareId,
      hw_count: 1,
      engine_id: engineId,
      engine_minor: engineMinor(version),
    }),
    workload_id: workloadId,
    kind: options.kind ?? 'serving',
    engine: { id: engineId, version, commit: null, container: null, install_method: 'docker' },
    model: {
      id: modelId,
      quant_id: quantId,
      hf_id: quant.hf_id ?? null,
      revision: null,
      dtype: null,
    },
    hardware: {
      id: hardwareId,
      count: 1,
      driver: null,
      cuda: null,
      fingerprint: null,
      captured: null,
    },
    args,
    args_canonical: canonical,
    serve_command: null,
    workload: { id: workloadId, resolved_params: { concurrency: 1 } },
    metrics: {
      requests_total: 50,
      requests_ok: 50,
      requests_failed: 0,
      success_rate: 1,
      duration_s: 100,
      output_tok_s: options.outputTokS === undefined ? 120 : options.outputTokS,
      decode_tok_s_per_request: { mean: options.decodeTokS ?? 120 },
      ttft_ms: { mean: 40, p50: 38, p95: 60 },
      vram_peak_gb: 18,
    },
    failures: [],
    gotchas: [{ severity: 'info', text: 'Fixture result.', link: null }],
    provenance: {
      github_login: login,
      github_user_id: null,
      started_at: startedAt,
      finished_at: null,
      submitted_at: options.submittedAt ?? '2026-08-02T10:00:00Z',
      commit: null,
      pr: null,
      method: 'atlas-bench',
      agent: null,
      notes: 'Idle box.',
    },
    verification: { level: 'self-reported', reproduced_by: [], flags: [] },
  };
}
