/**
 * Smoke test of the whole TUI against a small fixture repo — the same shapes the build
 * emits, read through LocalSource, rendered with ink-testing-library.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureRow } from '@atlas/core';
import { DEFAULT_CONFIG } from '../config.js';
import { loadAtlas } from '../data/load.js';
import { LocalSource } from '../data/source.js';
import type { CapturedHardware } from '../hw/capture.js';
import { matchHardware } from '../hw/match.js';
import type { Target } from '../hw/target.js';
import { App } from './App.js';

let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tui-app-'));
  const dataDir = path.join(repo, 'app', 'public', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value));

  write('manifest.json', {
    schema_version: 1,
    commit_short: 'abc1234',
    counts: { runs: 2, models: 1, hardware: 1, engines: 1 },
    shards: {},
  });
  write('registry.json', {
    hardware: [
      {
        schema_version: 1,
        id: 'apple-m2-max-32gb',
        name: 'Apple M2 Max 32GB',
        vendor: 'apple',
        kind: 'soc',
        memory_gb: 32,
        memory_bandwidth_gbs: 400,
        detect: { apple_chip: ['Apple M2 Max'], memory_gb: 32 },
      },
    ],
    engines: [
      {
        schema_version: 1,
        id: 'vllm',
        name: 'vLLM',
        repo: 'https://github.com/vllm-project/vllm',
        api: 'openai',
        platforms: ['macos-metal'],
        quant_formats: ['fp8'],
        install: [{ method: 'pip', package: 'vllm=={version}' }],
        serve: {
          command_template: 'vllm serve {model_ref} {flags}',
          model_ref: 'hf_id',
          flag_style: '--{name} {value}',
          bool_style: '--{name}',
        },
        drop_params: [],
        versions: [{ version: '0.27.1', param_count: 1 }],
      },
    ],
    models: [
      {
        model: {
          schema_version: 1,
          id: 'Qwen/Qwen3-8B',
          name: 'Qwen3 8B',
          hf_id: 'Qwen/Qwen3-8B',
          vendor: 'qwen',
          params_b: 8,
          context_length: 32768,
        },
        quants: [
          {
            schema_version: 1,
            id: 'fp8',
            model_id: 'Qwen/Qwen3-8B',
            format: 'fp8',
            bits: 8,
            hf_id: 'neuralmagic/Qwen3-8B-FP8',
            size_gb: 9.5,
            engines: ['vllm'],
            source: 'community',
          },
        ],
      },
    ],
    workloads: [],
    datasets: [],
    site: {
      schema_version: 1,
      repo: { owner: '0xBakeer', name: 'inference-atlas', default_branch: 'main' },
      site: {
        title: 'Inference Atlas',
        tagline: '',
        base_path: '/x/',
        url: 'https://example.test/',
      },
      coverage: { key_metrics: ['output_tok_s', 'ttft_p50'] },
    },
  });
  const rows = [
    fixtureRow({
      run_id: 'cfg0000000000001--serve-single-i256-o256-v1--aaa111',
      hardware: { id: 'apple-m2-max-32gb', count: 1 },
      path: 'results/vllm/Qwen/Qwen3-8B/apple-m2-max-32gb/r1.json',
    }),
    fixtureRow({
      run_id: 'cfg0000000000002--serve-single-i256-o256-v1--bbb222',
      metrics: { output_tok_s: 55.5, ttft_p50: 40 },
      hardware: { id: 'apple-m2-max-32gb', count: 1 },
      path: 'results/vllm/Qwen/Qwen3-8B/apple-m2-max-32gb/r2.json',
    }),
  ];
  write('index.json', rows);
  write('coverage.json', {});
  const resultDir = path.join(repo, 'results', 'vllm', 'Qwen', 'Qwen3-8B', 'apple-m2-max-32gb');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultDir, 'r1.json'),
    JSON.stringify({
      schema_version: 1,
      run_id: rows[0]!.run_id,
      args: { 'max-model-len': 8192 },
      model: { id: 'Qwen/Qwen3-8B', quant_id: 'fp8', hf_id: 'Qwen/Qwen3-8B' },
      metrics: { output_tok_s: 120.5, ram_peak_gb: 12, ttft_ms: { p50: 80, p95: 120 } },
      gotchas: [{ severity: 'warn', text: 'needs the fp8 kernels' }],
    }),
  );
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const captured: CapturedHardware = {
  platform: 'darwin',
  arch: 'arm64',
  cpu: 'Apple M2 Max',
  appleChip: 'Apple M2 Max',
  nvidiaGpus: [],
  memoryGb: 32,
  vramGb: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderApp(options: { unknownBox?: boolean } = {}) {
  const source = new LocalSource(repo);
  const data = await loadAtlas(source);
  const match = options.unknownBox ? null : matchHardware(captured, data.registry.hardware);
  const config = structuredClone(DEFAULT_CONFIG);
  config.data.refreshMinutes = 0;
  const target: Target = {
    hardware: match?.hardware ?? null,
    count: 1,
    source: match ? 'detected' : 'unknown',
    captured,
    capturedIsTarget: true,
  };
  return render(
    <App source={source} config={config} initialData={data} initialTarget={target} level="mono" />,
  );
}

describe('App', () => {
  it('opens on the home view with the box identified and runs ranked', async () => {
    const { lastFrame, unmount } = await renderApp();
    const frame = lastFrame()!;
    expect(frame).toContain('INFERENCE ATLAS');
    expect(frame).toContain('data @ abc1234');
    expect(frame).toContain('apple-m2-max-32gb');
    expect(frame).toContain('Qwen/Qwen3-8B');
    expect(frame).toContain('recommended'); // measured on this exact hardware
    expect(frame).toContain('Target box');
    unmount();
  });

  it('switches views, opens a run and shows its gotchas', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('2');
    await sleep(10);
    expect(lastFrame()).toContain('filter');
    stdin.write('\r'); // open selected run
    await sleep(50); // record load is async
    const frame = lastFrame()!;
    expect(frame).toContain('Fit on Apple M2 Max 32GB');
    expect(frame).toContain('needs the fp8 kernels');
    unmount();
  });

  it('filters runs', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('/');
    await sleep(10);
    stdin.write('bbb-not-there');
    await sleep(10);
    expect(lastFrame()).toContain('bbb-not-there');
    expect(lastFrame()).not.toContain('Qwen/Qwen3-8B');
    unmount();
  });

  it('opens the hardware picker with the detected box marked', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('b');
    await sleep(20);
    const frame = lastFrame()!;
    expect(frame).toContain('Pick your hardware');
    expect(frame).toContain('apple-m2-max-32gb');
    expect(frame).toContain('detected');
    unmount();
  });

  it('adjusts the device count with +/-', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('b');
    await sleep(20);
    stdin.write('+');
    await sleep(20);
    stdin.write('+');
    await sleep(20);
    expect(lastFrame()).toContain('3×');
    stdin.write('-');
    await sleep(20);
    expect(lastFrame()).toContain('2×');
    unmount();
  });

  it('offers a way out when no listed box is yours, and confirms before opening it', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('b');
    await sleep(20);
    expect(lastFrame()).toContain('not listed?');
    // Walk to the last row — the fixture registry has one device, so the add row is next.
    stdin.write('j');
    await sleep(20);
    stdin.write('\r');
    await sleep(30);
    const frame = lastFrame()!;
    expect(frame).toContain('Add your box to the registry?');
    expect(frame).toContain('Nothing is sent until you submit');
    // The preview shows what was probed here, and the link is visible before opening it.
    expect(frame).toContain('apple-m2-max-32gb');
    expect(frame).toContain('template=new-hardware.yml');
    // Cancelling opens nothing.
    stdin.write('n');
    await sleep(20);
    expect(lastFrame()).toContain('Pick your hardware');
    unmount();
  });

  it('asks for hardware up front when it cannot identify the machine', async () => {
    const { lastFrame, unmount } = await renderApp({ unknownBox: true });
    await sleep(20);
    const frame = lastFrame()!;
    expect(frame).toContain('Which box are you running models on?');
    expect(frame).toContain('did not match anything in the hardware registry');
    unmount();
  });

  it('shows help and comes back', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('?');
    await sleep(10);
    expect(lastFrame()).toContain('generate the install recipe');
    stdin.write('\u001b'); // esc
    await sleep(300);
    expect(lastFrame()).toContain('Worth running on');
    unmount();
  });
});
