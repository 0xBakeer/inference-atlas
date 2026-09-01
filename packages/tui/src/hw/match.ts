/**
 * Match a captured box against the hardware registry using the `detect` blocks each entry
 * carries — the same signals `atlas-bench hwinfo` uses. No guessing: a box that matches no
 * entry stays unidentified and the UI says so.
 */

import type { Hardware } from '@atlas/core';
import type { CapturedHardware } from './capture.js';

export interface HardwareMatch {
  hardware: Hardware;
  /** Higher is more specific: GPU/chip name match beats CPU match beats memory proximity. */
  score: number;
}

const contains = (haystack: string, needles: string[] | undefined): boolean =>
  !!needles?.some((n) => haystack.toLowerCase().includes(n.toLowerCase()));

export function matchHardware(
  captured: CapturedHardware,
  registry: Hardware[],
): HardwareMatch | null {
  const candidates: HardwareMatch[] = [];
  for (const hw of registry) {
    const d = hw.detect;
    if (!d) continue;
    let score = 0;
    if (captured.nvidiaGpus.some((g) => contains(g, d.nvidia_smi_name))) score += 100;
    if (captured.appleChip && contains(captured.appleChip, d.apple_chip)) score += 100;
    if (contains(captured.cpu, d.cpu_model)) score += 40;
    if (score === 0) continue;
    // Memory disambiguates size variants (apple-m2-max-32gb vs -96gb): exact-ish beats far.
    const wantMem = d.memory_gb ?? hw.memory_gb;
    if (wantMem) {
      const ratio = captured.memoryGb / wantMem;
      if (ratio > 0.85 && ratio < 1.18) score += 30;
      else score -= 50; // right chip family, wrong memory size — probably the sibling entry
    }
    candidates.push({ hardware: hw, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best && best.score >= 70 ? best : null;
}
