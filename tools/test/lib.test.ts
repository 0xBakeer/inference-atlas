/**
 * The small pieces the CLIs are built out of: argv parsing, the engine/device
 * compatibility mapping, index-row metric extraction and deterministic serialization.
 * Each of them is somewhere a wrong answer would be invisible in the output of the
 * command that uses it.
 */
import { describe, expect, it } from 'vitest';
import type { EngineMeta, Hardware, ResultRecord } from '@atlas/core';
import { parseArgv } from '../src/lib/args.js';
import { engineFitsHardware, hardwarePlatforms } from '../src/lib/compat.js';
import { parsePr, loginFromEmail } from '../src/lib/git.js';
import { indexMetrics } from '../src/lib/index-row.js';
import { serialize, sortKeys } from '../src/lib/write.js';

describe('parseArgv', () => {
  it('reads --key value, --key=value and bare flags', () => {
    const args = parseArgv(['--engine', 'vllm', '--version=0.27.1', '--json'], {
      boolean: ['json'],
    });
    expect(args.str('engine')).toBe('vllm');
    expect(args.str('version')).toBe('0.27.1');
    expect(args.bool('json')).toBe(true);
    expect(args.bool('missing')).toBe(false);
  });

  it('swallows every following token for a variadic flag', () => {
    const args = parseArgv(['--changed', 'a.json', 'b.json', 'c.json', '--json'], {
      variadic: ['changed'],
      boolean: ['json'],
    });
    expect(args.list('changed')).toEqual(['a.json', 'b.json', 'c.json']);
    expect(args.bool('json')).toBe(true);
  });

  it('splits comma-separated lists', () => {
    expect(parseArgv(['--workloads', 'a-v1,b-v1']).list('workloads')).toEqual(['a-v1', 'b-v1']);
  });

  it('collects repeated --args k=v pairs and types the values', () => {
    const args = parseArgv([
      '--args',
      'max-model-len=32768',
      '--args',
      'enable-prefix-caching=true',
      '--args',
      'name=qwen',
      '--args',
      'speculative-config={"method":"mtp"}',
    ]);
    expect(args.pairs('args')).toEqual({
      'max-model-len': 32768,
      'enable-prefix-caching': true,
      name: 'qwen',
      'speculative-config': { method: 'mtp' },
    });
  });

  it('drops the separator pnpm forwards before the real flags', () => {
    expect(parseArgv(['--', '--engine', 'vllm']).str('engine')).toBe('vllm');
  });
});

describe('engine / device compatibility', () => {
  const hardware = (vendor: string, kind: Hardware['kind']): Hardware =>
    ({ id: `${vendor}-x`, name: 'x', vendor, kind, memory_gb: 24, schema_version: 1 }) as Hardware;
  const engine = (platforms: string[]): EngineMeta =>
    ({ id: 'e', platforms }) as unknown as EngineMeta;

  it('maps each vendor to the platforms it can host', () => {
    expect(hardwarePlatforms(hardware('nvidia', 'gpu'))).toEqual(['linux-cuda', 'windows-cuda']);
    expect(hardwarePlatforms(hardware('amd', 'gpu'))).toEqual(['linux-rocm']);
    expect(hardwarePlatforms(hardware('apple', 'soc'))).toEqual(['macos-metal', 'macos-cpu']);
    expect(hardwarePlatforms(hardware('intel', 'gpu'))).toEqual(['linux-xpu']);
    expect(hardwarePlatforms(hardware('other', 'cpu'))).toEqual(['linux-cpu', 'windows-cpu']);
  });

  it('keeps vLLM off Apple silicon and MLX off NVIDIA', () => {
    const vllm = engine(['linux-cuda', 'linux-rocm', 'linux-cpu']);
    const mlx = engine(['macos-metal']);
    expect(engineFitsHardware(vllm, hardware('nvidia', 'gpu'))).toBe(true);
    expect(engineFitsHardware(vllm, hardware('apple', 'soc'))).toBe(false);
    expect(engineFitsHardware(mlx, hardware('apple', 'soc'))).toBe(true);
    expect(engineFitsHardware(mlx, hardware('nvidia', 'soc'))).toBe(false);
  });

  it('runs llama.cpp everywhere, which is the point of llama.cpp', () => {
    const llamacpp = engine([
      'linux-cuda',
      'linux-rocm',
      'linux-cpu',
      'macos-metal',
      'windows-cuda',
    ]);
    for (const device of [
      hardware('nvidia', 'gpu'),
      hardware('amd', 'gpu'),
      hardware('apple', 'soc'),
      hardware('other', 'cpu'),
    ]) {
      expect(engineFitsHardware(llamacpp, device), device.vendor).toBe(true);
    }
  });
});

describe('index row metrics', () => {
  const base = {
    metrics: null,
    scores: null,
    sweep: null,
  } as unknown as ResultRecord;

  it('flattens the distributions the site ranks on', () => {
    const { metrics, source } = indexMetrics({
      ...base,
      metrics: {
        output_tok_s: 120,
        ttft_ms: { mean: 40, p50: 38, p95: 60 },
        tpot_ms: { p50: 9 },
        decode_tok_s_per_request: { mean: 118 },
      },
    } as ResultRecord);
    expect(metrics).toMatchObject({
      output_tok_s: 120,
      ttft_p50: 38,
      ttft_p95: 60,
      tpot_p50: 9,
      decode_tok_s_per_request: 118,
    });
    expect(source).toBe('metrics');
  });

  it('falls back to the best point of a sweep when the top-level block is empty', () => {
    // A long-context sweep has no single number: the measurement is the curve, and the
    // atlas would otherwise show the run as having no data at all.
    const { metrics, source } = indexMetrics({
      ...base,
      metrics: { output_tok_s: null },
      sweep: [
        {
          input_tokens: 8,
          metrics: { decode_tok_s_per_request: { mean: 18.6 }, ttft_ms: { p50: 90 } },
        },
        {
          input_tokens: 32768,
          metrics: { decode_tok_s_per_request: { mean: 6.4 }, ttft_ms: { p50: 900 } },
        },
      ],
    } as ResultRecord);
    expect(metrics.decode_tok_s_per_request).toBe(18.6);
    expect(metrics.ttft_p50).toBe(90);
    expect(source).toBe('sweep-best');
  });

  it('reads eval accuracy out of scores', () => {
    const { metrics } = indexMetrics({
      ...base,
      scores: { suite: 'math', total: 100, correct: 87, accuracy: 0.87 },
    } as ResultRecord);
    expect(metrics.accuracy).toBe(0.87);
  });

  it('says "none" when nothing was measured', () => {
    expect(indexMetrics(base).source).toBe('none');
  });
});

describe('deterministic output', () => {
  it('sorts object keys recursively but leaves array order alone', () => {
    expect(JSON.stringify(sortKeys({ b: 1, a: { d: 2, c: [3, 1, 2] } }))).toBe(
      '{"a":{"c":[3,1,2],"d":2},"b":1}',
    );
    expect(JSON.stringify(sortKeys({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('writes compactly when asked and with a trailing newline otherwise', () => {
    expect(serialize({ a: 1 }, { pretty: false })).toBe('{"a":1}');
    expect(serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe('git helpers', () => {
  it('reads a pull request number out of either merge style', () => {
    expect(parsePr('results: vllm on a 4090 (#42)')).toBe(42);
    expect(parsePr('Merge pull request #7 from user/branch')).toBe(7);
    expect(parsePr('chore: no pull request here')).toBeNull();
  });

  it('reads a login out of a GitHub noreply address and nothing else', () => {
    expect(loginFromEmail('1234+octocat@users.noreply.github.com')).toBe('octocat');
    expect(loginFromEmail('octocat@users.noreply.github.com')).toBe('octocat');
    expect(loginFromEmail('someone@example.com')).toBeNull();
  });
});
