import { describe, expect, it } from 'vitest';
import type { Hardware, IndexRow, Quant, RegistryEngine } from '@atlas/core';
import { fixtureRow } from '@atlas/core';
import type { CapturedHardware } from './capture.js';
import { captureHardware, localPlatformTags, parseProbe } from './capture.js';
import { matchHardware } from './match.js';
import { fitVerdict } from './fit.js';
import type { Target } from './target.js';
import { describeTarget, registryTarget, targetMemoryGb, targetPlatformTags } from './target.js';

const m2max: CapturedHardware = {
  platform: 'darwin',
  arch: 'arm64',
  cpu: 'Apple M2 Max',
  appleChip: 'Apple M2 Max',
  nvidiaGpus: [],
  memoryGb: 32,
  vramGb: null,
};

const spark: CapturedHardware = {
  platform: 'linux',
  arch: 'arm64',
  cpu: 'Cortex-A725',
  appleChip: null,
  nvidiaGpus: ['NVIDIA GB10'],
  memoryGb: 121.6,
  vramGb: null,
};

const hw = (over: Partial<Hardware>): Hardware =>
  ({
    schema_version: 1,
    id: 'x',
    name: 'x',
    vendor: 'x',
    kind: 'soc',
    memory_gb: null,
    ...over,
  }) as Hardware;

const REGISTRY: Hardware[] = [
  hw({
    id: 'apple-m2-max-32gb',
    vendor: 'apple',
    memory_gb: 32,
    detect: { apple_chip: ['Apple M2 Max'], memory_gb: 32 },
  }),
  hw({
    id: 'apple-m2-max-96gb',
    vendor: 'apple',
    memory_gb: 96,
    detect: { apple_chip: ['Apple M2 Max'], memory_gb: 96 },
  }),
  hw({
    id: 'nvidia-gb10-dgx-spark',
    vendor: 'nvidia',
    memory_gb: 128,
    memory_bandwidth_gbs: 273,
    detect: { nvidia_smi_name: ['NVIDIA GB10'], cpu_model: ['Cortex-X925', 'NVIDIA Grace'] },
  }),
];

describe('captureHardware', () => {
  it('captures a Mac through sysctl without throwing on missing tools', () => {
    const captured = captureHardware((cmd, args) => {
      if (cmd === 'sysctl' && args[1] === 'machdep.cpu.brand_string') return 'Apple M2 Max\n';
      if (cmd === 'sysctl' && args[1] === 'hw.memsize') return String(32 * 1024 ** 3);
      throw new Error(`no ${cmd}`);
    });
    if (process.platform === 'darwin') {
      expect(captured.appleChip).toBe('Apple M2 Max');
      expect(captured.memoryGb).toBe(32);
    }
    expect(captured.nvidiaGpus).toEqual([]);
  });
});

describe('localPlatformTags', () => {
  it('maps Apple Silicon to metal', () => {
    expect(localPlatformTags(m2max)).toEqual(['macos-metal', 'macos-cpu']);
  });
  it('maps a CUDA linux box', () => {
    expect(localPlatformTags(spark)).toEqual(['linux-cuda', 'linux-cpu']);
  });
});

describe('matchHardware', () => {
  it('picks the right memory variant of an Apple chip', () => {
    expect(matchHardware(m2max, REGISTRY)?.hardware.id).toBe('apple-m2-max-32gb');
  });
  it('matches the Spark on its GPU name despite an unlisted CPU', () => {
    expect(matchHardware(spark, REGISTRY)?.hardware.id).toBe('nvidia-gb10-dgx-spark');
  });
  it('returns null rather than guessing', () => {
    const alien: CapturedHardware = {
      ...m2max,
      appleChip: 'Apple M9 Ultra',
      cpu: 'Apple M9 Ultra',
    };
    expect(matchHardware(alien, REGISTRY)).toBeNull();
  });
});

describe('fitVerdict', () => {
  const engine = (platforms: string[]): RegistryEngine =>
    ({
      meta: { id: 'vllm', platforms },
      overlay: null,
      versions: [],
      param_counts: {},
    }) as unknown as RegistryEngine;
  const quant = (over: Partial<Quant>): Quant =>
    ({ id: 'q', model_id: 'm', format: 'gguf', bits: 4, engines: [], ...over }) as unknown as Quant;
  const row = fixtureRow() as IndexRow;
  const targetOf = (captured: CapturedHardware, hw: Hardware | null): Target => ({
    kind: 'local',
    id: 'local',
    label: hw?.id ?? captured.cpu,
    captured,
    hardware: hw,
    ssh: null,
  });

  it('rejects a linux-only engine on a Mac', () => {
    const v = fitVerdict({
      row,
      engine: engine(['linux-cuda']),
      model: null,
      quant: null,
      target: targetOf(m2max, REGISTRY[0]!),
    });
    expect(v.level).toBe('wrong-platform');
    expect(v.reasons[0]).toContain('linux-cuda');
  });

  it('estimates from quant size when there is no measured peak, and says so', () => {
    const v = fitVerdict({
      row,
      engine: engine(['macos-metal']),
      model: null,
      quant: quant({ size_gb: 8 }),
      target: targetOf(m2max, REGISTRY[0]!),
    });
    expect(v.level).toBe('should-fit');
    expect(v.memoryBasis).toBe('estimated');
    expect(v.reasons.join('\n')).toContain('estimate');
  });

  it('will not fit when the estimate exceeds local memory', () => {
    const v = fitVerdict({
      row,
      engine: engine(['macos-metal']),
      model: null,
      quant: quant({ size_gb: 40 }),
      target: targetOf(m2max, REGISTRY[0]!),
    });
    expect(v.level).toBe('no-fit');
  });

  it('recommends off a measured peak that fits', () => {
    const v = fitVerdict({
      row,
      record: { metrics: { ram_peak_gb: 20 } } as never,
      engine: engine(['macos-metal']),
      model: null,
      quant: quant({ size_gb: 18 }),
      target: targetOf(m2max, REGISTRY[0]!),
    });
    expect(v.level).toBe('recommended');
    expect(v.memoryBasis).toBe('measured');
  });

  it('upgrades to recommended when the target IS the box the run was measured on', () => {
    const v = fitVerdict({
      row: fixtureRow({ hardware: { id: 'nvidia-gb10-dgx-spark', count: 1 } }) as IndexRow,
      engine: engine(['linux-cuda']),
      model: null,
      quant: quant({ size_gb: 20 }),
      target: targetOf(spark, REGISTRY[2]!),
    });
    expect(v.level).toBe('recommended');
    expect(v.reasons.join('\n')).toContain('this exact hardware');
  });

  it('judges a remote ssh target, not the machine it runs on', () => {
    const remote: Target = {
      kind: 'remote',
      id: 'ssh:spark',
      label: 'spark',
      captured: spark,
      hardware: REGISTRY[2]!,
      ssh: 'spark',
    };
    // A linux-cuda engine is wrong for this Mac but right for the remote box.
    const v = fitVerdict({
      row,
      engine: engine(['linux-cuda']),
      model: null,
      quant: quant({ size_gb: 60 }),
      target: remote,
    });
    expect(v.level).toBe('should-fit');
    expect(v.reasons.join('\n')).toContain('spark has 128 GB');
  });

  it('says so when a hand-picked registry target only infers its platform', () => {
    const v = fitVerdict({
      row,
      engine: engine(['macos-metal']),
      model: null,
      quant: quant({ size_gb: 10 }),
      target: registryTarget(REGISTRY[2]!), // an NVIDIA box: metal cannot run there
    });
    expect(v.level).toBe('wrong-platform');
    expect(v.reasons[0]).toContain('inferred from the registry entry');
  });
});

describe('target', () => {
  it('derives real platform tags from a capture', () => {
    const t = {
      kind: 'remote',
      id: 'ssh:x',
      label: 'x',
      captured: spark,
      hardware: null,
      ssh: 'x',
    } as Target;
    expect(targetPlatformTags(t)).toEqual({ tags: ['linux-cuda', 'linux-cpu'], inferred: false });
  });

  it('infers platform tags from the vendor when nothing was probed', () => {
    expect(targetPlatformTags(registryTarget(REGISTRY[0]!))).toEqual({
      tags: ['macos-metal', 'macos-cpu'],
      inferred: true,
    });
    expect(targetPlatformTags(registryTarget(REGISTRY[2]!)).inferred).toBe(true);
  });

  it('prefers the registry memory over the captured figure', () => {
    const t = {
      kind: 'remote',
      id: 'ssh:x',
      label: 'x',
      captured: spark, // 121.6 GB visible to the OS
      hardware: REGISTRY[2]!, // 128 GB installed
      ssh: 'x',
    } as Target;
    expect(targetMemoryGb(t)).toBe(128);
  });

  it('describes a remote target with its ssh destination', () => {
    const t = {
      kind: 'remote',
      id: 'ssh:spark',
      label: 'spark',
      captured: spark,
      hardware: REGISTRY[2]!,
      ssh: 'spark',
    } as Target;
    expect(describeTarget(t)).toContain('NVIDIA GB10');
    expect(describeTarget(t)).toContain('via ssh spark');
  });
});

describe('parseProbe', () => {
  it('reads a linux box with a GPU', () => {
    const out = [
      'os=Linux',
      'arch=aarch64',
      'cpu=Cortex-A725',
      'cpu2=',
      'memkb=127512345',
      'gpu=NVIDIA GB10, 0',
    ].join('\n');
    const c = parseProbe(out);
    expect(c.platform).toBe('linux');
    expect(c.cpu).toBe('Cortex-A725');
    expect(c.nvidiaGpus).toEqual(['NVIDIA GB10']);
    expect(c.memoryGb).toBeCloseTo(121.6, 1);
    expect(c.appleChip).toBeNull();
  });

  it('reads a Mac and keeps the Apple chip', () => {
    const c = parseProbe(
      ['os=Darwin', 'arch=arm64', 'cpu=Apple M2 Max', `membytes=${32 * 1024 ** 3}`].join('\n'),
    );
    expect(c.platform).toBe('darwin');
    expect(c.appleChip).toBe('Apple M2 Max');
    expect(c.memoryGb).toBe(32);
  });

  it('falls back to /proc/cpuinfo when lscpu said nothing', () => {
    expect(parseProbe('os=Linux\ncpu=\ncpu2=AMD EPYC 7003').cpu).toBe('AMD EPYC 7003');
  });

  it('survives junk without throwing', () => {
    expect(parseProbe('garbage\n\n=x').nvidiaGpus).toEqual([]);
  });
});
