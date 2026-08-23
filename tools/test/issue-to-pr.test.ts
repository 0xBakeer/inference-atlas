/**
 * The issue-form contribution path.
 *
 * Somebody with the hardware and the numbers but no checkout fills in a form; the workflow
 * turns it into a result file and opens a pull request in their name. Two things have to
 * hold for that to be safe: the ids must be *computed* (a form cannot be trusted to carry
 * them) and `provenance.github_login` must be the issue author, so the ownership rule keeps
 * working on a file that a bot committed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeArgs, modelSlug, parseRunId } from '@atlas/core';
import { field, jsonField, parseIssueForm } from '../src/lib/issue-form.js';
import { issueToResult } from '../src/issue-to-pr.js';
import { validateRepo } from '../src/validate.js';
import { SOURCE_ROOT, makeFixtureRepo } from './helpers/fixture-repo.js';
import type { FixtureRepo } from './helpers/fixture-repo.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

let repo: FixtureRepo;

beforeEach(() => {
  repo = makeFixtureRepo();
});
afterEach(() => {
  repo.dispose();
});

describe('parsing the form body', () => {
  const fields = parseIssueForm(fixture('submit-result-issue.md'));

  it('reads every answered field and drops the unanswered ones', () => {
    expect(field(fields, 'Engine')).toBe('vllm');
    expect(field(fields, 'Hardware')).toBe('nvidia-rtx-4090');
    expect(field(fields, 'Conditions and notes')).toContain('Ambient 21C');
    // `_No response_` is what GitHub renders for an empty optional field.
    expect(field(fields, 'Serve command')).toBeNull();
  });

  it('matches labels regardless of case and punctuation', () => {
    expect(field(fields, 'engine version')).toBe('0.27.1');
    expect(field(fields, 'Device Count!')).toBe('1');
  });

  it('unwraps a fenced code block before parsing JSON', () => {
    expect(jsonField(fields, 'Engine args (JSON)')).toEqual({
      'max-model-len': 32768,
      'gpu-memory-utilization': 0.9,
    });
  });
});

describe('the form and the parser agree', () => {
  it('recognises every label the issue template asks for', () => {
    // The labels in submit-result.yml are the contract between the form and this parser:
    // renaming one there silently breaks the pipeline, so it is asserted here.
    const template = readFileSync(
      join(SOURCE_ROOT, '.github/ISSUE_TEMPLATE/submit-result.yml'),
      'utf8',
    );
    const labels = [...template.matchAll(/^\s+label:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    const body = labels.map((label) => `### ${label}\n\nvalue\n`).join('\n');
    const fields = parseIssueForm(body);

    for (const label of [
      'Engine',
      'Engine version',
      'Model',
      'Quantization',
      'Hardware',
      'Device count',
      'Workload',
      'Engine args (JSON)',
      'Results (JSON)',
      'Started at (UTC)',
      'Container image',
      'Conditions and notes',
    ]) {
      expect(labels, `submit-result.yml is missing "${label}"`).toContain(label);
      expect(field(fields, label), label).toBe('value');
    }
  });
});

describe('building the result', () => {
  it('computes every id and produces a file that validates', () => {
    const outcome = issueToResult({
      root: repo.root,
      body: fixture('submit-result-issue.md'),
      author: 'octocat',
      issueNumber: 42,
      submittedAt: '2026-08-13T09:00:00Z',
    });

    expect(outcome.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(outcome.ok).toBe(true);

    const result = outcome.result!;
    expect(result.provenance.github_login).toBe('octocat');
    expect(result.provenance.method).toBe('issue-form');
    expect(result.provenance.github_user_id).toBeNull();
    expect(result.provenance.commit).toBeNull();
    expect(result.provenance.notes).toContain('issue #42');
    expect(result.kind).toBe('serving');
    expect(result.metrics?.output_tok_s).toBe(118.4);

    // The ids are derived, not taken from the form.
    const expected = canonicalizeArgs({
      engine_id: 'vllm',
      engine_version: '0.27.1',
      args: result.args,
      quant_id: 'fp8',
      dtype: null,
      params: repo.read<{ params: never[] }>('engines/vllm/versions/0.27.1.json').params,
      drop_params: repo.read<{ drop_params: string[] }>('engines/vllm/meta.json').drop_params,
    });
    expect(result.config_id).toBe(expected.configId);
    expect(result.args_canonical).toBe(expected.canonical);
    expect(parseRunId(result.run_id)?.workloadId).toBe('serve-single-i256-o256-v1');
    expect(outcome.path).toBe(`results/vllm/Qwen/Qwen3-8B/nvidia-rtx-4090/${result.run_id}.json`);

    // And the file it would write really does pass the validator.
    repo.write(outcome.path!, outcome.content!);
    const validation = validateRepo({ root: repo.root });
    expect(validation.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('produces the branch name and pull request metadata the workflow needs', () => {
    const outcome = issueToResult({
      root: repo.root,
      body: fixture('submit-result-issue.md'),
      author: 'octocat',
      issueNumber: 42,
    });
    // A model id carries a slash and mixed case; the branch name carries `modelSlug` of it,
    // and the title carries the id verbatim because that is what a reviewer searches for.
    const short = outcome.result!.cell_id.slice(0, 6);
    expect(outcome.branch).toBe(
      `result/vllm-${modelSlug('Qwen/Qwen3-8B')}-nvidia-rtx-4090-${short}`,
    );
    expect(outcome.branch!.split('/')).toHaveLength(2);
    expect(outcome.pr_title).toBe('results: vllm 0.27.1 Qwen/Qwen3-8B/fp8 on nvidia-rtx-4090');
    expect(outcome.pr_body).toContain('## Cells filled');
    expect(outcome.pr_body).toContain('## What failed');
    expect(outcome.pr_body).toContain('## Gotchas');
    expect(outcome.pr_body).toContain('## Conditions');
    expect(outcome.pr_body).toContain('Co-authored-by: octocat');
  });

  it('wraps engine-native benchmark output instead of demanding our format', () => {
    const outcome = issueToResult({
      root: repo.root,
      body: fixture('submit-result-native.md'),
      author: 'octocat',
      issueNumber: 43,
    });
    expect(outcome.ok).toBe(true);
    const result = outcome.result!;
    expect(result.metrics?.output_tok_s).toBe(828.24);
    expect(result.metrics?.ttft_ms?.p50).toBe(161);
    expect(result.metrics?.requests_total).toBe(200);
    expect(result.metrics?.requests_ok).toBe(198);
    expect(result.metrics?.requests_failed).toBe(2);
    // The date in the native dump becomes started_at, so the run id is reproducible.
    expect(result.provenance.started_at).toBe('2026-08-12T14:15:22Z');
    expect((result.raw?.payload as { source?: string }).source).toBe('vllm-bench-serve');
  });
});

describe('rejecting a form that cannot become a result', () => {
  it('names the missing field', () => {
    const outcome = issueToResult({
      root: repo.root,
      body: '### Engine\n\nvllm\n',
      author: 'octocat',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.map((i) => i.code)).toContain('issue-missing-field');
    expect(outcome.issues.map((i) => i.message).join(' ')).toContain('Hardware');
  });

  it('rejects unparseable JSON rather than guessing', () => {
    const body = fixture('submit-result-issue.md').replace('{ "max-model-len"', '{ max-model-len');
    const outcome = issueToResult({ root: repo.root, body, author: 'octocat' });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.map((i) => i.code)).toContain('issue-bad-args');
  });

  it('rejects results JSON it does not recognise', () => {
    const body = fixture('submit-result-issue.md').replace(
      /### Results \(JSON\)[\s\S]*?### Started at/,
      '### Results (JSON)\n\n{ "it_was": "fast" }\n\n### Started at',
    );
    const outcome = issueToResult({ root: repo.root, body, author: 'octocat' });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.map((i) => i.code)).toContain('issue-unrecognised-results');
  });

  it('still reports plausibility problems in numbers somebody typed by hand', () => {
    const body = fixture('submit-result-issue.md').replace(
      '"decode_tok_s_per_request": { "mean": 118.4 }',
      '"decode_tok_s_per_request": { "mean": 9000 }',
    );
    const outcome = issueToResult({ root: repo.root, body, author: 'octocat' });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.map((i) => i.code)).toContain('bandwidth-ceiling-exceeded');
  });
});
