#!/usr/bin/env tsx
/**
 * `pnpm build:data` — compile the repository into what the app fetches (SPEC §6).
 *
 *   pnpm build:data                       # → app/public/data
 *   pnpm build:data --out /tmp/data       # anywhere else
 *   pnpm build:data --no-git              # skip history; provenance stamps stay null
 *
 * Three things happen here that happen nowhere else:
 *
 * 1. **Provenance stamping.** `provenance.commit` and `provenance.pr` are derived from
 *    `git log --diff-filter=A` — the commit that *added* the file — and written only into
 *    the compiled copy, and a `submitted_at` the contributor left null is filled from the
 *    same commit: the file arriving on main is the submission. The raw file in `results/` is never rewritten, so what a
 *    contributor committed stays exactly what they committed and the stamp cannot be typed
 *    by hand (SPEC §5, last paragraph).
 * 2. **Overlay merging.** `engines/<id>/overlay.json` carries the hand-curated grouping and
 *    impact of each flag; the compiled `engines/<id>/<version>.json` has it folded in, so
 *    the config explorer needs one fetch instead of two.
 * 3. **Ranking the gaps.** The registry cross product minus what has been measured, scored
 *    by `site.wanted.weights` — the queue the whole contribution loop feeds on.
 *
 * The output is deterministic: keys sorted, arrays sorted by an explicit key, timestamps
 * only where they mean something. A rebuild with no data change produces byte-identical
 * files apart from `built_at`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCoverage, computeScores } from '@atlas/core';
import type {
  Contributor,
  CoverageCell,
  Dataset,
  EngineParam,
  EngineVersion,
  Provenance,
  RegistryCredits,
  ResultRecord,
  Workload,
} from '@atlas/core';
import { parseArgv } from './lib/args.js';
import { resolveUsers } from './resolve-user.js';
import type { ResolveOptions } from './resolve-user.js';
import { checkDataset } from './lib/datasets.js';
import type { DatasetStats } from './lib/datasets.js';
import { addCommits, headCommit, isGitRepo, parsePr } from './lib/git.js';
import { indexIdentities, resolveLogin } from './lib/identities.js';
import type { GitCommit } from './lib/git.js';
import { computeGaps, possibleCells } from './lib/gaps.js';
import type { WantedRequest } from './lib/gaps.js';
import { buildIndexRow } from './lib/index-row.js';
import type { BuiltIndexRow } from './lib/index-row.js';
import { loadRepo } from './lib/repo.js';
import type { EngineEntry, Repo } from './lib/repo.js';
import { Reporter } from './lib/report.js';
import { REPO_ROOT } from './lib/root.js';
import { writeJsonFile } from './lib/write.js';
import type { WrittenFile } from './lib/write.js';

const DEFAULT_OUT = 'app/public/data';

/**
 * Provenance as it appears in the compiled data: the git-derived fields added, and
 * `submitted_at` filled from the adding commit when the contributor left it null, so every
 * sort on submission order (timeline, latest results, scoring) has a date to work with.
 */
export interface StampedProvenance extends Provenance {
  commit_short: string | null;
  /** Author date of the commit that added the file — when the measurement became public. */
  merged_at: string | null;
}

/** A contributor row plus what the leaderboard shows and `@atlas/core` does not carry. */
export interface CompiledContributor extends Contributor {
  engine_ids: string[];
  /** Eval runs, pulled out of `breakdown` because the contributors page ranks on it. */
  evals: number;
  avatar_url: string;
}

export interface BuildOptions {
  root: string;
  out: string;
  /** Skip git entirely: no provenance stamps, no registry credits, `manifest.git: false`. */
  noGit?: boolean;
  /** Compile even when validation found errors (used by nothing but a debugging session). */
  force?: boolean;
}

export interface BuildOutcome {
  ok: boolean;
  out: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  counts: Record<string, number>;
  /** Validation errors that stopped the build, if any. */
  errors: string[];
}

/* --------------------------------------------------------------------- helpers */

function avatarUrl(login: string, userId: number | null): string {
  return userId != null
    ? `https://avatars.githubusercontent.com/u/${userId}?s=64`
    : `https://github.com/${login}.png?size=64`;
}

/** `engines/<id>/<version>.json`: the version's params with the overlay folded in. */
export function mergeOverlay(
  entry: EngineEntry,
  version: EngineVersion,
): EngineVersion & {
  groups: string[];
} {
  const overlay = entry.overlay;
  const params: EngineParam[] = version.params.map((param) => {
    const extra = overlay?.params?.[param.name];
    if (!extra) return { ...param };
    return {
      ...param,
      group: extra.group ?? param.group ?? null,
      impact: extra.impact ?? param.impact ?? null,
      ...(extra.notes ? { help: param.help ?? extra.notes } : {}),
      ...(extra.featured === true ? { featured: true } : {}),
    } as EngineParam;
  });
  params.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ...version, params, groups: overlay?.groups ?? [] };
}

function readWantedRequests(root: string): WantedRequest[] {
  const path = join(root, 'site/wanted-requests.json');
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as
      WantedRequest[] | { requests?: WantedRequest[] };
    return Array.isArray(data) ? data : (data.requests ?? []);
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------------- build */

export function buildData(options: BuildOptions): BuildOutcome {
  const root = options.root;
  const out = options.out;
  const reporter = new Reporter();
  const repo = loadRepo(root, reporter);

  const errors = reporter.errors.map((e) => `${e.file}: ${e.code}: ${e.message}`);
  if (errors.length > 0 && options.force !== true) {
    return { ok: false, out, files: [], counts: {}, errors };
  }

  const useGit = options.noGit !== true && isGitRepo(root);
  const head = useGit ? headCommit(root) : null;

  /* ------------------------------------------------------- provenance stamps */

  const resultPaths = repo.results.map((r) => r.path);
  const stamps: Map<string, GitCommit> = useGit ? addCommits(root, resultPaths) : new Map();

  const stampProvenance = (result: ResultRecord, path: string): StampedProvenance => {
    const commit = stamps.get(path) ?? null;
    // Author dates come with whatever offset the author's clock had; the app sorts these as
    // strings, so they are normalised to UTC like every other timestamp in a result.
    const merged = commit ? utcIso(commit.date) : null;
    return {
      ...result.provenance,
      commit: commit?.commit ?? null,
      commit_short: commit?.commit_short ?? null,
      pr: commit ? parsePr(commit.subject) : null,
      merged_at: merged,
      submitted_at: result.provenance.submitted_at ?? merged,
    };
  };

  /* ----------------------------------------------------------------- index */

  const rows: BuiltIndexRow[] = [];
  const runFiles: Array<{ relative: string; data: ResultRecord }> = [];
  for (const { path, data } of repo.results) {
    const provenance = stampProvenance(data, path);
    const stamped: ResultRecord = { ...data, provenance: provenance as Provenance };
    const row = buildIndexRow(stamped, path);
    rows.push(row);
    runFiles.push({
      relative: `runs/${path.replace(/^results\//, '')}`,
      data: stamped,
    });
  }
  rows.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));

  /* -------------------------------------------------------------- coverage */

  const engineVersions: Record<string, string[]> = {};
  for (const [id, entry] of repo.engines) {
    engineVersions[id] = [...(entry.meta.versions_available ?? [])].sort();
  }
  const cells = computeCoverage(rows, { engineVersions }, { site: repo.site });

  /* ------------------------------------------------------------- gaps queue */

  const gaps = computeGaps({ repo, cells, requests: readWantedRequests(root) });

  /* ---------------------------------------------------------- contributors */

  const credits = useGit ? registryCredits(root, repo) : {};
  const scoring = computeScores({
    rows,
    site: repo.site,
    registryCredits: credits,
    wantedCellIds: gaps.gaps.map((g) => g.cell_id),
  });

  const engineIdsByLogin = new Map<string, Set<string>>();
  const evalsByLogin = new Map<string, number>();
  for (const row of rows) {
    const login = row.provenance.login;
    const set = engineIdsByLogin.get(login) ?? new Set<string>();
    set.add(row.engine.id);
    engineIdsByLogin.set(login, set);
    if (row.kind === 'eval') evalsByLogin.set(login, (evalsByLogin.get(login) ?? 0) + 1);
  }

  const contributors: CompiledContributor[] = scoring.contributors.map((c) => ({
    ...c,
    engine_ids: [...(engineIdsByLogin.get(c.login) ?? [])].sort(),
    evals: evalsByLogin.get(c.login) ?? 0,
    avatar_url: avatarUrl(c.login, c.user_id),
  }));

  /* ------------------------------------------------------------------ write */

  rmSync(join(out, 'runs'), { recursive: true, force: true });
  rmSync(join(out, 'engines'), { recursive: true, force: true });

  const written: WrittenFile[] = [];
  const shards: Record<string, { sha256: string; bytes: number }> = {};
  const emit = (relative: string, data: unknown, pretty = true, shard = true): void => {
    const file = writeJsonFile(join(out, relative), data, { pretty });
    written.push(file);
    if (shard) shards[relative] = { sha256: file.sha256, bytes: file.bytes };
  };

  const builtAt = new Date().toISOString();

  /* registry.json */
  const datasetStats = new Map<string, DatasetStats>();
  const quiet = new Reporter();
  for (const dataset of repo.datasets.values()) {
    datasetStats.set(dataset.id, checkDataset(root, dataset, quiet));
  }

  emit('registry.json', {
    schema_version: 1,
    built_at: builtAt,
    hardware: [...repo.hardware.values()].sort(byId),
    engines: [...repo.engines.values()]
      .map((entry) => ({
        ...entry.meta,
        overlay: entry.overlay,
        versions: [...entry.versions.values()]
          .map((version) => ({
            version: version.version,
            released: version.released ?? null,
            extraction_method: version.extraction_method,
            param_count: version.params.length,
            path: `engines/${entry.meta.id}/${version.version}.json`,
          }))
          .sort((a, b) => (a.version < b.version ? -1 : 1)),
      }))
      .sort(byId),
    models: [...repo.models.values()]
      .map((entry) => ({ ...entry.model, quants: [...entry.quants.values()].sort(byId) }))
      .sort(byId),
    workloads: [...repo.workloads.values()].sort(byId),
    datasets: [...repo.datasets.values()]
      .sort(byId)
      .map((d) => datasetMeta(d, datasetStats.get(d.id))),
    site: repo.site,
  });

  /* index.json — compact: it is the biggest first-paint fetch. */
  emit('index.json', rows, false);

  /* coverage.json */
  emit('coverage.json', {
    schema_version: 1,
    built_at: builtAt,
    thresholds: repo.site?.coverage ?? null,
    cells,
  });

  /* contributors.json */
  emit('contributors.json', contributors);

  /* gaps.json */
  // Compact: the ranked queue with its reasons is the largest compiled file by far.
  emit(
    'gaps.json',
    {
      schema_version: 1,
      built_at: builtAt,
      wanted_workload_ids: gaps.wanted_workload_ids,
      max: gaps.max,
      considered: gaps.considered,
      gaps: gaps.gaps,
      missing_workloads: gaps.missing_workloads,
    },
    false,
  );

  /* workloads.json — the registry plus how much evidence each workload has. */
  const runsPerWorkload = new Map<string, number>();
  for (const row of rows) {
    runsPerWorkload.set(row.workload_id, (runsPerWorkload.get(row.workload_id) ?? 0) + 1);
  }
  emit('workloads.json', {
    schema_version: 1,
    built_at: builtAt,
    workloads: [...repo.workloads.values()]
      .map((workload: Workload) => ({
        ...workload,
        runs: runsPerWorkload.get(workload.id) ?? 0,
        dataset: datasetSummary(repo.datasets.get(workload.dataset_id ?? '')),
      }))
      .sort(byId),
  });

  /* datasets.json — metadata and counts only; the rows themselves are never compiled. */
  const workloadsPerDataset = new Map<string, string[]>();
  for (const workload of repo.workloads.values()) {
    if (!workload.dataset_id) continue;
    const list = workloadsPerDataset.get(workload.dataset_id) ?? [];
    list.push(workload.id);
    workloadsPerDataset.set(workload.dataset_id, list);
  }
  emit('datasets.json', {
    schema_version: 1,
    built_at: builtAt,
    datasets: [...repo.datasets.values()].sort(byId).map((dataset) => ({
      ...datasetMeta(dataset, datasetStats.get(dataset.id)),
      used_by_workloads: (workloadsPerDataset.get(dataset.id) ?? []).sort(),
    })),
  });

  /* engines/<id>/<version>.json */
  for (const entry of repo.engines.values()) {
    for (const version of entry.versions.values()) {
      emit(
        `engines/${entry.meta.id}/${version.version}.json`,
        mergeOverlay(entry, version),
        true,
        false,
      );
    }
  }

  /* runs/<engine>/<model>/<hardware>/<run_id>.json */
  for (const run of runFiles) emit(run.relative, run.data, true, false);

  /* stats.json — the landing page headline. */
  const levels: Record<CoverageCell['level'], number> = {
    none: 0,
    single: 0,
    reproduced: 0,
    disputed: 0,
    stale: 0,
  };
  for (const cell of Object.values(cells)) levels[cell.level] += 1;
  const byKind: Record<string, number> = {};
  for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;

  const cellsPossible = possibleCells(repo, cells);
  const cellsCovered = Object.keys(cells).length;
  const times = rows
    .map((r) => r.provenance.submitted_at ?? r.provenance.started_at)
    .filter((t): t is string => typeof t === 'string')
    .sort();

  const stats = {
    schema_version: 1,
    built_at: builtAt,
    commit: head?.commit ?? null,
    runs: rows.length,
    cells_covered: cellsCovered,
    cells_possible: cellsPossible,
    coverage_pct:
      cellsPossible === 0 ? 0 : Math.round((cellsCovered / cellsPossible) * 10000) / 100,
    contributors: contributors.length,
    engines: repo.engines.size,
    engine_versions: [...repo.engines.values()].reduce((n, e) => n + e.versions.size, 0),
    models: repo.models.size,
    quants: [...repo.models.values()].reduce((n, m) => n + m.quants.size, 0),
    hardware: repo.hardware.size,
    workloads: repo.workloads.size,
    datasets: repo.datasets.size,
    dataset_rows: [...datasetStats.values()].reduce((n, s) => n + (s.rows ?? 0), 0),
    evals_run: byKind.eval ?? 0,
    sweep_points: rows.reduce((n, r) => n + (r.sweep_points ?? 0), 0),
    gotchas: rows.reduce((n, r) => n + (r.gotchas ?? 0), 0),
    gaps: gaps.gaps.length,
    runs_by_kind: byKind,
    levels,
    first_run: times[0] ?? null,
    last_updated: times[times.length - 1] ?? null,
  };
  emit('stats.json', stats);

  /* manifest.json — written last: it hashes everything above it. */
  const manifest = {
    schema_version: 1,
    built_at: builtAt,
    git: useGit,
    commit: head?.commit ?? null,
    commit_short: head?.commit_short ?? null,
    base_path: repo.site?.site?.base_path ?? '/',
    counts: {
      runs: rows.length,
      cells: cellsCovered,
      contributors: contributors.length,
      hardware: repo.hardware.size,
      engines: repo.engines.size,
      models: repo.models.size,
      quants: stats.quants,
      workloads: repo.workloads.size,
      datasets: repo.datasets.size,
      gaps: gaps.gaps.length,
    },
    shards,
  };
  const manifestFile = writeJsonFile(join(out, 'manifest.json'), manifest);
  written.push(manifestFile);

  return {
    ok: true,
    out,
    files: written.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    counts: manifest.counts,
    errors: [],
  };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What a workload row shows about its dataset: enough to label it, never the rows. */
function datasetSummary(dataset: Dataset | undefined) {
  if (!dataset) return null;
  return { id: dataset.id, name: dataset.name, kind: dataset.kind, count: dataset.count };
}

/** The dataset fields the app shows — never the rows, which stay in the repository. */
function datasetMeta(dataset: Dataset, stats: DatasetStats | undefined) {
  return {
    id: dataset.id,
    name: dataset.name,
    kind: dataset.kind,
    description: dataset.description ?? null,
    licence: dataset.licence,
    files: dataset.files,
    count: dataset.count,
    rows: stats?.rows ?? dataset.count,
    bytes: stats?.bytes ?? null,
    topics: dataset.topics ?? [],
    categories: dataset.categories ?? [],
    schema: dataset.schema ?? null,
    created: dataset.created ?? null,
  };
}

/**
 * Who registered each piece of the registry, from the commit that added its file.
 *
 * `computeScores` credits new hardware, models, engines, quants and workloads, but a
 * registry file carries no `github_login` — the only identity in its history is the author
 * address of the commit that added it. GitHub's `…@users.noreply.github.com` form spells
 * the login; an ordinary address does not, and `site/identities.json` is where a person
 * says which addresses are theirs (`resolveLogin`). An address in neither is skipped
 * rather than guessed: crediting a plausible neighbour is worse than crediting nobody.
 */
function registryCredits(root: string, repo: Repo): RegistryCredits {
  const paths: Array<[keyof RegistryCredits, string, string]> = [];
  for (const id of repo.hardware.keys()) paths.push(['hardware', id, `hardware/${id}.json`]);
  for (const id of repo.engines.keys()) paths.push(['engines', id, `engines/${id}/meta.json`]);
  for (const [id, entry] of repo.models) {
    paths.push(['models', id, `models/${id}/model.json`]);
    for (const quantId of entry.quants.keys()) {
      paths.push(['quants', `${id}/${quantId}`, `models/${id}/quants/${quantId}.json`]);
    }
  }
  for (const id of repo.workloads.keys()) paths.push(['workloads', id, `workloads/${id}.json`]);

  const commits = addCommits(
    root,
    paths.map(([, , path]) => path),
  );
  const index = indexIdentities(repo.identities);
  const credits: RegistryCredits = {};
  for (const [kind, id, path] of paths) {
    const commit = commits.get(path);
    if (!commit) continue;
    const login = resolveLogin(commit.email, index);
    if (!login) continue;
    const bucket = (credits[kind] ??= {});
    bucket[id] = login;
  }
  return credits;
}

/** `2026-09-03T02:12:33-07:00` → `2026-09-03T09:12:33Z`; an unparseable date is kept as is. */
function utcIso(date: string): string {
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? date : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* ------------------------------------------------- fork contributor user ids */

/**
 * Fill in `user_id` for contributors whose results were merged from a fork.
 *
 * `stamp-user-ids` in validate.yml can only push to a branch in this repository, so a
 * contribution that arrives from a fork keeps `provenance.github_user_id: null` for ever —
 * and nobody can stamp it afterwards without tripping the ownership rule, which exists
 * precisely to stop one person editing another's result. check-result.ts already says the
 * build resolves it later; this is that.
 *
 * The login is what the contributors page keys on, so a contributor is listed either way.
 * The id only decides whether the avatar comes from the permanent numeric URL or the
 * renameable login one, which is why every failure path here is a shrug rather than an
 * error: no token, a rate limit, a network blip, a deleted account. The build must never
 * fail over a decoration.
 */
export async function resolveContributorIds(
  out: string,
  log: (message: string) => void = () => {},
  options: ResolveOptions = {},
): Promise<void> {
  const file = join(out, 'contributors.json');
  if (!existsSync(file)) return;

  let contributors: Array<{ login: string; user_id: number | null; avatar_url: string }>;
  try {
    contributors = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }

  const missing = contributors.filter((c) => c.user_id == null && c.login);
  if (missing.length === 0) return;

  const resolutions = await resolveUsers(
    missing.map((c) => c.login),
    options,
  );
  let filled = 0;
  for (const contributor of contributors) {
    const resolution = resolutions.get(contributor.login);
    if (!resolution || resolution.id == null) continue;
    contributor.user_id = resolution.id;
    contributor.avatar_url = avatarUrl(contributor.login, resolution.id);
    filled += 1;
  }

  if (filled === 0) {
    log(`contributor ids: ${missing.length} unresolved (no token, or the API said no)`);
    return;
  }
  writeFileSync(file, `${JSON.stringify(contributors, null, 2)}\n`);
  log(`contributor ids: resolved ${filled} of ${missing.length}`);
}

/* ----------------------------------------------------------------------- CLI */

async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv, { boolean: ['no-git', 'force', 'json', 'quiet'] });
  const root = resolve(args.str('root', REPO_ROOT));
  const out = resolve(root, args.str('out', DEFAULT_OUT));

  const outcome = buildData({
    root,
    out,
    noGit: args.bool('no-git'),
    force: args.bool('force'),
  });

  if (!outcome.ok) {
    process.stderr.write('build refused: validation found errors\n');
    for (const error of outcome.errors.slice(0, 40)) process.stderr.write(`  ${error}\n`);
    if (outcome.errors.length > 40) {
      process.stderr.write(`  …and ${outcome.errors.length - 40} more\n`);
    }
    process.stderr.write('run `pnpm validate` for the full report\n');
    return 1;
  }

  // After the emit, because it rewrites one of the files the emit just wrote.
  await resolveContributorIds(out, (message) => {
    if (!args.bool('quiet') && !args.bool('json')) process.stdout.write(`${message}\n`);
  });

  if (args.bool('json')) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else if (!args.bool('quiet')) {
    const bytes = outcome.files.reduce((n, f) => n + f.bytes, 0);
    const counts = Object.entries(outcome.counts)
      .map(([key, value]) => `${key} ${value}`)
      .join(' · ');
    process.stdout.write(
      `${counts}\n${outcome.files.length} file(s), ${(bytes / 1024).toFixed(1)} KB → ${outcome.out}\n`,
    );
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
