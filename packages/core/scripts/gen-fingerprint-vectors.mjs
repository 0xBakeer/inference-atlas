#!/usr/bin/env node
/**
 * Regenerates schemas/fixtures/fingerprint-vectors.json from the reference implementation.
 *
 * The expected hashes are COMPUTED, never typed. Run this only when you are *adding* a
 * vector — if an existing vector starts failing, that is a change in the fingerprint
 * definition and it needs a SPEC change and a coordinated update of the Python harness,
 * not a regenerate.
 *
 *   node packages/core/scripts/gen-fingerprint-vectors.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { canonicalizeArgs } from '../dist/canonical.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../schemas/fixtures/fingerprint-vectors.json');

/** A realistic slice of vLLM 0.27.1's EngineArgs, enough to exercise every rule. */
const VLLM_PARAMS = [
  { name: 'tensor-parallel-size', default: 1, aliases: ['-tp', 'tp'] },
  { name: 'pipeline-parallel-size', default: 1, aliases: ['-pp', 'pp'] },
  { name: 'gpu-memory-utilization', default: 0.9, aliases: [] },
  { name: 'max-model-len', default: null, aliases: [] },
  { name: 'max-num-seqs', default: 1024, aliases: [] },
  { name: 'enable-prefix-caching', default: false, aliases: [] },
  { name: 'enforce-eager', default: false, aliases: [] },
  { name: 'dtype', default: 'auto', aliases: [] },
  { name: 'kv-cache-dtype', default: 'auto', aliases: [] },
  { name: 'speculative-config', default: null, aliases: [] },
  { name: 'lora-modules', default: null, aliases: [] },
  { name: 'port', default: 8000, aliases: [] },
  { name: 'trust-remote-code', default: false, aliases: [] },
];

const VLLM_DROP = [
  'model',
  'host',
  'port',
  'api-key',
  'served-model-name',
  'download-dir',
  'revision',
  'hf-token',
];

/** llama.cpp's short flags are the real alias torture test. */
const LLAMACPP_PARAMS = [
  { name: 'ctx-size', default: 4096, aliases: ['-c'] },
  { name: 'n-gpu-layers', default: 0, aliases: ['-ngl', 'gpu-layers'] },
  { name: 'batch-size', default: 2048, aliases: ['-b'] },
  { name: 'flash-attn', default: 'auto', aliases: ['-fa'] },
  { name: 'parallel', default: 1, aliases: ['-np'] },
];

const LLAMACPP_DROP = ['model', 'host', 'port', 'api-key', 'alias', 'hf-repo', 'hf-file'];

const vllm = (args, extra = {}) => ({
  engine_id: 'vllm',
  engine_version: '0.27.1',
  args,
  quant_id: 'fp8',
  dtype: null,
  params: VLLM_PARAMS,
  drop_params: VLLM_DROP,
  ...extra,
});

const cases = [
  {
    name: 'empty-args',
    description:
      'No flags at all still produces a non-empty canonical string: the two pseudo-params.',
    input: vllm({}),
  },
  {
    name: 'alias-resolution-short-flag',
    description: '-tp resolves to tensor-parallel-size via the version file aliases.',
    input: vllm({ '-tp': 2 }),
    equivalence_group: 'tp2',
  },
  {
    name: 'alias-resolution-canonical-name',
    description: 'Writing the canonical name gives the identical fingerprint as the alias.',
    input: vllm({ 'tensor-parallel-size': 2 }),
    equivalence_group: 'tp2',
  },
  {
    name: 'default-dropping',
    description:
      'gpu-memory-utilization=0.9 and tensor-parallel-size=1 are this version defaults, so they vanish.',
    input: vllm({
      'gpu-memory-utilization': 0.9,
      'tensor-parallel-size': 1,
      'max-model-len': 262144,
    }),
    equivalence_group: 'maxlen-only',
  },
  {
    name: 'default-dropping-omitted',
    description: 'Omitting the defaults entirely is the same configuration.',
    input: vllm({ 'max-model-len': 262144 }),
    equivalence_group: 'maxlen-only',
  },
  {
    name: 'float-normalization-number',
    description: '0.44 as a JSON number.',
    input: vllm({ 'gpu-memory-utilization': 0.44 }),
    equivalence_group: 'gmu-044',
  },
  {
    name: 'float-normalization-trailing-zero-string',
    description: '"0.4400" from a shell command line is the same value as 0.44.',
    input: vllm({ 'gpu-memory-utilization': '0.4400' }),
    equivalence_group: 'gmu-044',
  },
  {
    name: 'float-normalization-0.90-equals-0.9',
    description:
      '"0.90" normalizes to 0.9, which is this version default, so the flag drops out entirely.',
    input: vllm({ 'gpu-memory-utilization': '0.90' }),
  },
  {
    name: 'bool-normalization-native',
    description: 'A real boolean.',
    input: vllm({ 'enable-prefix-caching': true }),
    equivalence_group: 'prefix-on',
  },
  {
    name: 'bool-normalization-string-True',
    description: 'Python-style "True" from an env var or a YAML file.',
    input: vllm({ 'enable-prefix-caching': 'True' }),
    equivalence_group: 'prefix-on',
  },
  {
    name: 'bool-normalization-one',
    description: '1 is true for a flag the version file declares boolean.',
    input: vllm({ 'enable-prefix-caching': 1 }),
    equivalence_group: 'prefix-on',
  },
  {
    name: 'nested-object-arg',
    description: 'speculative-config is an object; its keys are sorted, not reordered by luck.',
    input: vllm({ 'speculative-config': { num_speculative_tokens: 3, method: 'mtp' } }),
    equivalence_group: 'mtp3',
  },
  {
    name: 'nested-object-arg-as-json-string',
    description: 'The same object as it arrives from a shell command line.',
    input: vllm({ 'speculative-config': '{"method": "mtp", "num_speculative_tokens": 3}' }),
    equivalence_group: 'mtp3',
  },
  {
    name: 'array-arg-sorted',
    description: 'Array elements are sorted, so element order cannot fork the fingerprint.',
    input: vllm({ 'lora-modules': ['sql-lora', 'alpha-lora'] }),
    equivalence_group: 'lora-pair',
  },
  {
    name: 'array-arg-other-order',
    description: 'Same array, written the other way round.',
    input: vllm({ 'lora-modules': ['alpha-lora', 'sql-lora'] }),
    equivalence_group: 'lora-pair',
  },
  {
    name: 'unknown-engine-version-drops-no-defaults',
    description:
      'With no version file we do not know what a default is, so nothing is dropped — including values that would be defaults on a known version.',
    input: {
      engine_id: 'vllm',
      engine_version: '9.99.9',
      args: { 'gpu-memory-utilization': 0.9, 'tensor-parallel-size': 1 },
      quant_id: 'fp8',
      dtype: null,
      params: null,
      drop_params: VLLM_DROP,
    },
  },
  {
    name: 'drop-params-model-and-port',
    description:
      'Paths, ports and served names cannot change a number, so they never reach the hash.',
    input: vllm({
      model: 'Qwen/Qwen3.8-27B-FP8',
      port: 8123,
      host: '0.0.0.0',
      'api-key': 'secret',
      'served-model-name': 'local',
      'download-dir': '/mnt/weights',
      'max-model-len': 262144,
    }),
    equivalence_group: 'maxlen-only',
  },
  {
    name: 'key-ordering-independence-a',
    description: 'Flags written in one order.',
    input: vllm({
      'max-model-len': 262144,
      'gpu-memory-utilization': 0.44,
      'enable-prefix-caching': true,
    }),
    equivalence_group: 'three-flags',
  },
  {
    name: 'key-ordering-independence-b',
    description: 'The same three flags written in the opposite order.',
    input: vllm({
      'enable-prefix-caching': true,
      'gpu-memory-utilization': 0.44,
      'max-model-len': 262144,
    }),
    equivalence_group: 'three-flags',
  },
  {
    name: 'underscore-to-dash',
    description: 'max_model_len from a Python config is the same flag as --max-model-len.',
    input: vllm({ max_model_len: 262144 }),
    equivalence_group: 'maxlen-only',
  },
  {
    name: 'leading-dashes-stripped',
    description: 'Copy-pasting the flag with its dashes must not fork the fingerprint.',
    input: vllm({ '--max-model-len': 262144 }),
    equivalence_group: 'maxlen-only',
  },
  {
    name: 'uppercase-key-lowercased',
    description: 'Flag names are case-insensitive for fingerprinting purposes.',
    input: vllm({ '--Max-Model-Len': 262144 }),
    equivalence_group: 'maxlen-only',
  },
  {
    name: 'null-value-is-not-a-flag',
    description:
      'A null value means the flag was not passed; it must not appear in the fingerprint.',
    input: vllm({ 'max-model-len': 262144, 'kv-cache-dtype': null }),
    equivalence_group: 'maxlen-only',
  },
  {
    name: 'unknown-flag-kept-verbatim',
    description:
      'A flag the version file has never heard of is kept, normalized but not dropped — new flags must not silently collide.',
    input: vllm({ 'some-brand-new-flag': 'yes', 'max-model-len': 262144 }),
  },
  {
    name: 'quant-and-dtype-pseudo-params',
    description: 'The pseudo-params sort first because "@" is below "a" in byte order.',
    input: vllm({ 'max-model-len': 262144 }, { quant_id: 'bf16', dtype: 'bfloat16' }),
  },
  {
    name: 'llamacpp-short-flags',
    description: 'llama.cpp aliases: -c, -ngl, -np. -b 2048 is the default and drops out.',
    input: {
      engine_id: 'llamacpp',
      engine_version: 'b7000',
      args: { '-c': 262144, '-ngl': 999, '-b': 2048, '-np': 4, '--flash-attn': 'on' },
      quant_id: 'gguf-q5-k-m',
      dtype: null,
      params: LLAMACPP_PARAMS,
      drop_params: LLAMACPP_DROP,
    },
    equivalence_group: 'llamacpp-long',
  },
  {
    name: 'llamacpp-long-flags',
    description: 'The same llama.cpp configuration written with long flag names.',
    input: {
      engine_id: 'llamacpp',
      engine_version: 'b7000',
      args: {
        ctx_size: 262144,
        'n-gpu-layers': 999,
        'batch-size': 2048,
        parallel: 4,
        'flash-attn': 'on',
      },
      quant_id: 'gguf-q5-k-m',
      dtype: null,
      params: LLAMACPP_PARAMS,
      drop_params: LLAMACPP_DROP,
    },
    equivalence_group: 'llamacpp-long',
  },
  {
    name: 'engine-level-param-aliases',
    description: 'engine meta param_aliases apply on top of the per-param aliases.',
    input: vllm(
      { tp: 4 },
      { param_aliases: { tp: 'tensor-parallel-size', pp: 'pipeline-parallel-size' } },
    ),
  },
];

const vectors = cases.map((c) => {
  const { canonical, configId } = canonicalizeArgs(c.input);
  return { ...c, expected: { canonical, config_id: configId } };
});

// Every equivalence group must actually agree — the whole point of the fixture.
const groups = new Map();
for (const v of vectors) {
  if (!v.equivalence_group) continue;
  const seen = groups.get(v.equivalence_group);
  if (seen && seen !== v.expected.config_id) {
    throw new Error(
      `equivalence group "${v.equivalence_group}" disagrees: ${seen} vs ${v.expected.config_id} (${v.name})`,
    );
  }
  groups.set(v.equivalence_group, v.expected.config_id);
}

const doc = {
  $comment:
    'Golden vectors for SPEC §3 config fingerprinting. Generated by packages/core/scripts/gen-fingerprint-vectors.mjs from the TypeScript reference implementation. packages/core and bench/atlas_bench/canonical.py must both reproduce every expected value exactly. Vectors sharing an equivalence_group must produce the same config_id.',
  spec: 'docs/SPEC.md §3',
  vectors,
};

writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors to ${out}`);
