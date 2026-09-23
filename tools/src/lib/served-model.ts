/**
 * Did the server actually serve the model the result is filed under? (SPEC decision 29)
 *
 * The harness records what it sent in `raw.payload.engine_endpoint.served_model_id`. That
 * name is free text: LM Studio lowercases the repo id, llama-swap uses whatever alias its
 * config gives, vLLM uses `--served-model-name`. So an exact match is not required. What is
 * required is that the name does not contradict the label.
 *
 * Two signals, from strong to weak:
 *
 * - **Parameter count.** `deepseek-r1-distill-32b` cannot be `Qwen/Qwen3.8-27B`. When both
 *   sides carry a size token (`27b`, `0.6b`) and the sets do not overlap, the row measured a
 *   different model. That is an error: every number in the file belongs to somebody else's
 *   cell. Active-parameter tokens (`a3b`, `e2b`) are not sizes and are ignored.
 * - **Shared name.** Without a size on one side, the served name should still share a word
 *   of three or more letters with the model id, the quant repo or a quant file name. A name
 *   that shares none is reported as a warning, because aliases can be arbitrary.
 *
 * Only for results under review. Merged rows are what they are, and the rule was calibrated
 * on them: none of the 569 on main when it was added trips either signal.
 */
import type { ResultRecord } from '@atlas/core';
import type { Reporter } from './report.js';

const SIZE = /(?<![a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g;

/** Words that say nothing about which model it is. */
const NOISE = new Set([
  'gguf',
  'instruct',
  'chat',
  'the',
  'model',
  'bf16',
  'fp16',
  'fp8',
  'awq',
  'int4',
  'int8',
  'mlx',
  'bit',
]);

function norm(s: string): string {
  return s.toLowerCase().replaceAll('_', '-');
}

export function sizeTokens(s: string): Set<string> {
  return new Set([...norm(s).matchAll(SIZE)].map((m) => m[1]!));
}

export function nameWords(s: string): Set<string> {
  return new Set((norm(s).match(/[a-z]{3,}/g) ?? []).filter((w) => !NOISE.has(w)));
}

export interface ServedModelVerdict {
  level: 'ok' | 'warn' | 'error';
  message?: string;
}

export function servedModelVerdict(
  served: string,
  modelId: string,
  quant: { hf_id?: string | null; files?: readonly string[] | null } | null,
): ServedModelVerdict {
  const names = [
    modelId.split('/').pop() ?? modelId,
    quant?.hf_id ?? '',
    ...(quant?.files ?? []),
  ].filter((n) => n.length > 0);
  const lowered = served.toLowerCase();
  if (lowered === modelId.toLowerCase() || names.some((n) => n.toLowerCase() === lowered)) {
    return { level: 'ok' };
  }

  const servedSizes = sizeTokens(served);
  const labelSizes = new Set(names.flatMap((n) => [...sizeTokens(n)]));
  if (
    servedSizes.size > 0 &&
    labelSizes.size > 0 &&
    ![...servedSizes].some((s) => labelSizes.has(s))
  ) {
    return {
      level: 'error',
      message:
        `the server answered as "${served}" (${[...servedSizes].map((s) => `${s}B`).join(', ')}), ` +
        `but the result is filed under ${modelId} (${[...labelSizes].map((s) => `${s}B`).join(', ')}). ` +
        `These numbers belong to another model. Set model.served_model_id in the packet so the ` +
        `harness sends the right name, and re-run`,
    };
  }

  const servedWords = nameWords(served);
  const labelWords = new Set(names.flatMap((n) => [...nameWords(n)]));
  if (servedWords.size > 0 && ![...servedWords].some((w) => labelWords.has(w))) {
    return {
      level: 'warn',
      message:
        `the server answered as "${served}", which shares no name with ${modelId} or its quant ` +
        `files; confirm the right model was loaded`,
    };
  }
  return { level: 'ok' };
}

export function checkServedModel(
  file: string,
  result: ResultRecord,
  quant: { hf_id?: string | null; files?: readonly string[] | null } | null,
  reporter: Reporter,
): void {
  const endpoint = (result.raw?.payload as Record<string, unknown> | null | undefined)?.[
    'engine_endpoint'
  ] as { served_model_id?: unknown } | undefined;
  const served = endpoint?.served_model_id;
  if (typeof served !== 'string' || served.trim() === '') return;

  const verdict = servedModelVerdict(served.trim(), result.model.id, quant);
  const path = { path: 'raw.payload.engine_endpoint.served_model_id' };
  if (verdict.level === 'error') {
    reporter.error(file, 'served-model-mismatch', verdict.message!, path);
  } else if (verdict.level === 'warn') {
    reporter.warn(file, 'served-model-unmatched', verdict.message!, path);
  }
}

/**
 * llama.cpp reports its build in `/props` as `b<N>-<sha>`; the harness records it as
 * `engine_endpoint.build_info`. A result whose engine.version disagrees with the build the
 * server itself reported names a different build than the one measured.
 */
export function checkReportedBuild(file: string, result: ResultRecord, reporter: Reporter): void {
  const endpoint = (result.raw?.payload as Record<string, unknown> | null | undefined)?.[
    'engine_endpoint'
  ] as { build_info?: unknown } | undefined;
  const info = endpoint?.build_info;
  if (typeof info !== 'string' || info.trim() === '') return;
  const version = result.engine.version;
  const parts = info.trim().toLowerCase().split('-');
  if (parts.includes(version.toLowerCase()) || info.trim() === version) return;
  reporter.error(
    file,
    'engine-version-contradicts-server',
    `engine.version is "${version}" but the server reported build "${info.trim()}"; record the build that was measured`,
    { path: 'engine.version' },
  );
}
