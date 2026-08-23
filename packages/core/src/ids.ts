import { sha256Hex } from './hash.js';

/**
 * The computed identifiers — SPEC §2.
 *
 * Every one of these is derived, never typed by a human, and recomputed by the validator.
 * If a contributor edits a number by hand, the ids stop matching and CI fails.
 */

export interface CellIdInput {
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

/** `results/<engine>/<model>/<hardware>/<run_id>.json` — the only place a result may live. */
export function resultPath(
  engineId: string,
  modelId: string,
  hardwareId: string,
  id: string,
): string {
  return `results/${engineId}/${modelId}/${hardwareId}/${id}.json`;
}

/** Directory a packet tells an agent to write into. */
export function resultDir(engineId: string, modelId: string, hardwareId: string): string {
  return `results/${engineId}/${modelId}/${hardwareId}`;
}
