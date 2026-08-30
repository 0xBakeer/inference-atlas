/**
 * `build` — the compiled data the app reads (SPEC §6).
 *
 * Three things are worth testing here and the rest follows from them: that every file the
 * spec names is produced with the fields the app expects, that provenance stamping really
 * comes out of git history (with a `(#42)` in the commit subject), and that a rebuild is
 * byte-identical, because a build that reshuffles keys turns every deploy into a diff of
 * the whole data directory.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cellId, engineMinor } from '@atlas/core';
import type { CoverageCell, Gap } from '@atlas/core';
import { buildData, resolveContributorIds } from '../src/build.js';
import type { CompiledContributor } from '../src/build.js';
import type { BuiltIndexRow } from '../src/lib/index-row.js';
import { makeFixtureRepo, makeResult } from './helpers/fixture-repo.js';
import type { FixtureRepo } from './helpers/fixture-repo.js';

let repo: FixtureRepo;
let out: string;

function read<T>(relative: string): T {
  return JSON.parse(readFileSync(join(out, relative), 'utf8')) as T;
}

function build(options: { noGit?: boolean } = {}) {
  return buildData({ root: repo.root, out, noGit: options.noGit ?? true });
}

beforeEach(() => {
  repo = makeFixtureRepo();
  out = join(repo.root, 'app/public/data');
  repo.writeResult(makeResult(repo, { login: 'alice', decodeTokS: 110, outputTokS: 110 }));
  repo.writeResult(
    makeResult(repo, {
      login: 'bob',
      startedAt: '2026-08-01T12:00:00Z',
      decodeTokS: 105,
      outputTokS: 105,
    }),
  );
});

afterEach(() => {
  repo.dispose();
});

describe('output shape', () => {
  it('writes every file SPEC §6 names', () => {
    const outcome = build();
    expect(outcome.ok).toBe(true);
    for (const file of [
      'manifest.json',
      'registry.json',
      'index.json',
      'coverage.json',
      'contributors.json',
      'gaps.json',
      'stats.json',
      'workloads.json',
      'datasets.json',
      'engines/vllm/0.27.1.json',
    ]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    const rows = read<BuiltIndexRow[]>('index.json');
    expect(
      existsSync(join(out, `runs/vllm/Qwen/Qwen3-8B/nvidia-rtx-4090/${rows[0]!.run_id}.json`)),
    ).toBe(true);
  });

  it('gives every index row the fields the app reads', () => {
    build();
    const rows = read<BuiltIndexRow[]>('index.json');
    expect(rows).toHaveLength(2);
    const row = rows[0]!;
    expect(Object.keys(row).sort()).toEqual([
      'cell_id',
      'config_id',
      'engine',
      'gotchas',
      'hardware',
      'kind',
      'metrics',
      'metrics_source',
      'model',
      'path',
      'provenance',
      'run_id',
      'sweep_points',
      'verification_level',
      'workload_id',
    ]);
    expect(Object.keys(row.metrics).sort()).toEqual([
      'accuracy',
      'decode_tok_s_per_request',
      'output_tok_s',
      'power_avg_w',
      'success_rate',
      'tpot_p50',
      'ttft_p50',
      'ttft_p95',
      'vram_peak_gb',
    ]);
    expect(Object.keys(row.provenance).sort()).toEqual([
      'commit',
      'login',
      'pr',
      'started_at',
      'submitted_at',
      'user_id',
    ]);
    expect(row.engine.minor).toBe('0.27');
    expect(row.metrics.decode_tok_s_per_request).toBeGreaterThan(0);
    expect(row.metrics_source).toBe('metrics');
    expect(row.path.startsWith('results/')).toBe(true);
  });

  it('writes index.json without whitespace and manifest.json readably', () => {
    build();
    expect(readFileSync(join(out, 'index.json'), 'utf8')).not.toContain('\n  ');
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toContain('\n  ');
  });

  it('hashes every top-level shard in the manifest', () => {
    build();
    const manifest = read<{
      git: boolean;
      shards: Record<string, { sha256: string; bytes: number }>;
    }>('manifest.json');
    expect(manifest.git).toBe(false);
    expect(Object.keys(manifest.shards).sort()).toEqual([
      'contributors.json',
      'coverage.json',
      'datasets.json',
      'gaps.json',
      'index.json',
      'registry.json',
      'stats.json',
      'workloads.json',
    ]);
    const index = readFileSync(join(out, 'index.json'), 'utf8');
    expect(manifest.shards['index.json']!.bytes).toBe(Buffer.byteLength(index, 'utf8'));
  });

  it('merges the engine overlay into the compiled version file', () => {
    build();
    const version = read<{
      params: Array<{ name: string; group?: string | null; impact?: string | null }>;
      groups: string[];
    }>('engines/vllm/0.27.1.json');
    const tp = version.params.find((p) => p.name === 'tensor-parallel-size');
    expect(tp?.group).toBe('parallelism');
    expect(tp?.impact).toBe('high');
    expect(version.groups).toContain('parallelism');
  });

  it('reports coverage as one cell with two runs by two logins', () => {
    build();
    const coverage = read<{ cells: Record<string, CoverageCell> }>('coverage.json');
    const cells = Object.values(coverage.cells);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.runs).toBe(2);
    expect(cells[0]!.logins).toEqual(['alice', 'bob']);
    expect(cells[0]!.level).toBe('reproduced');
    expect(cells[0]!.best).not.toBeNull();
  });

  it('scores contributors with an avatar and the engines they used', () => {
    build();
    const contributors = read<CompiledContributor[]>('contributors.json');
    expect(contributors.map((c) => c.login).sort()).toEqual(['alice', 'bob']);
    const alice = contributors.find((c) => c.login === 'alice')!;
    expect(alice.points).toBeGreaterThan(0);
    expect(alice.engine_ids).toEqual(['vllm']);
    expect(alice.hardware_ids).toEqual(['nvidia-rtx-4090']);
    expect(alice.evals).toBe(0);
    // No numeric id resolved yet, so the avatar falls back to the login form.
    expect(alice.avatar_url).toBe('https://github.com/alice.png?size=64');
  });

  it('uses the numeric id for the avatar once CI has resolved it', () => {
    const stamped = makeResult(repo, { login: 'carol', startedAt: '2026-08-04T10:00:00Z' });
    stamped.provenance.github_user_id = 4242;
    repo.writeResult(stamped);
    build();
    const carol = read<CompiledContributor[]>('contributors.json').find(
      (c) => c.login === 'carol',
    )!;
    expect(carol.avatar_url).toBe('https://avatars.githubusercontent.com/u/4242?s=64');
  });

  it('counts the landing-page statistics', () => {
    build();
    const stats = read<Record<string, unknown>>('stats.json');
    expect(stats.runs).toBe(2);
    expect(stats.cells_covered).toBe(1);
    expect(stats.contributors).toBe(2);
    expect(stats.cells_possible).toBeGreaterThan(1);
    expect(stats.coverage_pct).toBeGreaterThan(0);
    expect(stats.last_updated).toBe('2026-08-02T10:00:00Z');
    expect((stats.levels as Record<string, number>).reproduced).toBe(1);
  });

  it('counts a measured multi-device cell in the denominator as well as the numerator', () => {
    const base = build();
    expect(base.ok).toBe(true);
    const before = read<Record<string, number>>('stats.json');

    // The cross product enumerates hw_count 1 only, so a tensor-parallel run lands in a cell
    // it cannot reach. It still has to be possible: it has been measured.
    const tp = makeResult(repo, { login: 'alice', startedAt: '2026-08-05T10:00:00Z' });
    tp.hardware.count = 2;
    tp.cell_id = cellId({
      model_id: tp.model.id,
      quant_id: tp.model.quant_id,
      hardware_id: tp.hardware.id,
      hw_count: 2,
      engine_id: tp.engine.id,
      engine_minor: engineMinor(tp.engine.version),
    });
    repo.writeResult(tp);
    build();

    const after = read<Record<string, number>>('stats.json');
    expect(after.cells_covered).toBe(before.cells_covered! + 1);
    expect(after.cells_possible).toBe(before.cells_possible! + 1);
  });

  it('reports dataset metadata and counts without compiling the rows', () => {
    build();
    const datasets = read<{
      datasets: Array<{ id: string; rows: number; used_by_workloads: string[] }>;
    }>('datasets.json');
    const prompts = datasets.datasets.find((d) => d.id === 'prompts-mixed-v1')!;
    expect(prompts.rows).toBe(2);
    expect(prompts.used_by_workloads).toContain('serve-single-i256-o256-v1');
    expect(JSON.stringify(datasets)).not.toContain('add 2 and 2');
  });
});

describe('gaps', () => {
  it('ranks unmeasured cells, sorted and deterministic', () => {
    build();
    const gaps = read<{ gaps: Gap[]; wanted_workload_ids: string[]; considered: number }>(
      'gaps.json',
    );
    expect(gaps.gaps.length).toBeGreaterThan(0);
    expect(gaps.considered).toBeGreaterThan(gaps.gaps.length);
    expect(gaps.wanted_workload_ids).toEqual(['serve-single-i256-o256-v1']);

    const scores = gaps.gaps.map((g) => g.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const gap of gaps.gaps) {
      expect(gap.reasons.length).toBeGreaterThan(0);
      expect(gap.workload_ids).toEqual(['serve-single-i256-o256-v1']);
    }
  });

  it('never offers a cell that is already measured, or an engine the device cannot run', () => {
    build();
    const rows = read<BuiltIndexRow[]>('index.json');
    const gaps = read<{ gaps: Gap[] }>('gaps.json');
    const measured = new Set(rows.map((r) => r.cell_id));
    expect(gaps.gaps.some((g) => measured.has(g.cell_id))).toBe(false);
    // mlx-lm is macOS-only; it must never be proposed on an NVIDIA device.
    expect(
      gaps.gaps.some((g) => g.engine_id === 'mlx-lm' && g.hardware_id.startsWith('nvidia-')),
    ).toBe(false);
    expect(
      gaps.gaps.some((g) => g.engine_id === 'mlx-lm' && g.hardware_id.startsWith('apple-')),
    ).toBe(true);
  });

  it('lists the workloads a measured cell is still missing', () => {
    build();
    const gaps = read<{
      missing_workloads: Array<{ cell_id: string; have: string[]; missing: string[] }>;
    }>('gaps.json');
    // The one measured cell carries the only wanted workload, so nothing is missing there.
    expect(gaps.missing_workloads).toEqual([]);
  });

  it('boosts a cell that somebody asked for in an issue', () => {
    const before = (() => {
      build();
      return read<{ gaps: Gap[] }>('gaps.json').gaps;
    })();
    const target = before[before.length - 1]!;
    repo.write('site/wanted-requests.json', {
      requests: [
        {
          engine_id: target.engine_id,
          model_id: target.model_id,
          quant_id: target.quant_id,
          hardware_id: target.hardware_id,
          issue: 17,
          reactions: 6,
        },
      ],
    });
    build();
    const after = read<{ gaps: Gap[] }>('gaps.json').gaps.find(
      (g) => g.cell_id === target.cell_id,
    )!;
    expect(after.score).toBeGreaterThan(target.score);
    expect(after.reasons.join(' ')).toContain('issue #17');
  });
});

describe('a repository with no results', () => {
  /**
   * The state the project starts in and returns to whenever a registry grows faster than
   * anybody measures it: every square grey. The build must still produce every file, with
   * empty collections rather than absent ones, because the app fetches them unconditionally
   * — and the gap queue must be *fuller* here than anywhere, not empty.
   */
  it('compiles an empty atlas whose gaps are still the whole registry', () => {
    const bare = makeFixtureRepo();
    const bareOut = join(bare.root, 'app/public/data');
    const readBare = <T>(relative: string): T =>
      JSON.parse(readFileSync(join(bareOut, relative), 'utf8')) as T;
    try {
      const outcome = buildData({ root: bare.root, out: bareOut, noGit: true });
      expect(outcome.ok).toBe(true);
      expect(outcome.counts.runs).toBe(0);

      expect(readBare<BuiltIndexRow[]>('index.json')).toEqual([]);
      expect(readBare<{ cells: Record<string, CoverageCell> }>('coverage.json').cells).toEqual({});
      expect(readBare<CompiledContributor[]>('contributors.json')).toEqual([]);

      const stats = readBare<Record<string, unknown>>('stats.json');
      expect(stats.runs).toBe(0);
      expect(stats.cells_covered).toBe(0);
      expect(stats.contributors).toBe(0);
      expect(stats.coverage_pct).toBe(0);
      expect(stats.cells_possible).toBeGreaterThan(0);
      expect(stats.first_run).toBeNull();
      expect(stats.last_updated).toBeNull();
      expect(stats.levels).toEqual({ none: 0, single: 0, reproduced: 0, disputed: 0, stale: 0 });
      expect(stats.models).toBeGreaterThan(0);

      // Nothing measured means nothing to copy, and every possible cell is a gap.
      expect(existsSync(join(bareOut, 'runs'))).toBe(false);
      const gaps = readBare<{ gaps: Gap[]; considered: number }>('gaps.json');
      expect(gaps.gaps.length).toBeGreaterThan(0);
      expect(gaps.considered).toBeGreaterThanOrEqual(gaps.gaps.length);
      expect(gaps.gaps.every((g) => g.level === 'none')).toBe(true);
    } finally {
      bare.dispose();
    }
  });
});

describe('determinism and provenance', () => {
  it('produces byte-identical output on a rebuild, apart from built_at', () => {
    build();
    const first = readFileSync(join(out, 'index.json'), 'utf8');
    const firstGaps = readFileSync(join(out, 'gaps.json'), 'utf8');
    build();
    expect(readFileSync(join(out, 'index.json'), 'utf8')).toBe(first);
    expect(stripBuiltAt(readFileSync(join(out, 'gaps.json'), 'utf8'))).toBe(
      stripBuiltAt(firstGaps),
    );
  });

  it('stamps the commit and pull request number from git history', () => {
    repo.initGit('seed: registries');
    const carol = makeResult(repo, { login: 'carol', startedAt: '2026-08-05T10:00:00Z' });
    const path = repo.writeResult(carol);
    repo.commit('results: carol on a 4090 (#42)');
    const head = repo.git('rev-parse', 'HEAD').trim();

    const outcome = buildData({ root: repo.root, out });
    expect(outcome.ok).toBe(true);

    const compiled = read<{ provenance: Record<string, unknown> }>(
      `runs/${path.replace(/^results\//, '')}`,
    );
    expect(compiled.provenance.commit).toBe(head);
    expect(compiled.provenance.commit_short).toBe(head.slice(0, 7));
    expect(compiled.provenance.pr).toBe(42);
    expect(typeof compiled.provenance.merged_at).toBe('string');

    // The raw file is never rewritten: the stamp exists only in the compiled copy.
    const raw = repo.read<{ provenance: Record<string, unknown> }>(path);
    expect(raw.provenance.commit).toBeNull();
    expect(raw.provenance.pr).toBeNull();

    const row = read<BuiltIndexRow[]>('index.json').find((r) => r.run_id === carol.run_id)!;
    expect(row.provenance.commit).toBe(head);
    expect(row.provenance.pr).toBe(42);
    expect(read<{ git: boolean }>('manifest.json').git).toBe(true);
  });

  it('understands a merge-commit subject as well as a squash subject', () => {
    repo.initGit('seed: registries');
    const dave = makeResult(repo, { login: 'dave', startedAt: '2026-08-06T10:00:00Z' });
    const path = repo.writeResult(dave);
    repo.commit('Merge pull request #7 from dave/result-branch');

    buildData({ root: repo.root, out });
    const compiled = read<{ provenance: { pr: number | null } }>(
      `runs/${path.replace(/^results\//, '')}`,
    );
    expect(compiled.provenance.pr).toBe(7);
  });

  it('leaves the stamps null outside a git repository', () => {
    build({ noGit: true });
    const rows = read<BuiltIndexRow[]>('index.json');
    expect(rows.every((r) => r.provenance.commit === null)).toBe(true);
    expect(read<{ git: boolean }>('manifest.json').git).toBe(false);
  });
});

describe('refusing bad data', () => {
  it('does not compile a repository that fails validation', () => {
    const broken = makeResult(repo, {
      login: 'eve',
      startedAt: '2026-08-07T10:00:00Z',
    }) as unknown as Record<string, unknown>;
    delete broken.verification;
    repo.write('results/vllm/Qwen/Qwen3-8B/nvidia-rtx-4090/broken.json', broken);
    const outcome = build();
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join('\n')).toContain('schema');
    expect(outcome.files).toEqual([]);
  });
});

function stripBuiltAt(text: string): string {
  return text.replace(/"built_at":"[^"]+"/g, '"built_at":"X"');
}

describe('contributor ids for contributions merged from forks', () => {
  // stamp-user-ids cannot push to a fork's branch, so those results keep a null
  // github_user_id and no one may stamp them afterwards without breaking the ownership
  // rule. The build fills the id in for the contributors page instead.
  const contributorsFile = () => join(out, 'contributors.json');
  const write = (rows: unknown) =>
    writeFileSync(contributorsFile(), `${JSON.stringify(rows, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(contributorsFile(), 'utf8')) as CompiledContributor[];

  beforeEach(() => build());

  it('fills the id and switches the avatar to the permanent url', async () => {
    write([
      { login: 'forker', user_id: null, avatar_url: 'https://github.com/forker.png?size=64' },
      {
        login: 'stamped',
        user_id: 7,
        avatar_url: 'https://avatars.githubusercontent.com/u/7?s=64',
      },
    ]);
    const asked: string[] = [];
    await resolveContributorIds(out, () => {}, {
      fetchImpl: async (url: string) => {
        asked.push(url);
        return { ok: true, status: 200, json: async () => ({ id: 1065484 }) };
      },
    });

    const [forker, stamped] = read();
    expect(forker?.user_id).toBe(1065484);
    expect(forker?.avatar_url).toBe('https://avatars.githubusercontent.com/u/1065484?s=64');
    // The contributor who already had an id is not asked about again.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('forker');
    expect(stamped?.user_id).toBe(7);
  });

  it('leaves the file untouched when the login cannot be resolved', async () => {
    write([{ login: 'ghost', user_id: null, avatar_url: 'https://github.com/ghost.png?size=64' }]);
    const before = readFileSync(contributorsFile(), 'utf8');
    await resolveContributorIds(out, () => {}, {
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    // A deleted account, a rate limit or a network blip must never fail a build or
    // rewrite the file: the login-derived avatar still works.
    expect(readFileSync(contributorsFile(), 'utf8')).toBe(before);
    expect(read()[0]?.user_id ?? null).toBe(null);
  });

  it('does nothing when every contributor already has an id', async () => {
    write([
      {
        login: 'someone',
        user_id: 42,
        avatar_url: 'https://avatars.githubusercontent.com/u/42?s=64',
      },
    ]);
    const before = readFileSync(contributorsFile(), 'utf8');
    await resolveContributorIds(out);
    expect(readFileSync(contributorsFile(), 'utf8')).toBe(before);
  });

  it('shrugs when the file is missing rather than throwing', async () => {
    await expect(resolveContributorIds(join(out, 'no-such-dir'))).resolves.toBeUndefined();
  });
});
