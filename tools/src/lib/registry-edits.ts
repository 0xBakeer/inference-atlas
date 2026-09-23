/**
 * Existing registry records are the maintainers' to change (SPEC decision 29).
 *
 * A result is interpreted against its registry: a wrong release date, a wrong attention
 * type or a dropped note silently changes what every measurement of that model means. So
 * the ownership rule for results has a counterpart here. Adding a record is open to anyone.
 * Changing or deleting one that already exists needs its code owner, as named by
 * `.github/CODEOWNERS` **at the base ref**, so a pull request cannot make itself an owner.
 *
 * One edit stays open to everyone, because the quant records invite it ("correct this record
 * in the same PR if it is wrong"): the fields that say where the weights live, `hf_id`,
 * `files`, `size_gb` and `revision`. Anything else in a quant file, and anything at all in a
 * model, hardware, engine, workload, dataset or schema file, is a maintainer change.
 *
 * `maintainer-override` downgrades the error to a warning, as it does for ownership.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile } from './git.js';
import { showFile } from './git.js';
import type { Reporter } from './report.js';

const GUARDED = ['models/', 'hardware/', 'engines/', 'workloads/', 'datasets/', 'schemas/'];
const QUANT_FILE = /^models\/[^/]+\/[^/]+\/quants\/[^/]+\.json$/;
const LOCATION_FIELDS = new Set(['hf_id', 'files', 'size_gb', 'revision']);
const CODEOWNERS = '.github/CODEOWNERS';
/** Workflows open pull requests as this account (engine ingest); nobody else can. */
const WORKFLOW_BOT = 'github-actions[bot]';

export interface RegistryEditOptions {
  root: string;
  base: string;
  author: string;
  allowOverride?: boolean;
}

interface OwnerRule {
  pattern: string;
  owners: string[];
}

export function parseCodeowners(text: string | null): OwnerRule[] {
  if (!text) return [];
  const rules: OwnerRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners: owners.map((o) => o.replace(/^@/, '').toLowerCase()) });
  }
  return rules;
}

/** The subset of CODEOWNERS syntax this repository uses: `*`, `/dir/` and `/file`. */
function matches(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  const anchored = pattern.replace(/^\//, '');
  if (anchored.endsWith('/')) return path.startsWith(anchored);
  return path === anchored;
}

/** CODEOWNERS semantics: the last matching rule wins. */
export function ownersOf(rules: OwnerRule[], path: string): string[] {
  let owners: string[] = [];
  for (const rule of rules) if (matches(rule.pattern, path)) owners = rule.owners;
  return owners;
}

function parse(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Top-level keys whose values differ, including keys added or removed. */
export function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

export function checkRegistryEdits(
  changed: ChangedFile[],
  reporter: Reporter,
  options: RegistryEditOptions,
): void {
  const { root, base, author } = options;
  const login = author.trim().toLowerCase();
  if (login === WORKFLOW_BOT) return;
  const rules = parseCodeowners(showFile(root, base, CODEOWNERS));

  const violation = (file: string, message: string) => {
    if (options.allowOverride === true) {
      reporter.warn(
        file,
        'ownership-override',
        `registry-edit-foreign: ${message} (maintainer-override)`,
      );
    } else {
      reporter.error(file, 'registry-edit-foreign', message);
    }
  };

  for (const change of changed) {
    // A copy leaves its source untouched, so like an addition it only creates a record.
    if (change.status === 'A' || change.status === 'C') continue;
    // A rename touches the record at its old path; that is the one that existed.
    const existing = change.oldPath ?? change.path;
    if (!GUARDED.some((dir) => existing.startsWith(dir))) continue;
    const owners = ownersOf(rules, existing);
    if (owners.includes(login)) continue;
    const ownerText = owners.length > 0 ? owners.map((o) => `@${o}`).join(', ') : 'a maintainer';

    if (change.status === 'D' || change.oldPath) {
      violation(
        existing,
        `${change.status === 'D' ? 'deletes' : 'moves'} an existing registry record; only ${ownerText} may do that`,
      );
      continue;
    }

    const before = parse(showFile(root, base, existing));
    const full = join(root, change.path);
    const after = existsSync(full) ? parse(readFileSync(full, 'utf8')) : null;
    if (before === null || after === null) {
      violation(existing, `changes an existing registry record; only ${ownerText} may do that`);
      continue;
    }
    const keys = changedKeys(before, after);
    if (keys.length === 0) continue;
    if (QUANT_FILE.test(existing)) {
      const other = keys.filter((k) => !LOCATION_FIELDS.has(k));
      if (other.length === 0) continue;
      violation(
        existing,
        `changes ${other.map((k) => `"${k}"`).join(', ')} in an existing quant record. A contributor may correct where the weights live (${[...LOCATION_FIELDS].join(', ')}); everything else is for ${ownerText}`,
      );
      continue;
    }
    violation(
      existing,
      `changes ${keys.map((k) => `"${k}"`).join(', ')} in an existing registry record; only ${ownerText} may do that. Add a new record instead, or ask in the pull request`,
    );
  }
}
