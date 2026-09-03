#!/usr/bin/env tsx
/**
 * `pnpm validate` — SPEC §5, the same code CI runs on every pull request.
 *
 *   pnpm validate                                   # everything, locally
 *   pnpm validate --changed a.json b.json           # report only these files
 *   pnpm validate --pr-author octocat --base origin/main --json
 *   pnpm validate --json-out report.json              # report to a file, not stdout
 *
 * What it does, in order: schema-check every JSON file against the schema its *path*
 * implies, recompute every derived id, check referential integrity and physics, look for
 * duplicate run ids and for results that contradict existing ones, and — when the pull
 * request context is passed in — enforce the ownership rule.
 *
 * `--changed` narrows what is *reported*, never what is *loaded*: duplicate ids and
 * cross-result disagreements can only be found by reading the whole repository, and a pull
 * request that breaks a file it did not touch should still be told about it. Repository-wide
 * issues (an empty `file`) are always reported.
 *
 * Exit code 1 on any error, or on any warning with `--strict`.
 */
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { SiteConfig } from '@atlas/core';
import { parseArgv } from './lib/args.js';
import { checkResult } from './lib/check-result.js';
import { checkDataset } from './lib/datasets.js';
import { changedFiles as gitChangedFiles, isGitRepo } from './lib/git.js';
import { buildIndexRow } from './lib/index-row.js';
import { checkIdentities } from './lib/identities.js';
import { checkOwnership } from './lib/ownership.js';
import { loadRepo } from './lib/repo.js';
import { REPO_ROOT } from './lib/root.js';
import type { Counts, Issue } from './lib/report.js';
import { Reporter, codeCounts, renderMarkdown, renderSummary } from './lib/report.js';

export interface ValidateOptions {
  root: string;
  /** Repository-relative paths; when set, only issues about these files are reported. */
  changed?: string[] | null;
  /** `github.event.pull_request.user.login` — enables the ownership check together with `base`. */
  prAuthor?: string | null;
  /** Git ref the pull request targets, e.g. `origin/main`. */
  base?: string | null;
  /** CI passes this when the pull request carries the `maintainer-override` label. */
  allowOverride?: boolean;
  /** Treat warnings as failures. */
  strict?: boolean;
}

export interface ValidateOutcome {
  ok: boolean;
  /** Only the issues this invocation reports (narrowed by `--changed`). */
  issues: Issue[];
  /** Every issue found, including files this pull request did not touch. */
  allIssues: Issue[];
  counts: Counts;
  codes: string[];
}

/** SPEC §5.6: a result that disagrees with an existing one by more than this wants a human. */
const DEFAULT_DISPUTE_PCT = 25;

function keyMetricOf(site: SiteConfig | null): string[] {
  return site?.coverage?.key_metrics ?? ['output_tok_s', 'decode_tok_s_per_request', 'accuracy'];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function validateRepo(options: ValidateOptions): ValidateOutcome {
  const root = options.root;
  const reporter = new Reporter();
  // The files this invocation is actually about. CI and the local pre-flight both name them
  // with --changed; a full-repository sweep names none, and checks that only make sense for
  // a contribution in progress stay quiet accordingly.
  const underReview = new Set((options.changed ?? []).map(normalize));
  const repo = loadRepo(root, reporter);

  /* ------------------------------------------------------------------- site */

  if (repo.site) {
    const registries: Record<string, ReadonlyMap<string, unknown>> = {
      hardware: repo.hardware,
      models: repo.models,
      engines: repo.engines,
      workloads: repo.workloads,
    };
    for (const [kind, ids] of Object.entries(repo.site.featured ?? {})) {
      const registry = registries[kind];
      if (!registry) continue;
      for (const id of ids ?? []) {
        if (registry.has(id)) continue;
        const message = `featured.${kind} references unknown id "${id}"`;
        if (registry.size === 0) reporter.warn('site/config.json', 'unknown-featured-id', message);
        else reporter.error('site/config.json', 'unknown-featured-id', message);
      }
    }
  } else {
    reporter.error('site/config.json', 'missing-site-config', 'site/config.json is missing');
  }

  /* -------------------------------------------------------------- workloads */

  for (const workload of repo.workloads.values()) {
    const file = `workloads/${workload.id}.json`;
    if (workload.dataset_id && !repo.datasets.has(workload.dataset_id)) {
      reporter.error(
        file,
        'unknown-dataset',
        `dataset_id "${workload.dataset_id}" is not a registered dataset`,
      );
    }
    if (workload.kind === 'eval' && !workload.dataset_id) {
      reporter.error(file, 'eval-without-dataset', 'an eval workload must name a dataset_id');
    }
  }

  /* --------------------------------------------------------------- datasets */

  for (const dataset of repo.datasets.values()) checkDataset(root, dataset, reporter);

  /* ------------------------------------------------------------- identities */

  if (repo.identities) checkIdentities(repo.identities, reporter);

  /* ---------------------------------------------------------------- results */

  const seenRunIds = new Map<string, string>();
  for (const { path, data } of repo.results) {
    const previous = seenRunIds.get(data.run_id);
    if (previous) {
      reporter.error(
        path,
        'duplicate-run-id',
        `run_id "${data.run_id}" is also used by ${previous}`,
        {
          related: [previous],
        },
      );
    } else {
      seenRunIds.set(data.run_id, path);
    }
    checkResult(repo, path, data, reporter, {
      allowMissingWorkloads: true,
      underReview: underReview.has(normalize(path)),
    });
  }

  crossCheck(repo, reporter);

  /* --------------------------------------------------------------- ownership */

  const author = options.prAuthor?.trim() ?? '';
  const base = options.base?.trim() ?? '';
  if (author && base) {
    if (!isGitRepo(root)) {
      reporter.warn(
        '',
        'ownership-skipped',
        'not a git checkout with history; ownership not checked',
      );
    } else {
      const changed = gitChangedFiles(root, base);
      if (changed === null) {
        reporter.error(
          '',
          'git-diff-failed',
          `git diff ${base}...HEAD failed — check out with fetch-depth: 0 and fetch the base ref`,
        );
      } else {
        checkOwnership(changed, reporter, {
          root,
          base,
          author,
          allowOverride: options.allowOverride === true,
        });
      }
    }
  }

  /* ----------------------------------------------------------------- report */

  const counts: Counts = {
    hardware: repo.hardware.size,
    engines: repo.engines.size,
    models: repo.models.size,
    quants: [...repo.models.values()].reduce((n, m) => n + m.quants.size, 0),
    workloads: repo.workloads.size,
    datasets: repo.datasets.size,
    results: repo.results.length,
  };

  const all = reporter.issues;
  const issues =
    options.changed && options.changed.length > 0
      ? reporter.forFiles(new Set(options.changed.map(normalize)))
      : all;

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  const ok = errors === 0 && !(options.strict === true && warnings > 0);

  return {
    ok,
    issues,
    allIssues: all,
    counts,
    codes: [...new Set(issues.map((i) => i.code))].sort(),
  };
}

function normalize(path: string): string {
  return path.trim().replace(/^\.\//, '').split('\\').join('/');
}

/**
 * SPEC §5.6 — a new result that disagrees with an existing measurement of the *same*
 * configuration and workload is not necessarily wrong, but somebody should look at it.
 * Comparison is against the median of the group, so a pair that disagrees flags both files
 * and a single outlier among five does not drag the others down with it.
 */
function crossCheck(repo: ReturnType<typeof loadRepo>, reporter: Reporter): void {
  const threshold = repo.site?.coverage?.disputed_deviation_pct ?? DEFAULT_DISPUTE_PCT;
  const keys = keyMetricOf(repo.site);

  const groups = new Map<string, Array<{ path: string; metrics: Record<string, number | null> }>>();
  for (const { path, data } of repo.results) {
    const row = buildIndexRow(data, path);
    const key = `${row.cell_id}|${row.config_id}|${row.workload_id}`;
    const list = groups.get(key);
    const entry = { path, metrics: row.metrics as Record<string, number | null> };
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  for (const [key, entries] of groups) {
    if (entries.length < 2) continue;
    const metric = keys.find((k) => entries.some((e) => typeof e.metrics[k] === 'number'));
    if (!metric) continue;
    const withMetric = entries.filter((e) => typeof e.metrics[metric] === 'number');
    if (withMetric.length < 2) continue;

    const values = withMetric.map((e) => e.metrics[metric] as number);
    const mid = median(values);
    if (mid === 0) continue;

    for (const entry of withMetric) {
      const value = entry.metrics[metric] as number;
      const deviation = (Math.abs(value - mid) / Math.abs(mid)) * 100;
      if (deviation <= threshold) continue;
      const [, configId, workloadId] = key.split('|') as [string, string, string];
      reporter.warn(
        entry.path,
        'needs-review',
        `${metric} is ${value}, ${deviation.toFixed(1)}% from the median ${mid} of ${withMetric.length} runs of config ${configId} / ${workloadId} — same configuration, different numbers`,
        { related: withMetric.filter((e) => e !== entry).map((e) => e.path) },
      );
    }
  }
}

/* ----------------------------------------------------------------------- CLI */

export function main(argv: string[]): number {
  const args = parseArgv(argv, {
    variadic: ['changed'],
    boolean: ['json', 'strict', 'allow-override', 'markdown', 'no-color'],
  });
  const jsonOut = args.str('json-out');

  const root = resolve(args.str('root', REPO_ROOT));
  const outcome = validateRepo({
    root,
    changed: args.list('changed'),
    prAuthor: args.str('pr-author'),
    base: args.str('base'),
    allowOverride: args.bool('allow-override'),
    strict: args.bool('strict'),
  });

  const report = () =>
    `${JSON.stringify(
      {
        ok: outcome.ok,
        counts: outcome.counts,
        errors: outcome.issues.filter((i) => i.level === 'error'),
        warnings: outcome.issues.filter((i) => i.level === 'warn'),
        codes: outcome.codes,
        code_counts: codeCounts(outcome.issues),
        // Consumed by the workflow that comments on pull requests from forks, which has no
        // checkout to count changed files for itself.
        changed_results: (args.list('changed') ?? []).filter((f) => f.startsWith('results/'))
          .length,
        markdown: renderMarkdown(outcome.issues, { counts: outcome.counts }),
      },
      null,
      2,
    )}\n`;

  // --json-out exists because --json does not survive a wrapper. Run through
  // `pnpm exec ... --json > report.json` and a FAILING validation makes pnpm append its own
  // ELIFECYCLE block to the same stdout, so the file becomes JSON followed by trailing text
  // and whoever reads it back gets a parse error instead of the findings. That is not
  // hypothetical: it is why the first external contribution got a SyntaxError from CI
  // instead of the one sentence telling them which field was wrong. Writing the report here
  // is immune to anything else sharing the stream.
  if (jsonOut) {
    writeFileSync(resolve(jsonOut), report(), 'utf8');
  }

  if (args.bool('json')) {
    process.stdout.write(report());
  } else if (args.bool('markdown')) {
    process.stdout.write(`${renderMarkdown(outcome.issues, { counts: outcome.counts })}\n`);
  } else {
    process.stdout.write(
      `${renderSummary(outcome.issues, {
        counts: outcome.counts,
        color: !args.bool('no-color') && process.stdout.isTTY === true,
      })}\n`,
    );
  }

  return outcome.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
