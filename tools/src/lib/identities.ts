/**
 * Who committed this? — the half of contributor identity git cannot answer on its own.
 *
 * A result file carries `provenance.github_login`, and validate checks it against the pull
 * request author, so results are attributable by construction. A registry file — a piece of
 * hardware, a model, a quant, a workload — carries no such field: the only identity in its
 * history is the author address of the commit that added it. GitHub's noreply addresses
 * spell the login (`loginFromEmail`), but an ordinary address does not, and the SPEC
 * refuses to guess a login from a display name. The consequence was that a contributor who
 * commits as `you@yourdomain.com` earned nothing for widening the registry.
 *
 * `site/identities.json` closes that gap without guessing: a maintained map from author
 * address to login, where every entry can cite the pull requests GitHub itself recorded
 * that login as the author of. Two rules keep it honest — an address belongs to exactly one
 * login, and a pull request may only touch the entry for its own author (see
 * `ownership.ts`) — so the map is self-service without being a way to take somebody else's
 * points.
 *
 * The build reads only this file. Nothing here talks to the network: `resolve-identities`
 * is the tool that proposes entries from the GitHub API, and it writes them here first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginFromEmail } from './git.js';
import type { Reporter } from './report.js';

export const IDENTITIES_PATH = 'site/identities.json';

export interface IdentityEntry {
  login: string;
  emails: string[];
  verified_by?: number[];
  notes?: string | null;
}

export interface IdentityMap {
  schema_version: number;
  identities: IdentityEntry[];
}

/** Addresses are compared case-insensitively: nobody means two people by `A@x` and `a@x`. */
export const emailKey = (email: string): string => email.trim().toLowerCase();

/** Address → login, ready for lookup. */
export type IdentityIndex = Map<string, string>;

export function indexIdentities(map: IdentityMap | null): IdentityIndex {
  const index: IdentityIndex = new Map();
  for (const entry of map?.identities ?? []) {
    for (const email of entry.emails) {
      // First writer wins; `checkIdentities` is what reports the duplicate as an error.
      if (!index.has(emailKey(email))) index.set(emailKey(email), entry.login);
    }
  }
  return index;
}

/** Read the map, or null when the repository has none (a fork need not keep one). */
export function loadIdentities(root: string): IdentityMap | null {
  const file = join(root, IDENTITIES_PATH);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IdentityMap;
  } catch {
    return null;
  }
}

/**
 * The login behind a commit's author address.
 *
 * The noreply form wins: it is GitHub's own statement about the account, needs no
 * maintenance, and cannot drift. The map is consulted only when that says nothing, and
 * still returns null when it has nothing to say — an unattributable commit stays
 * unattributed rather than being credited to a plausible neighbour.
 */
export function resolveLogin(email: string, index?: IdentityIndex | null): string | null {
  const fromAddress = loginFromEmail(email);
  if (fromAddress) return fromAddress;
  return index?.get(emailKey(email)) ?? null;
}

/**
 * Semantic checks the schema cannot express: one address per person, one entry per login,
 * and a noreply address that did not need an entry at all.
 */
export function checkIdentities(map: IdentityMap, reporter: Reporter): void {
  const byEmail = new Map<string, string>();
  const byLogin = new Map<string, number>();

  for (const entry of map.identities) {
    const loginKey = entry.login.trim().toLowerCase();
    const seenAt = byLogin.get(loginKey);
    if (seenAt !== undefined) {
      reporter.error(
        IDENTITIES_PATH,
        'identity-duplicate-login',
        `"${entry.login}" has two entries; put every address of one person in a single entry`,
      );
    } else {
      byLogin.set(loginKey, 1);
    }

    for (const email of entry.emails) {
      const key = emailKey(email);
      const owner = byEmail.get(key);
      if (owner !== undefined && owner !== loginKey) {
        reporter.error(
          IDENTITIES_PATH,
          'identity-email-conflict',
          `${email} is claimed by both "${owner}" and "${entry.login}"; an address can only belong to one account`,
        );
        continue;
      }
      byEmail.set(key, loginKey);

      const fromAddress = loginFromEmail(email);
      if (fromAddress && fromAddress.toLowerCase() !== loginKey) {
        reporter.error(
          IDENTITIES_PATH,
          'identity-contradicts-address',
          `${email} is GitHub's noreply address for "${fromAddress}" but is mapped to "${entry.login}"`,
        );
      } else if (fromAddress) {
        reporter.warn(
          IDENTITIES_PATH,
          'identity-redundant',
          `${email} already carries the login; the entry is harmless but does nothing`,
        );
      }
    }

    if (!entry.verified_by || entry.verified_by.length === 0) {
      reporter.warn(
        IDENTITIES_PATH,
        'identity-unverified',
        `"${entry.login}" cites no pull request; add verified_by so the mapping can be checked against what GitHub recorded`,
      );
    }
  }
}

/**
 * The logins an edit to the map touches — added, removed, or had their addresses changed.
 *
 * Ownership is decided on this set: you may edit your own entry and nobody else's, which
 * is the same rule result files live under.
 */
export function touchedLogins(before: IdentityMap | null, after: IdentityMap | null): string[] {
  const fingerprint = (map: IdentityMap | null): Map<string, string> => {
    const out = new Map<string, string>();
    for (const entry of map?.identities ?? []) {
      out.set(
        entry.login.trim().toLowerCase(),
        JSON.stringify({
          login: entry.login,
          emails: [...entry.emails].map(emailKey).sort(),
          verified_by: [...(entry.verified_by ?? [])].sort((a, b) => a - b),
        }),
      );
    }
    return out;
  };

  const a = fingerprint(before);
  const b = fingerprint(after);
  const touched = new Set<string>();
  for (const [login, value] of b) if (a.get(login) !== value) touched.add(login);
  for (const [login] of a) if (!b.has(login)) touched.add(login);
  return [...touched].sort();
}
