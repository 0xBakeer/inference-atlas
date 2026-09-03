/**
 * The identity map: what it resolves, what it refuses to resolve, and the rules that stop
 * it becoming a way to take somebody else's registry credit.
 */
import { describe, expect, it } from 'vitest';
import {
  checkIdentities,
  emailKey,
  indexIdentities,
  resolveLogin,
  touchedLogins,
} from '../src/lib/identities.js';
import type { IdentityMap } from '../src/lib/identities.js';
import { applyProposals } from '../src/resolve-identities.js';
import { Reporter } from '../src/lib/report.js';

const map: IdentityMap = {
  schema_version: 1,
  identities: [
    { login: 'GraithSecurity', emails: ['johann@graith.io'], verified_by: [194] },
    { login: 'johntdavies', emails: ['John.davies@incept5.com'], verified_by: [112] },
  ],
};

const codes = (reporter: Reporter): string[] => reporter.issues.map((i) => i.code);

describe('resolveLogin', () => {
  const index = indexIdentities(map);

  it('reads the login straight out of a GitHub noreply address', () => {
    expect(resolveLogin('95100110+AzeezIsh@users.noreply.github.com', index)).toBe('AzeezIsh');
    expect(resolveLogin('octocat@users.noreply.github.com', null)).toBe('octocat');
  });

  it('falls back to the map for an ordinary address', () => {
    expect(resolveLogin('johann@graith.io', index)).toBe('GraithSecurity');
  });

  it('matches addresses case-insensitively, the way people type them', () => {
    expect(resolveLogin('john.davies@incept5.com', index)).toBe('johntdavies');
    expect(resolveLogin('  JOHN.DAVIES@INCEPT5.COM ', index)).toBe('johntdavies');
  });

  it('still credits nobody for an address nobody has claimed', () => {
    expect(resolveLogin('stranger@example.com', index)).toBeNull();
    expect(resolveLogin('stranger@example.com', null)).toBeNull();
  });

  it('prefers the address GitHub wrote over anything the map says', () => {
    const hostile = indexIdentities({
      schema_version: 1,
      identities: [{ login: 'thief', emails: ['95100110+AzeezIsh@users.noreply.github.com'] }],
    });
    expect(resolveLogin('95100110+AzeezIsh@users.noreply.github.com', hostile)).toBe('AzeezIsh');
  });
});

describe('checkIdentities', () => {
  it('passes a well-formed map', () => {
    const reporter = new Reporter();
    checkIdentities(map, reporter);
    expect(codes(reporter)).toEqual([]);
  });

  it('rejects one address claimed by two people', () => {
    const reporter = new Reporter();
    checkIdentities(
      {
        schema_version: 1,
        identities: [
          { login: 'alice', emails: ['shared@example.com'], verified_by: [1] },
          { login: 'bob', emails: ['shared@example.com'], verified_by: [2] },
        ],
      },
      reporter,
    );
    expect(codes(reporter)).toContain('identity-email-conflict');
  });

  it('rejects two entries for one login', () => {
    const reporter = new Reporter();
    checkIdentities(
      {
        schema_version: 1,
        identities: [
          { login: 'alice', emails: ['a@example.com'], verified_by: [1] },
          { login: 'Alice', emails: ['b@example.com'], verified_by: [2] },
        ],
      },
      reporter,
    );
    expect(codes(reporter)).toContain('identity-duplicate-login');
  });

  it('rejects a noreply address pointed at somebody else', () => {
    const reporter = new Reporter();
    checkIdentities(
      {
        schema_version: 1,
        identities: [
          { login: 'thief', emails: ['victim@users.noreply.github.com'], verified_by: [1] },
        ],
      },
      reporter,
    );
    expect(codes(reporter)).toContain('identity-contradicts-address');
  });

  it('warns about an entry that cites no pull request', () => {
    const reporter = new Reporter();
    checkIdentities(
      { schema_version: 1, identities: [{ login: 'alice', emails: ['a@example.com'] }] },
      reporter,
    );
    expect(codes(reporter)).toContain('identity-unverified');
  });
});

describe('touchedLogins', () => {
  it('sees nothing when nothing changed', () => {
    expect(touchedLogins(map, structuredClone(map))).toEqual([]);
  });

  it('names the login whose addresses changed', () => {
    const after = structuredClone(map);
    after.identities[0]!.emails.push('second@graith.io');
    expect(touchedLogins(map, after)).toEqual(['graithsecurity']);
  });

  it('names an added and a removed entry', () => {
    const added = structuredClone(map);
    added.identities.push({ login: 'newcomer', emails: ['n@example.com'] });
    expect(touchedLogins(map, added)).toEqual(['newcomer']);

    const removed = structuredClone(map);
    removed.identities.splice(1, 1);
    expect(touchedLogins(map, removed)).toEqual(['johntdavies']);
  });

  it('treats an absent map as an empty one, so seeding names every entry', () => {
    expect(touchedLogins(null, map)).toEqual(['graithsecurity', 'johntdavies']);
  });
});

describe('applyProposals', () => {
  it('creates an entry and records the pull request that proved it', () => {
    const next = applyProposals(null, [
      { email: 'new@example.com', login: 'newcomer', pr: 42, files: 3 },
    ]);
    expect(next.identities).toEqual([
      { login: 'newcomer', emails: ['new@example.com'], verified_by: [42] },
    ]);
  });

  it('adds an address to the entry a person already has', () => {
    const next = applyProposals(map, [
      { email: 'second@graith.io', login: 'GraithSecurity', pr: 196, files: 1 },
    ]);
    const entry = next.identities.find((e) => e.login === 'GraithSecurity')!;
    expect(entry.emails).toEqual(['johann@graith.io', 'second@graith.io']);
    expect(entry.verified_by).toEqual([194, 196]);
  });

  it('is idempotent — proposing what is already recorded changes nothing', () => {
    const once = applyProposals(map, [
      { email: 'johann@graith.io', login: 'GraithSecurity', pr: 194, files: 1 },
    ]);
    expect(once.identities.find((e) => e.login === 'GraithSecurity')).toEqual({
      login: 'GraithSecurity',
      emails: ['johann@graith.io'],
      verified_by: [194],
    });
  });
});

describe('emailKey', () => {
  it('folds case and surrounding space, and nothing else', () => {
    expect(emailKey('  A@B.com ')).toBe('a@b.com');
    expect(emailKey('a+tag@b.com')).toBe('a+tag@b.com');
  });
});
