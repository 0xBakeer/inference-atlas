import { describe, expect, it } from 'vitest';
import type { Hardware, IndexRow, Quant, RegistryEngine } from '@atlas/core';
import { fixtureRow } from '@atlas/core';
import type { CapturedHardware } from './capture.js';
import { captureHardware, localPlatformTags } from './capture.js';
import { matchHardware } from './match.js';
import { fitVerdict } from './fit.js';

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
    memory_gb: 32,
    detect: { apple_chip: ['Apple M2 Max'], memory_gb: 32 },
  }),
  hw({
    id: 'apple-m2-max-96gb',
    memory_gb: 96,
    detect: { apple_chip: ['Apple M2 Max'], memory_gb: 96 },
  }),
  hw({
    id: 'nvidia-gb10-dgx-spark',
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

  it('rejects a linux-only engine on a Mac', () => {
    const v = fitVerdict({
      row,
      engine: engine(['linux-cuda']),
      model: null,
      quant: null,
      measuredOn: null,
      localHardware: REGISTRY[0]!,
      captured: m2max,
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
      measuredOn: null,
      localHardware: REGISTRY[0]!,
      captured: m2max,
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
      measuredOn: null,
      localHardware: REGISTRY[0]!,
      captured: m2max,
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
      measuredOn: null,
      localHardware: REGISTRY[0]!,
      captured: m2max,
    });
    expect(v.level).toBe('recommended');
    expect(v.memoryBasis).toBe('measured');
  });

  it('upgrades to recommended on the identical hardware id', () => {
    const v = fitVerdict({
      row,
      engine: engine(['linux-cuda']),
      model: null,
      quant: quant({ size_gb: 20 }),
      measuredOn: REGISTRY[2]!,
      localHardware: REGISTRY[2]!,
      captured: spark,
    });
    expect(v.level).toBe('recommended');
    expect(v.reasons.join('\n')).toContain('this exact hardware');
  });
});
