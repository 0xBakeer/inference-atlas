/**
 * The rule the whole project rests on (SPEC §0.2, §5.3).
 *
 * > A pull request may only add, modify or delete a result file whose
 * > `provenance.github_login` equals its author.
 *
 * That is what makes merge conflicts structurally impossible and what makes every number
 * attributable to somebody who stands behind it. A *modification* is checked twice — the
 * new content and the content at the merge base — because otherwise overwriting somebody
 * else's file with your own login would pass.
 *
 * The check needs both sides of the diff, so it is the one part of validation that only
 * works inside a git checkout with history (`fetch-depth: 0` in `validate.yml`). Without
 * `--pr-author` and `--base` it does nothing at all: a contributor running `pnpm validate`
 * locally is not a pull request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResultRecord } from '@atlas/core';
import type { ChangedFile } from './git.js';
import { showFile } from './git.js';
import type { Reporter } from './report.js';

export interface OwnershipOptions {
  root: string;
  base: string;
  /** `github.event.pull_request.user.login`. */
  author: string;
  /** CI passes this when the pull request carries the `maintainer-override` label. */
  allowOverride?: boolean;
}

const RESULTS = 'results/';

function sameLogin(a: string | null | undefined, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

function loginOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    return (JSON.parse(text) as ResultRecord).provenance?.github_login ?? null;
  } catch {
    return null;
  }
}

function currentLogin(root: string, path: string): string | null {
  const full = join(root, path);
  if (!existsSync(full)) return null;
  try {
    return (
      (JSON.parse(readFileSync(full, 'utf8')) as ResultRecord).provenance?.github_login ?? null
    );
  } catch {
    return null;
  }
}

export function checkOwnership(
  changed: ChangedFile[],
  reporter: Reporter,
  options: OwnershipOptions,
): void {
  const { root, base, author } = options;
  const override = options.allowOverride === true;

  const results = changed.filter(
    (c) => c.path.startsWith(RESULTS) || c.oldPath?.startsWith(RESULTS),
  );
  const others = changed.filter(
    (c) => !c.path.startsWith(RESULTS) && !c.oldPath?.startsWith(RESULTS),
  );
  if (results.length > 0 && others.length > 0) {
    reporter.warn(
      '',
      'mixed-pr',
      `this pull request touches ${results.length} result file(s) and ${others.length} file(s) outside results/ — allowed, but review the non-result changes on their own merits`,
      { related: others.slice(0, 10).map((c) => c.path) },
    );
  }

  /** Report an ownership violation, or downgrade it when the override label is set. */
  const violation = (file: string, code: string, message: string) => {
    if (override) {
      reporter.warn(file, 'ownership-override', `${code}: ${message} (maintainer-override)`);
    } else {
      reporter.error(file, code, message);
    }
  };

  for (const change of results) {
    const path = change.path;

    if (change.status === 'D') {
      const previous = loginOf(showFile(root, base, path));
      if (previous === null) {
        reporter.warn(
          path,
          'ownership-unreadable',
          `deleted file could not be read at ${base}; ownership was not verified`,
        );
      } else if (!sameLogin(previous, author)) {
        violation(
          path,
          'ownership-deleted',
          `deleting a result owned by "${previous}"; only ${previous} may delete it`,
        );
      }
      continue;
    }

    const now = currentLogin(root, path);
    if (now === null) {
      reporter.warn(
        path,
        'ownership-unreadable',
        'file could not be read or has no provenance.github_login; ownership was not verified',
      );
    } else if (!sameLogin(now, author)) {
      violation(
        path,
        change.status === 'A' ? 'ownership-added' : 'ownership-modified',
        `provenance.github_login is "${now}" but the pull request author is "${author}"; you may only submit your own results`,
      );
    }

    if (change.status === 'A') continue;

    // Modified, renamed or copied: the file existed before, so the previous owner counts too.
    const previousPath = change.oldPath ?? path;
    const previous = loginOf(showFile(root, base, previousPath));
    if (previous === null) {
      reporter.warn(
        path,
        'ownership-unreadable',
        `previous version (${base}:${previousPath}) could not be read; the earlier owner was not verified`,
      );
      continue;
    }
    if (!sameLogin(previous, author)) {
      violation(
        path,
        'ownership-modified-previous',
        `this file was authored by "${previous}"; ${author} may not modify or move somebody else's result`,
      );
    }
  }
}
