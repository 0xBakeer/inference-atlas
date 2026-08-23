/**
 * Engine parameter ingestion — the parsers, on captured output.
 *
 * The fixtures are what the real thing prints: an argparse dump the way the snippet in
 * `snippets.ts` serializes it, and `--help` text in llama.cpp's and Ollama's actual layout.
 * Testing against captured output rather than against a docker run is the point: the docker
 * path is three lines of `spawnSync` and the parsing is where every mistake lives, and a
 * wrong default here silently merges two different configurations into one fingerprint.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineParam, EngineVersion } from '@atlas/core';
import { paramsFromArgparse } from '../src/ingest/argparse.js';
import type { ArgparseDump } from '../src/ingest/argparse.js';
import { paramsFromHelpText, paramsFromOllamaHelp } from '../src/ingest/helptext.js';
import { compareVersions, ingestEngine, parseSource } from '../src/ingest/index.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';
import type { FixtureRepo } from './helpers/fixture-repo.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const byName = (params: EngineParam[], name: string) => params.find((p) => p.name === name);

describe('argparse dumps', () => {
  const params = paramsFromArgparse(JSON.parse(fixture('vllm-argparse-dump.json')) as ArgparseDump);

  it('drops --help and keeps everything else, sorted', () => {
    expect(byName(params, 'help')).toBeUndefined();
    expect(params.map((p) => p.name)).toEqual([...params.map((p) => p.name)].sort());
  });

  it('takes the long option as the name and the rest as aliases', () => {
    const tp = byName(params, 'tensor-parallel-size')!;
    expect(tp.aliases).toEqual(['-tp']);
    expect(tp.type).toBe('int');
    expect(tp.default).toBe(1);
  });

  it('infers float, enum, json, list and bool from the action', () => {
    expect(byName(params, 'gpu-memory-utilization')!.type).toBe('float');
    expect(byName(params, 'gpu-memory-utilization')!.default).toBe(0.9);

    const kv = byName(params, 'kv-cache-dtype')!;
    expect(kv.type).toBe('enum');
    expect(kv.choices).toEqual(['auto', 'fp8', 'fp8_e5m2', 'fp8_e4m3']);

    expect(byName(params, 'speculative-config')!.type).toBe('json');
    expect(byName(params, 'middleware')!.type).toBe('list');
    expect(byName(params, 'disable-log-stats')!.type).toBe('bool');
    expect(byName(params, 'disable-log-stats')!.default).toBe(false);
  });

  it('keeps a null default null, because a null default is never dropped', () => {
    // SPEC decision 5: `enable-prefix-caching` depends on the model, so it has no constant
    // default and an explicitly passed value must always survive into the fingerprint.
    const prefix = byName(params, 'enable-prefix-caching')!;
    expect(prefix.type).toBe('bool');
    expect(prefix.default).toBeNull();
  });

  it('carries a positional over under its destination name', () => {
    expect(byName(params, 'model-tag')!.type).toBe('str');
  });

  it('collapses wrapped help text onto one line', () => {
    expect(byName(params, 'gpu-memory-utilization')!.help).toBe(
      'The fraction of GPU memory to be used for the model executor, ranging from 0 to 1.',
    );
  });

  it('turns a path-shaped string flag into the path type', () => {
    expect(byName(params, 'download-dir')!.type).toBe('path');
  });
});

describe('llama-server --help', () => {
  const params = paramsFromHelpText(fixture('llama-server-help.txt'));

  it('skips help and version', () => {
    expect(byName(params, 'help')).toBeUndefined();
    expect(byName(params, 'version')).toBeUndefined();
  });

  it('reads the long name, the short alias and the numeric default', () => {
    const ctx = byName(params, 'ctx-size')!;
    expect(ctx.aliases).toEqual(['-c']);
    expect(ctx.type).toBe('int');
    expect(ctx.default).toBe(4096);
    expect(ctx.help).toContain('size of the prompt context');
  });

  it('reads a float default', () => {
    expect(byName(params, 'temp')!.type).toBe('float');
    expect(byName(params, 'temp')!.default).toBe(0.8);
  });

  it('turns a brace-listed metavar into an enum', () => {
    const fa = byName(params, 'flash-attn')!;
    expect(fa.type).toBe('enum');
    expect(fa.choices).toEqual(['on', 'off', 'auto']);
    expect(fa.default).toBe('auto');
  });

  it('reads "(default: enabled)" and a bare switch as booleans', () => {
    expect(byName(params, 'cont-batching')!.type).toBe('bool');
    expect(byName(params, 'cont-batching')!.default).toBe(true);
    expect(byName(params, 'mlock')!.type).toBe('bool');
    expect(byName(params, 'mlock')!.default).toBe(false);
  });

  it('keeps every alias of a three-way spelling', () => {
    const ngl = byName(params, 'n-gpu-layers')!;
    expect(ngl.aliases).toEqual(expect.arrayContaining(['-ngl', '--gpu-layers']));
    expect(ngl.default).toBe(0);
  });

  it('picks up the environment variable a flag mirrors', () => {
    expect(byName(params, 'threads')!.env).toBe('LLAMA_ARG_THREADS');
    expect(byName(params, 'threads')!.default).toBe(-1);
  });
});

describe('ollama serve --help', () => {
  const params = paramsFromOllamaHelp(fixture('ollama-serve-help.txt'));

  it('names the environment variables the way the registry does', () => {
    const parallel = byName(params, 'ollama-num-parallel')!;
    expect(parallel.env).toBe('OLLAMA_NUM_PARALLEL');
    expect(parallel.aliases).toEqual(['num_parallel', 'num-parallel']);
  });

  it('reads defaults out of the help text and falls back to the known list', () => {
    expect(byName(params, 'ollama-context-length')!.default).toBe(4096);
    expect(byName(params, 'ollama-flash-attention')!.default).toBe(false);
    expect(byName(params, 'ollama-kv-cache-type')!.default).toBe('f16');
    // Not described by this build's help, so the curated default stands.
    expect(byName(params, 'ollama-max-queue')!.default).toBe(512);
  });

  it('keeps a variable this build lists that the curated list does not know', () => {
    expect(byName(params, 'ollama-debug')!.env).toBe('OLLAMA_DEBUG');
  });
});

describe('parseSource', () => {
  it('recognises an argparse dump by its JSON, and help text by not being JSON', () => {
    expect(parseSource('vllm', fixture('vllm-argparse-dump.json')).kind).toBe('argparse');
    expect(parseSource('llamacpp', fixture('llama-server-help.txt')).kind).toBe('help');
    expect(parseSource('ollama', fixture('ollama-serve-help.txt')).kind).toBe('ollama-help');
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(['0.27.1', '0.9.0', '0.10.0'].sort(compareVersions)).toEqual([
      '0.9.0',
      '0.10.0',
      '0.27.1',
    ]);
    expect(['b7000', 'b6999'].sort(compareVersions)).toEqual(['b6999', 'b7000']);
  });
});

describe('writing a version file', () => {
  let repo: FixtureRepo;

  beforeEach(() => {
    repo = makeFixtureRepo();
  });
  afterEach(() => {
    repo.dispose();
  });

  it('dry-runs without touching the repository', () => {
    const outcome = ingestEngine({
      root: repo.root,
      engineId: 'vllm',
      version: '0.28.0',
      from: join(FIXTURES, 'vllm-argparse-dump.json'),
      dryRun: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.written).toBe(false);
    expect(outcome.params).toBeGreaterThan(5);
    expect(outcome.content).toContain('"extraction_method": "argparse"');
    expect(() => repo.read('engines/vllm/versions/0.28.0.json')).toThrow();
  });

  it('writes a schema-valid file and registers the version', () => {
    const outcome = ingestEngine({
      root: repo.root,
      engineId: 'vllm',
      version: '0.28.0',
      from: join(FIXTURES, 'vllm-argparse-dump.json'),
    });
    expect(outcome.errors).toEqual([]);
    expect(outcome.written).toBe(true);
    expect(outcome.meta_updated).toBe(true);

    const written = repo.read<EngineVersion>('engines/vllm/versions/0.28.0.json');
    expect(written.engine_id).toBe('vllm');
    expect(written.version).toBe('0.28.0');
    // The overlay's curated grouping survives ingestion of a brand new version.
    expect(byName(written.params, 'tensor-parallel-size')!.group).toBe('parallelism');
    expect(byName(written.params, 'tensor-parallel-size')!.impact).toBe('high');

    const meta = repo.read<{ versions_available: string[] }>('engines/vllm/meta.json');
    expect(meta.versions_available).toEqual(['0.26.1', '0.27.1', '0.28.0']);
  });

  it('refuses an engine that is not registered', () => {
    const outcome = ingestEngine({
      root: repo.root,
      engineId: 'not-an-engine',
      version: '1.0.0',
      from: join(FIXTURES, 'vllm-argparse-dump.json'),
      dryRun: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors[0]).toContain('unknown engine');
  });
});
