/**
 * What box am I sitting at? Same philosophy as `atlas-bench hwinfo`: capture, never type.
 * This is the TypeScript sibling — enough of a capture to *match* a registry entry and to
 * gate fit verdicts, not a replacement for the harness (which still stamps result files).
 *
 * Detection is a starting point, never the last word: whatever this finds, the user can
 * override in the hardware picker, because the box you deploy to is often not this one.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';

export interface CapturedHardware {
  platform: NodeJS.Platform;
  arch: string;
  cpu: string;
  /** Apple chip name when this is a Mac ("Apple M2 Max"), else null. */
  appleChip: string | null;
  /** GPU names from nvidia-smi, empty when there is none. */
  nvidiaGpus: string[];
  /** Total system memory in GB (unified memory on a Mac/SoC). */
  memoryGb: number;
  /** Dedicated VRAM in GB when nvidia-smi reports it, else null. */
  vramGb: number | null;
}

export type ExecLike = (cmd: string, args: string[]) => string;

const defaultExec: ExecLike = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

function tryExec(exec: ExecLike, cmd: string, args: string[]): string | null {
  try {
    return exec(cmd, args).trim();
  } catch {
    return null;
  }
}

export function captureHardware(exec: ExecLike = defaultExec): CapturedHardware {
  const platform = process.platform;
  const arch = process.arch;
  let cpu = os.cpus()[0]?.model ?? '';
  let appleChip: string | null = null;
  let memoryGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const nvidiaGpus: string[] = [];
  let vramGb: number | null = null;

  if (platform === 'darwin') {
    const brand = tryExec(exec, 'sysctl', ['-n', 'machdep.cpu.brand_string']);
    if (brand) cpu = brand;
    if (/^Apple\s/.test(cpu)) appleChip = cpu;
    const memsize = tryExec(exec, 'sysctl', ['-n', 'hw.memsize']);
    if (memsize && /^\d+$/.test(memsize)) memoryGb = Math.round(Number(memsize) / 1024 ** 3);
  } else if (platform === 'linux') {
    const lscpu = tryExec(exec, 'lscpu', []);
    const model = lscpu?.match(/Model name:\s*(.+)/)?.[1]?.trim();
    if (model) cpu = model;
  }

  const smi = tryExec(exec, 'nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits',
  ]);
  if (smi) {
    for (const line of smi.split('\n')) {
      const [name, mem] = line.split(',').map((s) => s.trim());
      if (!name) continue;
      nvidiaGpus.push(name);
      const mib = Number(mem);
      if (Number.isFinite(mib) && mib > 0) vramGb = Math.round((mib / 1024) * 10) / 10;
    }
  }

  return { platform, arch, cpu, appleChip, nvidiaGpus, memoryGb, vramGb };
}

/**
 * The platform tags a box can satisfy, in engine-meta vocabulary
 * (`macos-metal`, `linux-cuda`, `linux-cpu`, ...).
 */
export function localPlatformTags(hw: CapturedHardware): string[] {
  if (hw.platform === 'darwin') {
    return hw.appleChip ? ['macos-metal', 'macos-cpu'] : ['macos-cpu'];
  }
  if (hw.platform === 'linux') {
    return hw.nvidiaGpus.length > 0 ? ['linux-cuda', 'linux-cpu'] : ['linux-cpu'];
  }
  if (hw.platform === 'win32') {
    return hw.nvidiaGpus.length > 0 ? ['windows-cuda', 'windows-cpu'] : ['windows-cpu'];
  }
  return [];
}
