import { describe, expect, it } from 'vitest';
import type { Hardware, IndexRow, Quant, RegistryEngine } from '@atlas/core';
import { fixtureRow } from '@atlas/core';
import type { CapturedHardware } from './capture.js';
import { captureHardware, localPlatformTags } from './capture.js';
import { matchHardware } from './match.js';
import { fitVerdict } from './fit.js';
import type { Target } from './target.js';
import {
  chooseTarget,
  describeTarget,
  detectTarget,
  deviceCount,
  servingDevices,
  targetLabel,
  targetMemory,
  targetPlatformTags,
} from './target.js';

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

const GPU_24GB = hw({
  id: 'nvidia-rtx-4090',
  vendor: 'nvidia',
  kind: 'gpu',
  memory_gb: 24,
  memory_bandwidth_gbs: 1008,
  detect: { nvidia_smi_name: ['NVIDIA GeForce RTX 4090'] },
});

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
  GPU_24GB,
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
  it('matches a discrete GPU by its VRAM, not the host RAM', () => {
    // The bug this guards: `memory_gb` on a GPU entry is VRAM. Comparing a 24 GB card
    // against a workstation's 64 GB of system memory rejected every discrete GPU.
    const workstation: CapturedHardware = {
      platform: 'linux',
      arch: 'x64',
      cpu: 'AMD Ryzen 9 7950X',
      appleChip: null,
      nvidiaGpus: ['NVIDIA GeForce RTX 4090'],
      memoryGb: 64,
      vramGb: 24,
    };
    expect(matchHardware(workstation, REGISTRY)?.hardware.id).toBe('nvidia-rtx-4090');
  });

  it('still matches a GPU when nvidia-smi reported no VRAM figure', () => {
    const noVram: CapturedHardware = {
      platform: 'linux',
      arch: 'x64',
      cpu: 'AMD Ryzen 9 7950X',
      appleChip: null,
      nvidiaGpus: ['NVIDIA GeForce RTX 4090'],
      memoryGb: 128,
      vramGb: null,
    };
    expect(matchHardware(noVram, REGISTRY)?.hardware.id).toBe('nvidia-rtx-4090');
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
  const targetOf = (captured: CapturedHardware, hw: Hardware | null, count = 1): Target => ({
    hardware: hw,
    count,
    source: 'detected',
    captured,
    capturedIsTarget: true,
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

  it('says so when a chosen target only infers its platform', () => {
    const v = fitVerdict({
      row,
      engine: engine(['macos-metal']),
      model: null,
      quant: quant({ size_gb: 10 }),
      target: chooseTarget(REGISTRY[2]!, 1, null), // an NVIDIA box: metal cannot run there
    });
    expect(v.level).toBe('wrong-platform');
    expect(v.reasons[0]).toContain('inferred from the registry entry');
  });

  it('has no verdict at all until hardware is selected', () => {
    const v = fitVerdict({
      row,
      engine: engine(['macos-metal']),
      model: null,
      quant: quant({ size_gb: 10 }),
      target: {
        hardware: null,
        count: 1,
        source: 'unknown',
        captured: m2max,
        capturedIsTarget: true,
      },
    });
    expect(v.level).toBe('unknown');
    expect(v.reasons[0]).toContain('press b');
  });

  it('pools memory across several GPUs in a host and says how many are needed', () => {
    const v = fitVerdict({
      row,
      engine: engine(['linux-cuda']),
      model: null,
      quant: quant({ size_gb: 60 }), // 75 GB with headroom: needs 4 of the 24 GB cards
      target: chooseTarget(GPU_24GB, 4, null),
    });
    expect(v.level).toBe('should-fit');
    expect(v.devicesNeeded).toBe(4);
    expect(v.reasons.join('\n')).toContain('pools 96 GB (24 GB × 4)');
    expect(v.reasons.join('\n')).toContain('--tensor-parallel-size 4');
  });

  it('does not pool memory across separate machines', () => {
    // Two DGX Sparks are two computers: a 200 GB model does not fit "256 GB".
    const v = fitVerdict({
      row,
      engine: engine(['linux-cuda']),
      model: null,
      quant: quant({ size_gb: 200 }),
      target: chooseTarget(REGISTRY[2]!, 2, null),
    });
    expect(v.level).toBe('no-fit');
    expect(v.reasons.join('\n')).toContain('has 128 GB');
  });

  it('downgrades a run measured on more devices than the target has', () => {
    const v = fitVerdict({
      row: fixtureRow({
        hardware: { id: 'nvidia-rtx-4090', count: 4 },
        metrics: { output_tok_s: 100 },
      }) as IndexRow,
      engine: engine(['linux-cuda']),
      model: null,
      quant: quant({ size_gb: 10 }),
      target: chooseTarget(GPU_24GB, 1, null),
    });
    expect(v.level).toBe('tight');
    expect(v.reasons.join('\n')).toContain('measured on 4 devices, you have 1');
  });
});

describe('target', () => {
  it('derives real platform tags from the probed machine', () => {
    expect(targetPlatformTags(detectTarget(REGISTRY, () => ''))).toBeDefined();
    const probed: Target = {
      hardware: REGISTRY[2]!,
      count: 1,
      source: 'detected',
      captured: spark,
      capturedIsTarget: true,
    };
    expect(targetPlatformTags(probed)).toEqual({
      tags: ['linux-cuda', 'linux-cpu'],
      inferred: false,
    });
  });

  it('infers platform tags from the vendor when the box was chosen, not probed', () => {
    expect(targetPlatformTags(chooseTarget(REGISTRY[0]!, 1, null))).toEqual({
      tags: ['macos-metal', 'macos-cpu'],
      inferred: true,
    });
  });

  it('labels a multi-device target', () => {
    expect(targetLabel(chooseTarget(GPU_24GB, 3, null))).toBe('3 × x');
    expect(targetLabel(chooseTarget(GPU_24GB, 1, null))).toBe('x');
  });

  it('pools GPU memory but not whole machines', () => {
    expect(targetMemory(chooseTarget(GPU_24GB, 3, null))).toEqual({
      perDeviceGb: 24,
      usableGb: 72,
      poolable: true,
    });
    expect(targetMemory(chooseTarget(REGISTRY[2]!, 2, null))).toEqual({
      perDeviceGb: 128,
      usableGb: 128,
      poolable: false,
    });
  });

  it('scales serving devices only where memory pools', () => {
    expect(servingDevices(chooseTarget(GPU_24GB, 3, null))).toBe(3);
    expect(servingDevices(chooseTarget(REGISTRY[2]!, 2, null))).toBe(1);
  });

  it('describes pooling and separateness', () => {
    expect(describeTarget(chooseTarget(GPU_24GB, 3, null))).toContain('24 GB each → 72 GB pooled');
    expect(describeTarget(chooseTarget(REGISTRY[2]!, 2, null))).toContain('separate machines');
  });

  it('counts the probed GPUs once a registry entry matched', () => {
    const three: CapturedHardware = {
      ...spark,
      nvidiaGpus: ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 4090'],
    };
    expect(deviceCount(three, GPU_24GB)).toBe(3);
    expect(deviceCount({ ...three, nvidiaGpus: ['NVIDIA GeForce RTX 4090'] }, GPU_24GB)).toBe(1);
  });

  it('does not count devices on a box it could not identify', () => {
    const three: CapturedHardware = { ...spark, nvidiaGpus: ['a', 'a', 'a'] };
    expect(deviceCount(three, null)).toBe(1);
  });
});
