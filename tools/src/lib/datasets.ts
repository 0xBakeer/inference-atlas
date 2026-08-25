/**
 * Light checks on the dataset payloads.
 *
 * The dataset *record* is schema-checked like everything else; the rows are not, because
 * every kind carries its own fields and a schema per kind would have to change every time
 * somebody adds a dataset (SPEC decision 2). What is checked here is the part the harness
 * actually depends on: the files exist, the row count matches what the record claims, and
 * the first rows carry the fields the scorers read. Fifty rows is enough to catch a
 * generator that emitted the wrong shape and cheap enough to run on every pull request.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Dataset } from '@atlas/core';
import type { Reporter } from './report.js';

const SAMPLE_ROWS = 50;

/** Fields every row of a kind must carry, plus the "at least one of" alternatives. */
const REQUIRED: Record<Dataset['kind'], { all: string[]; oneOf: string[][] }> = {
  prompts: { all: ['id'], oneOf: [['messages', 'prompt']] },
  eval: { all: ['id', 'answer', 'scorer'], oneOf: [['prompt', 'messages']] },
  haystack: { all: ['id', 'answer'], oneOf: [['question', 'prompt']] },
  images: {
    all: ['id'],
    oneOf: [
      ['image', 'image_file'],
      ['prompt', 'messages'],
    ],
  },
  // A conversations row is one turn of a recorded session, not a standalone item: it is
  // keyed by the session it belongs to and by its position in it, and what else it carries
  // depends on the role — a tool turn has results and no content, an assistant turn has
  // tool_calls and often no content either.
  conversations: { all: ['conversation_id', 'turn', 'role'], oneOf: [] },
};

export interface DatasetStats {
  /** Rows counted in the first `.jsonl` of `files`, or null when there is none. */
  rows: number | null;
  bytes: number;
  files: Array<{ name: string; bytes: number; exists: boolean }>;
}

export function checkDataset(root: string, dataset: Dataset, reporter: Reporter): DatasetStats {
  const dir = join(root, 'datasets', dataset.id);
  const file = `datasets/${dataset.id}/dataset.json`;
  const files: DatasetStats['files'] = [];
  let bytes = 0;

  for (const name of dataset.files) {
    const full = join(dir, name);
    const exists = existsSync(full);
    if (!exists) {
      reporter.error(file, 'dataset-file-missing', `files lists "${name}", which does not exist`);
      files.push({ name, bytes: 0, exists });
      continue;
    }
    const size = statSync(full).size;
    bytes += size;
    files.push({ name, bytes: size, exists });
  }

  const rowFile = dataset.files.find((name) => name.endsWith('.jsonl'));
  if (!rowFile || !existsSync(join(dir, rowFile))) return { rows: null, bytes, files };

  const text = readFileSync(join(dir, rowFile), 'utf8');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== dataset.count) {
    reporter.warn(
      file,
      'dataset-count-mismatch',
      `count says ${dataset.count} but ${rowFile} has ${lines.length} rows`,
    );
  }

  const required = REQUIRED[dataset.kind];
  for (const [i, line] of lines.slice(0, SAMPLE_ROWS).entries()) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      reporter.error(
        `datasets/${dataset.id}/${rowFile}`,
        'dataset-row-invalid',
        `row ${i + 1} is not JSON: ${(error as Error).message}`,
      );
      continue;
    }
    for (const field of required.all) {
      if (row[field] === undefined || row[field] === null) {
        reporter.error(
          `datasets/${dataset.id}/${rowFile}`,
          'dataset-row-shape',
          `row ${i + 1} (${String(row.id ?? '?')}) is a "${dataset.kind}" row without "${field}"`,
        );
      }
    }
    for (const group of required.oneOf) {
      if (!group.some((field) => row[field] !== undefined && row[field] !== null)) {
        reporter.error(
          `datasets/${dataset.id}/${rowFile}`,
          'dataset-row-shape',
          `row ${i + 1} (${String(row.id ?? '?')}) has none of ${group.join(' / ')}`,
        );
      }
    }
  }

  return { rows: lines.length, bytes, files };
}
