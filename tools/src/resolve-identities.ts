#!/usr/bin/env tsx
/**
 * `resolve-identities` — propose `site/identities.json` entries from what GitHub recorded.
 *
 *   pnpm --filter @atlas/tools run resolve-identities            # report only
 *   pnpm --filter @atlas/tools run resolve-identities --write    # write the map
 *
 * A registry file's only identity is the author address of the commit that added it, and an
 * ordinary address does not spell a GitHub login. The map fixes that (see
 * `lib/identities.ts`), but somebody has to fill it in, and filling it in by reading display
 * names is exactly the guess the SPEC forbids.
 *
 * This does it from evidence instead. Every registry file merged through a pull request was
 * added by a squash commit whose subject ends `(#123)`, and the GitHub API says who that
 * pull request's author was. Address plus pull request author is a mapping GitHub itself
 * asserts; the number goes into `verified_by` so anyone can check it later without running
 * this tool. A commit with no pull request, or one the API cannot confirm, is reported and
 * left alone — the map only ever grows by evidence.
 *
 * Nothing here runs during a build. `tools/build` reads the committed file and never the
 * network, so the compiled data stays deterministic and works offline.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgv } from './lib/args.js';
import { addCommits, isGitRepo, parsePr } from './lib/git.js';
import type { IdentityEntry, IdentityMap } from './lib/identities.js';
import { IDENTITIES_PATH, emailKey, indexIdentities, resolveLogin } from './lib/identities.js';
import { Reporter } from './lib/report.js';
import { loadRepo } from './lib/repo.js';
import { REPO_ROOT } from './lib/root.js';

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface ResolveIdentityOptions {
  token?: string | null;
  fetchImpl?: FetchLike;
}

/** An address that carries registry files but resolves to no login. */
export interface UnattributedAddress {
  email: string;
  /** Registry files added under this address. */
  files: number;
  /** Pull requests those files arrived in, newest last. */
  prs: number[];
}

export interface Proposal {
  email: string;
  login: string;
  /** The pull request whose recorded author is this login. */
  pr: number;
  files: number;
}

export interface ResolveIdentitiesOutcome {
  proposals: Proposal[];
  /** Addresses no pull request could speak for. */
  unresolved: UnattributedAddress[];
  written: boolean;
}

/** Every registry path the credit calculation cares about (the same set `build` uses). */
export function registryPaths(repo: ReturnType<typeof loadRepo>): string[] {
  const paths: string[] = [];
  for (const id of repo.hardware.keys()) paths.push(`hardware/${id}.json`);
  for (const id of repo.engines.keys()) paths.push(`engines/${id}/meta.json`);
  for (const [id, entry] of repo.models) {
    paths.push(`models/${id}/model.json`);
    for (const quantId of entry.quants.keys()) paths.push(`models/${id}/quants/${quantId}.json`);
  }
  for (const id of repo.workloads.keys()) paths.push(`workloads/${id}.json`);
  return paths;
}

/**
 * Addresses that added registry files and resolve to nobody — the work this tool exists
 * for, in the order the leaderboard would care about (most files first).
 */
export function unattributedAddresses(
  root: string,
  repo: ReturnType<typeof loadRepo>,
): UnattributedAddress[] {
  const index = indexIdentities(repo.identities);
  const commits = addCommits(root, registryPaths(repo));
  const byEmail = new Map<string, UnattributedAddress>();

  for (const commit of commits.values()) {
    if (resolveLogin(commit.email, index)) continue;
    const key = emailKey(commit.email);
    const entry = byEmail.get(key) ?? { email: commit.email, files: 0, prs: [] };
    entry.files += 1;
    const pr = parsePr(commit.subject);
    if (pr !== null && !entry.prs.includes(pr)) entry.prs.push(pr);
    byEmail.set(key, entry);
  }

  return [...byEmail.values()]
    .map((e) => ({ ...e, prs: [...e.prs].sort((a, b) => a - b) }))
    .sort((a, b) => b.files - a.files || a.email.localeCompare(b.email));
}

/** The login GitHub recorded as a pull request's author, or null when it cannot say. */
export async function prAuthor(
  owner: string,
  repoName: string,
  pr: number,
  options: ResolveIdentityOptions = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'inference-atlas-tools',
  };
  const token = options.token ?? process.env.GITHUB_TOKEN ?? null;
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${owner}/${repoName}/pulls/${pr}`, {
      headers,
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json()) as { user?: { login?: unknown } };
  const login = body.user?.login;
  return typeof login === 'string' && login.length > 0 ? login : null;
}

/** Fold proposals into the map, keeping one entry per login and never dropping anything. */
export function applyProposals(map: IdentityMap | null, proposals: Proposal[]): IdentityMap {
  const next: IdentityMap = map
    ? { ...map, identities: map.identities.map((e) => ({ ...e, emails: [...e.emails] })) }
    : { schema_version: 1, identities: [] };

  for (const proposal of proposals) {
    const key = proposal.login.trim().toLowerCase();
    let entry: IdentityEntry | undefined = next.identities.find(
      (e) => e.login.trim().toLowerCase() === key,
    );
    if (!entry) {
      entry = { login: proposal.login, emails: [], verified_by: [] };
      next.identities.push(entry);
    }
    if (!entry.emails.some((e) => emailKey(e) === emailKey(proposal.email))) {
      entry.emails.push(proposal.email);
    }
    entry.verified_by = [...new Set([...(entry.verified_by ?? []), proposal.pr])].sort(
      (a, b) => a - b,
    );
  }

  next.identities.sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
  return next;
}

export async function resolveIdentities(
  root: string,
  options: ResolveIdentityOptions & { write?: boolean } = {},
): Promise<ResolveIdentitiesOutcome> {
  const reporter = new Reporter();
  const repo = loadRepo(root, reporter);
  const owner = repo.site?.repo?.owner;
  const name = repo.site?.repo?.name;
  if (!owner || !name) throw new Error('site/config.json does not name the repository');

  const pending = unattributedAddresses(root, repo);
  const proposals: Proposal[] = [];
  const unresolved: UnattributedAddress[] = [];

  for (const address of pending) {
    let matched: Proposal | null = null;
    // Newest pull request first: it is the one whose author account still exists.
    for (const pr of [...address.prs].reverse()) {
      const login = await prAuthor(owner, name, pr, options);
      if (login) {
        matched = { email: address.email, login, pr, files: address.files };
        break;
      }
    }
    if (matched) proposals.push(matched);
    else unresolved.push(address);
  }

  let written = false;
  if (options.write === true && proposals.length > 0) {
    const file = join(root, IDENTITIES_PATH);
    const current: IdentityMap | null = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as IdentityMap)
      : null;
    writeFileSync(file, `${JSON.stringify(applyProposals(current, proposals), null, 2)}\n`, 'utf8');
    written = true;
  }

  return { proposals, unresolved, written };
}

/* ----------------------------------------------------------------------- CLI */

async function main(argv: string[]): Promise<number> {
  const args = parseArgv(argv, { boolean: ['json', 'write'] });
  const root = resolve(args.str('root', REPO_ROOT));
  if (!isGitRepo(root)) {
    process.stderr.write('not a git checkout with history; nothing to resolve\n');
    return 2;
  }

  const outcome = await resolveIdentities(root, {
    token: args.str('token'),
    write: args.bool('write'),
  });

  if (args.bool('json')) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return 0;
  }

  if (outcome.proposals.length === 0 && outcome.unresolved.length === 0) {
    process.stdout.write('every registry file already resolves to a contributor\n');
    return 0;
  }
  for (const p of outcome.proposals) {
    process.stdout.write(
      `${p.email} → ${p.login}  (PR #${p.pr}, ${p.files} registry file${p.files === 1 ? '' : 's'})\n`,
    );
  }
  for (const u of outcome.unresolved) {
    process.stderr.write(
      `warn  ${u.email} adds ${u.files} registry file(s) but no pull request could name its author` +
        `${u.prs.length > 0 ? ` (tried #${u.prs.join(', #')})` : ' (no pull request in the commit subject)'}\n`,
    );
  }
  process.stdout.write(
    outcome.written
      ? `wrote ${IDENTITIES_PATH}\n`
      : `run again with --write to record ${outcome.proposals.length} mapping(s)\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
