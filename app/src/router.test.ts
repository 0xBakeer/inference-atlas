import { describe, expect, it } from 'vitest';
import { buildHash, href, modelHref, modelIdFromSegments, parseHash, qlist, qnum } from './router.js';

describe('router', () => {
  it('parses paths and queries', () => {
    const r = parseHash('#/results?engine=vllm&sort=-output_tok_s');
    expect(r.path).toBe('/results');
    expect(r.segments).toEqual(['results']);
    expect(r.query.get('engine')).toBe('vllm');
    expect(r.query.get('sort')).toBe('-output_tok_s');
  });
  it('handles root, missing hash, and encoded segments', () => {
    expect(parseHash('').path).toBe('/');
    expect(parseHash('#/').segments).toEqual([]);
    expect(parseHash('#/run/abc--serve-v1--123').segments).toEqual(['run', 'abc--serve-v1--123']);
    expect(parseHash('#/contributors/some%20one').segments[1]).toBe('some one');
  });
  it('routes HF model ids with the slash as a real path segment', () => {
    // model_id is the Hugging Face repo id verbatim (SPEC §2, decision #20)
    const r = parseHash('#/models/google/gemma-4-E2B-it');
    expect(r.segments).toEqual(['models', 'google', 'gemma-4-E2B-it']);
    expect(modelIdFromSegments(r.segments)).toBe('google/gemma-4-E2B-it');
    // case is preserved end to end — never lowercased or kebab-cased
    const q = parseHash('#/models/Qwen/Qwen3.8-27B');
    expect(modelIdFromSegments(q.segments)).toBe('Qwen/Qwen3.8-27B');
    // a %2F-encoded slash decodes into the same id
    const enc = parseHash('#/models/google%2Fgemma-4-E2B-it');
    expect(modelIdFromSegments(enc.segments)).toBe('google/gemma-4-E2B-it');
    // list route has no item
    expect(modelIdFromSegments(parseHash('#/models').segments)).toBeNull();
  });
  it('builds model hrefs that keep the slash and the case', () => {
    expect(modelHref('google/gemma-4-E2B-it')).toBe('#/models/google/gemma-4-E2B-it');
    expect(modelHref('Qwen/Qwen3.8-27B')).toBe('#/models/Qwen/Qwen3.8-27B');
    expect(
      modelIdFromSegments(parseHash(modelHref('nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16')).segments),
    ).toBe('nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16');
  });
  it('builds hashes and hrefs', () => {
    expect(buildHash('/results', { engine: 'vllm', empty: '', nil: null })).toBe(
      '#/results?engine=vllm',
    );
    expect(buildHash('results')).toBe('#/results');
    expect(href('run', 'abc')).toBe('#/run/abc');
    expect(href('contributors', 'a b')).toBe('#/contributors/a%20b');
  });
  it('reads lists and numbers', () => {
    const q = new URLSearchParams('runs=a,b,c&mem=64&bad=x');
    expect(qlist(q, 'runs')).toEqual(['a', 'b', 'c']);
    expect(qlist(q, 'none')).toEqual([]);
    expect(qnum(q, 'mem')).toBe(64);
    expect(qnum(q, 'bad')).toBeNull();
  });
});
