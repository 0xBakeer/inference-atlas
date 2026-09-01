/**
 * Would this measured configuration run on the **target** box, and what should it expect?
 *
 * The verdict is deliberately honest about its basis. The atlas so far holds only
 * unified-memory boxes, so `metrics.ram_peak_gb` is the measured footprint where it exists;
 * when it does not, the fall-back is `quant.size_gb` plus headroom — and the verdict then
 * says "estimate", never "measured". A target the user picked from the registry without
 * probing it says that too, rather than pretending the platform check was real.
 */

import type { IndexRow, Quant, RegistryEngine, RegistryModel, ResultRecord } from '@atlas/core';
import { bandwidthCeiling } from '@atlas/core';
import type { Target } from './target.js';
import { targetMemoryGb, targetPlatformTags } from './target.js';

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
  /** Decode ceiling on the target in tok/s (bandwidth bound), when computable. */
  decodeCeiling: number | null;
}

export interface FitInput {
  row: IndexRow;
  /** Full record when loaded — refines memory with the measured peak. */
  record?: ResultRecord | null;
  engine: RegistryEngine | null;
  model: RegistryModel | null;
  quant: Quant | null;
  /** The box being judged against. */
  target: Target;
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
  const { row, engine, target } = input;

  // 1. Platform: does any of this engine's platforms match the target?
  const platforms = engine?.meta.platforms ?? [];
  const { tags, inferred } = targetPlatformTags(target);
  if (platforms.length > 0 && tags.length > 0 && !platforms.some((p) => tags.includes(p))) {
    reasons.push(
      `${row.engine.id} runs on ${platforms.join(', ')} — ${target.label} offers ${tags.join(', ')}` +
        (inferred ? ' (inferred from the registry entry, nothing probed)' : ''),
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
  const targetMem = targetMemoryGb(target);
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
      `estimate: ${input.quant.size_gb.toFixed(1)} GB weights + ${Math.round(HEADROOM_FRACTION * 100)}% headroom ≈ ${need.toFixed(1)} GB (no measured peak)`,
    );
  } else {
    reasons.push('no measured footprint and no quant size — memory fit unknown');
  }

  let level: FitLevel = 'unknown';
  if (need !== null && targetMem !== null) {
    const frac = need / targetMem;
    reasons.push(
      `${target.label} has ${targetMem.toFixed(0)} GB → ${(frac * 100).toFixed(0)}% used`,
    );
    if (frac > 1) level = 'no-fit';
    else if (frac > 0.9) level = 'tight';
    else level = memoryBasis === 'measured' ? 'recommended' : 'should-fit';
  }

  // The target IS the box this run was measured on: the strongest evidence there is.
  if (
    level !== 'no-fit' &&
    level !== 'unknown' &&
    target.hardware &&
    target.hardware.id === row.hardware.id
  ) {
    reasons.push(`measured on this exact hardware (${target.hardware.id})`);
    level = 'recommended';
    memoryBasis = memoryBasis === 'none' ? 'estimated' : memoryBasis;
  }

  // 4. Expectation: the bandwidth-bound decode ceiling on the target.
  const decodeCeiling = bandwidthCeiling(
    target.hardware,
    input.model?.model ?? null,
    input.quant,
    1, // no tolerance — this is a ceiling, not a plausibility band
  );
  if (decodeCeiling !== null) {
    reasons.push(`bandwidth-bound decode ceiling there ≈ ${decodeCeiling.toFixed(0)} tok/s`);
  }

  return { level, label: LABEL[level], reasons, memoryBasis, decodeCeiling };
}
