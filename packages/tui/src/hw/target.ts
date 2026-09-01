/**
 * The **target box**: the machine a run is being judged against, which is not necessarily
 * the machine the TUI is running on. Sitting at a Mac and deploying to a DGX over ssh is
 * the normal case, so every fit verdict, the ranking and the recipe are computed against a
 * target the user can switch at any time.
 *
 * Three kinds, in descending order of how much we actually know:
 *   local     — captured here, matched against the registry
 *   remote    — captured over ssh on another host, matched against the registry
 *   registry  — the user picked a hardware entry with nothing captured; platform support is
 *               inferred from the entry's vendor, and every verdict says so
 */

import type { Hardware } from '@atlas/core';
import type { CapturedHardware, ExecLike } from './capture.js';
import { captureHardware, captureRemote, localPlatformTags } from './capture.js';
import { matchHardware } from './match.js';

export type TargetKind = 'local' | 'remote' | 'registry';

export interface Target {
  kind: TargetKind;
  /** Stable id used to persist the selection: `local`, `ssh:<dest>`, `hw:<hardware-id>`. */
  id: string;
  /** Short label for the header ("this Mac", "spark", "nvidia-rtx-4090"). */
  label: string;
  /** What was probed, when anything was. */
  captured: CapturedHardware | null;
  /** Registry entry: matched from the capture, or chosen outright. */
  hardware: Hardware | null;
  /** ssh destination for a remote target. */
  ssh: string | null;
}

export function localTarget(registry: Hardware[], exec?: ExecLike): Target {
  const captured = captureHardware(exec);
  const match = matchHardware(captured, registry);
  return {
    kind: 'local',
    id: 'local',
    label: match?.hardware.name ?? captured.cpu ?? 'this machine',
    captured,
    hardware: match?.hardware ?? null,
    ssh: null,
  };
}

export function remoteTarget(
  destination: string,
  registry: Hardware[],
  exec?: ExecLike,
): { target: Target } | { error: string } {
  const result = captureRemote(destination, exec);
  if ('error' in result) return result;
  const match = matchHardware(result.captured, registry);
  return {
    target: {
      kind: 'remote',
      id: `ssh:${destination}`,
      label: destination,
      captured: result.captured,
      hardware: match?.hardware ?? null,
      ssh: destination,
    },
  };
}

/** A hardware entry chosen by hand — nothing probed, so nothing is claimed as measured. */
export function registryTarget(hardware: Hardware): Target {
  return {
    kind: 'registry',
    id: `hw:${hardware.id}`,
    label: hardware.name,
    captured: null,
    hardware,
    ssh: null,
  };
}

/**
 * Platform tags for a target. A capture gives the real answer; a hand-picked registry entry
 * only supports a guess from its vendor, which callers must treat as inferred.
 */
export function targetPlatformTags(target: Target): { tags: string[]; inferred: boolean } {
  if (target.captured) return { tags: localPlatformTags(target.captured), inferred: false };
  const hw = target.hardware;
  if (!hw) return { tags: [], inferred: true };
  const vendor = hw.vendor.toLowerCase();
  if (vendor === 'apple') return { tags: ['macos-metal', 'macos-cpu'], inferred: true };
  if (vendor === 'nvidia') return { tags: ['linux-cuda', 'linux-cpu'], inferred: true };
  if (vendor === 'amd') return { tags: ['linux-rocm', 'linux-cpu'], inferred: true };
  if (vendor === 'intel') return { tags: ['linux-xpu', 'linux-cpu'], inferred: true };
  return { tags: ['linux-cpu'], inferred: true };
}

/** Memory to judge fit against: the registry entry wins, a capture is the fallback. */
export function targetMemoryGb(target: Target): number | null {
  const registryMem = target.hardware?.memory_gb;
  if (typeof registryMem === 'number' && registryMem > 0) return registryMem;
  const captured = target.captured?.memoryGb;
  return typeof captured === 'number' && captured > 0 ? captured : null;
}

/** One-line description for the header and the recipe. */
export function describeTarget(target: Target): string {
  const bits: string[] = [];
  if (target.captured) {
    bits.push(target.captured.cpu || target.captured.platform);
    if (target.captured.nvidiaGpus.length > 0) bits.push(target.captured.nvidiaGpus.join(', '));
    const mem = target.captured.memoryGb;
    if (mem > 0) bits.push(`${mem} GB`);
  } else if (target.hardware) {
    if (target.hardware.memory_gb) bits.push(`${target.hardware.memory_gb} GB`);
    if (target.hardware.memory_bandwidth_gbs)
      bits.push(`${target.hardware.memory_bandwidth_gbs} GB/s`);
    bits.push('registry entry — nothing probed');
  }
  if (target.ssh) bits.push(`via ssh ${target.ssh}`);
  return bits.join(' · ');
}
