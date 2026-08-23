/**
 * Reading the repository into memory.
 *
 * "The repo is the database" (SPEC §0.1), so this is the database driver: it walks the
 * registry directories, schema-checks every file it finds, and hands back maps keyed by id.
 * Structural problems (unparseable JSON, an id that disagrees with its filename, a stray
 * file in a registry directory) are reported here rather than duplicated in each caller.
 *
 * Loading is deliberately tolerant: a file that fails its schema is *not* put into the
 * registry, but every other file is still read, so one broken record does not hide the
 * other nineteen problems a contributor would otherwise fix one round-trip at a time.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { isModelId } from '@atlas/core';
import type {
  Dataset,
  EngineMeta,
  EngineOverlay,
  EngineVersion,
  Hardware,
  Model,
  Quant,
  ResultRecord,
  SiteConfig,
  Workload,
} from '@atlas/core';
import type { Reporter } from './report.js';
import { Schemas, schemaFor } from './schemas.js';

export interface EngineEntry {
  meta: EngineMeta;
  overlay: EngineOverlay | null;
  /** Version id → parameter schema, in registration order. */
  versions: Map<string, EngineVersion>;
}

export interface ModelEntry {
  model: Model;
  quants: Map<string, Quant>;
}

export interface LoadedResult {
  /** Repository-relative, POSIX separators — the key every report and index row uses. */
  path: string;
  data: ResultRecord;
}

export interface Repo {
  root: string;
  hardware: Map<string, Hardware>;
  engines: Map<string, EngineEntry>;
  models: Map<string, ModelEntry>;
  workloads: Map<string, Workload>;
  datasets: Map<string, Dataset>;
  results: LoadedResult[];
  site: SiteConfig | null;
  schemas: Schemas;
  /** Every `.json` file seen under the registry directories, whether or not it validated. */
  seen: string[];
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function relPath(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}

/** Recursive `*.json` walk, sorted so that the output of every tool is deterministic. */
export function walkJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJson(full));
    else if (entry.endsWith('.json')) out.push(full);
  }
  return out;
}

function dirs(root: string, name: string): string[] {
  const base = join(root, name);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .filter((entry) => statSync(join(base, entry)).isDirectory());
}

/**
 * `models/<hf-owner>/<hf-name>` pairs, sorted — the two-level directory a model id implies.
 *
 * A `model.json` directly under an owner directory is the pre-decision-20 layout (a single
 * kebab-case level) and is called out by name, because the alternative is the model being
 * silently invisible to every tool that reads the registry.
 */
function modelDirs(root: string, reporter: Reporter): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const owner of dirs(root, 'models')) {
    if (existsSync(join(root, 'models', owner, 'model.json'))) {
      reporter.error(
        `models/${owner}/model.json`,
        'model-dir-depth',
        'a model directory is two levels deep: models/<hf-owner>/<hf-name>/model.json, where <hf-owner>/<hf-name> is the Hugging Face repo id',
      );
      // The whole subtree is the old layout; descending into it would report its `quants/`
      // as a second model directory and bury the one error that says what to do.
      continue;
    }
    for (const name of dirs(root, join('models', owner))) out.push([owner, name]);
  }
  return out;
}

export function loadRepo(root: string, reporter: Reporter, schemas?: Schemas): Repo {
  const sc = schemas ?? new Schemas(join(root, 'schemas'));
  const seen: string[] = [];

  /** Read + schema-check one file. Returns null when it should not enter the registry. */
  const load = <T>(path: string): T | null => {
    const file = relPath(root, path);
    seen.push(file);
    const verdict = schemaFor(file);
    if (verdict.kind === 'ignored') return null;
    if (verdict.kind === 'unmapped') {
      reporter.error(file, 'unmapped-file', 'no schema matches this path; it does not belong here');
      return null;
    }
    let data: T;
    try {
      data = readJson<T>(path);
    } catch (error) {
      reporter.error(file, 'invalid-json', (error as Error).message);
      return null;
    }
    const errors = sc.check(verdict.name, data);
    for (const message of errors) {
      reporter.error(file, 'schema', `${verdict.name}: ${message}`);
    }
    return errors.length === 0 ? data : null;
  };

  /* ------------------------------------------------------------------ hardware */

  const hardware = new Map<string, Hardware>();
  for (const path of walkJson(join(root, 'hardware'))) {
    const data = load<Hardware>(path);
    if (!data) continue;
    const file = relPath(root, path);
    if (data.id !== basename(path, '.json')) {
      reporter.error(file, 'id-mismatch', `id "${data.id}" does not match the filename`);
      continue;
    }
    if (hardware.has(data.id)) {
      reporter.error(file, 'duplicate-id', `duplicate hardware id "${data.id}"`);
      continue;
    }
    hardware.set(data.id, data);
  }

  /* -------------------------------------------------------------------- engines */

  const engines = new Map<string, EngineEntry>();
  for (const dir of dirs(root, 'engines')) {
    const base = join(root, 'engines', dir);
    const metaPath = join(base, 'meta.json');
    if (!existsSync(metaPath)) {
      reporter.error(`engines/${dir}`, 'missing-meta', 'engine directory without a meta.json');
      continue;
    }
    const meta = load<EngineMeta>(metaPath);
    if (!meta) continue;
    if (meta.id !== dir) {
      reporter.error(
        relPath(root, metaPath),
        'id-mismatch',
        `id "${meta.id}" does not match the directory name "${dir}"`,
      );
      continue;
    }

    const versions = new Map<string, EngineVersion>();
    for (const path of walkJson(join(base, 'versions'))) {
      const data = load<EngineVersion>(path);
      if (!data) continue;
      const file = relPath(root, path);
      if (data.version !== basename(path, '.json')) {
        reporter.error(
          file,
          'id-mismatch',
          `version "${data.version}" does not match the filename`,
        );
        continue;
      }
      if (data.engine_id !== meta.id) {
        reporter.error(file, 'id-mismatch', `engine_id "${data.engine_id}" is not "${meta.id}"`);
        continue;
      }
      const names = new Set<string>();
      for (const param of data.params) {
        if (names.has(param.name)) {
          reporter.error(file, 'duplicate-param', `duplicate param "${param.name}"`);
        }
        names.add(param.name);
      }
      versions.set(data.version, data);
    }

    for (const version of meta.versions_available ?? []) {
      if (!versions.has(version)) {
        reporter.error(
          relPath(root, metaPath),
          'missing-version-file',
          `versions_available lists "${version}" but engines/${dir}/versions/${version}.json is missing`,
        );
      }
    }
    for (const version of versions.keys()) {
      if (!(meta.versions_available ?? []).includes(version)) {
        reporter.warn(
          relPath(root, metaPath),
          'unlisted-version',
          `versions/${version}.json exists but is not listed in versions_available`,
        );
      }
    }

    const overlayPath = join(base, 'overlay.json');
    let overlay: EngineOverlay | null = null;
    if (existsSync(overlayPath)) {
      overlay = load<EngineOverlay>(overlayPath);
      if (overlay) {
        const file = relPath(root, overlayPath);
        if (overlay.engine_id !== meta.id) {
          reporter.error(
            file,
            'id-mismatch',
            `engine_id "${overlay.engine_id}" is not "${meta.id}"`,
          );
          overlay = null;
        } else {
          const known = new Set([...versions.values()].flatMap((v) => v.params.map((p) => p.name)));
          for (const name of Object.keys(overlay.params)) {
            if (known.size > 0 && !known.has(name)) {
              reporter.warn(
                file,
                'overlay-unknown-param',
                `overlay describes "${name}", which no registered version declares`,
              );
            }
          }
        }
      }
    }

    engines.set(meta.id, { meta, overlay, versions });
  }

  /* --------------------------------------------------------------------- models */

  const models = new Map<string, ModelEntry>();
  /** Lowercased id → the id that claimed it, for the case-collision check below. */
  const modelDirsSeen = new Map<string, string>();
  for (const [owner, name] of modelDirs(root, reporter)) {
    const dir = `${owner}/${name}`;
    const base = join(root, 'models', owner, name);
    const modelPath = join(base, 'model.json');
    if (!existsSync(modelPath)) {
      reporter.error(`models/${dir}`, 'missing-model', 'model directory without a model.json');
      continue;
    }
    // Two directories that differ only by case are one directory on macOS and Windows, so a
    // repository carrying both cannot be checked out at all. Rejected here rather than left
    // to whoever clones it next (SPEC §2, decision 20).
    const collision = modelDirsSeen.get(dir.toLowerCase());
    if (collision !== undefined) {
      reporter.error(
        relPath(root, modelPath),
        'model-dir-case-collision',
        `models/${dir} and models/${collision} differ only by case; a case-insensitive filesystem cannot hold both`,
        { related: [`models/${collision}/model.json`] },
      );
      continue;
    }
    modelDirsSeen.set(dir.toLowerCase(), dir);

    // The directory *is* the id (SPEC §2), so a directory that is not a Hugging Face repo id
    // is a model nobody can pull — checked before the record is read, because no id inside
    // the file can rescue a path that cannot hold one.
    if (!isModelId(dir)) {
      reporter.error(
        relPath(root, modelPath),
        'invalid-model-id',
        `"${dir}" is not a Hugging Face repo id: <owner>/<name>, each starting with a letter or a digit and made of [A-Za-z0-9._-]`,
      );
      continue;
    }

    const model = load<Model>(modelPath);
    if (!model) continue;
    if (model.id !== dir) {
      reporter.error(
        relPath(root, modelPath),
        'id-mismatch',
        `id "${model.id}" does not match the directory "${dir}"`,
      );
      continue;
    }
    if (model.hf_id !== model.id) {
      reporter.error(
        relPath(root, modelPath),
        'hf-id-mismatch',
        `hf_id "${String(model.hf_id)}" must equal the id "${model.id}"`,
      );
    }
    if (model.moe && (model.active_params_b ?? model.params_b) >= model.params_b) {
      reporter.warn(
        relPath(root, modelPath),
        'moe-active-params',
        'MoE model whose active_params_b is not smaller than params_b',
      );
    }

    const quants = new Map<string, Quant>();
    for (const path of walkJson(join(base, 'quants'))) {
      const quant = load<Quant>(path);
      if (!quant) continue;
      const file = relPath(root, path);
      if (quant.id !== basename(path, '.json')) {
        reporter.error(file, 'id-mismatch', `id "${quant.id}" does not match the filename`);
        continue;
      }
      if (quant.model_id !== model.id) {
        reporter.error(file, 'id-mismatch', `model_id "${quant.model_id}" is not "${model.id}"`);
        continue;
      }
      quants.set(quant.id, quant);
    }
    if (quants.size === 0) {
      reporter.warn(
        relPath(root, modelPath),
        'model-without-quants',
        'model without a single quantization record',
      );
    }
    models.set(model.id, { model, quants });
  }

  // Quant → engine references need the engine registry, so they are checked after both loads.
  for (const [modelId, entry] of models) {
    for (const [quantId, quant] of entry.quants) {
      const file = `models/${modelId}/quants/${quantId}.json`;
      for (const engineId of quant.engines) {
        const engine = engines.get(engineId);
        if (!engine) {
          reporter.error(
            file,
            'unknown-engine',
            `engines lists "${engineId}", which is not a registered engine`,
          );
        } else if (!engine.meta.quant_formats.includes(quant.format)) {
          reporter.error(
            file,
            'quant-format-unsupported',
            `engine "${engineId}" does not declare support for format "${quant.format}"`,
          );
        }
      }
    }
  }

  /* ------------------------------------------------------------------ workloads */

  const workloads = new Map<string, Workload>();
  for (const path of walkJson(join(root, 'workloads'))) {
    const data = load<Workload>(path);
    if (!data) continue;
    const file = relPath(root, path);
    if (data.id !== basename(path, '.json')) {
      reporter.error(file, 'id-mismatch', `id "${data.id}" does not match the filename`);
      continue;
    }
    workloads.set(data.id, data);
  }

  /* ------------------------------------------------------------------- datasets */

  const datasets = new Map<string, Dataset>();
  for (const dir of dirs(root, 'datasets')) {
    const path = join(root, 'datasets', dir, 'dataset.json');
    if (!existsSync(path)) continue;
    const data = load<Dataset>(path);
    if (!data) continue;
    const file = relPath(root, path);
    if (data.id !== dir) {
      reporter.error(file, 'id-mismatch', `id "${data.id}" does not match the directory name`);
      continue;
    }
    datasets.set(data.id, data);
  }

  /* ---------------------------------------------------------------------- site */

  let site: SiteConfig | null = null;
  const sitePath = join(root, 'site/config.json');
  if (existsSync(sitePath)) site = load<SiteConfig>(sitePath);

  /* -------------------------------------------------------------------- results */

  const results: LoadedResult[] = [];
  for (const path of walkJson(join(root, 'results'))) {
    const data = load<ResultRecord>(path);
    if (!data) continue;
    results.push({ path: relPath(root, path), data });
  }

  return { root, hardware, engines, models, workloads, datasets, results, site, schemas: sc, seen };
}

/** Every quant in the registry as a flat list — the enumeration gaps and stats both need. */
export function allQuants(repo: Repo): Array<{ model: Model; quant: Quant }> {
  const out: Array<{ model: Model; quant: Quant }> = [];
  for (const entry of repo.models.values()) {
    for (const quant of entry.quants.values()) out.push({ model: entry.model, quant });
  }
  return out;
}
