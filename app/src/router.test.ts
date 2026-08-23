import { describe, expect, it } from 'vitest';
import { buildHash, href, parseHash, qlist, qnum } from './router.js';

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
    expect(parseHash('#/models/qwen3.8-27b').segments[1]).toBe('qwen3.8-27b');
    expect(parseHash('#/contributors/some%20one').segments[1]).toBe('some one');
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
