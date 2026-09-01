/** Test fixtures shared by every consumer's test suite. Pure builders, no I/O. */
import type { CompiledIndexRow } from './types.js';

export function fixtureRow(over: Partial<CompiledIndexRow> = {}): CompiledIndexRow {
  return {
    run_id: 'cfg0000000000001--serve-single-i256-o256-v1--abc123',
    cell_id: 'cell',
    config_id: 'cfg0000000000001',
    workload_id: 'serve-single-i256-o256-v1',
    kind: 'serving',
    engine: { id: 'vllm', version: '0.27.1', minor: '0.27' },
    model: { id: 'Qwen/Qwen3-8B', quant_id: 'fp8' },
    hardware: { id: 'nvidia-rtx-4090', count: 1 },
    metrics: { output_tok_s: 120.5, ttft_p50: 80, ttft_p95: 120 },
    provenance: { login: 'someone', submitted_at: '2026-08-23T12:00:00Z' },
    verification_level: 'self-reported',
    path: 'results/vllm/Qwen/Qwen3-8B/nvidia-rtx-4090/x.json',
    ...over,
  };
}
