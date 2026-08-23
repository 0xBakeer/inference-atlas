#!/usr/bin/env node
/**
 * Registry check — the wave-1 stand-in for `tools/validate`.
 *
 * Validates every JSON file in the repository against its schema, recomputes the derived
 * ids of every result, and runs the plausibility checks. `tools/validate` will supersede
 * this with the ownership and git-history parts that only make sense inside CI; until then
 * this is what a contributor runs before opening the pull request.
 *
 *   node packages/core/scripts/check-registries.mjs [--quiet]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalizeArgs } from '../dist/canonical.js';
import { cellId, engineMinor, runId, resultPath, parseResultPath, isModelId } from '../dist/ids.js';
import { checkPlausibility } from '../dist/plausibility.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const quiet = process.argv.includes('--quiet');

const errors = [];
const warnings = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);
const warn = (file, message) => warnings.push(`${file}: ${message}`);

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rel = (path) => relative(ROOT, path);

function walk(dir, filter = (f) => f.endsWith('.json')) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry)) out.push(full);
  }
  return out.sort();
}

/* ------------------------------------------------------------------- schemas */

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
// ajv-formats is CJS; the default export lands in .default under some resolutions.
const applyFormats = addFormats.default ?? addFormats;
applyFormats(ajv);

const schemaDir = join(ROOT, 'schemas');
for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
  ajv.addSchema(read(join(schemaDir, file)));
}
const validator = (name) =>
  ajv.getSchema(`https://inference-atlas.dev/schemas/${name}.schema.json`);

function validate(name, path, data) {
  const check = validator(name);
  if (!check(data)) {
    for (const e of check.errors ?? []) {
      fail(
        rel(path),
        `${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`,
      );
    }
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ registry */

const hardware = new Map();
for (const path of walk(join(ROOT, 'hardware'))) {
  const data = read(path);
  if (validate('hardware', path, data)) {
    if (data.id !== basename(path, '.json'))
      fail(rel(path), `id "${data.id}" does not match the filename`);
    if (hardware.has(data.id)) fail(rel(path), `duplicate hardware id "${data.id}"`);
    hardware.set(data.id, data);
  }
}

const engines = new Map();
for (const dir of existsSync(join(ROOT, 'engines')) ? readdirSync(join(ROOT, 'engines')) : []) {
  const base = join(ROOT, 'engines', dir);
  if (!statSync(base).isDirectory()) continue;
  const metaPath = join(base, 'meta.json');
  if (!existsSync(metaPath)) {
    fail(rel(base), 'engine directory without a meta.json');
    continue;
  }
  const meta = read(metaPath);
  if (!validate('engine', metaPath, meta)) continue;
  if (meta.id !== dir) fail(rel(metaPath), `id "${meta.id}" does not match the directory name`);

  const versions = new Map();
  for (const path of walk(join(base, 'versions'))) {
    const data = read(path);
    if (!validate('engine-version', path, data)) continue;
    if (data.version !== basename(path, '.json'))
      fail(rel(path), `version "${data.version}" does not match the filename`);
    if (data.engine_id !== meta.id)
      fail(rel(path), `engine_id "${data.engine_id}" does not match "${meta.id}"`);
    const names = new Set();
    for (const p of data.params) {
      if (names.has(p.name)) fail(rel(path), `duplicate param "${p.name}"`);
      names.add(p.name);
    }
    versions.set(data.version, data);
  }
  for (const v of meta.versions_available ?? []) {
    if (!versions.has(v))
      fail(
        rel(metaPath),
        `versions_available lists "${v}" but engines/${dir}/versions/${v}.json is missing`,
      );
  }
  for (const v of versions.keys()) {
    if (!(meta.versions_available ?? []).includes(v))
      warn(rel(metaPath), `versions/${v}.json exists but is not listed in versions_available`);
  }

  const overlayPath = join(base, 'overlay.json');
  let overlay = null;
  if (existsSync(overlayPath)) {
    overlay = read(overlayPath);
    if (validate('engine-overlay', overlayPath, overlay)) {
      if (overlay.engine_id !== meta.id)
        fail(rel(overlayPath), `engine_id "${overlay.engine_id}" does not match "${meta.id}"`);
      const known = new Set([...versions.values()].flatMap((v) => v.params.map((p) => p.name)));
      for (const name of Object.keys(overlay.params)) {
        if (known.size && !known.has(name))
          warn(
            rel(overlayPath),
            `overlay describes "${name}", which no registered version declares`,
          );
      }
    }
  }
  engines.set(meta.id, { meta, versions, overlay });
}

const models = new Map();
// A model id is <owner>/<name>, so the registry is two levels deep. On a case-insensitive
// filesystem (every Mac, by default) two ids that differ only in case are the same directory,
// which would silently merge two different repositories — so they are rejected outright.
const modelDirsByCase = new Map();
const modelsRoot = join(ROOT, 'models');
const ownerDirs = existsSync(modelsRoot)
  ? readdirSync(modelsRoot).filter((d) => statSync(join(modelsRoot, d)).isDirectory())
  : [];
for (const owner of ownerDirs) {
  const ownerPath = join(modelsRoot, owner);
  const strays = readdirSync(ownerPath).filter((f) => !statSync(join(ownerPath, f)).isDirectory());
  if (strays.length) {
    fail(
      rel(ownerPath),
      `owner directory holds files (${strays.join(', ')}); it may only hold model directories`,
    );
  }
  for (const name of readdirSync(ownerPath).filter((d) =>
    statSync(join(ownerPath, d)).isDirectory(),
  )) {
    const dir = `${owner}/${name}`;
    const base = join(ownerPath, name);
    const modelPath = join(base, 'model.json');

    const previous = modelDirsByCase.get(dir.toLowerCase());
    if (previous) {
      fail(
        `models/${dir}`,
        `collides with models/${previous} on a case-insensitive filesystem; two model ids may not differ only by case`,
      );
    } else {
      modelDirsByCase.set(dir.toLowerCase(), dir);
    }

    if (!existsSync(modelPath)) {
      fail(rel(base), 'model directory without a model.json');
      continue;
    }
    const model = read(modelPath);
    if (!validate('model', modelPath, model)) continue;
    if (model.id !== dir)
      fail(rel(modelPath), `id "${model.id}" does not match the directory path "${dir}"`);
    if (!isModelId(model.id))
      fail(rel(modelPath), `id "${model.id}" is not a Hugging Face repo id (<owner>/<name>)`);
    if (model.hf_id !== model.id)
      fail(
        rel(modelPath),
        `hf_id "${model.hf_id}" must equal id "${model.id}" — the id is the repo`,
      );
    if (model.moe && (model.active_params_b ?? model.params_b) >= model.params_b) {
      warn(rel(modelPath), 'MoE model whose active_params_b is not smaller than params_b');
    }

    const quants = new Map();
    for (const path of walk(join(base, 'quants'))) {
      const quant = read(path);
      if (!validate('quant', path, quant)) continue;
      if (quant.id !== basename(path, '.json'))
        fail(rel(path), `id "${quant.id}" does not match the filename`);
      if (quant.model_id !== model.id)
        fail(rel(path), `model_id "${quant.model_id}" does not match "${model.id}"`);
      for (const engineId of quant.engines) {
        const engine = engines.get(engineId);
        if (!engine) {
          fail(rel(path), `engines lists "${engineId}", which is not a registered engine`);
        } else if (!engine.meta.quant_formats.includes(quant.format)) {
          fail(
            rel(path),
            `engine "${engineId}" does not declare support for format "${quant.format}"`,
          );
        }
      }
      quants.set(quant.id, quant);
    }
    if (quants.size === 0) warn(rel(modelPath), 'model without a single quantization record');
    models.set(model.id, { model, quants });
  }
}

const workloads = new Map();
for (const path of walk(join(ROOT, 'workloads'))) {
  const data = read(path);
  if (!validate('workload', path, data)) continue;
  if (data.id !== basename(path, '.json'))
    fail(rel(path), `id "${data.id}" does not match the filename`);
  workloads.set(data.id, data);
}

const datasets = new Map();
for (const dir of existsSync(join(ROOT, 'datasets')) ? readdirSync(join(ROOT, 'datasets')) : []) {
  const base = join(ROOT, 'datasets', dir);
  if (!statSync(base).isDirectory()) continue;
  const path = join(base, 'dataset.json');
  if (!existsSync(path)) continue;
  const data = read(path);
  if (!validate('dataset', path, data)) continue;
  if (data.id !== dir) fail(rel(path), `id "${data.id}" does not match the directory name`);
  datasets.set(data.id, data);
}

let site = null;
const sitePath = join(ROOT, 'site/config.json');
if (existsSync(sitePath)) {
  site = read(sitePath);
  validate('site', sitePath, site);
  for (const [kind, ids] of Object.entries(site.featured ?? {})) {
    const registry = { hardware, models, engines, workloads }[kind];
    for (const id of ids) {
      if (registry && !registry.has(id)) {
        (kind === 'workloads' ? warn : fail)(
          rel(sitePath),
          `featured.${kind} references unknown id "${id}"`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------- results */

const runIds = new Set();
for (const path of walk(join(ROOT, 'results'))) {
  const result = read(path);
  if (!validate('result', path, result)) continue;
  const file = rel(path);

  if (runIds.has(result.run_id)) fail(file, `duplicate run_id "${result.run_id}"`);
  runIds.add(result.run_id);

  const engine = engines.get(result.engine.id);
  const modelEntry = models.get(result.model.id);
  const quant = modelEntry?.quants.get(result.model.quant_id) ?? null;
  const hw = hardware.get(result.hardware.id) ?? null;

  if (!engine) fail(file, `unknown engine "${result.engine.id}"`);
  if (!modelEntry) fail(file, `unknown model "${result.model.id}"`);
  else if (!quant) fail(file, `unknown quant "${result.model.id}/${result.model.quant_id}"`);
  if (!hw) fail(file, `unknown hardware "${result.hardware.id}"`);
  if (quant && !quant.engines.includes(result.engine.id)) {
    fail(file, `quant "${result.model.quant_id}" does not list engine "${result.engine.id}"`);
  }
  if (workloads.size > 0) {
    const workload = workloads.get(result.workload_id);
    if (!workload) fail(file, `unknown workload "${result.workload_id}"`);
    else if (workload.kind !== result.kind) {
      fail(
        file,
        `kind "${result.kind}" does not mirror workload "${workload.id}" kind "${workload.kind}"`,
      );
    }
  } else {
    warn(file, `workload "${result.workload_id}" could not be checked: workloads/ is empty`);
  }

  const versionFile = engine?.versions.get(result.engine.version) ?? null;
  if (engine && !versionFile)
    warn(
      file,
      `unknown-engine-version: engines/${result.engine.id}/versions/${result.engine.version}.json is missing, so no defaults were dropped`,
    );

  const { canonical, configId } = canonicalizeArgs({
    engine_id: result.engine.id,
    engine_version: result.engine.version,
    args: result.args,
    quant_id: result.model.quant_id,
    dtype: result.model.dtype ?? null,
    params: versionFile?.params ?? null,
    drop_params: engine?.meta.drop_params ?? [],
    param_aliases: engine?.meta.param_aliases ?? null,
  });
  if (canonical !== result.args_canonical) {
    fail(
      file,
      `args_canonical mismatch\n    stored:   ${result.args_canonical}\n    computed: ${canonical}`,
    );
  }
  if (configId !== result.config_id)
    fail(file, `config_id mismatch: stored ${result.config_id}, computed ${configId}`);

  const expectedCell = cellId({
    model_id: result.model.id,
    quant_id: result.model.quant_id,
    hardware_id: result.hardware.id,
    hw_count: result.hardware.count,
    engine_id: result.engine.id,
    engine_minor: engineMinor(result.engine.version),
  });
  if (expectedCell !== result.cell_id)
    fail(file, `cell_id mismatch: stored ${result.cell_id}, computed ${expectedCell}`);

  const expectedRun = runId(
    configId,
    result.workload_id,
    result.provenance.github_login,
    result.provenance.started_at,
  );
  if (expectedRun !== result.run_id)
    fail(file, `run_id mismatch: stored ${result.run_id}, computed ${expectedRun}`);

  const expectedPath = resultPath(
    result.engine.id,
    result.model.id,
    result.hardware.id,
    result.run_id,
  );
  if (file !== expectedPath) {
    const shape = parseResultPath(file)
      ? ''
      : ' (results/<engine>/<owner>/<name>/<hardware>/<run_id>.json — the model id is two segments)';
    fail(file, `wrong path; it belongs at ${expectedPath}${shape}`);
  }

  if (result.provenance.github_user_id != null)
    warn(file, 'provenance.github_user_id is set; CI resolves it, contributors leave it null');
  if (result.provenance.commit != null || result.provenance.pr != null) {
    warn(
      file,
      'provenance.commit / provenance.pr are set; the build stamps them, contributors leave them null',
    );
  }

  for (const issue of checkPlausibility({
    result,
    hardware: hw,
    model: modelEntry?.model ?? null,
    quant,
    site,
  })) {
    (issue.level === 'error' ? fail : warn)(
      file,
      `${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`,
    );
  }
}

/* -------------------------------------------------------------------- report */

if (!quiet) {
  console.log(
    `hardware ${hardware.size} · engines ${engines.size} · models ${models.size} · quants ${[...models.values()].reduce((n, m) => n + m.quants.size, 0)} · workloads ${workloads.size} · datasets ${datasets.size} · results ${runIds.size}`,
  );
}
for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
if (errors.length) {
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
if (!quiet) console.log(`ok — 0 errors, ${warnings.length} warning(s)`);
