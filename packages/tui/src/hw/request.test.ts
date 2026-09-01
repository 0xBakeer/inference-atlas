import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '@atlas/core';
import type { CapturedHardware } from './capture.js';
import { hardwareIssueUrl, proposeHardware, requestPreview } from './request.js';

const site = {
  schema_version: 1,
  repo: { owner: '0xBakeer', name: 'inference-atlas', default_branch: 'main' },
} as unknown as SiteConfig;

const base: CapturedHardware = {
  platform: 'linux',
  arch: 'x64',
  cpu: 'AMD Ryzen 9 7950X',
  appleChip: null,
  nvidiaGpus: [],
  memoryGb: 64,
  vramGb: null,
};

describe('proposeHardware', () => {
  it('proposes a vendor-first id for a GPU, dropping the marketing words', () => {
    const r = proposeHardware({
      ...base,
      nvidiaGpus: ['NVIDIA GeForce RTX 5090'],
      vramGb: 32,
    });
    expect(r.id).toBe('nvidia-rtx-5090');
    expect(r.kind).toBe('gpu');
    expect(r.memory).toContain('32 GB VRAM');
  });

  it('puts the memory size in an Apple id, because unified memory is the constraint', () => {
    const r = proposeHardware({
      ...base,
      platform: 'darwin',
      cpu: 'Apple M4 Max',
      appleChip: 'Apple M4 Max',
      memoryGb: 128,
    });
    expect(r.id).toBe('apple-m4-max-128gb');
    expect(r.kind).toBe('soc');
    expect(r.name).toBe('Apple M4 Max (128 GB)');
  });

  it('falls back to the CPU for a box with neither', () => {
    const r = proposeHardware(base);
    expect(r.id).toBe('amd-ryzen-9-7950x');
    expect(r.kind).toBe('cpu');
  });

  it('never guesses a bandwidth figure — the plausibility checks would trust it', () => {
    const r = proposeHardware({ ...base, nvidiaGpus: ['NVIDIA H200'], vramGb: 141 });
    expect(r.memory).toContain('UNKNOWN');
    expect(r.specs).toContain('memory_bandwidth_gbs:');
    expect(r.specs).not.toMatch(/\d+\s*GB\/s/);
  });

  it('carries the probe output verbatim as the detection strings', () => {
    const r = proposeHardware({ ...base, nvidiaGpus: ['NVIDIA GB10', 'NVIDIA GB10'] });
    expect(r.detect).toContain('NVIDIA GB10');
    expect(r.detect).toContain('AMD Ryzen 9 7950X');
    expect(r.detect).toContain('64 GB visible to the OS');
    expect(r.specs).toContain('This host has 2 of these devices.');
  });
});

describe('hardwareIssueUrl', () => {
  const r = proposeHardware({ ...base, nvidiaGpus: ['NVIDIA GeForce RTX 5090'], vramGb: 32 });
  const url = hardwareIssueUrl(r, site);

  it('targets the repository issue form for hardware', () => {
    expect(url.startsWith('https://github.com/0xBakeer/inference-atlas/issues/new?')).toBe(true);
    expect(url).toContain('template=new-hardware.yml');
  });

  it('pre-fills every field the template declares', () => {
    const params = new URL(url).searchParams;
    for (const field of ['id', 'name', 'kind', 'memory', 'detect', 'specs', 'title']) {
      expect(params.get(field)).toBeTruthy();
    }
    expect(params.get('id')).toBe('nvidia-rtx-5090');
    expect(params.get('kind')).toBe('gpu');
  });

  it('stays inside the URL length a browser will accept', () => {
    expect(url.length).toBeLessThan(8000);
  });

  it('carries nothing beyond the hardware probe — no user, host or path', () => {
    const body = decodeURIComponent(url);
    expect(body).not.toMatch(/\/Users\/|\/home\/|@/);
  });
});

describe('requestPreview', () => {
  it('shows the id, kind and the probe lines the user is about to send', () => {
    const lines = requestPreview(proposeHardware(base)).join('\n');
    expect(lines).toContain('id      amd-ryzen-9-7950x');
    expect(lines).toContain('kind    cpu');
    expect(lines).toContain('uname:  linux x64');
  });
});
