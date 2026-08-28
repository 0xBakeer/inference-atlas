import { html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { MetricBlock } from '@atlas/core';
import { fmtMs, fmtTokS } from '../util/format.js';
import { AtlasElement } from './base.js';

interface MetricBar {
  label: string;
  value: number;
  text: string;
}

function value(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function throughputBars(metrics: MetricBlock): MetricBar[] {
  return [
    ['Output', value(metrics.output_tok_s)],
    ['Total', value(metrics.total_tok_s)],
    ['Prefill', value(metrics.prefill_tok_s)],
    [
      'Decode / request',
      value(metrics.decode_tok_s_per_request?.p50 ?? metrics.decode_tok_s_per_request?.mean),
    ],
  ]
    .filter((item): item is [string, number] => item[1] !== null)
    .map(([label, n]) => ({ label, value: n, text: fmtTokS(n) }));
}

export function latencyBars(metrics: MetricBlock): MetricBar[] {
  return [
    ['TTFT p50', value(metrics.ttft_ms?.p50 ?? metrics.ttft_ms?.mean)],
    ['TTFT p95', value(metrics.ttft_ms?.p95 ?? metrics.ttft_ms?.p90)],
    ['TPOT p50', value(metrics.tpot_ms?.p50 ?? metrics.tpot_ms?.mean)],
    ['E2E p50', value(metrics.e2e_ms?.p50 ?? metrics.e2e_ms?.mean)],
  ]
    .filter((item): item is [string, number] => item[1] !== null)
    .map(([label, n]) => ({ label, value: n, text: fmtMs(n) }));
}

function group(title: string, items: MetricBar[], cls: string): TemplateResult | typeof nothing {
  if (!items.length) return nothing;
  const max = Math.max(...items.map((item) => item.value), 1);
  return html`<div class="metric-chart-group">
    <div class="overview-label">${title}</div>
    <div class="metric-chart-bars">
      ${items.map(
        (item) =>
          html`<div class="metric-chart-bar">
            <span class="metric-chart-name">${item.label}</span>
            <i class="metric-chart-track"
              ><i class=${cls} style=${`width:${Math.max(3, (item.value / max) * 100)}%`}></i
            ></i>
            <span class="metric-chart-value">${item.text}</span>
          </div>`,
      )}
    </div>
  </div>`;
}

@customElement('atlas-run-metric-chart')
export class AtlasRunMetricChart extends AtlasElement {
  @property({ attribute: false }) metrics: MetricBlock | null = null;

  override render() {
    if (!this.metrics) return nothing;
    const throughput = throughputBars(this.metrics);
    const latency = latencyBars(this.metrics);
    if (!throughput.length && !latency.length) return nothing;
    return html`<section class="run-metric-chart" aria-label="Metric profile charts">
      ${group('Throughput · tok/s', throughput, 'throughput')}
      ${group('Latency · milliseconds', latency, 'latency')}
    </section>`;
  }
}
