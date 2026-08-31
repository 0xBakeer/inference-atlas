/**
 * Everything SPEC §5 says about one result file, minus the parts that need git.
 *
 * Recomputation first (ids, canonical string, path), then referential integrity, then
 * physics. The order matters for the reader of a failing pull request: an id mismatch
 * usually explains every check below it, so it is reported first.
 *
 * Shared with `issue-to-pr`, which runs exactly these checks on the file it generates
 * before it offers to open a pull request.
 */
import {
  canonicalizeArgs,
  cellId,
  checkPlausibility,
  engineMinor,
  resultPath,
  runId,
} from '@atlas/core';
import type { ResultRecord } from '@atlas/core';
import type { Repo } from './repo.js';
import type { Reporter } from './report.js';

/** SPEC §4: a payload above this must be truncated, with the aggregates kept. */
const MAX_RAW_PAYLOAD_BYTES = 100 * 1024;

export interface CheckResultOptions {
  /**
   * Whether the caller is actually working on this file, i.e. it was named by `--changed`.
   *
   * The CI-owned-field checks below are gated on this, because CI *writes* those fields: the
   * stamp-user-ids job resolves provenance.github_user_id and commits it. Warning whenever
   * the field is set therefore fires on every result that has ever been merged - 151 of them
   * at the time this was added, growing by one per contribution - and buries the findings a
   * contributor actually needs under a wall of noise about files they never touched.
   *
   * A full-repository sweep names no files and so says nothing about them. CI always passes
   * --changed, and so does the local pre-flight in CONTRIBUTING, which is exactly where a
   * hand-typed value should still be caught.
   */
  underReview?: boolean;
  /**
   * When the workload registry is empty the repository is mid-landing (wave 2 order:
   * results seeded before `workloads/`), and every result would fail on an id that is
   * simply not there yet. An empty registry downgrades the check to a warning; a
   * *populated* registry that is missing this id is a hard error.
   */
  allowMissingWorkloads?: boolean;
}

export function checkResult(
  repo: Repo,
  file: string,
  result: ResultRecord,
  reporter: Reporter,
  options: CheckResultOptions = {},
): void {
  const engine = repo.engines.get(result.engine.id) ?? null;
  const modelEntry = repo.models.get(result.model.id) ?? null;
  const quant = modelEntry?.quants.get(result.model.quant_id) ?? null;
  const hardware = repo.hardware.get(result.hardware.id) ?? null;

  /* ------------------------------------------------------ recomputed identity */

  const versionFile = engine?.versions.get(result.engine.version) ?? null;
  if (engine && !versionFile) {
    reporter.warn(
      file,
      'unknown-engine-version',
      `engines/${result.engine.id}/versions/${result.engine.version}.json is missing, so no defaults were dropped from the fingerprint`,
    );
  }

  // A fork's version string names the upstream commit it branched from, not its own patches,
  // so two forks - or two builds of one fork either side of a fix - can share it. Where the
  // registry says the version is a fork, the result has to say which build it was, and that
  // answer goes into the fingerprint (SPEC §3, decision 24).
  const isFork = versionFile?.distribution === 'fork';
  const build = result.engine.build ?? null;
  // Only for results under review. Every cell merged before this rule existed predates the
  // engine.build field, and failing them now would say their numbers are wrong when what is
  // actually missing is a provenance field nobody could have filled in.
  if (options.underReview && isFork && !build) {
    reporter.error(
      file,
      'fork-build-unnamed',
      `engines/${result.engine.id}/versions/${result.engine.version}.json is registered as a fork ` +
        `of ${versionFile?.source_repo ?? 'an unnamed repository'}, whose version string names the ` +
        `upstream commit rather than the fork's patches. Set engine.build to the build actually ` +
        `served - a container digest, or <fork repo>@<fork ref> - so two builds sharing this ` +
        `version do not share a fingerprint`,
      { path: 'engine.build' },
    );
  }
  if (!isFork && build && versionFile) {
    reporter.warn(
      file,
      'build-on-upstream-version',
      `engine.build is set but ${result.engine.version} is registered as an upstream release, ` +
        `whose version string already pins the build; this result will not share a config_id ` +
        `with otherwise identical runs that omit it`,
      { path: 'engine.build' },
    );
  }

  const { canonical, configId } = canonicalizeArgs({
    engine_id: result.engine.id,
    engine_version: result.engine.version,
    args: result.args,
    quant_id: result.model.quant_id,
    dtype: result.model.dtype ?? null,
    params: versionFile?.params ?? null,
    drop_params: engine?.meta.drop_params ?? [],
    param_aliases: engine?.meta.param_aliases ?? null,
    build,
  });

  if (canonical !== result.args_canonical) {
    reporter.error(
      file,
      'args-canonical-mismatch',
      `stored "${result.args_canonical}", computed "${canonical}"`,
      { path: 'args_canonical' },
    );
  }
  if (configId !== result.config_id) {
    reporter.error(file, 'config-id-mismatch', `stored ${result.config_id}, computed ${configId}`, {
      path: 'config_id',
    });
  }

  const expectedCell = cellId({
    model_id: result.model.id,
    quant_id: result.model.quant_id,
    hardware_id: result.hardware.id,
    hw_count: result.hardware.count,
    engine_id: result.engine.id,
    engine_minor: engineMinor(result.engine.version),
  });
  if (expectedCell !== result.cell_id) {
    reporter.error(file, 'cell-id-mismatch', `stored ${result.cell_id}, computed ${expectedCell}`, {
      path: 'cell_id',
    });
  }

  const expectedRun = runId(
    configId,
    result.workload_id,
    result.provenance.github_login,
    result.provenance.started_at,
  );
  if (expectedRun !== result.run_id) {
    reporter.error(file, 'run-id-mismatch', `stored ${result.run_id}, computed ${expectedRun}`, {
      path: 'run_id',
    });
  }

  const expectedPath = resultPath(
    result.engine.id,
    result.model.id,
    result.hardware.id,
    result.run_id,
  );
  if (file !== expectedPath) {
    reporter.error(file, 'wrong-path', `this file belongs at ${expectedPath}`);
  }

  /* --------------------------------------------------- referential integrity */

  if (!engine) reporter.error(file, 'unknown-engine', `unknown engine "${result.engine.id}"`);
  if (!modelEntry) {
    reporter.error(file, 'unknown-model', `unknown model "${result.model.id}"`);
  } else if (!quant) {
    reporter.error(
      file,
      'unknown-quant',
      `unknown quantization "${result.model.id}/${result.model.quant_id}"`,
    );
  }
  if (!hardware) {
    reporter.error(file, 'unknown-hardware', `unknown hardware "${result.hardware.id}"`);
  }
  if (quant && !quant.engines.includes(result.engine.id)) {
    reporter.error(
      file,
      'quant-engine-mismatch',
      `quant "${result.model.quant_id}" does not list engine "${result.engine.id}" in its engines[] — either the run used a format this engine cannot load, or the quant record is wrong`,
    );
  }

  const workload = repo.workloads.get(result.workload_id) ?? null;
  if (!workload) {
    const empty = repo.workloads.size === 0 && options.allowMissingWorkloads === true;
    const message = `unknown workload "${result.workload_id}"`;
    if (empty) {
      reporter.warn(file, 'unknown-workload', `${message} (workloads/ is empty — not checked)`);
    } else {
      reporter.error(file, 'unknown-workload', message);
    }
  } else {
    if (workload.kind !== result.kind) {
      reporter.error(
        file,
        'kind-mismatch',
        `kind "${result.kind}" does not mirror workload "${workload.id}" kind "${workload.kind}"`,
        { path: 'kind' },
      );
    }
    if (workload.dataset_id && !repo.datasets.has(workload.dataset_id)) {
      reporter.error(
        file,
        'unknown-dataset',
        `workload "${workload.id}" references dataset "${workload.dataset_id}", which is not registered`,
      );
    }
  }

  /* ------------------------------------------------------------ CI-owned fields */

  if (options.underReview && result.provenance.github_user_id != null) {
    reporter.warn(
      file,
      'ci-owned-field',
      'provenance.github_user_id is set; CI resolves it and contributors leave it null',
      { path: 'provenance.github_user_id' },
    );
  }
  if (options.underReview && (result.provenance.commit != null || result.provenance.pr != null)) {
    reporter.warn(
      file,
      'ci-owned-field',
      'provenance.commit / provenance.pr are set; the build stamps them into the compiled copy and contributors leave them null',
      { path: 'provenance.commit' },
    );
  }

  /* ------------------------------------------------------------- bounded payload */

  const payload = result.raw?.payload;
  if (payload != null && result.raw?.truncated !== true) {
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes > MAX_RAW_PAYLOAD_BYTES) {
      reporter.error(
        file,
        'raw-payload-too-large',
        `raw.payload is ${(bytes / 1024).toFixed(1)} KB; keep it under 100 KB or set raw.truncated: true`,
        { path: 'raw.payload' },
      );
    }
  }

  /* ------------------------------------------------------------------ physics */

  for (const issue of checkPlausibility({
    result,
    hardware,
    model: modelEntry?.model ?? null,
    quant,
    site: repo.site,
  })) {
    const extra = issue.path ? { path: issue.path } : {};
    if (issue.level === 'error') reporter.error(file, issue.code, issue.message, extra);
    else reporter.warn(file, issue.code, issue.message, extra);
  }
}
