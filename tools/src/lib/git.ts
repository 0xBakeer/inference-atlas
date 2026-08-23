/**
 * Everything the tools ask git for.
 *
 * Two very different jobs live here. `validate` needs *what a pull request changed* and the
 * *previous* content of every file it touched, because the ownership rule is about both
 * versions of a modified file. `build` needs the commit that first added each file, because
 * `provenance.commit` and `provenance.pr` are derived from history rather than typed by the
 * contributor — that is what makes them unfakeable.
 *
 * Every function degrades to `null`/empty outside a git repository (a tarball download, a
 * fresh `git init` with no commits) instead of throwing: the build still has to produce
 * data, it just leaves the stamps null and says `git: false` in the manifest.
 */
import { spawnSync } from 'node:child_process';

export interface GitCommit {
  commit: string;
  commit_short: string;
  subject: string;
  /** Author date, ISO-8601 with offset, as `%aI` prints it. */
  date: string;
  /** Author email — the only place git history knows about GitHub identity. */
  email: string;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface ChangedFile {
  status: ChangeStatus;
  /** Path as of the head of the branch; for a deletion, the path that disappeared. */
  path: string;
  /** Set for renames and copies: where the content came from. */
  oldPath?: string;
}

function run(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const proc = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) return { ok: false, stdout: '', stderr: String(proc.error) };
  return { ok: proc.status === 0, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/** True only when `root` is inside a work tree *and* that work tree has a commit. */
export function isGitRepo(root: string): boolean {
  if (!run(root, ['rev-parse', '--is-inside-work-tree']).ok) return false;
  return run(root, ['rev-parse', 'HEAD']).ok;
}

export function headCommit(root: string): GitCommit | null {
  const proc = run(root, ['log', '-1', '--format=%H%x1f%aI%x1f%ae%x1f%s']);
  if (!proc.ok) return null;
  return parseCommitLine(proc.stdout.trim());
}

export function currentBranch(root: string): string | null {
  const proc = run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return proc.ok ? proc.stdout.trim() : null;
}

function parseCommitLine(line: string): GitCommit | null {
  const [commit, date, email, ...rest] = line.split('\u001f');
  if (!commit) return null;
  return {
    commit,
    commit_short: commit.slice(0, 7),
    date: date ?? '',
    email: email ?? '',
    subject: rest.join('\u001f'),
  };
}

/**
 * `git diff --name-status <base>...HEAD` — what this branch changed since it forked.
 *
 * The three-dot form is deliberate: it compares against the merge base, so commits that
 * landed on `main` after the branch was cut are not attributed to the pull request.
 */
export function changedFiles(root: string, base: string): ChangedFile[] | null {
  const proc = run(root, ['diff', '--name-status', '-M', `${base}...HEAD`]);
  if (!proc.ok) return null;
  const out: ChangedFile[] = [];
  for (const line of proc.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]!;
    const status = code[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[1];
      const path = parts[2];
      if (oldPath && path) out.push({ status, path, oldPath });
      continue;
    }
    const path = parts[1];
    if (path) out.push({ status, path });
  }
  return out;
}

/** Content of a file at a ref, or null when it does not exist there. */
export function showFile(root: string, ref: string, path: string): string | null {
  const proc = run(root, ['show', `${ref}:${path}`]);
  return proc.ok ? proc.stdout : null;
}

/** `(#123)` from a squash-merge subject, or `Merge pull request #123 from …`. */
export function parsePr(subject: string): number | null {
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  if (squash) return Number(squash[1]);
  const merge = /^Merge pull request #(\d+)\b/.exec(subject);
  if (merge) return Number(merge[1]);
  return null;
}

/**
 * For every file under `paths`, the commit that *first* added it.
 *
 * One `git log` for the whole tree rather than one per file: at a few thousand results the
 * per-file form takes minutes and this takes a second. `--reverse` makes the first time a
 * path appears its addition, which is what SPEC §5 means by "the adding commit".
 */
export function addCommits(root: string, paths: string[]): Map<string, GitCommit> {
  const found = new Map<string, GitCommit>();
  if (paths.length === 0) return found;
  const proc = run(root, [
    'log',
    '--reverse',
    '--diff-filter=A',
    '--name-only',
    '--format=%x01%H%x1f%aI%x1f%ae%x1f%s',
    '--',
    ...paths,
  ]);
  if (!proc.ok) return found;

  let current: GitCommit | null = null;
  for (const line of proc.stdout.split('\n')) {
    if (line.startsWith('\u0001')) {
      current = parseCommitLine(line.slice(1));
      continue;
    }
    const path = line.trim();
    if (!path || !current) continue;
    if (!found.has(path)) found.set(path, current);
  }
  return found;
}

/**
 * GitHub login of a commit's author, when it can be told from the address.
 *
 * GitHub's noreply addresses (`1234+login@users.noreply.github.com`) carry the login
 * verbatim, which is the only place git history knows about GitHub identities at all.
 * Anything else returns null and the credit is simply not awarded — guessing a login from
 * a display name would put points on somebody else's account.
 */
export function loginFromEmail(email: string): string | null {
  const match =
    /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)@users\.noreply\.github\.com$/.exec(
      email.trim(),
    );
  return match ? match[1]!.toLowerCase() : null;
}
