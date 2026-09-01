/**
 * What box am I looking at? Same philosophy as `atlas-bench hwinfo`: capture, never type.
 * This is the TypeScript sibling — enough of a capture to *match* a registry entry and to
 * gate fit verdicts, not a replacement for the harness (which still stamps result files).
 *
 * The same probe runs locally and over ssh: `captureHardware` shells out through an injected
 * `ExecLike`, and `captureRemote` sends one combined probe script to another host, so the
 * box you are targeting does not have to be the box you are sitting at.
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

/* ------------------------------------------------------------------------ remote */

/**
 * One shell script rather than five round-trips: ssh latency dominates, and a single
 * connection keeps `ssh` prompting (host key, passphrase) to at most one interaction.
 * Every probe is guarded — a box without nvidia-smi or lscpu still reports what it has.
 */
export const PROBE_SCRIPT = [
  'echo "os=$(uname -s)"',
  'echo "arch=$(uname -m)"',
  'if [ "$(uname -s)" = Darwin ]; then',
  '  echo "cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"',
  '  echo "membytes=$(sysctl -n hw.memsize 2>/dev/null)"',
  'else',
  '  echo "cpu=$(lscpu 2>/dev/null | sed -n \'s/^Model name:[[:space:]]*//p\' | head -1)"',
  '  echo "cpu2=$(sed -n \'s/^model name[[:space:]]*: //p\' /proc/cpuinfo 2>/dev/null | head -1)"',
  '  echo "memkb=$(sed -n \'s/^MemTotal:[[:space:]]*\\([0-9]*\\).*/\\1/p\' /proc/meminfo 2>/dev/null)"',
  'fi',
  'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null |',
  '  while IFS= read -r l; do echo "gpu=$l"; done',
].join('\n');

/** Parse the probe output. Exported for tests and so a bad line never throws. */
export function parseProbe(output: string): CapturedHardware {
  const fields = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!value) continue;
    const list = fields.get(key);
    if (list) list.push(value);
    else fields.set(key, [value]);
  }
  const first = (key: string): string => fields.get(key)?.[0] ?? '';

  const uname = first('os');
  const platform: NodeJS.Platform =
    uname === 'Darwin' ? 'darwin' : uname === 'Linux' ? 'linux' : 'linux';
  const cpu = first('cpu') || first('cpu2');
  const appleChip = platform === 'darwin' && /^Apple\s/.test(cpu) ? cpu : null;

  let memoryGb = 0;
  const bytes = Number(first('membytes'));
  const kb = Number(first('memkb'));
  if (Number.isFinite(bytes) && bytes > 0) memoryGb = Math.round(bytes / 1024 ** 3);
  else if (Number.isFinite(kb) && kb > 0) memoryGb = Math.round((kb / 1024 ** 2) * 10) / 10;

  const nvidiaGpus: string[] = [];
  let vramGb: number | null = null;
  for (const line of fields.get('gpu') ?? []) {
    const [name, mem] = line.split(',').map((s) => s.trim());
    if (!name) continue;
    nvidiaGpus.push(name);
    const mib = Number(mem);
    if (Number.isFinite(mib) && mib > 0) vramGb = Math.round((mib / 1024) * 10) / 10;
  }

  return { platform, arch: first('arch'), cpu, appleChip, nvidiaGpus, memoryGb, vramGb };
}

/**
 * Capture another machine over ssh. `destination` is whatever ssh understands — an alias
 * from `~/.ssh/config`, `user@host`, anything. BatchMode keeps it from hanging on a
 * password prompt inside the TUI: a box that needs interaction fails fast and says so.
 */
export function captureRemote(
  destination: string,
  exec: ExecLike = defaultExec,
): { captured: CapturedHardware } | { error: string } {
  try {
    const out = exec('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      destination,
      PROBE_SCRIPT,
    ]);
    const captured = parseProbe(out);
    if (!captured.cpu && captured.nvidiaGpus.length === 0 && captured.memoryGb === 0) {
      return { error: `${destination}: probe returned nothing usable` };
    }
    return { captured };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `ssh ${destination}: ${message.split('\n')[0]}` };
  }
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
