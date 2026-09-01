import { describe, expect, it } from 'vitest';
import type {
  EngineVersion,
  IndexRow,
  Quant,
  RegistryEngine,
  ResultRecord,
  SiteConfig,
} from '@atlas/core';
import { fixtureRow } from '@atlas/core';
import type { FitVerdict } from '../hw/fit.js';
import { generateRecipe, recipeFileName } from './generate.js';

const site = {
  schema_version: 1,
  repo: { owner: '0xBakeer', name: 'inference-atlas', default_branch: 'main' },
  site: {
    title: 'Inference Atlas',
    tagline: '',
    base_path: '/inference-atlas/',
    url: 'https://0xbakeer.github.io/inference-atlas/',
  },
} as unknown as SiteConfig;

const engine: RegistryEngine = {
  meta: {
    schema_version: 1,
    id: 'vllm',
    name: 'vLLM',
    repo: 'https://github.com/vllm-project/vllm',
    docs: 'https://docs.vllm.ai/',
    api: 'openai',
    default_port: 8000,
    platforms: ['linux-cuda'],
    quant_formats: ['fp8'],
    install: [
      { method: 'docker', image: 'vllm/vllm-openai:v{version}', notes: 'aarch64 tags vary.' },
      { method: 'pip', package: 'vllm=={version}' },
    ],
    serve: {
      command_template: 'vllm serve {model_ref} {flags}',
      model_ref: 'hf_id',
      flag_style: '--{name} {value}',
      bool_style: '--{name}',
      bool_false_style: '--no-{name}',
    },
    health: { path: '/health', ready_timeout_s: 1800 },
    drop_params: [],
  },
  overlay: null,
  versions: ['0.27.1'],
  param_counts: {},
} as unknown as RegistryEngine;

const quant: Quant = {
  schema_version: 1,
  id: 'fp8',
  model_id: 'Qwen/Qwen3-8B',
  format: 'fp8',
  bits: 8,
  hf_id: 'neuralmagic/Qwen3-8B-FP8',
  revision: 'abc123def',
  size_gb: 9.5,
  engines: ['vllm'],
  source: 'community',
} as unknown as Quant;

const record = {
  schema_version: 1,
  run_id: 'cfg0000000000001--serve-single-i256-o256-v1--abc123',
  args: { 'max-model-len': 8192, 'enable-prefix-caching': false },
  model: { id: 'Qwen/Qwen3-8B', quant_id: 'fp8', hf_id: 'Qwen/Qwen3-8B' },
  metrics: {
    output_tok_s: 120.5,
    success_rate: 1,
    ram_peak_gb: 21.3,
    ttft_ms: { p50: 80, p95: 120 },
  },
  gotchas: [{ severity: 'warn', text: 'The default max-model-len OOMs on 24 GB.' }],
  provenance: { github_login: 'someone' },
} as unknown as ResultRecord;

const engineVersion = {
  schema_version: 1,
  engine_id: 'vllm',
  version: '0.27.1',
  extraction_method: 'argparse',
  params: [
    {
      name: 'max-model-len',
      type: 'int',
      default: null,
      help: 'Context window served.',
      impact: 'high',
    },
  ],
} as unknown as EngineVersion;

const fit: FitVerdict = {
  level: 'should-fit',
  label: '~ should fit',
  reasons: ['estimate: 9.5 GB weights + 25% headroom ≈ 11.9 GB'],
  memoryBasis: 'estimated',
  decodeCeiling: 42,
};

const input = () => ({
  row: fixtureRow() as IndexRow,
  record,
  engine,
  model: null,
  quant,
  measuredOn: null,
  workload: null,
  engineVersion,
  fit,
  targetLabel: 'apple-m2-max-32gb',
  site,
});

describe('generateRecipe', () => {
  const md = generateRecipe(input());

  it('renders the exact serve command from the recorded args', () => {
    expect(md).toContain(
      'vllm serve neuralmagic/Qwen3-8B-FP8 --no-enable-prefix-caching --max-model-len 8192',
    );
  });

  it('pins the weights revision', () => {
    expect(md).toContain('neuralmagic/Qwen3-8B-FP8');
    expect(md).toContain('pin revision `abc123def`');
  });

  it('substitutes the engine version into install commands', () => {
    expect(md).toContain('docker pull vllm/vllm-openai:v0.27.1');
    expect(md).toContain("uv pip install 'vllm==0.27.1'");
  });

  it('documents each flag with help from the param table', () => {
    expect(md).toContain('| `max-model-len` | `8192` | `null` | high | Context window served. |');
    expect(md).toContain('_not in the registered param table_');
  });

  it('carries the gotchas and the measured numbers', () => {
    expect(md).toContain('The default max-model-len OOMs on 24 GB.');
    expect(md).toContain('| output tok/s | 120.5 |');
  });

  it('labels an estimated fit as an estimate', () => {
    expect(md).toContain('~ should fit on apple-m2-max-32gb');
    expect(md).toContain('estimate, not a measurement');
  });

  it('includes the verify loop with the original workload and args', () => {
    expect(md).toContain('atlas-bench packet');
    expect(md).toContain('--workload serve-single-i256-o256-v1');
    expect(md).toContain('--arg max-model-len=8192');
  });

  it('includes the agent rules', () => {
    expect(md).toContain('Never edit a number by hand.');
  });

  it('links the run on the site', () => {
    expect(md).toContain(
      'https://0xbakeer.github.io/inference-atlas/#/run/cfg0000000000001--serve-single-i256-o256-v1--abc123',
    );
  });
});

describe('recipeFileName', () => {
  it('slugs to a safe file name', () => {
    expect(recipeFileName(fixtureRow() as IndexRow)).toBe(
      'qwen-qwen3-8b--fp8--vllm-0.27.1--serve-single-i256-o256-v1.md',
    );
  });
});
