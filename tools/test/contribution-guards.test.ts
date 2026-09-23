/**
 * Contribution guards (SPEC decision 29): checks for submissions that pass every schema and
 * recomputed id and are still wrong. A run served by another model, one build under two
 * version strings, curated registry records rewritten, repo ids that are not on the Hub.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResultRecord } from '@atlas/core';
import { validateRepo } from '../src/validate.js';
import { checkHuggingFace } from '../src/lib/hf.js';
import type { Fetch } from '../src/lib/hf.js';
import { changedKeys, ownersOf, parseCodeowners } from '../src/lib/registry-edits.js';
import { servedModelVerdict } from '../src/lib/served-model.js';
import { makeFixtureRepo, makeResult } from './helpers/fixture-repo.js';
import type { FixtureRepo } from './helpers/fixture-repo.js';

let repo: FixtureRepo;

beforeEach(() => {
  repo = makeFixtureRepo();
});

afterEach(() => {
  repo.dispose();
});

function codes(outcome: ReturnType<typeof validateRepo>, level: 'error' | 'warn' = 'error') {
  return outcome.issues.filter((i) => i.level === level).map((i) => i.code);
}

function served(result: ResultRecord, name: string, buildInfo?: string): ResultRecord {
  result.raw = {
    harness: 'atlas-bench',
    harness_version: '0.1.0',
    sha256: null,
    payload_path: null,
    payload: {
      engine_endpoint: {
        attached: true,
        base_url: 'http://localhost:8080',
        served_model_id: name,
        advertised_models: [name],
        ...(buildInfo ? { build_info: buildInfo } : {}),
      },
    },
    truncated: false,
  } as ResultRecord['raw'];
  return result;
}

/* ------------------------------------------------------------ served model */

describe('served model', () => {
  const qwen38 = { hf_id: 'unsloth/Qwen3.8-27B-GGUF', files: ['Qwen3.8-27B-Q4_K_M.gguf'] };

  it('rejects a run the server answered as a model of another size', () => {
    const verdict = servedModelVerdict('deepseek-r1-distill-32b', 'Qwen/Qwen3.8-27B', qwen38);
    expect(verdict.level).toBe('error');
    expect(verdict.message).toContain('32B');
    expect(verdict.message).toContain('27B');
  });

  it.each([
    ['qwen3.8-27b-uncensored', 'orcarouter/Qwen3.8-27B-Uncensored', null],
    ['gemma4-26b-a4b-uncensored', 'huihui-ai/Huihui-gemma-4-26B-A4B-it-abliterated', null],
    ['nous-hermes-4-36b', 'NousResearch/Hermes-4.3-36B', null],
    ['tinfield', 'badtheorylabs/Tinfield-1', null],
    ['google/gemma-4-e2b', 'google/gemma-4-E2B-it', null],
    ['llama-3.1-8b', 'meta-llama/Llama-3.1-8B-Instruct', null],
  ])('accepts the alias %s for %s', (name, id, quant) => {
    expect(servedModelVerdict(name, id, quant).level).toBe('ok');
  });

  it('does not read an active-parameter tag as a size', () => {
    // a3b / e2b are active counts, not totals; they must not be compared with 30b.
    expect(servedModelVerdict('qwen3-a3b', 'Qwen/Qwen3-30B-A3B', null).level).toBe('ok');
  });

  it('warns when the served name shares nothing with the label', () => {
    expect(servedModelVerdict('dolphin-alias', 'Qwen/Qwen3-8B', null).level).toBe('warn');
  });

  it('reports the mismatch on a file under review, and only there', () => {
    const path = repo.writeResult(served(makeResult(repo), 'deepseek-r1-distill-32b'));
    expect(codes(validateRepo({ root: repo.root, changed: [path] }))).toContain(
      'served-model-mismatch',
    );
    expect(codes(validateRepo({ root: repo.root }))).not.toContain('served-model-mismatch');
  });

  it('rejects an engine.version the server itself contradicts', () => {
    const path = repo.writeResult(served(makeResult(repo), 'qwen3-8b', 'b11071-f95b0d9'));
    expect(codes(validateRepo({ root: repo.root, changed: [path] }))).toContain(
      'engine-version-contradicts-server',
    );
  });
});

/* ---------------------------------------------------------- version split */

describe('one build, one version', () => {
  it('rejects two version strings for the same engine commit in one pull request', () => {
    const a = makeResult(repo, { startedAt: '2026-08-03T09:00:00Z' });
    a.engine.commit = 'f95b0d9';
    const b = makeResult(repo, { startedAt: '2026-08-03T10:00:00Z', version: '0.27.1' });
    b.engine.commit = 'f95b0d9';
    b.engine.version = '0.27.0';
    const pa = repo.writeResult(a);
    const pb = repo.write(`results/vllm/Qwen/Qwen3-8B/nvidia-rtx-4090/split-b.json`, b);
    const outcome = validateRepo({ root: repo.root, changed: [pa, pb] });
    expect(
      outcome.issues.filter((i) => i.code === 'engine-version-split').map((i) => i.file),
    ).toEqual(expect.arrayContaining([pa]));
  });

  it('says nothing when the commit is not recorded', () => {
    const pa = repo.writeResult(makeResult(repo, { startedAt: '2026-08-03T09:00:00Z' }));
    const pb = repo.writeResult(makeResult(repo, { startedAt: '2026-08-03T10:00:00Z' }));
    const outcome = validateRepo({ root: repo.root, changed: [pa, pb] });
    expect(codes(outcome)).not.toContain('engine-version-split');
  });
});

/* -------------------------------------------------------- registry edits */

describe('registry edits', () => {
  const MODEL = 'models/Qwen/Qwen3-8B/model.json';
  const QUANT = 'models/Qwen/Qwen3-8B/quants/fp8.json';

  beforeEach(() => {
    repo.write('.github/CODEOWNERS', '/models/  @maintainer\n/engines/ @maintainer\n');
    repo.initGit();
    repo.git('checkout', '-q', '-b', 'contribution');
  });

  const check = (author: string, allowOverride = false) =>
    validateRepo({ root: repo.root, prAuthor: author, base: 'main', allowOverride });

  function edit(path: string, change: (record: Record<string, unknown>) => void) {
    const record = JSON.parse(repo.git('show', `HEAD:${path}`)) as Record<string, unknown>;
    change(record);
    repo.write(path, record);
    repo.commit(`edit ${path}`);
  }

  it('rejects a contributor rewriting a model record', () => {
    edit(MODEL, (r) => {
      r.released = '2026-01-08';
    });
    const outcome = check('stranger');
    expect(codes(outcome)).toContain('registry-edit-foreign');
    const message = outcome.issues.find((i) => i.code === 'registry-edit-foreign')?.message;
    expect(message).toContain('"released"');
    expect(message).toContain('@maintainer');
  });

  it('lets the code owner named at the base ref edit it', () => {
    edit(MODEL, (r) => {
      r.released = '2026-01-08';
    });
    expect(codes(check('Maintainer'))).not.toContain('registry-edit-foreign');
  });

  it('does not let a pull request make itself the owner', () => {
    repo.write('.github/CODEOWNERS', '/models/  @stranger\n');
    edit(MODEL, (r) => {
      r.notes = 'rewritten';
    });
    expect(codes(check('stranger'))).toContain('registry-edit-foreign');
  });

  it('lets anyone correct where a quant’s weights live', () => {
    edit(QUANT, (r) => {
      r.hf_id = 'someone/Qwen3-8B-FP8';
      r.size_gb = 9.1;
    });
    expect(codes(check('stranger'))).not.toContain('registry-edit-foreign');
  });

  it('rejects dropping the notes of a quant record', () => {
    edit(QUANT, (r) => {
      r.hf_id = 'someone/Qwen3-8B-FP8';
      delete r.notes;
    });
    const message = check('stranger').issues.find(
      (i) => i.code === 'registry-edit-foreign',
    )?.message;
    expect(message).toContain('"notes"');
    expect(message).not.toContain('"hf_id"');
  });

  it('rejects deleting a record', () => {
    repo.remove(QUANT);
    repo.commit('drop a quant');
    expect(codes(check('stranger'))).toContain('registry-edit-foreign');
  });

  it('accepts a new record from anyone', () => {
    repo.write('models/Qwen/Qwen3-8B/quants/gguf-q4-k-m.json', {
      schema_version: 1,
      id: 'gguf-q4-k-m',
      model_id: 'Qwen/Qwen3-8B',
      format: 'gguf',
      bits: 4.8,
      hf_id: 'unsloth/Qwen3-8B-GGUF',
      files: ['Qwen3-8B-Q4_K_M.gguf'],
      size_gb: 5,
      engines: ['llamacpp'],
      source: 'community',
    });
    repo.commit('add a quant');
    expect(codes(check('stranger'))).not.toContain('registry-edit-foreign');
  });

  it('downgrades to a warning under maintainer-override', () => {
    edit(MODEL, (r) => {
      r.attention = 'mha';
    });
    const outcome = check('stranger', true);
    expect(codes(outcome)).not.toContain('registry-edit-foreign');
    expect(codes(outcome, 'warn')).toContain('ownership-override');
  });

  it('parses CODEOWNERS with last-match-wins', () => {
    const rules = parseCodeowners('*  @a\n/models/ @b @C\n# comment\n');
    expect(ownersOf(rules, 'models/x/y/model.json')).toEqual(['b', 'C']);
    expect(ownersOf(rules, 'README.md')).toEqual(['a']);
    expect(changedKeys({ a: 1, b: [1] }, { a: 1, b: [2], c: 3 })).toEqual(['b', 'c']);
  });
});

/* ---------------------------------------------------------- Hugging Face */

describe('Hugging Face', () => {
  type Reply = { status: number; location?: string; body?: unknown } | Error;

  function hub(replies: Record<string, Reply>): Fetch {
    return async (url) => {
      const id = url.replace('https://huggingface.co/api/models/', '');
      const reply = replies[id] ?? {
        status: 401,
        body: { error: 'Invalid username or password.' },
      };
      if (reply instanceof Error) throw reply;
      return {
        status: reply.status,
        headers: { get: (n: string) => (n === 'location' ? (reply.location ?? null) : null) },
        json: async () => reply.body,
      };
    };
  }

  function quant(hfId: string, files: string[]) {
    return repo.write('models/Qwen/Qwen3-8B/quants/gguf-q4-k-m.json', {
      schema_version: 1,
      id: 'gguf-q4-k-m',
      model_id: 'Qwen/Qwen3-8B',
      format: 'gguf',
      bits: 4.8,
      hf_id: hfId,
      files,
      size_gb: 5,
      engines: ['llamacpp'],
      source: 'community',
    });
  }

  const run = (files: string[], replies: Record<string, Reply>) =>
    checkHuggingFace({ root: repo.root, files, fetchFn: hub(replies) });

  it('accepts a repo that exists and holds the named file', async () => {
    const path = quant('unsloth/Qwen3-8B-GGUF', ['Qwen3-8B-Q4_K_M.gguf']);
    const issues = await run([path], {
      'unsloth/Qwen3-8B-GGUF': {
        status: 200,
        body: { id: 'unsloth/Qwen3-8B-GGUF', siblings: [{ rfilename: 'Qwen3-8B-Q4_K_M.gguf' }] },
      },
    });
    expect(issues).toEqual([]);
  });

  it('rejects a repo the Hub does not have', async () => {
    const path = quant('huihui-ai/Qwen3.6-27B-abliterated', ['x.gguf']);
    expect((await run([path], {})).map((i) => i.code)).toEqual(['hf-repo-missing']);
  });

  it('rejects a file the repo does not have', async () => {
    const path = quant('NousResearch/Hermes-4.3-36B-GGUF', ['hermes-4.3-36b-Q4_K_M.gguf']);
    const issues = await run([path], {
      'NousResearch/Hermes-4.3-36B-GGUF': {
        status: 200,
        body: {
          id: 'NousResearch/Hermes-4.3-36B-GGUF',
          siblings: [{ rfilename: 'Hermes-4.3-36B-Q4_K_M.gguf' }],
        },
      },
    });
    expect(issues.map((i) => i.code)).toEqual(['hf-file-missing']);
  });

  it('rejects an id in the wrong case or under an old owner', async () => {
    const path = quant('nousresearch/Hermes-4.3-36B-GGUF', ['a.gguf']);
    const issues = await run([path], {
      'nousresearch/Hermes-4.3-36B-GGUF': {
        status: 307,
        location: '/api/models/NousResearch/Hermes-4.3-36B-GGUF',
      },
    });
    expect(issues.map((i) => i.code)).toEqual(['hf-repo-renamed']);
    expect(issues[0]?.message).toContain('NousResearch/Hermes-4.3-36B-GGUF');
  });

  it('only warns when the Hub cannot be reached', async () => {
    const path = quant('unsloth/Qwen3-8B-GGUF', ['a.gguf']);
    const issues = await run([path], { 'unsloth/Qwen3-8B-GGUF': new Error('ECONNRESET') });
    expect(issues.map((i) => [i.level, i.code])).toEqual([['warn', 'hf-unreachable']]);
  });

  it('ignores files that are not model or quant records', async () => {
    expect(await run(['results/x.json', 'engines/vllm/meta.json'], {})).toEqual([]);
  });
});
