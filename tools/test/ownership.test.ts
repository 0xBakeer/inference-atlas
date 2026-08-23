/**
 * The ownership rule, against real git.
 *
 * This is the guarantee the whole project rests on — "nobody can overwrite your numbers" —
 * so it is tested against an actual repository with actual commits and an actual branch,
 * not against a mocked `git diff`. Each test builds a base commit on `main`, cuts a branch,
 * does what a contributor would do, and asks `validate` what it thinks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResultRecord } from '@atlas/core';
import { validateRepo } from '../src/validate.js';
import { makeFixtureRepo, makeResult } from './helpers/fixture-repo.js';
import type { FixtureRepo } from './helpers/fixture-repo.js';

let repo: FixtureRepo;
/** The result `alice` owns, committed on `main` before every test. */
let alicePath: string;

function check(options: { author: string; allowOverride?: boolean }) {
  return validateRepo({
    root: repo.root,
    prAuthor: options.author,
    base: 'main',
    allowOverride: options.allowOverride,
  });
}

function codes(outcome: ReturnType<typeof validateRepo>, level: 'error' | 'warn' = 'error') {
  return outcome.issues.filter((i) => i.level === level).map((i) => i.code);
}

beforeEach(() => {
  repo = makeFixtureRepo();
  alicePath = repo.writeResult(makeResult(repo, { login: 'alice' }));
  repo.initGit();
  repo.git('checkout', '-q', '-b', 'contribution');
});

afterEach(() => {
  repo.dispose();
});

describe('adding', () => {
  it('accepts a result whose provenance login is the pull request author', () => {
    repo.writeResult(makeResult(repo, { login: 'bob', startedAt: '2026-08-03T09:00:00Z' }));
    repo.commit('results: bob adds a run');
    const outcome = check({ author: 'bob' });
    expect(codes(outcome)).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('matches the login case-insensitively, the way GitHub does', () => {
    repo.writeResult(makeResult(repo, { login: 'bob', startedAt: '2026-08-03T09:00:00Z' }));
    repo.commit('results: bob adds a run');
    expect(codes(check({ author: 'BoB' }))).toEqual([]);
  });

  it('rejects a result submitted under somebody else’s login', () => {
    repo.writeResult(makeResult(repo, { login: 'carol', startedAt: '2026-08-03T09:00:00Z' }));
    repo.commit('results: a run attributed to carol');
    const outcome = check({ author: 'bob' });
    expect(codes(outcome)).toContain('ownership-added');
    expect(outcome.ok).toBe(false);
  });
});

describe('modifying', () => {
  it('accepts an owner editing their own file', () => {
    const stored = repo.read<ResultRecord>(alicePath);
    stored.provenance.notes = 'Re-checked the ambient temperature.';
    repo.write(alicePath, stored);
    repo.commit('results: alice adds a note');
    expect(codes(check({ author: 'alice' }))).toEqual([]);
  });

  it('rejects editing a file authored by somebody else', () => {
    const stored = repo.read<ResultRecord>(alicePath);
    stored.provenance.notes = 'I think this number is wrong.';
    repo.write(alicePath, stored);
    repo.commit('results: bob edits alice’s run');
    const outcome = check({ author: 'bob' });
    expect(codes(outcome)).toContain('ownership-modified-previous');
    expect(outcome.ok).toBe(false);
  });

  it('rejects overwriting somebody else’s file with your own login', () => {
    // The give-away this check exists for: the *new* content passes the author check, and
    // only the previous version reveals that the file belonged to alice.
    const stored = repo.read<ResultRecord>(alicePath);
    stored.provenance.github_login = 'bob';
    repo.write(alicePath, stored);
    repo.commit('results: bob claims alice’s file');
    const outcome = check({ author: 'bob' });
    expect(codes(outcome)).toContain('ownership-modified-previous');
  });
});

describe('deleting', () => {
  it('accepts an owner deleting their own file', () => {
    repo.remove(alicePath);
    repo.commit('results: alice withdraws a run');
    expect(codes(check({ author: 'alice' }))).toEqual([]);
  });

  it('rejects deleting somebody else’s file', () => {
    repo.remove(alicePath);
    repo.commit('results: bob deletes alice’s run');
    const outcome = check({ author: 'bob' });
    expect(codes(outcome)).toContain('ownership-deleted');
    expect(outcome.ok).toBe(false);
  });
});

describe('renaming', () => {
  it('rejects moving somebody else’s file', () => {
    const stored = repo.read<ResultRecord>(alicePath);
    repo.remove(alicePath);
    repo.write(`results/vllm/Qwen/Qwen3-8B/apple-m2-max-32gb/${stored.run_id}.json`, stored);
    repo.commit('results: bob moves alice’s run');
    const outcome = check({ author: 'bob' });
    expect(codes(outcome).some((c) => c.startsWith('ownership-'))).toBe(true);
  });
});

describe('flags and escapes', () => {
  it('downgrades a violation to a warning under --allow-override', () => {
    repo.remove(alicePath);
    repo.commit('chore: maintainer removes a disputed run');
    const outcome = check({ author: 'maintainer', allowOverride: true });
    expect(codes(outcome)).toEqual([]);
    expect(codes(outcome, 'warn')).toContain('ownership-override');
    expect(outcome.ok).toBe(true);
  });

  it('warns about a pull request that mixes results with other files', () => {
    repo.writeResult(makeResult(repo, { login: 'bob', startedAt: '2026-08-03T09:00:00Z' }));
    const hardware = repo.read<Record<string, unknown>>('hardware/nvidia-rtx-4090.json');
    hardware.notes = 'Added a note in the same pull request.';
    repo.write('hardware/nvidia-rtx-4090.json', hardware);
    repo.commit('results + registry in one pull request');
    const outcome = check({ author: 'bob' });
    expect(codes(outcome)).toEqual([]);
    expect(codes(outcome, 'warn')).toContain('mixed-pr');
  });

  it('does nothing at all without a pull request context', () => {
    repo.writeResult(makeResult(repo, { login: 'carol', startedAt: '2026-08-03T09:00:00Z' }));
    repo.commit('results: a run attributed to carol');
    const outcome = validateRepo({ root: repo.root });
    expect(codes(outcome).some((c) => c.startsWith('ownership-'))).toBe(false);
    expect(outcome.ok).toBe(true);
  });

  it('reports a base ref it cannot diff against instead of passing silently', () => {
    const outcome = validateRepo({
      root: repo.root,
      prAuthor: 'bob',
      base: 'origin/does-not-exist',
    });
    expect(codes(outcome)).toContain('git-diff-failed');
  });
});
