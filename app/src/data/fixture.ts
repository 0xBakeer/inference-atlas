export { fixtureRow } from '@atlas/core';
/** A tiny registry/index fixture for tests. */
import type { SiteConfig } from '@atlas/core';
import siteJson from '../../../site/config.json';
import type { Registry } from './types.js';

export const site = siteJson as unknown as SiteConfig;

export function fixtureRegistry(): Registry {
  return {
    site,
    datasets: [],
    hardware: [
      {
        schema_version: 1,
        id: 'nvidia-rtx-4090',
        name: 'NVIDIA GeForce RTX 4090',
        vendor: 'nvidia',
        kind: 'gpu',
        memory_gb: 24,
        memory_bandwidth_gbs: 1008,
      },
      {
        schema_version: 1,
        id: 'apple-m2-max-32gb',
        name: 'Apple M2 Max (32 GB)',
        vendor: 'apple',
        kind: 'soc',
        memory_gb: 32,
        memory_bandwidth_gbs: 400,
      },
    ],
    engines: [
      {
        meta: {
          schema_version: 1,
          id: 'vllm',
          name: 'vLLM',
          repo: 'https://github.com/vllm-project/vllm',
          api: 'openai',
          platforms: ['linux-cuda'],
          quant_formats: ['bf16', 'fp8'],
          install: [{ method: 'docker', image: 'vllm/vllm-openai:v{version}' }],
          serve: {
            command_template: 'vllm serve {model_ref} {flags}',
            model_ref: 'hf_id',
            flag_style: '--{name} {value}',
            bool_style: '--{name}',
          },
          drop_params: ['port'],
          versions_available: ['0.26.1', '0.27.1'],
        },
        overlay: null,
        versions: ['0.26.1', '0.27.1'],
      },
      {
        meta: {
          schema_version: 1,
          id: 'mlx-lm',
          name: 'MLX LM',
          repo: 'https://github.com/ml-explore/mlx-lm',
          api: 'openai',
          platforms: ['macos-metal'],
          quant_formats: ['mlx', 'bf16'],
          install: [{ method: 'pip', package: 'mlx-lm=={version}' }],
          serve: {
            command_template: 'mlx_lm.server --model {model_ref} {flags}',
            model_ref: 'hf_id',
            flag_style: '--{name} {value}',
          },
          drop_params: [],
          versions_available: ['0.28.4'],
        },
        overlay: null,
        versions: ['0.28.4'],
      },
    ],
    models: [
      {
        model: {
          schema_version: 1,
          id: 'Qwen/Qwen3-8B',
          name: 'Qwen3-8B',
          hf_id: 'Qwen/Qwen3-8B',
          vendor: 'alibaba',
          params_b: 8,
          context_length: 131072,
        },
        quants: [
          {
            schema_version: 1,
            id: 'bf16',
            model_id: 'Qwen/Qwen3-8B',
            format: 'bf16',
            bits: 16,
            hf_id: 'Qwen/Qwen3-8B',
            engines: ['vllm', 'mlx-lm'],
            source: 'official',
            size_gb: 16,
          },
          {
            schema_version: 1,
            id: 'fp8',
            model_id: 'Qwen/Qwen3-8B',
            format: 'fp8',
            bits: 8,
            hf_id: 'Qwen/Qwen3-8B-FP8',
            engines: ['vllm'],
            source: 'official',
            size_gb: 8,
          },
          {
            schema_version: 1,
            id: 'mlx-4bit',
            model_id: 'Qwen/Qwen3-8B',
            format: 'mlx',
            bits: 4,
            hf_id: 'mlx-community/Qwen3-8B-4bit',
            engines: ['mlx-lm'],
            source: 'community',
            size_gb: 4.5,
          },
        ],
      },
    ],
    workloads: [
      {
        schema_version: 1,
        id: 'serve-single-i256-o256-v1',
        name: 'Single stream',
        kind: 'serving',
        params: { concurrency: 1 },
        metrics_required: ['ttft_ms'],
      },
      {
        schema_version: 1,
        id: 'eval-math-v1',
        name: 'Math eval',
        kind: 'eval',
        params: {},
        eval: { suite: 'math', scorer: 'numeric' },
        metrics_required: ['accuracy'],
      },
    ],
  };
}
