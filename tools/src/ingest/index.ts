#!/usr/bin/env tsx
/**
 * `pnpm ingest` — write `engines/<id>/versions/<version>.json` from the engine itself.
 *
 *   pnpm ingest --engine vllm --version 0.28.0                     # docker (default for vllm)
 *   pnpm ingest --engine sglang --version 0.5.5 --method pip       # current environment
 *   pnpm ingest --engine llamacpp --version b7100 --method help-text
 *   pnpm ingest --engine vllm --version 0.28.0 --from dump.json --dry-run
 *
 * Why this exists (DESIGN §3.4): the defaults in a version file are load-bearing —
 * canonicalization drops any flag whose value equals the default, so one wrong default
 * silently merges two different configurations into one fingerprint. Hand-maintaining that
 * across nine engines and a release every two weeks is not a thing anybody does correctly.
 *
 * `--from <file>` reads a captured argparse dump or help text instead of running anything,
 * which is how the parsers are unit-tested and how a contributor without docker can still
 * contribute a version file from a `--help` they pasted into a file.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineMeta, EngineOverlay, EngineParam, EngineVersion } from '@atlas/core';
import { parseArgv } from './../lib/args.js';
import { loadRepo } from './../lib/repo.js';
import { Reporter } from './../lib/report.js';
import { REPO_ROOT } from './../lib/root.js';
import { serialize } from './../lib/write.js';
import type { ArgparseDump } from './argparse.js';
import { paramsFromArgparse } from './argparse.js';
import { paramsFromHelpText, paramsFromOllamaHelp } from './helptext.js';
import { HELP_COMMANDS, SNIPPETS } from './snippets.js';

export type IngestMethod = 'docker' | 'pip' | 'help-text';

export interface IngestOptions {
  root: string;
  engineId: string;
  version: string;
  method?: IngestMethod | null;
  /** Captured argparse dump or help text; skips execution entirely. */
  from?: string | null;
  dryRun?: boolean;
}

export interface IngestOutcome {
  ok: boolean;
  engine_id: string;
  version: string;
  method: IngestMethod;
  path: string;
  params: number;
  /** The file content, whether or not it was written. */
  content: string;
  written: boolean;
  /** True when `versions_available` in meta.json gained an entry. */
  meta_updated: boolean;
  errors: string[];
}

/* ------------------------------------------------------------------- parsing */

export type SourceKind = 'argparse' | 'help' | 'ollama-help';

/** Which parser to use: an argparse dump is JSON, everything else is text. */
export function parseSource(
  engineId: string,
  text: string,
): { params: EngineParam[]; kind: SourceKind } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const dump = JSON.parse(trimmed) as ArgparseDump;
    return { params: paramsFromArgparse(dump), kind: 'argparse' };
  }
  if (engineId === 'ollama') return { params: paramsFromOllamaHelp(text), kind: 'ollama-help' };
  return { params: paramsFromHelpText(text), kind: 'help' };
}

/**
 * Fold in what a human knows and a parser cannot: the group a flag belongs to and how much
 * it moves the numbers. The overlay is the curated layer; the previous version file is the
 * fallback, so annotations survive an engine release without being retyped.
 */
export function applyAnnotations(
  params: EngineParam[],
  overlay: EngineOverlay | null,
  previous: EngineVersion | null,
): EngineParam[] {
  const before = new Map((previous?.params ?? []).map((p) => [p.name, p]));
  return params.map((param) => {
    const curated = overlay?.params?.[param.name];
    const old = before.get(param.name);
    const group = curated?.group ?? old?.group ?? null;
    const impact = curated?.impact ?? old?.impact ?? null;
    return {
      ...param,
      help: param.help ?? old?.help ?? null,
      ...(group ? { group } : {}),
      ...(impact ? { impact } : {}),
    };
  });
}

/* ----------------------------------------------------------------- execution */

function firstInstall(meta: EngineMeta, method: 'docker' | 'pip') {
  return meta.install?.find((i) => i.method === method) ?? null;
}

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (proc.error) return { ok: false, stdout: '', stderr: String(proc.error) };
  return { ok: proc.status === 0, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/**
 * Run the introspection snippet inside the engine's own container.
 *
 * Implemented but not exercised in this repository's own test run: it needs a docker
 * daemon and a multi-gigabyte image pull. `ingest-engines.yml` is where it actually runs,
 * nightly, on a CPU-only runner — building an argparse parser never touches the GPU.
 */
export function captureFromDocker(meta: EngineMeta, version: string): string {
  const install = firstInstall(meta, 'docker');
  const image = (install?.image ?? '').replace('{version}', version);
  if (!image) throw new Error(`engine "${meta.id}" has no docker install method with an image`);
  const snippet = SNIPPETS[meta.id];
  if (!snippet) throw new Error(`no introspection snippet for engine "${meta.id}"`);

  const proc = run('docker', ['run', '--rm', '--entrypoint', 'python3', image, '-c', snippet]);
  if (!proc.ok) throw new Error(`docker run ${image} failed: ${proc.stderr.trim().slice(0, 500)}`);
  return proc.stdout;
}

/** Run the snippet against the engine installed in the current Python environment. */
export function captureFromPip(meta: EngineMeta): string {
  const snippet = SNIPPETS[meta.id];
  if (!snippet) throw new Error(`no introspection snippet for engine "${meta.id}"`);
  const proc = run('python3', ['-c', snippet]);
  if (!proc.ok) {
    throw new Error(`python3 introspection failed: ${proc.stderr.trim().slice(0, 500)}`);
  }
  return proc.stdout;
}

/** Run the engine's `--help` and capture it. */
export function captureFromHelp(meta: EngineMeta): string {
  const command = HELP_COMMANDS[meta.id];
  if (!command) throw new Error(`no --help command registered for engine "${meta.id}"`);
  const proc = run(command[0]!, command.slice(1));
  // Several CLIs print help to stderr and exit non-zero; the text is what matters.
  const text = `${proc.stdout}\n${proc.stderr}`.trim();
  if (text === '') throw new Error(`${command.join(' ')} produced no output`);
  return text;
}

function defaultMethod(engineId: string): IngestMethod {
  if (SNIPPETS[engineId]) return 'docker';
  return 'help-text';
}

/* -------------------------------------------------------------------- ingest */

export function ingestEngine(options: IngestOptions): IngestOutcome {
  const root = options.root;
  const repo = loadRepo(root, new Reporter());
  const entry = repo.engines.get(options.engineId);
  const method = options.method ?? defaultMethod(options.engineId);
  const path = `engines/${options.engineId}/versions/${options.version}.json`;

  const fail = (message: string): IngestOutcome => ({
    ok: false,
    engine_id: options.engineId,
    version: options.version,
    method,
    path,
    params: 0,
    content: '',
    written: false,
    meta_updated: false,
    errors: [message],
  });

  if (!entry)
    return fail(`unknown engine "${options.engineId}" — add engines/<id>/meta.json first`);

  let text: string;
  try {
    if (options.from) {
      text = readFileSync(resolve(options.from), 'utf8');
    } else if (method === 'docker') {
      text = captureFromDocker(entry.meta, options.version);
    } else if (method === 'pip') {
      text = captureFromPip(entry.meta);
    } else {
      text = captureFromHelp(entry.meta);
    }
  } catch (error) {
    return fail((error as Error).message);
  }

  let params: EngineParam[];
  let kind: SourceKind;
  try {
    ({ params, kind } = parseSource(options.engineId, text));
  } catch (error) {
    return fail(`could not parse the captured output: ${(error as Error).message}`);
  }
  if (params.length === 0) return fail('the captured output produced no parameters');

  const previous = newestVersion(entry.versions);
  const annotated = applyAnnotations(params, entry.overlay, previous);

  const version: EngineVersion = {
    schema_version: 1,
    engine_id: options.engineId,
    version: options.version,
    released: null,
    extraction_method: kind === 'argparse' ? 'argparse' : 'help',
    extracted_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: sourceLabel(entry.meta, method, options.version, options.from ?? null),
    notes: null,
    params: annotated,
  };

  const errors = repo.schemas.check('engine-version', version);
  const content = serialize(version, { sorted: true });

  let written = false;
  let metaUpdated = false;
  if (options.dryRun !== true && errors.length === 0) {
    writeFileSync(join(root, path), content, 'utf8');
    written = true;
    metaUpdated = addToVersionsAvailable(root, entry.meta, options.version);
  }

  return {
    ok: errors.length === 0,
    engine_id: options.engineId,
    version: options.version,
    method,
    path,
    params: annotated.length,
    content,
    written,
    meta_updated: metaUpdated,
    errors: errors.map((message) => `engine-version: ${message}`),
  };
}

function sourceLabel(
  meta: EngineMeta,
  method: IngestMethod,
  version: string,
  from: string | null,
): string {
  if (from) return `captured output (${from})`;
  if (method === 'docker') {
    return (meta.install?.find((i) => i.method === 'docker')?.image ?? meta.id).replace(
      '{version}',
      version,
    );
  }
  if (method === 'pip') return `python3 -c "…" against the installed ${meta.id}`;
  return (HELP_COMMANDS[meta.id] ?? [meta.id, '--help']).join(' ');
}

/** Latest registered version, used as the source of hand-written annotations. */
function newestVersion(versions: Map<string, EngineVersion>): EngineVersion | null {
  const ids = [...versions.keys()].sort();
  const last = ids[ids.length - 1];
  return last ? (versions.get(last) ?? null) : null;
}

/**
 * Add the new version to `meta.versions_available`, in place.
 *
 * `meta.json` is edited rather than rewritten from the parsed object so that the file keeps
 * its comments-as-key-order and a reviewer sees a one-line diff in the pull request the
 * nightly workflow opens.
 */
function addToVersionsAvailable(root: string, meta: EngineMeta, version: string): boolean {
  const path = join(root, 'engines', meta.id, 'meta.json');
  if (!existsSync(path)) return false;
  const data = JSON.parse(readFileSync(path, 'utf8')) as EngineMeta;
  const list = data.versions_available ?? [];
  if (list.includes(version)) return false;
  data.versions_available = [...list, version].sort(compareVersions);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return true;
}

/** Numeric-aware version order: `0.9.0` before `0.27.1`, `b6999` before `b7000`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const ta = pa[i] ?? '';
    const tb = pb[i] ?? '';
    const na = /^[a-z]*(\d+)$/.exec(ta);
    const nb = /^[a-z]*(\d+)$/.exec(tb);
    if (na && nb) {
      const diff = Number(na[1]) - Number(nb[1]);
      if (diff !== 0) return diff;
      continue;
    }
    if (ta !== tb) return ta < tb ? -1 : 1;
  }
  return 0;
}

/* ----------------------------------------------------------------------- CLI */

function main(argv: string[]): number {
  const args = parseArgv(argv, { boolean: ['dry-run', 'json'] });
  const root = resolve(args.str('root', REPO_ROOT));
  const engineId = args.str('engine');
  const version = args.str('version');

  if (!engineId || !version) {
    process.stderr.write(
      'usage: ingest --engine <id> --version <version> [--method docker|pip|help-text] [--from <file>] [--dry-run]\n',
    );
    return 2;
  }

  const outcome = ingestEngine({
    root,
    engineId,
    version,
    method: (args.str('method') as IngestMethod | null) ?? null,
    from: args.str('from'),
    dryRun: args.bool('dry-run'),
  });

  if (args.bool('json')) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.ok ? 0 : 1;
  }

  for (const error of outcome.errors) process.stderr.write(`ERROR ${error}\n`);
  if (!outcome.ok) return 1;

  if (outcome.written) {
    process.stdout.write(
      `${outcome.path} — ${outcome.params} params via ${outcome.method}` +
        `${outcome.meta_updated ? ', versions_available updated' : ''}\n`,
    );
  } else {
    process.stdout.write(
      `${outcome.path} — ${outcome.params} params via ${outcome.method} (dry run)\n`,
    );
    process.stdout.write(outcome.content);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
