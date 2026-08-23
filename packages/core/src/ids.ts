import { sha256Hex } from './hash.js';

/**
 * The computed identifiers — SPEC §2.
 *
 * Every one of these is derived, never typed by a human, and recomputed by the validator.
 * If a contributor edits a number by hand, the ids stop matching and CI fails.
 */

export interface CellIdInput {
  /** The Hugging Face repo id, verbatim: `Qwen/Qwen3.8-27B`. Hashed exactly as written. */
  model_id: string;
  quant_id: string;
  hardware_id: string;
  hw_count: number;
  engine_id: string;
  /** First two version components, e.g. `0.27`. Use `engineMinor()` to derive it. */
  engine_minor: string;
}

/**
 * `sha256("model|quant|hardware|count|engine|minor")[:12]` — one square of the coverage map.
 *
 * The engine *minor* rather than the full version is deliberate: patch releases of an engine
 * are the same square, minors are not, because 0.26 → 0.27 routinely moves numbers by double
 * digit percentages.
 *
 * The model id goes in verbatim, case and slash included (SPEC §2, decision 20), so
 * `Qwen/Qwen3-8B` and a re-upload of it under another account are never the same square.
 */
export function cellId(input: CellIdInput): string {
  const parts = [
    input.model_id,
    input.quant_id,
    input.hardware_id,
    String(input.hw_count),
    input.engine_id,
    input.engine_minor,
  ];
  return sha256Hex(parts.join('|')).slice(0, 12);
}

/**
 * First two components of a version.
 *
 * `0.27.1 → 0.27`, `v1.2.3 → 1.2`, `0.26.1.dev0+g568afb3a1 → 0.26`. Version schemes that are
 * not dotted numbers (llama.cpp's `b7000`, LM Studio's dates) have no minor to speak of and
 * are returned lowercased and trimmed, so each build is its own square.
 */
export function engineMinor(version: string): string {
  const v = version.trim().toLowerCase();
  const m = /^v?(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}` : v;
}

/** `<config_id>--<workload_id>--<sha256(login|started_at)[:6]>` */
export function runId(
  configId: string,
  workloadId: string,
  githubLogin: string,
  startedAt: string,
): string {
  const who = sha256Hex(`${githubLogin}|${startedAt}`).slice(0, 6);
  return `${configId}--${workloadId}--${who}`;
}

export interface ParsedRunId {
  configId: string;
  workloadId: string;
  contributorHash: string;
}

/**
 * Inverse of `runId` as far as it goes. Returns null for anything that is not a run id.
 * Workload ids may contain single dashes but never `--`, which is what makes this unambiguous.
 */
export function parseRunId(id: string): ParsedRunId | null {
  const parts = id.split('--');
  if (parts.length !== 3) return null;
  const [configId, workloadId, contributorHash] = parts as [string, string, string];
  if (!/^[0-9a-f]{16}$/.test(configId)) return null;
  if (!/^[0-9a-f]{6}$/.test(contributorHash)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(workloadId)) return null;
  return { configId, workloadId, contributorHash };
}

/**
 * A model id is the Hugging Face repo id, verbatim and case-preserved, with exactly one slash.
 * Every other id in the atlas is lowercase kebab-case; this one is not, because
 * `unsloth/Qwen3-8B-GGUF` and `Qwen/Qwen3-8B` are different weights by different people.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** SPEC §2: `Qwen/Qwen3.8-27B` yes, `qwen3.8-27b` no, `a/b/c` no. */
export function isModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value);
}

/**
 * A model id flattened into one path-safe, lowercase segment: `Qwen/Qwen3.8-27B` →
 * `qwen-qwen3.8-27b`. Used where a slash is not allowed — git branch names above all.
 *
 * Deliberately not injective: two ids that differ only in case collapse to the same slug. It
 * is never an identifier, only a label; the cell hash in the branch name is what makes the
 * branch unique.
 */
export function modelSlug(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
}

/**
 * `results/<engine>/<owner>/<name>/<hardware>/<run_id>.json` — the only place a result may
 * live. The model id contributes two path segments because it *is* two segments.
 */
export function resultPath(
  engineId: string,
  modelId: string,
  hardwareId: string,
  id: string,
): string {
  return `${resultDir(engineId, modelId, hardwareId)}/${id}.json`;
}

/** Directory a packet tells an agent to write into. */
export function resultDir(engineId: string, modelId: string, hardwareId: string): string {
  return `results/${engineId}/${modelId}/${hardwareId}`;
}

export interface ParsedResultPath {
  engine_id: string;
  model_id: string;
  hardware_id: string;
  run_id: string;
}

/**
 * Inverse of `resultPath`. Returns null for any path that is not a legal result file, which
 * is how the validator answers "does this changed file belong where it lies?".
 *
 * The model id eats exactly two segments, so a legal path has six of them; the file name must
 * be a run id, because SPEC §2 fixes it to `run_id + ".json"`.
 */
export function parseResultPath(path: string): ParsedResultPath | null {
  const parts = path.replace(/^\.?\//, '').split('/');
  if (parts.length !== 6) return null;
  const [root, engineId, owner, name, hardwareId, file] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (root !== 'results') return null;
  if (!file.endsWith('.json')) return null;
  const id = file.slice(0, -'.json'.length);
  if (!parseRunId(id)) return null;
  const modelId = `${owner}/${name}`;
  if (!isModelId(modelId)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(engineId)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(hardwareId)) return null;
  return { engine_id: engineId, model_id: modelId, hardware_id: hardwareId, run_id: id };
}
