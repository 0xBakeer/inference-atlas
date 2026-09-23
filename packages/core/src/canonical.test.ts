import { describe, expect, it } from 'vitest';
import { canonicalizeArgs, normalizeKey, normalizeNumber, normalizeValue } from './canonical.js';
import type { CanonicalizeInput } from './canonical.js';
import { readJson } from '../test/helpers.js';

interface Vector {
  name: string;
  description?: string;
  equivalence_group?: string;
  input: CanonicalizeInput;
  expected: { canonical: string; config_id: string };
}

const fixture = readJson<{ vectors: Vector[] }>('schemas/fixtures/fingerprint-vectors.json');

describe('canonicalizeArgs against the golden vectors', () => {
  it('has enough vectors to be worth calling golden', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(12);
  });

  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      const { canonical, configId } = canonicalizeArgs(vector.input);
      expect(canonical).toBe(vector.expected.canonical);
      expect(configId).toBe(vector.expected.config_id);
    });
  }

  it('agrees within every equivalence group', () => {
    const groups = new Map<string, Set<string>>();
    for (const vector of fixture.vectors) {
      if (!vector.equivalence_group) continue;
      const set = groups.get(vector.equivalence_group) ?? new Set<string>();
      set.add(canonicalizeArgs(vector.input).configId);
      groups.set(vector.equivalence_group, set);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const [name, ids] of groups) {
      expect(ids, `equivalence group ${name}`).toHaveLength(1);
    }
  });

  it('rebuilds the canonical string from resolved', () => {
    for (const vector of fixture.vectors) {
      const { canonical, resolved } = canonicalizeArgs(vector.input);
      const rebuilt = Object.keys(resolved)
        .sort()
        .map((k) => `${k}=${resolved[k]}`)
        .join(';');
      expect(rebuilt).toBe(canonical);
    }
  });
});

describe('normalization rules', () => {
  it('normalizes flag names', () => {
    expect(normalizeKey('--Max_Model_Len')).toBe('max-model-len');
    expect(normalizeKey('  -tp ')).toBe('tp');
    expect(normalizeKey('ctx-size')).toBe('ctx-size');
  });

  it('gives the shortest round-trip number', () => {
    expect(normalizeNumber(0.9)).toBe('0.9');
    expect(normalizeNumber(8192)).toBe('8192');
    expect(normalizeNumber(0.4400000000000001)).toBe('0.44');
    expect(normalizeNumber(1 / 3)).toBe('0.333333');
  });

  it('folds booleans only when the param is known to be one', () => {
    expect(normalizeValue(1, 'bool')).toBe('true');
    expect(normalizeValue('True', 'bool')).toBe('true');
    expect(normalizeValue('off', 'bool')).toBe('false');
    // Without a declared type, 1 is the number one, not true.
    expect(normalizeValue(1)).toBe('1');
  });

  it('sorts object keys and array elements', () => {
    expect(normalizeValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(normalizeValue(['b', 'a'])).toBe('["a","b"]');
  });

  it('always produces a non-empty canonical string', () => {
    const { canonical } = canonicalizeArgs({
      engine_id: 'vllm',
      engine_version: null,
      args: {},
      quant_id: 'bf16',
    });
    expect(canonical).toBe('@dtype=auto;@quant=bf16');
  });

  it('drops nothing when the engine version is unknown', () => {
    const args = { 'gpu-memory-utilization': 0.9 };
    const known = canonicalizeArgs({
      engine_id: 'vllm',
      engine_version: '0.27.1',
      args,
      quant_id: 'bf16',
      params: [{ name: 'gpu-memory-utilization', default: 0.9 }],
    });
    const unknown = canonicalizeArgs({
      engine_id: 'vllm',
      engine_version: '9.9.9',
      args,
      quant_id: 'bf16',
      params: null,
    });
    expect(known.canonical).toBe('@dtype=auto;@quant=bf16');
    expect(unknown.canonical).toContain('gpu-memory-utilization=0.9');
    expect(known.configId).not.toBe(unknown.configId);
  });
});

describe('request options in the fingerprint (SPEC §3, decision 28)', () => {
  const base: CanonicalizeInput = {
    engine_id: 'sglang',
    engine_version: '0.5.20',
    args: {},
    quant_id: 'bf16',
  };

  it('ignores a request block that is entirely at the harness defaults', () => {
    const plain = canonicalizeArgs(base);
    const defaulted = canonicalizeArgs({
      ...base,
      request: { temperature: 0, seed: 42, timeout_s: 600, extra_body: {} },
    });
    expect(defaulted.canonical).toBe(plain.canonical);
    expect(defaulted.configId).toBe(plain.configId);
  });

  it('gives thinking-off its own config_id', () => {
    const thinkingOn = canonicalizeArgs({ ...base, request: { temperature: 0, seed: 42 } });
    const thinkingOff = canonicalizeArgs({
      ...base,
      request: { temperature: 0, seed: 42, chat_template_kwargs: { enable_thinking: false } },
    });
    expect(thinkingOff.canonical).toBe(
      '@dtype=auto;@quant=bf16;@req.chat_template_kwargs={"enable_thinking":false}',
    );
    expect(thinkingOff.configId).not.toBe(thinkingOn.configId);
  });

  it('never fingerprints a credential', () => {
    const withKey = canonicalizeArgs({ ...base, request: { api_key: 'sk-secret' } });
    expect(withKey.canonical).toBe(canonicalizeArgs(base).canonical);
    expect(withKey.canonical).not.toContain('sk-secret');
  });

  it('keeps the option names as the API spells them and sorts them last', () => {
    const { canonical } = canonicalizeArgs({
      ...base,
      args: { 'tensor-parallel-size': 2 },
      request: { reasoning_effort: 'max', temperature: 0.7 },
    });
    expect(canonical).toBe(
      '@dtype=auto;@quant=bf16;@req.reasoning_effort=max;@req.temperature=0.7;tensor-parallel-size=2',
    );
  });
});
