import { describe, expect, it } from 'vitest';
import { AGENT_RULES, buildPacket, renderFlags, renderServeCommand } from './packet.js';
import type { PacketRegistry } from './packet.js';
import { canonicalizeArgs } from './canonical.js';
import { cellId } from './ids.js';
import { readJson } from '../test/helpers.js';
import type { EngineMeta, EngineVersion, Hardware, Model, Quant, SiteConfig } from './types.js';

// The packet is built against the real registry on purpose: if a schema or a registry file
// changes shape, this test notices before the app does.
const site = readJson<SiteConfig>('site/config.json');
const vllm = readJson<EngineMeta>('engines/vllm/meta.json');
const vllmVersion = readJson<EngineVersion>('engines/vllm/versions/0.27.1.json');
const llamacpp = readJson<EngineMeta>('engines/llamacpp/meta.json');
const llamacppVersion = readJson<EngineVersion>('engines/llamacpp/versions/b7000.json');
const qwen = readJson<Model>('models/Qwen/Qwen3.8-27B/model.json');
const qwenFp8 = readJson<Quant>('models/Qwen/Qwen3.8-27B/quants/fp8.json');
const ling = readJson<Model>('models/inclusionAI/Ling-3.0-flash/model.json');
const lingGguf = readJson<Quant>('models/inclusionAI/Ling-3.0-flash/quants/gguf-q5-k-m.json');
const spark = readJson<Hardware>('hardware/nvidia-gb10-dgx-spark.json');
const m2 = readJson<Hardware>('hardware/apple-m2-max-32gb.json');

const registry: PacketRegistry = {
  hardware: [spark, m2],
  engines: [
    { meta: vllm, versions: [vllmVersion] },
    { meta: llamacpp, versions: [llamacppVersion] },
  ],
  models: [
    { model: qwen, quants: [qwenFp8] },
    { model: ling, quants: [lingGguf] },
  ],
  workloads: [],
};

const args = {
  'max-model-len': 262144,
  'gpu-memory-utilization': 0.44,
  'enable-prefix-caching': true,
  'speculative-config': { method: 'mtp', num_speculative_tokens: 3 },
};

const cellPacket = buildPacket(
  {
    kind: 'cell',
    engine_id: 'vllm',
    engine_version: '0.27.1',
    model_id: 'Qwen/Qwen3.8-27B',
    quant_id: 'fp8',
    hardware_id: 'nvidia-gb10-dgx-spark',
    hw_count: 1,
    args,
    workload_ids: ['serve-single-i256-o256-v1'],
  },
  registry,
  site,
);

describe('command rendering', () => {
  it('renders flags the way the engine wants them written', () => {
    expect(
      renderFlags({ 'max-model-len': 262144, 'enable-prefix-caching': true }, vllm.serve),
    ).toBe('--enable-prefix-caching --max-model-len 262144');
  });

  it('single-quotes JSON-valued flags', () => {
    expect(renderFlags({ 'speculative-config': { method: 'mtp' } }, vllm.serve)).toBe(
      `--speculative-config '{"method":"mtp"}'`,
    );
  });

  it('omits a false boolean when the engine has no --no- form', () => {
    expect(renderFlags({ 'enable-torch-compile': false }, llamacpp.serve)).toBe('');
  });

  it('builds a runnable serve command', () => {
    const cmd = renderServeCommand(vllm, 'Qwen/Qwen3.8-27B-FP8', { 'max-model-len': 262144 });
    expect(cmd).toBe('vllm serve Qwen/Qwen3.8-27B-FP8 --max-model-len 262144');
  });
});

describe('the cell packet', () => {
  const md = cellPacket.markdown;

  it('walks through all eight steps of the contract', () => {
    expect(md).toContain('### 1. Get the repository');
    expect(md).toContain('### 2. Capture the hardware truthfully');
    expect(md).toContain('### 3. Install the engine and fetch the weights');
    expect(md).toContain('### 4. Start the engine with exactly these flags');
    expect(md).toContain('### 5. Run the workloads');
    expect(md).toContain('### 6. Validate locally');
    expect(md).toContain('### 7. Commit and open the pull request');
    expect(md).toContain('### 8. Rules');
  });

  it('clones the repository from the site config', () => {
    expect(md).toContain('git clone https://github.com/Inference-Atlas/inference-atlas.git');
    expect(md).toContain('cd inference-atlas');
    expect(md).toContain('AGENTS.md');
  });

  it('captures hardware with the harness rather than by hand', () => {
    expect(md).toContain('uv run atlas-bench hwinfo --json');
    expect(md).toContain('nvidia-smi name "NVIDIA GB10"');
    expect(md).toContain('Never type specifications by hand');
  });

  it('pins the engine version and the exact serve command', () => {
    expect(md).toContain('docker pull vllm/vllm-openai:v0.27.1');
    expect(md).toContain('--entrypoint vllm vllm/vllm-openai:v0.27.1 serve Qwen/Qwen3.8-27B-FP8');
    expect(md).toContain('atlas-bench serve --spec task.json');
    expect(md).toContain('--enable-prefix-caching');
    expect(md).toContain(`--speculative-config '{"method":"mtp","num_speculative_tokens":3}'`);
  });

  it('runs the workload through the harness and validates locally', () => {
    expect(md).toContain('uv run atlas-bench run --spec task.json');
    expect(md).toContain('pnpm validate');
    expect(md).toContain('results/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark/<run_id>.json');
  });

  it('opens the pull request on the right branch with the right label', () => {
    expect(md).toContain('git checkout -b result/vllm-qwen-qwen3.8-27b-nvidia-gb10-dgx-spark-');
    expect(md).toContain('gh pr create --base main');
    expect(md).toContain('--label results');
  });

  it('states every rule', () => {
    for (const rule of AGENT_RULES) expect(md).toContain(rule);
  });

  it('carries the expected fingerprint so a different run is visible as different', () => {
    const expected = canonicalizeArgs({
      engine_id: 'vllm',
      engine_version: '0.27.1',
      args,
      quant_id: 'fp8',
      dtype: null,
      params: vllmVersion.params,
      drop_params: vllm.drop_params,
      param_aliases: vllm.param_aliases,
    });
    expect(md).toContain(expected.canonical);
    expect(md).toContain(expected.configId);
  });

  it('carries a JSON packet the harness can consume', () => {
    const json = cellPacket.json;
    expect(json.packet_version).toBe(1);
    expect(json.kind).toBe('cell');
    expect(json.cell.cell_id).toBe(
      cellId({
        model_id: 'Qwen/Qwen3.8-27B',
        quant_id: 'fp8',
        hardware_id: 'nvidia-gb10-dgx-spark',
        hw_count: 1,
        engine_id: 'vllm',
        engine_minor: '0.27',
      }),
    );
    expect(json.model.hf_id).toBe('Qwen/Qwen3.8-27B-FP8');
    expect(json.engine.install?.method).toBe('docker');
    expect(json.output_dir).toBe('results/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark');
    expect(json.agent_rules).toEqual([...AGENT_RULES]);
    expect(md).toContain(JSON.stringify(json, null, 2));
  });

  it('offers a shell script that does the same thing', () => {
    expect(cellPacket.shell).toContain('#!/usr/bin/env bash');
    expect(cellPacket.shell).toContain('set -euo pipefail');
    expect(cellPacket.shell).toContain('uv run atlas-bench hwinfo --json');
    expect(cellPacket.shell).toContain('vllm serve');
    expect(cellPacket.shell).toContain('gh pr create --base main');
  });

  it('offers a pre-filled issue url', () => {
    expect(cellPacket.issueUrl).toContain(
      'https://github.com/Inference-Atlas/inference-atlas/issues/new?',
    );
    expect(cellPacket.issueUrl).toContain('labels=wanted');
    expect(decodeURIComponent(cellPacket.issueUrl)).toContain('nvidia-gb10-dgx-spark');
  });
});

describe('the registry packets', () => {
  it('tells you how to register hardware honestly', () => {
    const packet = buildPacket(
      { kind: 'new-hardware', target_name: 'NVIDIA RTX 5080', workload_ids: [] },
      registry,
      site,
    );
    expect(packet.markdown).toContain('Register new hardware: NVIDIA RTX 5080');
    expect(packet.markdown).toContain('uv run atlas-bench hwinfo --json');
    expect(packet.markdown).toContain('a null is worth more than a guess');
    expect(packet.json.branch).toBe('new-hardware/nvidia-rtx-5080');
    expect(packet.json.pr_title).toBe('hardware: add NVIDIA RTX 5080');
  });

  it('tells you to take model metadata from config.json, not the launch post', () => {
    const packet = buildPacket(
      { kind: 'new-model', target_name: 'Some New 12B', workload_ids: [] },
      registry,
      site,
    );
    expect(packet.markdown).toContain('models/<owner>/<name>/model.json');
    expect(packet.markdown).toContain('not the launch blog post');
    expect(packet.json.pr_title).toBe('model: add Some New 12B');
  });

  it('tells you to record how the engine flags were extracted', () => {
    const packet = buildPacket(
      { kind: 'new-engine', target_name: 'ktransformers', workload_ids: [] },
      registry,
      site,
    );
    expect(packet.markdown).toContain('engines/<id>/meta.json');
    expect(packet.markdown).toContain('extraction_method');
    expect(packet.json.branch).toBe('new-engine/ktransformers');
  });

  it('handles a gguf engine whose model_ref is a file path', () => {
    const packet = buildPacket(
      {
        kind: 'cell',
        engine_id: 'llamacpp',
        engine_version: 'b7000',
        model_id: 'inclusionAI/Ling-3.0-flash',
        quant_id: 'gguf-q5-k-m',
        hardware_id: 'nvidia-gb10-dgx-spark',
        args: { 'ctx-size': 262144 },
        workload_ids: ['longctx-depth-sweep-v1'],
      },
      registry,
      site,
    );
    expect(packet.markdown).toContain(
      'llama-server -m ./models/Ling-3.0-flash-Q5_K_M.gguf --ctx-size 262144',
    );
    expect(packet.json.cell.engine_minor).toBe('b7000');
  });

  it('downloads the one file it needs out of a multi-quant GGUF repository', () => {
    const packet = buildPacket(
      {
        kind: 'cell',
        engine_id: 'llamacpp',
        engine_version: 'b7000',
        model_id: 'inclusionAI/Ling-3.0-flash',
        quant_id: 'gguf-q5-k-m',
        hardware_id: 'nvidia-gb10-dgx-spark',
        workload_ids: [],
      },
      registry,
      site,
    );
    expect(packet.markdown).toContain(`hf download ${lingGguf.hf_id} Ling-3.0-flash-Q5_K_M.gguf`);
  });

  it('puts a branch-safe rendering of the model id in the branch name', () => {
    const packet = buildPacket(
      {
        kind: 'cell',
        engine_id: 'vllm',
        engine_version: '0.27.1',
        model_id: 'Qwen/Qwen3.8-27B',
        quant_id: 'fp8',
        hardware_id: 'nvidia-gb10-dgx-spark',
        workload_ids: [],
      },
      registry,
      site,
    );
    expect(packet.json.branch).toMatch(/^result\/[a-z0-9./-]+$/);
    expect(packet.json.branch).toContain('vllm-qwen-qwen3.8-27b-nvidia-gb10-dgx-spark-');
    // the id itself, slash and capitals included, still names the cell and the output directory
    expect(packet.json.cell.model_id).toBe('Qwen/Qwen3.8-27B');
    expect(packet.json.output_dir).toBe('results/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark');
  });
});
