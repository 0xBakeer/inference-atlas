/**
 * Resolving logins to numeric user ids.
 *
 * `fetch` is injected rather than hit: this runs on every pull request and a test that
 * calls api.github.com would be rate-limited and flaky. What matters is the policy around
 * the call — one request per distinct login, an id written into the file, a login that does
 * not exist failing the command, and a rate limit *not* failing it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResultRecord } from '@atlas/core';
import { resolveUser, stampUserIds } from '../src/resolve-user.js';
import type { FetchLike } from '../src/resolve-user.js';
import { makeFixtureRepo, makeResult } from './helpers/fixture-repo.js';
import type { FixtureRepo } from './helpers/fixture-repo.js';

let repo: FixtureRepo;

/** A fetch that answers from a table and records what it was asked. */
function fakeFetch(
  users: Record<string, number | 404 | 403>,
  calls: string[] = [],
): { fetchImpl: FetchLike; calls: string[] } {
  const fetchImpl: FetchLike = async (url) => {
    const login = decodeURIComponent(url.split('/').pop()!);
    calls.push(login);
    const answer = users[login];
    if (answer === undefined || answer === 404) {
      return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    }
    if (answer === 403) {
      return { ok: false, status: 403, json: async () => ({ message: 'rate limit' }) };
    }
    return { ok: true, status: 200, json: async () => ({ login, id: answer }) };
  };
  return { fetchImpl, calls };
}

beforeEach(() => {
  repo = makeFixtureRepo();
});
afterEach(() => {
  repo.dispose();
});

describe('resolveUser', () => {
  it('returns the numeric id', async () => {
    const { fetchImpl } = fakeFetch({ octocat: 583231 });
    await expect(resolveUser('octocat', { fetchImpl })).resolves.toEqual({
      login: 'octocat',
      id: 583231,
    });
  });

  it('distinguishes a login that does not exist from a call that failed', async () => {
    const { fetchImpl } = fakeFetch({ ghost: 404, limited: 403 });
    expect(await resolveUser('ghost', { fetchImpl })).toMatchObject({
      id: null,
      reason: 'not-found',
    });
    expect(await resolveUser('limited', { fetchImpl })).toMatchObject({
      id: null,
      reason: 'failed',
    });
  });

  it('treats a network error as a failure, not as a missing user', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await resolveUser('octocat', { fetchImpl })).toMatchObject({
      id: null,
      reason: 'failed',
    });
  });
});

describe('stampUserIds', () => {
  it('writes the id into the file and asks once per distinct login', async () => {
    const first = repo.writeResult(makeResult(repo, { login: 'octocat' }));
    const second = repo.writeResult(
      makeResult(repo, { login: 'octocat', startedAt: '2026-08-02T09:00:00Z' }),
    );
    const { fetchImpl, calls } = fakeFetch({ octocat: 583231 });

    const outcome = await stampUserIds(repo.root, [first, second], { fetchImpl });
    expect(outcome.updated.sort()).toEqual([first, second].sort());
    expect(outcome.resolved).toEqual({ octocat: 583231 });
    expect(calls).toEqual(['octocat']);
    expect(repo.read<ResultRecord>(first).provenance.github_user_id).toBe(583231);
  });

  it('skips a file that already carries an id', async () => {
    const result = makeResult(repo, { login: 'octocat' });
    result.provenance.github_user_id = 1;
    const path = repo.writeResult(result);
    const { fetchImpl, calls } = fakeFetch({ octocat: 583231 });

    const outcome = await stampUserIds(repo.root, [path], { fetchImpl });
    expect(outcome.skipped).toEqual([path]);
    expect(outcome.updated).toEqual([]);
    expect(calls).toEqual([]);
    expect(repo.read<ResultRecord>(path).provenance.github_user_id).toBe(1);
  });

  it('ignores anything that is not a result file', async () => {
    const { fetchImpl, calls } = fakeFetch({ octocat: 583231 });
    const outcome = await stampUserIds(repo.root, ['hardware/nvidia-rtx-4090.json', 'README.md'], {
      fetchImpl,
    });
    expect(outcome.updated).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('reports a login that does not exist', async () => {
    const path = repo.writeResult(makeResult(repo, { login: 'ghost' }));
    const { fetchImpl } = fakeFetch({ ghost: 404 });
    const outcome = await stampUserIds(repo.root, [path], { fetchImpl });
    expect(outcome.unknown).toEqual(['ghost']);
    expect(outcome.updated).toEqual([]);
  });

  it('leaves the field null when the API could not be reached', async () => {
    const path = repo.writeResult(makeResult(repo, { login: 'octocat' }));
    const { fetchImpl } = fakeFetch({ octocat: 403 });
    const outcome = await stampUserIds(repo.root, [path], { fetchImpl });
    expect(outcome.unresolved).toEqual(['octocat']);
    expect(outcome.unknown).toEqual([]);
    expect(repo.read<ResultRecord>(path).provenance.github_user_id).toBeNull();
  });

  it('changes nothing under --dry-run', async () => {
    const path = repo.writeResult(makeResult(repo, { login: 'octocat' }));
    const { fetchImpl } = fakeFetch({ octocat: 583231 });
    const outcome = await stampUserIds(repo.root, [path], { fetchImpl, dryRun: true });
    expect(outcome.updated).toEqual([path]);
    expect(repo.read<ResultRecord>(path).provenance.github_user_id).toBeNull();
  });
});
