/**
 * Would this measured configuration run on the local box, and what should it expect?
 *
 * The verdict is deliberately honest about its basis. The atlas so far holds only
 * unified-memory boxes, so `metrics.ram_peak_gb` is the measured footprint where it exists;
 * when it does not (or the local box differs), the fall-back is `quant.size_gb` plus
 * headroom — and the verdict then says "estimate", never "measured".
 */

import type {
  Hardware,
  IndexRow,
  Quant,
  RegistryEngine,
  RegistryModel,
  ResultRecord,
} from '@atlas/core';
import { bandwidthCeiling } from '@atlas/core';
import type { CapturedHardware } from './capture.js';
import { localPlatformTags } from './capture.js';

export type FitLevel =
  'recommended' | 'should-fit' | 'tight' | 'no-fit' | 'wrong-platform' | 'unknown';

export interface FitVerdict {
  level: FitLevel;
  /** One-line summary for tables. */
  label: string;
  /** Full reasoning, one reason per line, shown in the detail view and the recipe. */
  reasons: string[];
  /** Whether the memory judgement is a measurement or an estimate. */
  memoryBasis: 'measured' | 'estimated' | 'none';
  /** Decode ceiling on the local box in tok/s (bandwidth bound), when computable. */
  decodeCeiling: number | null;
}

export interface FitInput {
  row: IndexRow;
  /** Full record when loaded — refines memory with the measured peak. */
  record?: ResultRecord | null;
  engine: RegistryEngine | null;
  model: RegistryModel | null;
  quant: Quant | null;
  /** Registry entry the run was measured on. */
  measuredOn: Hardware | null;
  /** Registry entry for the local box (null = unidentified box). */
  localHardware: Hardware | null;
  captured: CapturedHardware;
}

const LABEL: Record<FitLevel, string> = {
  recommended: '✓ recommended',
  'should-fit': '~ should fit',
  tight: '! tight',
  'no-fit': '✗ won’t fit',
  'wrong-platform': '✗ wrong platform',
  unknown: '? unknown',
};

/** KV-cache + runtime headroom the estimate reserves on top of the weights. */
const HEADROOM_FRACTION = 0.25;

export function fitVerdict(input: FitInput): FitVerdict {
  const reasons: string[] = [];
  const { row, engine, captured } = input;

  // 1. Platform: does any of this engine's platforms match the local box?
  const platforms = engine?.meta.platforms ?? [];
  const local = localPlatformTags(captured);
  if (platforms.length > 0 && !platforms.some((p) => local.includes(p))) {
    reasons.push(
      `${row.engine.id} runs on ${platforms.join(', ')} — this box offers ${local.join(', ') || 'an unknown platform'}`,
    );
    return {
      level: 'wrong-platform',
      label: LABEL['wrong-platform'],
      reasons,
      memoryBasis: 'none',
      decodeCeiling: null,
    };
  }

  // 2. Quant format support (quant.engines is validated repo-side, so this rarely fires).
  if (
    input.quant &&
    input.quant.engines.length > 0 &&
    !input.quant.engines.includes(row.engine.id)
  ) {
    reasons.push(`quant ${input.quant.id} lists engines ${input.quant.engines.join(', ')}`);
    return {
      level: 'no-fit',
      label: LABEL['no-fit'],
      reasons,
      memoryBasis: 'none',
      decodeCeiling: null,
    };
  }

  // 3. Memory. Measured peak from the run when the run has one, else weights + headroom.
  const localMem = input.localHardware?.memory_gb ?? captured.memoryGb;
  const measuredPeak =
    input.record?.metrics?.ram_peak_gb ?? input.record?.metrics?.vram_peak_gb ?? null;
  let memoryBasis: FitVerdict['memoryBasis'] = 'none';
  let need: number | null = null;
  if (typeof measuredPeak === 'number' && measuredPeak > 0) {
    need = measuredPeak;
    memoryBasis = 'measured';
    reasons.push(`measured peak ${measuredPeak.toFixed(1)} GB on ${row.hardware.id}`);
  } else if (input.quant?.size_gb) {
    need = input.quant.size_gb * (1 + HEADROOM_FRACTION);
    memoryBasis = 'estimated';
    reasons.push(
      `estimate: ${input.quant.size_gb.toFixed(1)} GB weights + ${Math.round(HEADROOM_FRACTION * 100)}% headroom ≈ ${need.toFixed(1)} GB (no measured peak for this box)`,
    );
  } else {
    reasons.push('no measured footprint and no quant size — memory fit unknown');
  }

  let level: FitLevel = 'unknown';
  if (need !== null && localMem > 0) {
    const frac = need / localMem;
    reasons.push(`local memory ${localMem.toFixed(0)} GB → ${(frac * 100).toFixed(0)}% used`);
    if (frac > 1) level = 'no-fit';
    else if (frac > 0.9) level = 'tight';
    else level = memoryBasis === 'measured' ? 'recommended' : 'should-fit';
  }

  // Same box the run was measured on and it succeeded → recommended even off an estimate.
  if (
    level !== 'no-fit' &&
    level !== 'unknown' &&
    input.localHardware &&
    input.measuredOn &&
    input.localHardware.id === input.measuredOn.id
  ) {
    reasons.push(`measured on this exact hardware (${input.measuredOn.id})`);
    level = 'recommended';
    memoryBasis = memoryBasis === 'none' ? 'estimated' : memoryBasis;
  }

  // 4. Expectation: the bandwidth-bound decode ceiling on the local box.
  const decodeCeiling = bandwidthCeiling(
    input.localHardware,
    input.model?.model ?? null,
    input.quant,
    1, // no tolerance — this is a ceiling, not a plausibility band
  );
  if (decodeCeiling !== null) {
    reasons.push(`bandwidth-bound decode ceiling here ≈ ${decodeCeiling.toFixed(0)} tok/s`);
  }

  return { level, label: LABEL[level], reasons, memoryBasis, decodeCeiling };
}
