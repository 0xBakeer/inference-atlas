#!/usr/bin/env tsx
/**
 * `issue-to-pr` — turn a "Submit result" issue into a result file (SPEC §7, contribution
 * path three: somebody who has the hardware and the numbers but not a checkout).
 *
 *   pnpm --filter @atlas/tools run issue-to-pr --body-file issue.md --author octocat \
 *        --issue 42 [--write] [--json]
 *
 * The issue form (`.github/ISSUE_TEMPLATE/submit-result.yml`) collects exactly what cannot
 * be derived: engine, version, model, quant, hardware, args, workload, the numbers, and the
 * conditions. Everything else — the ids, the canonical argument string, the path — is
 * computed here with `@atlas/core`, the same way the harness computes it, and the result is
 * validated before the workflow is allowed to open a pull request.
 *
 * `provenance.method` is `issue-form` and `provenance.github_login` is the *issue author*,
 * never the bot: the ownership rule has to keep working for a file the bot committed.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeArgs, cellId, engineMinor, resultPath, runId } from '@atlas/core';
import type { Args, MetricBlock, ResultRecord, Scores } from '@atlas/core';
import { parseArgv } from './lib/args.js';
import { checkResult } from './lib/check-result.js';
import { field, jsonField, parseIssueForm } from './lib/issue-form.js';
import { loadRepo } from './lib/repo.js';
import type { Repo } from './lib/repo.js';
import type { Issue } from './lib/report.js';
import { Reporter } from './lib/report.js';
import { REPO_ROOT } from './lib/root.js';
import { looksLikeMetricBlock, nativeStartedAt, wrapNative } from './lib/wrap.js';
import { serialize } from './lib/write.js';

const MAX_PAYLOAD_BYTES = 100 * 1024;

export interface IssueToPrInput {
  root: string;
  body: string;
  /** The issue author's login — the owner of the resulting file. */
  author: string;
  issueNumber?: number | null;
  /** ISO timestamp the issue was created; used as `submitted_at`. */
  submittedAt?: string | null;
}

export interface IssueToPrOutcome {
  ok: boolean;
  /** Repository-relative path the result belongs at. */
  path: string | null;
  result: ResultRecord | null;
  /** Serialized file content, ready to write. */
  content: string | null;
  branch: string | null;
  pr_title: string | null;
  pr_body: string | null;
  issues: Issue[];
}

/* ------------------------------------------------------------------ conversion */

function requireField(
  fields: ReturnType<typeof parseIssueForm>,
  reporter: Reporter,
  label: string,
  ...aliases: string[]
): string | null {
  const value = field(fields, label, ...aliases);
  if (value === null) {
    reporter.error('', 'issue-missing-field', `the form field "${label}" is empty`);
    return null;
  }
  // Dropdowns come back with the label the contributor saw; take the leading id token.
  return value.split('\n')[0]!.trim();
}

export function issueToResult(input: IssueToPrInput): IssueToPrOutcome {
  const reporter = new Reporter();
  const repo: Repo = loadRepo(input.root, new Reporter());
  const fields = parseIssueForm(input.body);

  const engineId = requireField(fields, reporter, 'Engine');
  const version = requireField(fields, reporter, 'Engine version', 'Version');
  const modelId = requireField(fields, reporter, 'Model');
  const quantId = requireField(fields, reporter, 'Quantization', 'Quant');
  const hardwareId = requireField(fields, reporter, 'Hardware');
  const workloadId = requireField(fields, reporter, 'Workload');

  const hwCountRaw = field(fields, 'Device count', 'Devices', 'Hardware count');
  const hwCount = hwCountRaw ? Number.parseInt(hwCountRaw, 10) : 1;

  let args: Args = {};
  try {
    const parsed = jsonField(fields, 'Engine args (JSON)', 'Args', 'Engine args');
    if (parsed !== undefined) {
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reporter.error('', 'issue-bad-args', 'Engine args must be a JSON object of flag → value');
      } else {
        args = parsed as Args;
      }
    }
  } catch (error) {
    reporter.error(
      '',
      'issue-bad-args',
      `Engine args is not valid JSON: ${(error as Error).message}`,
    );
  }

  let payload: Record<string, unknown> | undefined;
  try {
    const parsed = jsonField(fields, 'Results (JSON)', 'Harness output', 'Metrics', 'Results');
    if (parsed === undefined) {
      reporter.error('', 'issue-missing-field', 'the form field "Results (JSON)" is empty');
    } else if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reporter.error('', 'issue-bad-results', 'Results must be a JSON object');
    } else {
      payload = parsed as Record<string, unknown>;
    }
  } catch (error) {
    reporter.error(
      '',
      'issue-bad-results',
      `Results is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (
    reporter.errors.length > 0 ||
    !engineId ||
    !version ||
    !modelId ||
    !quantId ||
    !hardwareId ||
    !workloadId ||
    !payload
  ) {
    return empty(reporter.issues);
  }

  /* ------------------------------------------------------------ the numbers */

  let metrics: MetricBlock | null = null;
  let scores: Scores | null = null;
  let resolvedParams: Record<string, unknown> = {};
  let source = 'issue-form';

  const nested = payload as { metrics?: unknown; scores?: unknown; sweep?: unknown };
  if (nested.metrics && typeof nested.metrics === 'object') {
    metrics = nested.metrics as MetricBlock;
  }
  if (nested.scores && typeof nested.scores === 'object') {
    scores = nested.scores as Scores;
  }
  if (!metrics && !scores) {
    if (looksLikeMetricBlock(payload)) {
      metrics = payload as MetricBlock;
    } else {
      const wrapped = wrapNative(payload);
      if (wrapped.source === 'unknown') {
        reporter.error(
          '',
          'issue-unrecognised-results',
          'the pasted JSON is neither an Atlas metric block ({"metrics": …}) nor output of `vllm bench serve` / SGLang `bench_serving.py`',
        );
        return empty(reporter.issues);
      }
      metrics = wrapped.metrics;
      resolvedParams = wrapped.resolved_params;
      source = wrapped.source;
    }
  }

  /* ------------------------------------------------------------------- ids */

  const engine = repo.engines.get(engineId) ?? null;
  const versionFile = engine?.versions.get(version) ?? null;
  const workload = repo.workloads.get(workloadId) ?? null;
  const quant = repo.models.get(modelId)?.quants.get(quantId) ?? null;
  const model = repo.models.get(modelId)?.model ?? null;

  const startedAt =
    field(fields, 'Started at (UTC)', 'Started at') ??
    nativeStartedAt(payload) ??
    new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const { canonical, configId } = canonicalizeArgs({
    engine_id: engineId,
    engine_version: version,
    args,
    quant_id: quantId,
    dtype: field(fields, 'dtype') ?? null,
    params: versionFile?.params ?? null,
    drop_params: engine?.meta.drop_params ?? [],
    param_aliases: engine?.meta.param_aliases ?? null,
  });

  const id = runId(configId, workloadId, input.author, startedAt);
  const cell = cellId({
    model_id: modelId,
    quant_id: quantId,
    hardware_id: hardwareId,
    hw_count: hwCount,
    engine_id: engineId,
    engine_minor: engineMinor(version),
  });

  const payloadText = JSON.stringify(payload);
  const truncated = Buffer.byteLength(payloadText, 'utf8') > MAX_PAYLOAD_BYTES;

  const notes = [
    field(fields, 'Conditions and notes', 'Notes', 'Conditions'),
    input.issueNumber ? `Submitted through issue #${input.issueNumber}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const result: ResultRecord = {
    schema_version: 1,
    run_id: id,
    config_id: configId,
    cell_id: cell,
    workload_id: workloadId,
    kind: workload?.kind ?? 'serving',
    engine: {
      id: engineId,
      version,
      commit: null,
      container: field(fields, 'Container image', 'Container'),
      install_method: null,
    },
    model: {
      id: modelId,
      quant_id: quantId,
      hf_id: quant?.hf_id ?? model?.hf_id ?? null,
      revision: null,
      dtype: field(fields, 'dtype'),
    },
    hardware: {
      id: hardwareId,
      count: Number.isFinite(hwCount) && hwCount > 0 ? hwCount : 1,
      driver: field(fields, 'Driver'),
      cuda: field(fields, 'CUDA'),
      fingerprint: null,
      captured: null,
    },
    args,
    args_canonical: canonical,
    serve_command: field(fields, 'Serve command'),
    workload: {
      id: workloadId,
      resolved_params: {
        ...(workload?.params ?? {}),
        ...(resolvedParams as Record<string, string | number | boolean | unknown[] | null>),
      },
    },
    metrics,
    scores,
    failures: [],
    gotchas: [],
    raw: {
      harness: 'issue-form',
      harness_version: null,
      sha256: null,
      payload_path: null,
      payload: truncated ? { source, truncated: true } : { source, ...payload },
      truncated,
    },
    provenance: {
      github_login: input.author,
      github_user_id: null,
      started_at: startedAt,
      finished_at: null,
      submitted_at: input.submittedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      commit: null,
      pr: null,
      method: 'issue-form',
      agent: null,
      notes: notes || null,
    },
    verification: { level: 'self-reported', reproduced_by: [], flags: [] },
  };

  const path = resultPath(engineId, modelId, hardwareId, id);

  /* -------------------------------------------------------------- validate */

  const schemaErrors = repo.schemas.check('result', result);
  for (const message of schemaErrors) reporter.error(path, 'schema', `result: ${message}`);
  checkResult(repo, path, result, reporter, { allowMissingWorkloads: true });

  const ok = reporter.errors.length === 0;
  const short = cell.slice(0, 6);
  const branch = `${repo.site?.repo?.branch_prefix ?? 'result/'}${engineId}-${modelId}-${hardwareId}-${short}`;
  const prTitle = `results: ${engineId} ${version} ${modelId}/${quantId} on ${hardwareId}`;

  return {
    ok,
    path,
    result,
    content: serialize(result, { sorted: true }),
    branch,
    pr_title: prTitle,
    pr_body: prBody(result, path, input, notes),
    issues: reporter.issues,
  };
}

function empty(issues: Issue[]): IssueToPrOutcome {
  return {
    ok: false,
    path: null,
    result: null,
    content: null,
    branch: null,
    pr_title: null,
    pr_body: null,
    issues,
  };
}

/** AGENTS.md prescribes the four sections, in this order and nothing else. */
function prBody(result: ResultRecord, path: string, input: IssueToPrInput, notes: string): string {
  const headline =
    result.metrics?.output_tok_s ??
    result.metrics?.decode_tok_s_per_request?.mean ??
    result.scores?.accuracy ??
    null;
  return [
    '## Cells filled',
    '',
    `- ${result.engine.id} ${result.engine.version} · ${result.model.id}/${result.model.quant_id} · ` +
      `${result.hardware.id} ×${result.hardware.count} · ${result.workload_id}` +
      (headline === null ? '' : ` · ${headline}`),
    '',
    '## What failed',
    '',
    'Nothing failed.',
    '',
    '## Gotchas',
    '',
    'None reported through the issue form.',
    '',
    '## Conditions',
    '',
    notes || 'Not stated.',
    '',
    '---',
    '',
    `Generated from issue #${input.issueNumber ?? '?'} by \`tools/issue-to-pr\`. The numbers, the`,
    `configuration and the ownership of \`${path}\` belong to @${input.author}.`,
    '',
    `Co-authored-by: ${input.author} <${input.author}@users.noreply.github.com>`,
  ].join('\n');
}

/* ----------------------------------------------------------------------- CLI */

function main(argv: string[]): number {
  const args = parseArgv(argv, { boolean: ['write', 'json'] });
  const root = resolve(args.str('root', REPO_ROOT));
  const bodyFile = args.str('body-file');
  const body = bodyFile ? readFileSync(resolve(bodyFile), 'utf8') : (args.str('body', '') ?? '');
  const author = args.str('author', '');

  if (!body || !author) {
    process.stderr.write(
      'usage: issue-to-pr --body-file <file> --author <login> [--issue N] [--write]\n',
    );
    return 2;
  }

  const outcome = issueToResult({
    root,
    body,
    author,
    issueNumber: args.has('issue') ? args.num('issue', 0) : null,
    submittedAt: args.str('submitted-at'),
  });

  if (outcome.ok && outcome.path && outcome.content && args.bool('write')) {
    const target = join(root, outcome.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, outcome.content, 'utf8');
  }

  if (args.bool('json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: outcome.ok,
          path: outcome.path,
          branch: outcome.branch,
          pr_title: outcome.pr_title,
          pr_body: outcome.pr_body,
          run_id: outcome.result?.run_id ?? null,
          cell_id: outcome.result?.cell_id ?? null,
          errors: outcome.issues.filter((i) => i.level === 'error'),
          warnings: outcome.issues.filter((i) => i.level === 'warn'),
        },
        null,
        2,
      )}\n`,
    );
  } else if (outcome.ok) {
    process.stdout.write(`${outcome.path}\n${outcome.branch}\n${outcome.pr_title}\n`);
  } else {
    for (const issue of outcome.issues.filter((i) => i.level === 'error')) {
      process.stderr.write(`ERROR ${issue.code}: ${issue.message}\n`);
    }
  }
  return outcome.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
