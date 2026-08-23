#!/usr/bin/env tsx
/**
 * `resolve-users` — turn GitHub logins into numeric user ids (SPEC §5.7).
 *
 *   pnpm --filter @atlas/tools run resolve-users --changed results/**\/*.json
 *
 * Why the id matters: a login can be renamed and then claimed by somebody else, but the
 * numeric id is permanent. Attribution, the contributors page and the avatar URL all key on
 * it. The contributor leaves `provenance.github_user_id` null; `validate.yml` runs this on
 * the pull request branch and pushes a `chore: stamp github_user_id` commit.
 *
 * A login that does not exist is an error — a result attributed to a non-existent account
 * has no owner and the ownership rule would have nothing to check. Anything else (a rate
 * limit, a network blip) leaves the field null and warns: the build resolves it later, and
 * a flaky API must never fail somebody's contribution.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResultRecord } from '@atlas/core';
import { parseArgv } from './lib/args.js';
import { REPO_ROOT } from './lib/root.js';

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface ResolveOptions {
  token?: string | null;
  /** Injected by the tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
}

export type Resolution =
  | { login: string; id: number }
  | { login: string; id: null; reason: 'not-found' | 'failed'; status: number };

const API = 'https://api.github.com/users';

export async function resolveUser(
  login: string,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'inference-atlas-tools',
  };
  const token = options.token ?? process.env.GITHUB_TOKEN ?? null;
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${API}/${encodeURIComponent(login)}`, { headers });
  } catch {
    return { login, id: null, reason: 'failed', status: 0 };
  }
  if (response.status === 404) return { login, id: null, reason: 'not-found', status: 404 };
  if (!response.ok) return { login, id: null, reason: 'failed', status: response.status };

  const body = (await response.json()) as { id?: unknown };
  return typeof body.id === 'number'
    ? { login, id: body.id }
    : { login, id: null, reason: 'failed', status: response.status };
}

/** One request per distinct login, however many files mention it. */
export async function resolveUsers(
  logins: Iterable<string>,
  options: ResolveOptions = {},
): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  for (const login of new Set([...logins].map((l) => l.trim()).filter(Boolean))) {
    out.set(login, await resolveUser(login, options));
  }
  return out;
}

export interface StampOutcome {
  /** Files rewritten with a newly resolved id. */
  updated: string[];
  /** Files already carrying an id — left untouched. */
  skipped: string[];
  resolved: Record<string, number>;
  /** Logins the API says do not exist; these fail the command. */
  unknown: string[];
  /** Logins that could not be checked (rate limit, network). */
  unresolved: string[];
}

export async function stampUserIds(
  root: string,
  files: string[],
  options: ResolveOptions & { dryRun?: boolean } = {},
): Promise<StampOutcome> {
  const targets = files
    .map((file) => file.trim().replace(/^\.\//, ''))
    .filter((file) => file.startsWith('results/') && file.endsWith('.json'))
    .filter((file) => existsSync(join(root, file)));

  const pending: Array<{ file: string; data: ResultRecord }> = [];
  const skipped: string[] = [];
  for (const file of targets) {
    const data = JSON.parse(readFileSync(join(root, file), 'utf8')) as ResultRecord;
    if (data.provenance?.github_user_id != null) skipped.push(file);
    else pending.push({ file, data });
  }

  const resolutions = await resolveUsers(
    pending.map((p) => p.data.provenance.github_login),
    options,
  );

  const updated: string[] = [];
  const resolved: Record<string, number> = {};
  const unknown = new Set<string>();
  const unresolved = new Set<string>();

  for (const { file, data } of pending) {
    const resolution = resolutions.get(data.provenance.github_login);
    if (!resolution || resolution.id === null) {
      if (resolution?.reason === 'not-found') unknown.add(data.provenance.github_login);
      else unresolved.add(data.provenance.github_login);
      continue;
    }
    resolved[resolution.login] = resolution.id;
    if (options.dryRun === true) {
      updated.push(file);
      continue;
    }
    data.provenance.github_user_id = resolution.id;
    writeFileSync(join(root, file), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    updated.push(file);
  }

  return {
    updated,
    skipped,
    resolved,
    unknown: [...unknown].sort(),
    unresolved: [...unresolved].sort(),
  };
}

/* ----------------------------------------------------------------------- CLI */

async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv, { variadic: ['changed'], boolean: ['json', 'dry-run'] });
  const root = resolve(args.str('root', REPO_ROOT));
  const files = args.list('changed');
  if (files.length === 0) {
    process.stderr.write('usage: resolve-users --changed <result files...> [--dry-run] [--json]\n');
    return 2;
  }

  const outcome = await stampUserIds(root, files, {
    token: args.str('token'),
    dryRun: args.bool('dry-run'),
  });

  if (args.bool('json')) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else {
    process.stdout.write(
      `resolved ${Object.keys(outcome.resolved).length} login(s), ` +
        `stamped ${outcome.updated.length} file(s), ${outcome.skipped.length} already had an id\n`,
    );
    for (const login of outcome.unresolved) {
      process.stderr.write(`warn  could not resolve "${login}" right now; left null\n`);
    }
    for (const login of outcome.unknown) {
      process.stderr.write(`ERROR github login "${login}" does not exist\n`);
    }
  }
  return outcome.unknown.length > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
