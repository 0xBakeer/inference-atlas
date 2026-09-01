/**
 * Would this measured configuration run on the **target** box, and what should it expect?
 *
 * The verdict is deliberately honest about its basis. The atlas so far holds only
 * unified-memory boxes, so `metrics.ram_peak_gb` is the measured footprint where it exists;
 * when it does not, the fall-back is `quant.size_gb` plus headroom — and the verdict then
 * says "estimate", never "measured". A target the user picked rather than probed says that
 * too, rather than pretending the platform check was real.
 *
 * Device counts are part of the judgement in both directions: a run measured on four cards
 * is not evidence that it fits on one, and a rig of four cards only helps a model that the
 * engine can shard across them.
 */

import type { IndexRow, Quant, RegistryEngine, RegistryModel, ResultRecord } from '@atlas/core';
import { bandwidthCeiling } from '@atlas/core';
import type { Target } from './target.js';
import { servingDevices, targetLabel, targetMemory, targetPlatformTags } from './target.js';

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
  /** Devices a single model must be sharded across to fit. 1 = no sharding needed. */
  devicesNeeded: number;
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

const NO_MEMORY = { memoryBasis: 'none', decodeCeiling: null, devicesNeeded: 1 } as const;

export function fitVerdict(input: FitInput): FitVerdict {
  const reasons: string[] = [];
  const { row, engine, target } = input;
  const label = targetLabel(target);

  // 0. Nothing selected yet: say so rather than inventing a verdict.
  if (!target.hardware) {
    return {
      level: 'unknown',
      label: LABEL.unknown,
      reasons: ['no target hardware selected — press b to pick your box'],
      ...NO_MEMORY,
    };
  }

  // 1. Platform: does any of this engine's platforms match the target?
  const platforms = engine?.meta.platforms ?? [];
  const { tags, inferred } = targetPlatformTags(target);
  if (platforms.length > 0 && tags.length > 0 && !platforms.some((p) => tags.includes(p))) {
    reasons.push(
      `${row.engine.id} runs on ${platforms.join(', ')} — ${label} offers ${tags.join(', ')}` +
        (inferred ? ' (inferred from the registry entry, nothing probed)' : ''),
    );
    return { level: 'wrong-platform', label: LABEL['wrong-platform'], reasons, ...NO_MEMORY };
  }

  // 2. Quant format support (quant.engines is validated repo-side, so this rarely fires).
  if (
    input.quant &&
    input.quant.engines.length > 0 &&
    !input.quant.engines.includes(row.engine.id)
  ) {
    reasons.push(`quant ${input.quant.id} lists engines ${input.quant.engines.join(', ')}`);
    return { level: 'no-fit', label: LABEL['no-fit'], reasons, ...NO_MEMORY };
  }

  // 3. Memory. Measured peak from the run when the run has one, else weights + headroom.
  const memory = targetMemory(target);
  const measuredCount = row.hardware.count || 1;
  const measuredPeak =
    input.record?.metrics?.ram_peak_gb ?? input.record?.metrics?.vram_peak_gb ?? null;
  let memoryBasis: FitVerdict['memoryBasis'] = 'none';
  let need: number | null = null;
  if (typeof measuredPeak === 'number' && measuredPeak > 0) {
    need = measuredPeak;
    memoryBasis = 'measured';
    reasons.push(
      `measured peak ${measuredPeak.toFixed(1)} GB on ${measuredCount > 1 ? `${measuredCount} × ` : ''}${row.hardware.id}`,
    );
  } else if (input.quant?.size_gb) {
    need = input.quant.size_gb * (1 + HEADROOM_FRACTION);
    memoryBasis = 'estimated';
    reasons.push(
      `estimate: ${input.quant.size_gb.toFixed(1)} GB weights + ${Math.round(HEADROOM_FRACTION * 100)}% headroom ≈ ${need.toFixed(1)} GB (no measured peak)`,
    );
  } else {
    reasons.push('no measured footprint and no quant size — memory fit unknown');
  }

  // How many of the target's devices this model has to be spread over.
  let devicesNeeded = 1;
  if (need !== null && memory.perDeviceGb) {
    devicesNeeded = Math.max(1, Math.ceil(need / memory.perDeviceGb));
  }

  let level: FitLevel = 'unknown';
  if (need !== null && memory.usableGb !== null) {
    const frac = need / memory.usableGb;
    reasons.push(
      memory.poolable
        ? `${label} pools ${memory.usableGb} GB (${memory.perDeviceGb} GB × ${target.count}) → ${(frac * 100).toFixed(0)}% used`
        : `${label} has ${memory.usableGb.toFixed(0)} GB → ${(frac * 100).toFixed(0)}% used`,
    );
    if (frac > 1) level = 'no-fit';
    else if (frac > 0.9) level = 'tight';
    else level = memoryBasis === 'measured' ? 'recommended' : 'should-fit';

    if (devicesNeeded > 1 && level !== 'no-fit') {
      reasons.push(
        `needs sharding across ${devicesNeeded} of your ${target.count} devices — the engine must support tensor parallelism (e.g. vLLM \`--tensor-parallel-size ${devicesNeeded}\`)`,
      );
    }
  }

  // The run was measured on more devices than the target has: not evidence that it fits.
  if (measuredCount > target.count) {
    reasons.push(
      `measured on ${measuredCount} devices, you have ${target.count} — the flags below assume ${measuredCount}`,
    );
    if (level === 'recommended' || level === 'should-fit') level = 'tight';
  }

  // The target IS the box this run was measured on, in the same quantity: strongest evidence.
  if (
    level !== 'no-fit' &&
    level !== 'unknown' &&
    target.hardware.id === row.hardware.id &&
    measuredCount === target.count
  ) {
    reasons.push(
      `measured on this exact hardware (${measuredCount > 1 ? `${measuredCount} × ` : ''}${target.hardware.id})`,
    );
    level = 'recommended';
    memoryBasis = memoryBasis === 'none' ? 'estimated' : memoryBasis;
  }

  // 4. Expectation: the bandwidth-bound decode ceiling on the target.
  const devices = servingDevices(target);
  const decodeCeiling = bandwidthCeiling(
    target.hardware,
    input.model?.model ?? null,
    input.quant,
    1, // no tolerance — this is a ceiling, not a plausibility band
    devices,
  );
  if (decodeCeiling !== null) {
    reasons.push(
      `bandwidth-bound decode ceiling there ≈ ${decodeCeiling.toFixed(0)} tok/s` +
        (devices > 1 ? ` across ${devices} devices` : ''),
    );
  }

  return { level, label: LABEL[level], reasons, memoryBasis, decodeCeiling, devicesNeeded };
}
