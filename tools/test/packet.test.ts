/**
 * `packet` — the brief an agent executes.
 *
 * The generator itself is tested in `@atlas/core`; what is tested here is that the CLI
 * reads the registry off disk correctly and that the brief it prints is *self-contained*.
 * A packet that quietly omits step 6 (validate locally) or the rules block is worse than no
 * packet at all: it produces confident contributions that fail review.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { AGENT_RULES } from '@atlas/core';
import type { PacketJson } from '@atlas/core';
import { renderPacket } from '../src/packet.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';
import type { FixtureRepo } from './helpers/fixture-repo.js';

let repo: FixtureRepo;

const cellSpec = {
  kind: 'cell' as const,
  engine_id: 'vllm',
  engine_version: '0.27.1',
  model_id: 'Qwen/Qwen3-8B',
  quant_id: 'fp8',
  hardware_id: 'nvidia-rtx-4090',
  hw_count: 1,
  args: { 'max-model-len': 32768 },
  workload_ids: ['serve-single-i256-o256-v1'],
};

beforeEach(() => {
  repo = makeFixtureRepo();
});
afterEach(() => {
  repo.dispose();
});

describe('markdown brief', () => {
  it('carries all eight steps and every rule', () => {
    const { text } = renderPacket({ root: repo.root, spec: cellSpec, format: 'md' });
    for (const heading of [
      '### 1. Get the repository',
      '### 2. Capture the hardware truthfully',
      '### 3. Install the engine',
      '### 4. Start the engine',
      '### 5. Run the workloads',
      '### 6. Validate locally',
      '### 7. Commit and open the pull request',
      '### 8. Rules',
    ]) {
      expect(text).toContain(heading);
    }
    for (const rule of AGENT_RULES) expect(text).toContain(rule);
  });

  it('names the concrete thing to run, not a placeholder', () => {
    const { text, packet } = renderPacket({ root: repo.root, spec: cellSpec, format: 'md' });
    expect(text).toContain('docker pull vllm/vllm-openai:v0.27.1');
    expect(text).toContain('Qwen/Qwen3-8B-FP8');
    expect(text).toContain('results/vllm/Qwen/Qwen3-8B/nvidia-rtx-4090');
    expect(text).toContain(packet.json.cell.cell_id!);
    expect(text).toContain('AGENTS.md');
    expect(text).not.toContain('undefined');
  });
});

describe('other renderings', () => {
  it('emits the JSON packet the harness consumes', () => {
    const { text } = renderPacket({ root: repo.root, spec: cellSpec, format: 'json' });
    const json = JSON.parse(text) as PacketJson;
    expect(json.packet_version).toBe(1);
    expect(json.kind).toBe('cell');
    expect(json.engine.version).toBe('0.27.1');
    expect(json.model.hf_id).toBe('Qwen/Qwen3-8B-FP8');
    expect(json.workloads).toEqual([
      { id: 'serve-single-i256-o256-v1', kind: 'serving', name: expect.any(String) },
    ]);
    expect(json.output_dir).toBe('results/vllm/Qwen/Qwen3-8B/nvidia-rtx-4090');
    expect(json.agent_rules).toEqual([...AGENT_RULES]);
  });

  it('emits a shell script and an issue url', () => {
    expect(renderPacket({ root: repo.root, spec: cellSpec, format: 'shell' }).text).toContain(
      'git clone',
    );
    expect(renderPacket({ root: repo.root, spec: cellSpec, format: 'issue' }).text).toContain(
      'https://github.com/0xBakeer/inference-atlas/issues/new',
    );
  });
});

describe('registry additions', () => {
  it('renders a new-hardware brief without a cell', () => {
    const { text, packet } = renderPacket({
      root: repo.root,
      spec: { kind: 'new-hardware', target_name: 'RTX 5080' },
      format: 'md',
    });
    expect(packet.json.kind).toBe('new-hardware');
    expect(packet.json.cell.cell_id).toBeNull();
    expect(text).toContain('RTX 5080');
    expect(text).toContain('hardware/');
  });

  it('renders a new-model brief from a Hugging Face id', () => {
    const { packet } = renderPacket({
      root: repo.root,
      spec: { kind: 'new-model', target_name: 'Qwen/Qwen3-4B' },
      format: 'md',
    });
    expect(packet.json.kind).toBe('new-model');
    expect(packet.markdown).toContain('Qwen/Qwen3-4B');
  });
});
