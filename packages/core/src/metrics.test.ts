import { describe, expect, it } from 'vitest';
import { fixtureRow } from './fixtures.js';
import { headlineMetric } from './metrics.js';

/** The site-wide order, as `site/config.json` carries it. */
const KEY_METRICS = ['output_tok_s', 'decode_tok_s_per_request', 'accuracy', 'ttft_p50'];

describe('headlineMetric', () => {
  it('takes the first site key metric present, in order', () => {
    const hl = headlineMetric(fixtureRow(), KEY_METRICS);
    expect(hl?.def.key).toBe('output_tok_s');
    expect(hl?.value).toBe(120.5);
  });

  it('falls past a key metric the row does not carry', () => {
    const row = fixtureRow({ metrics: { ttft_p50: 80 } });
    expect(headlineMetric(row, KEY_METRICS)?.def.key).toBe('ttft_p50');
  });

  // On a longctx run the model answers a needle question in a handful of tokens, so
  // output_tok_s collapses to answer-length / TTFT and ranks engines by verbosity: a 6-token
  // and an 89-token answer differ ~20x on it while their prefill differs under 2.5x.
  it('does not headline output_tok_s on a longctx run', () => {
    const row = fixtureRow({
      workload_id: 'longctx-depth-sweep-v1',
      kind: 'longctx',
      metrics: { output_tok_s: 0.276, ttft_p50: 21763.894 },
    });
    const hl = headlineMetric(row, KEY_METRICS);
    expect(hl?.def.key).toBe('ttft_p50');
    expect(hl?.value).toBe(21763.894);
  });

  it('still reports output_tok_s on a longctx run that carries nothing better', () => {
    const row = fixtureRow({
      workload_id: 'longctx-depth-sweep-v1',
      kind: 'longctx',
      metrics: { output_tok_s: 0.276 },
    });
    expect(headlineMetric(row, KEY_METRICS)?.def.key).toBe('output_tok_s');
  });

  // An image run has no tokens at all, so every token metric on it is null and the site
  // order would fall through to success rate — a number that is 1.0 on every lane that did
  // not crash, and therefore ranks nothing.
  it('headlines seconds per image on an image run', () => {
    const row = fixtureRow({
      workload_id: 't2i-single-1k-40s-v1',
      kind: 'image',
      metrics: { s_per_image_p50: 12.4, success_rate: 1, vram_peak_gb: 41.2 },
    });
    const hl = headlineMetric(row, KEY_METRICS);
    expect(hl?.def.key).toBe('s_per_image_p50');
    expect(hl?.value).toBe(12.4);
    expect(hl?.def.better).toBe('lower');
  });

  it('falls to peak memory on an image run that reported no timing', () => {
    const row = fixtureRow({
      workload_id: 't2i-single-2k-40s-v1',
      kind: 'image',
      metrics: { success_rate: 1, vram_peak_gb: 41.2 },
    });
    expect(headlineMetric(row, KEY_METRICS)?.def.key).toBe('vram_peak_gb');
  });

  it('leaves serving runs on the site order', () => {
    const row = fixtureRow({ metrics: { output_tok_s: 120.5, ttft_p50: 80 } });
    expect(headlineMetric(row, KEY_METRICS)?.def.key).toBe('output_tok_s');
  });

  it('returns null when the row carries no usable metric', () => {
    expect(headlineMetric(fixtureRow({ metrics: {} }), KEY_METRICS)).toBeNull();
  });
});
