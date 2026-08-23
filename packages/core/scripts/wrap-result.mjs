#!/usr/bin/env node
/**
 * Fill in the computed fields of a draft result and put it where it belongs.
 *
 * A draft is a result file with `run_id`, `config_id`, `cell_id` and `args_canonical`
 * missing or wrong; this script recomputes all four from the registry and writes the file
 * to results/<engine>/<owner>/<name>/<hardware>/<run_id>.json — `<owner>/<name>` being the
 * model id, which is the Hugging Face repo id verbatim.
 *
 * This is the wave-1 stand-in for `atlas wrap` / `atlas-bench submit`, which will do the
 * same thing as part of the harness. It exists so that a measurement taken outside the
 * harness can be filed without anybody typing a hash.
 *
 *   node packages/core/scripts/wrap-result.mjs draft.json [--write]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeArgs } from '../dist/canonical.js';
import { cellId, engineMinor, runId, resultPath, isModelId } from '../dist/ids.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const [draftPath, ...flags] = process.argv.slice(2);
if (!draftPath) {
  console.error('usage: wrap-result.mjs <draft.json> [--write]');
  process.exit(2);
}
const write = flags.includes('--write');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const draft = read(draftPath);
if (!isModelId(draft.model.id)) {
  throw new Error(
    `model.id "${draft.model.id}" is not a Hugging Face repo id (<owner>/<name>) — see SPEC §2`,
  );
}
const modelPath = join(ROOT, 'models', draft.model.id, 'model.json');
if (!existsSync(modelPath)) throw new Error(`unknown model ${draft.model.id} (${modelPath})`);
const metaPath = join(ROOT, 'engines', draft.engine.id, 'meta.json');
if (!existsSync(metaPath)) throw new Error(`unknown engine ${draft.engine.id}`);
const meta = read(metaPath);
const versionPath = join(
  ROOT,
  'engines',
  draft.engine.id,
  'versions',
  `${draft.engine.version}.json`,
);
const versionFile = existsSync(versionPath) ? read(versionPath) : null;
if (!versionFile) {
  console.warn(
    `warn: no version file for ${draft.engine.id} ${draft.engine.version} — no defaults will be dropped`,
  );
}

const { canonical, configId } = canonicalizeArgs({
  engine_id: draft.engine.id,
  engine_version: draft.engine.version,
  args: draft.args,
  quant_id: draft.model.quant_id,
  dtype: draft.model.dtype ?? null,
  params: versionFile?.params ?? null,
  drop_params: meta.drop_params ?? [],
  param_aliases: meta.param_aliases ?? null,
});

const cell = cellId({
  model_id: draft.model.id,
  quant_id: draft.model.quant_id,
  hardware_id: draft.hardware.id,
  hw_count: draft.hardware.count,
  engine_id: draft.engine.id,
  engine_minor: engineMinor(draft.engine.version),
});
const id = runId(
  configId,
  draft.workload_id,
  draft.provenance.github_login,
  draft.provenance.started_at,
);
const target = resultPath(draft.engine.id, draft.model.id, draft.hardware.id, id);

// Rebuild the object so the computed keys keep their place at the top of the file.
const {
  schema_version,
  run_id: _r,
  config_id: _c,
  cell_id: _l,
  args_canonical: _a,
  ...rest
} = draft;
const out = { schema_version, run_id: id, config_id: configId, cell_id: cell, ...rest };
// args_canonical belongs directly after args, so rebuild the key order explicitly.
const ordered = {};
for (const [key, value] of Object.entries(out)) {
  ordered[key] = value;
  if (key === 'args') ordered.args_canonical = canonical;
}

console.log(
  `config_id ${configId}\ncell_id   ${cell}\nrun_id    ${id}\ncanonical ${canonical}\npath      ${target}`,
);
if (write) {
  const full = join(ROOT, target);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`written   ${target}`);
}
