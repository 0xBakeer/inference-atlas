/**
 * Smoke test of the whole TUI against a small fixture repo — the same shapes the build
 * emits, read through LocalSource, rendered with ink-testing-library.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureRow } from '@atlas/core';
import { DEFAULT_CONFIG } from '../config.js';
import { loadAtlas } from '../data/load.js';
import { LocalSource } from '../data/source.js';
import type { CapturedHardware } from '../hw/capture.js';
import { matchHardware } from '../hw/match.js';
import type * as SendModule from '../recipe/send.js';
import type { Target } from '../hw/target.js';
import { App } from './App.js';

const outward = vi.hoisted(() => ({
  openUrl: vi.fn<(url: string) => { ok: boolean; via?: string; error?: string }>(),
  copyToClipboard: vi.fn<(text: string) => boolean>(),
}));
vi.mock('../recipe/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SendModule>()),
  openUrl: (url: string) => outward.openUrl(url),
  copyToClipboard: (text: string) => outward.copyToClipboard(text),
}));

let repo: string;
let configHome: string;
const savedConfigHome = process.env['XDG_CONFIG_HOME'];
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tui-app-'));
  // Picking a box persists it; keep that off the developer's real config file.
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tui-cfg-'));
  process.env['XDG_CONFIG_HOME'] = configHome;
  outward.openUrl.mockReset().mockReturnValue({ ok: true, via: 'open' });
  outward.copyToClipboard.mockReset().mockReturnValue(true);
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
  fs.rmSync(configHome, { recursive: true, force: true });
  if (savedConfigHome === undefined) delete process.env['XDG_CONFIG_HOME'];
  else process.env['XDG_CONFIG_HOME'] = savedConfigHome;
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
  config.recipes.dir = path.join(configHome, 'recipes');
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
  /*
   * Enter is not one byte. Ink only names `\r` "return"; a terminal that sends `\n` — which
   * is what several WSL/ConPTY setups do — used to hit every `key.return` branch as a
   * no-op, so the keys below simply did nothing with no error to show for it.
   */
  it('opens a run when Enter arrives as a line feed', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('2');
    await sleep(10);
    stdin.write('\n');
    await sleep(50);
    expect(lastFrame()).toContain('Fit on Apple M2 Max 32GB');
    unmount();
  });

  it('confirms the registry request when Enter arrives as a line feed', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('b');
    await sleep(20);
    stdin.write('j');
    await sleep(20);
    stdin.write('\n');
    await sleep(30);
    expect(lastFrame()).toContain('Add your box to the registry?');
    stdin.write('n'); // never open a browser from a test
    await sleep(20);
    unmount();
  });

  it('does not let a stray line feed leak into the filter text', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('/');
    await sleep(10);
    stdin.write('Qwen');
    await sleep(10);
    stdin.write('\n'); // ends the filter, the way enter does
    await sleep(10);
    const frame = lastFrame()!;
    expect(frame).toContain('filter: Qwen');
    expect(frame).not.toContain('▌'); // the caret is gone: typing stopped
    expect(frame).toContain('Qwen/Qwen3-8B'); // and the filter still matches
    unmount();
  });

  /*
   * Picking a box is only a means to an end. The answer lives on the home view, so the
   * selection has to land there — it used to stay in the picker, and the re-ranked list
   * only appeared once the user pressed esc.
   */
  it('lands on the home view with the ranking as soon as a box is picked', async () => {
    const { stdin, lastFrame, unmount } = await renderApp({ unknownBox: true });
    await sleep(20);
    expect(lastFrame()).toContain('Which box are you running models on?');
    stdin.write('j'); // past the "not listed?" row, which comes first for an unknown box
    await sleep(20);
    stdin.write('\r');
    await sleep(30);
    const frame = lastFrame()!;
    expect(frame).toContain('Worth running on Apple M2 Max 32GB');
    expect(frame).toContain('Qwen/Qwen3-8B');
    expect(frame).toContain('saved to'); // the confirmation follows you home
    expect(frame).not.toContain('Pick your hardware');
    unmount();
  });

  it('remembers the picked box in the config file', async () => {
    const { stdin, unmount } = await renderApp({ unknownBox: true });
    await sleep(20);
    stdin.write('j');
    await sleep(20);
    stdin.write('\n'); // line-feed enter again: the picker must take it too
    await sleep(30);
    const toml = fs.readFileSync(path.join(configHome, 'inference-atlas', 'config.toml'), 'utf8');
    expect(toml).toContain('hardware = "apple-m2-max-32gb"');
    unmount();
  });
  /*
   * The reported WSL symptom: `xdg-open` is not installed, `openUrl` failed, and the
   * dialog dropped the error on the floor — so enter and y both looked like dead keys.
   */
  it('says what happened when no browser can be reached, and keeps the link reachable', async () => {
    outward.openUrl.mockReturnValue({ ok: false, error: 'tried xdg-open (not installed)' });
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('b');
    await sleep(20);
    stdin.write('j');
    await sleep(20);
    stdin.write('\r');
    await sleep(30);
    expect(lastFrame()).toContain('Add your box to the registry?');
    stdin.write('y');
    await sleep(40);
    const frame = lastFrame()!;
    expect(frame).toContain('no browser this shell can reach');
    expect(frame).toContain('xdg-open (not installed)');
    expect(frame).toContain('on your clipboard');
    // The dialog stays up rather than vanishing with the link.
    expect(frame).toContain('Add your box to the registry?');
    expect(outward.copyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('template=new-hardware.yml'),
    );
    // …and the link is on disk too, for a shell with no clipboard bridge at all.
    const saved = fs.readdirSync(path.join(configHome, 'recipes'));
    expect(saved.some((f) => f.startsWith('hardware-request-'))).toBe(true);
    unmount();
  });

  it('confirms and closes when a browser does open', async () => {
    const { stdin, lastFrame, unmount } = await renderApp();
    stdin.write('b');
    await sleep(20);
    stdin.write('j');
    await sleep(20);
    stdin.write('\r');
    await sleep(30);
    stdin.write('y');
    await sleep(40);
    const frame = lastFrame()!;
    expect(frame).toContain('opened the registry request in your browser (open)');
    expect(frame).toContain('Pick your hardware'); // dialog dismissed
    expect(outward.openUrl).toHaveBeenCalledTimes(1);
    unmount();
  });
});
