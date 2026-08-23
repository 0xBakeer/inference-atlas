/**
 * The issue list every tool reports through.
 *
 * One shape for humans (a grouped summary on the terminal) and for machines (`--json`,
 * which `validate.yml` turns into a sticky pull-request comment). Every issue carries a
 * stable `code`: the workflow keys its labels off those codes and the tests assert on them,
 * so codes are API — rename one only with the workflow and the tests in the same commit.
 */
import pc from 'picocolors';

export type IssueLevel = 'error' | 'warn';

export interface Issue {
  level: IssueLevel;
  /** Stable machine-readable code, e.g. `run-id-mismatch`, `ownership-added`. */
  code: string;
  /** Repository-relative path of the offending file, or `''` for repository-wide issues. */
  file: string;
  message: string;
  /** Dotted path inside the file, when the issue is about one field. */
  path?: string;
  /** Other files involved — the conflicting results of a `needs-review`, for instance. */
  related?: string[];
}

export interface Counts {
  [kind: string]: number;
}

export class Reporter {
  readonly issues: Issue[] = [];

  error(file: string, code: string, message: string, extra: Partial<Issue> = {}): void {
    this.issues.push({ ...extra, level: 'error', code, file, message });
  }

  warn(file: string, code: string, message: string, extra: Partial<Issue> = {}): void {
    this.issues.push({ ...extra, level: 'warn', code, file, message });
  }

  add(issue: Issue): void {
    this.issues.push(issue);
  }

  get errors(): Issue[] {
    return this.issues.filter((i) => i.level === 'error');
  }

  get warnings(): Issue[] {
    return this.issues.filter((i) => i.level === 'warn');
  }

  has(code: string): boolean {
    return this.issues.some((i) => i.code === code);
  }

  /** Issues about the given files only — what `--changed` narrows the report down to. */
  forFiles(files: Set<string>): Issue[] {
    return this.issues.filter((i) => i.file === '' || files.has(i.file));
  }
}

/** Issue codes present, most frequent first — the header line of the summary. */
export function codeCounts(issues: Issue[]): Array<{ code: string; level: IssueLevel; n: number }> {
  const seen = new Map<string, { code: string; level: IssueLevel; n: number }>();
  for (const issue of issues) {
    const key = `${issue.level}|${issue.code}`;
    const entry = seen.get(key);
    if (entry) entry.n += 1;
    else seen.set(key, { code: issue.code, level: issue.level, n: 1 });
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || (a.code < b.code ? -1 : 1));
}

function group(issues: Issue[]): Map<string, Issue[]> {
  const byFile = new Map<string, Issue[]>();
  for (const issue of issues) {
    const list = byFile.get(issue.file);
    if (list) list.push(issue);
    else byFile.set(issue.file, [issue]);
  }
  return new Map([...byFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

export interface SummaryOptions {
  counts?: Counts;
  /** Extra lines printed above the issue list, e.g. "8 result files checked". */
  headline?: string;
  color?: boolean;
}

/** The terminal report: counts, then every issue grouped by file. */
export function renderSummary(issues: Issue[], options: SummaryOptions = {}): string {
  const colour = options.color ?? true;
  const paint = (fn: (s: string) => string, s: string) => (colour ? fn(s) : s);
  const lines: string[] = [];

  if (options.counts) {
    lines.push(
      Object.entries(options.counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · '),
    );
  }
  if (options.headline) lines.push(options.headline);

  for (const [file, fileIssues] of group(issues)) {
    lines.push('');
    lines.push(paint(pc.bold, file || '(repository)'));
    for (const issue of fileIssues) {
      const tag = issue.level === 'error' ? paint(pc.red, 'ERROR') : paint(pc.yellow, 'warn ');
      const where = issue.path ? paint(pc.dim, ` (${issue.path})`) : '';
      lines.push(`  ${tag} ${paint(pc.cyan, issue.code)}: ${issue.message}${where}`);
      for (const related of issue.related ?? []) {
        lines.push(`        ${paint(pc.dim, related)}`);
      }
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  lines.push('');
  const codes = codeCounts(issues)
    .map((c) => `${c.code}×${c.n}`)
    .join(', ');
  if (codes) lines.push(paint(pc.dim, codes));
  lines.push(
    errors === 0
      ? paint(pc.green, `ok — 0 errors, ${warnings} warning(s)`)
      : paint(pc.red, `${errors} error(s), ${warnings} warning(s)`),
  );
  return lines.join('\n');
}

/** The Markdown block `validate.yml` posts as a pull-request comment. */
export function renderMarkdown(issues: Issue[], options: SummaryOptions = {}): string {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warn');
  const lines: string[] = [];
  lines.push(
    errors.length === 0
      ? `**Validation passed** — ${warnings.length} warning(s).`
      : `**Validation failed** — ${errors.length} error(s), ${warnings.length} warning(s).`,
  );
  if (options.counts) {
    lines.push('');
    lines.push(
      Object.entries(options.counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · '),
    );
  }
  if (issues.length > 0) {
    lines.push('');
    lines.push('| | code | file | message |');
    lines.push('|---|---|---|---|');
    for (const issue of [...errors, ...warnings].slice(0, 50)) {
      const message = issue.message.replace(/\n/g, ' ').replace(/\|/g, '\\|');
      lines.push(
        `| ${issue.level === 'error' ? '❌' : '⚠️'} | \`${issue.code}\` | \`${issue.file || '—'}\` | ${message} |`,
      );
    }
    if (issues.length > 50) lines.push(`| | | | …and ${issues.length - 50} more |`);
  }
  return lines.join('\n');
}
