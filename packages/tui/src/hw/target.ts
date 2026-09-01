/**
 * The **target box**: the hardware a run is judged against, and how many of them.
 *
 * Detection is a first guess. It is right often enough to be worth doing and wrong often
 * enough that the user always owns the final answer — the machine you deploy to is
 * frequently not the machine you browse from, and a rig is rarely one card. So a target is
 * a registry entry plus a **count**, the TUI proposes one at startup, asks outright when it
 * cannot recognise the box, and the choice is written to the config file.
 *
 * Counts are not cosmetic. `3 × nvidia-rtx-6000` has three times the memory *and* three
 * times the bandwidth of one, but only for engines that can shard a model across devices,
 * and only when the devices are in one host. Two DGX Sparks are two computers: a model must
 * fit one of them. `poolable` is what keeps that distinction honest.
 */

import type { Hardware } from '@atlas/core';
import type { CapturedHardware, ExecLike } from './capture.js';
import { captureHardware, localPlatformTags } from './capture.js';
import { matchHardware } from './match.js';

/** How the current target came to be — shown in the UI, never guessed at. */
export type TargetSource = 'detected' | 'chosen' | 'unknown';

export interface Target {
  /** The registry entry, or null when this machine matched nothing and nothing was chosen. */
  hardware: Hardware | null;
  /** How many of them. Always ≥ 1. */
  count: number;
  source: TargetSource;
  /** What was probed on this machine, kept for the "detected" reasoning and platform tags. */
  captured: CapturedHardware | null;
  /** Whether `captured` describes *this* target (false once the user picks another box). */
  capturedIsTarget: boolean;
}

/** "3 × NVIDIA RTX 6000 Pro" / "Apple M2 Max (32 GB)". */
export function targetLabel(target: Target): string {
  const name = target.hardware?.name ?? target.captured?.cpu ?? 'unidentified box';
  return target.count > 1 ? `${target.count} × ${name}` : name;
}

export function targetId(target: Target): string {
  return target.hardware
    ? `${target.hardware.id}${target.count > 1 ? `×${target.count}` : ''}`
    : 'unknown';
}

/**
 * Detect this machine. A multi-GPU host reports one nvidia-smi line per device, so the
 * count comes out of the probe rather than being assumed to be 1.
 */
export function detectTarget(registry: Hardware[], exec?: ExecLike): Target {
  const captured = captureHardware(exec);
  const match = matchHardware(captured, registry);
  const count = match && captured.nvidiaGpus.length > 1 ? captured.nvidiaGpus.length : 1;
  return {
    hardware: match?.hardware ?? null,
    count,
    source: match ? 'detected' : 'unknown',
    captured,
    capturedIsTarget: true,
  };
}

/** The user picked a box. `captured` stays for reference but no longer describes the target. */
export function chooseTarget(
  hardware: Hardware,
  count: number,
  captured: CapturedHardware | null,
): Target {
  const isThisMachine = captured !== null && matchHardware(captured, [hardware]) !== null;
  return {
    hardware,
    count: Math.max(1, Math.round(count)),
    source: 'chosen',
    captured,
    capturedIsTarget: isThisMachine,
  };
}

/**
 * Platform tags for the target. When the target is the probed machine we know the answer;
 * otherwise it is inferred from the registry entry's vendor and callers must say so.
 */
export function targetPlatformTags(target: Target): { tags: string[]; inferred: boolean } {
  if (target.captured && target.capturedIsTarget) {
    return { tags: localPlatformTags(target.captured), inferred: false };
  }
  const hw = target.hardware;
  if (!hw) return { tags: [], inferred: true };
  const vendor = hw.vendor.toLowerCase();
  if (vendor === 'apple') return { tags: ['macos-metal', 'macos-cpu'], inferred: true };
  if (vendor === 'nvidia') return { tags: ['linux-cuda', 'linux-cpu'], inferred: true };
  if (vendor === 'amd') return { tags: ['linux-rocm', 'linux-cpu'], inferred: true };
  if (vendor === 'intel') return { tags: ['linux-xpu', 'linux-cpu'], inferred: true };
  return { tags: ['linux-cpu'], inferred: true };
}

export interface TargetMemory {
  /** Memory of one device. */
  perDeviceGb: number | null;
  /** Memory a single model can reach: pooled across devices only when that is real. */
  usableGb: number | null;
  /**
   * True when several devices can serve one model together — discrete GPUs in a host, which
   * an engine shards across with tensor parallelism. False for several whole machines
   * (`soc`, `cpu`): those are separate nodes and a model has to fit one of them.
   */
  poolable: boolean;
}

export function targetMemory(target: Target): TargetMemory {
  const hw = target.hardware;
  const perDeviceGb =
    hw?.memory_gb ??
    (target.capturedIsTarget && target.captured?.memoryGb ? target.captured.memoryGb : null);
  const poolable = target.count > 1 && hw?.kind === 'gpu';
  if (perDeviceGb === null) return { perDeviceGb: null, usableGb: null, poolable };
  return {
    perDeviceGb,
    usableGb: poolable ? perDeviceGb * target.count : perDeviceGb,
    poolable,
  };
}

/** Devices a single model can be served across — what `bandwidthCeiling` should scale by. */
export function servingDevices(target: Target): number {
  return targetMemory(target).poolable ? target.count : 1;
}

/** One-line description for the header and the recipe. */
export function describeTarget(target: Target): string {
  const bits: string[] = [];
  const mem = targetMemory(target);
  const hw = target.hardware;
  if (hw) {
    if (mem.perDeviceGb) {
      bits.push(
        mem.poolable
          ? `${mem.perDeviceGb} GB each → ${mem.usableGb} GB pooled`
          : `${mem.perDeviceGb} GB`,
      );
    }
    if (hw.memory_bandwidth_gbs) {
      const devices = servingDevices(target);
      bits.push(
        devices > 1
          ? `${hw.memory_bandwidth_gbs} GB/s × ${devices}`
          : `${hw.memory_bandwidth_gbs} GB/s`,
      );
    }
    if (target.count > 1 && !mem.poolable) bits.push('separate machines — a model must fit one');
  } else if (target.captured) {
    bits.push(target.captured.cpu, `${target.captured.memoryGb} GB`);
  }
  if (target.source === 'chosen' && !target.capturedIsTarget) bits.push('chosen, not probed');
  if (target.source === 'detected') bits.push('detected on this machine');
  return bits.filter(Boolean).join(' · ');
}
