import { describe, expect, it } from 'vitest';
import type { RequestSample } from '@atlas/core';
import './request-strip.js';
import { logTicks, type AtlasRequestStrip } from './request-strip.js';

const sample = (over: Partial<RequestSample>): RequestSample => ({
  id: 'concurrency1-r00000',
  level: 1,
  ttft_ms: 100,
  e2e_ms: 1000,
  completion_tokens: 256,
  ok: true,
  warmup: false,
  ...over,
});

async function mount(props: Partial<AtlasRequestStrip>): Promise<AtlasRequestStrip> {
  const el = document.createElement('atlas-request-strip') as AtlasRequestStrip;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('logTicks', () => {
  it('ticks the decades across a wide span', () => {
    expect(logTicks(1500, 90000)).toEqual([10000]);
    expect(logTicks(100, 100000)).toEqual([100, 1000, 10000, 100000]);
  });

  it('fills 2× and 5× steps when everything sits in one decade', () => {
    expect(logTicks(1000, 9000)).toEqual([1000, 2000, 5000]);
  });

  it('is empty for degenerate input', () => {
    expect(logTicks(0, 10)).toEqual([]);
    expect(logTicks(10, 5)).toEqual([]);
  });
});

describe('atlas-request-strip', () => {
  it('renders one dot per measured request with level markers, skipping warmups', async () => {
    const el = await mount({
      samples: [
        sample({}),
        sample({ id: 'concurrency1-w00000', warmup: true }),
        sample({ id: 'concurrency16-r00000', level: 16, ttft_ms: 15000 }),
        sample({ id: 'concurrency16-r00001', level: 16, ttft_ms: 16000 }),
      ],
    });
    expect(el.querySelectorAll('circle.dot')).toHaveLength(3);
    // one min–max range and one p50 caliper per level
    expect(el.querySelectorAll('line.range')).toHaveLength(2);
    expect(el.querySelectorAll('line.p50')).toHaveLength(2);
    const levels = [...el.querySelectorAll('text.level')].map((t) => t.textContent?.trim());
    expect(levels).toEqual(['1', '16']);
    expect(el.querySelector('circle.dot title')?.textContent).toContain('TTFT');
  });

  it('marks failed requests and switches metric', async () => {
    const el = await mount({
      samples: [sample({}), sample({ id: 'concurrency1-r00001', ok: false, ttft_ms: 900 })],
      metric: 'e2e',
    });
    // the failed request has no e2e problem here — both dots render on the e2e metric
    expect(el.querySelectorAll('circle.dot')).toHaveLength(2);
    expect(el.querySelectorAll('circle.failed')).toHaveLength(1);
    expect(el.querySelector('circle.dot title')?.textContent).toContain('E2E');
  });

  it('renders nothing when the payload has no usable samples', async () => {
    const el = await mount({ samples: [sample({ ttft_ms: null, e2e_ms: null })] });
    expect(el.querySelector('svg')).toBeNull();
  });
});
