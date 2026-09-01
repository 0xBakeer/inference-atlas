/** One run in full: identity, fit, latency distribution, request shape, sweep, gotchas. */

import React from 'react';
import { Box, Text } from 'ink';
import type { Gotcha, IndexRow, ResultRecord } from '@atlas/core';
import { fmtMs, fmtPct, fmtTokS, requestSamples } from '@atlas/core';
import { columnRows, hbar, resample, resampleFlags } from '../../canvas/blocks.js';
import type { ColorLevel } from '../../canvas/color.js';
import { paint, ramp } from '../../canvas/color.js';
import { legendChips, renderChart } from '../../canvas/chart.js';
import { sweepChartData } from '../../derive.js';
import type { FitVerdict } from '../../hw/fit.js';
import { COLORS, FIT_COLOR, LATENCY_RAMP } from '../theme.js';
import { ChartLines, Panel, SeverityNote } from '../widgets.js';

export interface DetailProps {
  row: IndexRow;
  record: ResultRecord | null;
  loading: boolean;
  fit: FitVerdict | null;
  /** Name of the box the fit was judged against — not necessarily this machine. */
  targetLabel: string;
  width: number;
  level: ColorLevel;
}

const PERCENTILES = ['p50', 'p90', 'p95', 'p99'] as const;

/** Headline metrics this run actually carries — an eval has no tok/s and should not say "–". */
function summarise(row: IndexRow): string {
  const bits: string[] = [];
  const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (n(row.metrics.output_tok_s)) bits.push(`${fmtTokS(row.metrics.output_tok_s)} tok/s`);
  if (n(row.metrics.decode_tok_s_per_request))
    bits.push(`${fmtTokS(row.metrics.decode_tok_s_per_request)} tok/s per request`);
  if (n(row.metrics.ttft_p50)) bits.push(`TTFT p50 ${fmtMs(row.metrics.ttft_p50)} ms`);
  if (n(row.metrics.accuracy)) bits.push(`accuracy ${fmtPct(row.metrics.accuracy)}`);
  if (n(row.metrics.success_rate)) bits.push(`success ${fmtPct(row.metrics.success_rate)}`);
  if (n(row.metrics.power_avg_w)) bits.push(`${Math.round(row.metrics.power_avg_w)} W`);
  return bits.join(' · ') || 'no headline metrics on this run';
}

/** `left … right` spread across exactly `width` cells, or trimmed when they do not fit. */
function axisCaption(left: string, right: string, width: number): string {
  const gap = width - left.length - right.length;
  if (gap < 1) return `${left} … ${right}`.slice(0, Math.max(0, width));
  return `${left}${' '.repeat(gap)}${right}`;
}

/**
 * Percentile bars. Scaling to the max alone makes p50…p99 look identical whenever the tail
 * is tight, so the colour deepens with the percentile: the shape of the tail is in the
 * ramp, the absolute size in the bar, and the scale is spelled out underneath.
 */
function LatencyBars({
  record,
  inner,
  level,
}: {
  record: ResultRecord;
  inner: number;
  level: ColorLevel;
}): React.JSX.Element | null {
  const dist = record.metrics?.ttft_ms;
  if (!dist) return null;
  const values = PERCENTILES.map((p) => dist[p]).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (values.length === 0) return null;
  const max = Math.max(...values);
  const labelWidth = Math.max(...values.map((v) => fmtMs(v).length)) + 3;
  // "TTFT p50 " prefix + bar + " <value> ms"
  const barWidth = Math.max(12, inner - 9 - labelWidth - 4);
  return (
    <Box flexDirection="column">
      {PERCENTILES.map((p, i) => {
        const v = dist[p];
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        const colour = ramp(LATENCY_RAMP, i / (PERCENTILES.length - 1));
        return (
          <Text key={p}>
            <Text color={COLORS.muted}>TTFT </Text>
            <Text color={colour}>{p} </Text>
            {paint(hbar(v / max, barWidth), { fg: colour }, level)}
            <Text> {`${fmtMs(v)} ms`.padStart(labelWidth)}</Text>
          </Text>
        );
      })}
      <Text color={COLORS.muted}>
        {' '.repeat(9)}
        {axisCaption('0', `${fmtMs(max)} ms`, barWidth)}
      </Text>
    </Box>
  );
}

interface Shape {
  node: React.JSX.Element;
  total: number;
  failed: number;
}

/**
 * Every request as one column, downsampled across the whole run rather than truncated: a
 * 400-request sweep must show all of its arms, not the first ninety calls.
 */
function requestShape(record: ResultRecord, inner: number, level: ColorLevel): Shape | null {
  const samples = requestSamples(record).filter((s) => !s.warmup);
  if (samples.length === 0) return null;
  const cols = Math.max(10, inner);
  const values = resample(
    samples.map((s) => s.e2e_ms),
    cols,
  );
  const failed = resampleFlags(
    samples.map((s) => !s.ok),
    cols,
  );
  const present = values.filter((v): v is number => v !== null);
  const max = present.length > 0 ? Math.max(...present) : 1;
  const rows = columnRows(values, 3, { min: 0, max });
  const node = (
    <Box flexDirection="column">
      {rows.map((line, r) => (
        <Text key={r}>
          {[...line]
            .map((ch, i) => {
              const v = values[i];
              const colour = failed[i]
                ? COLORS.bad
                : v === null || v === undefined
                  ? COLORS.muted
                  : ramp(LATENCY_RAMP, v / max);
              return paint(ch, { fg: colour }, level);
            })
            .join('')}
        </Text>
      ))}
      <Text color={COLORS.muted}>{axisCaption('first', `last · peak ${fmtMs(max)} ms`, cols)}</Text>
    </Box>
  );
  return { node, total: samples.length, failed: samples.filter((s) => !s.ok).length };
}

export function DetailView({
  row,
  record,
  loading,
  fit,
  targetLabel,
  width,
  level,
}: DetailProps): React.JSX.Element {
  // `width` is already the panel's content width: the shell subtracts its own padding (2)
  // and the panel frame plus padding (4) before handing it over.
  const inner = Math.max(20, width);
  const sweep = record ? sweepChartData(record) : null;
  const shape = record ? requestShape(record, inner, level) : null;
  const latency = record ? LatencyBars({ record, inner, level }) : null;
  const gotchas: Gotcha[] = record?.gotchas ?? [];
  const sweepSeries = sweep
    ? [
        {
          label: 'tok/s',
          color: COLORS.accent,
          points: sweep.throughput,
          fill: true,
          axis: 'left' as const,
        },
        {
          label: 'TTFT ms',
          color: COLORS.counter,
          points: sweep.latencyP95,
          axis: 'right' as const,
        },
      ].filter((s) => s.points.length > 1)
    : [];

  return (
    <Box flexDirection="column" gap={1}>
      <Panel
        title={`${row.model.id} · ${row.model.quant_id} · ${row.engine.id}@${row.engine.version}`}
      >
        <Text>
          {row.hardware.id}
          {row.hardware.count > 1 ? ` ×${row.hardware.count}` : ''} · {row.workload_id} ({row.kind})
          · by @{row.provenance.login ?? '?'} · {row.verification_level}
        </Text>
        <Text color={COLORS.muted}>{summarise(row)}</Text>
      </Panel>

      {fit ? (
        <Panel title={`Fit on ${targetLabel}: ${fit.label}`} borderColor={FIT_COLOR[fit.level]}>
          {fit.reasons.map((r, i) => (
            <Text key={i} color={FIT_COLOR[fit.level]}>
              • {r}
            </Text>
          ))}
        </Panel>
      ) : null}

      {loading ? <Text color={COLORS.muted}>loading full run…</Text> : null}

      {latency ? <Panel title="Latency distribution — time to first token">{latency}</Panel> : null}

      {shape ? (
        <Panel
          title={`Requests — ${shape.total} calls, end-to-end each${shape.failed > 0 ? ` · ${shape.failed} failed` : ''}`}
        >
          {shape.node}
        </Panel>
      ) : null}

      {sweepSeries.length > 0 ? (
        <Panel title={`Sweep over ${sweep!.xLabel}    ${legendChips(sweepSeries, level)}`}>
          <ChartLines
            lines={renderChart({
              width: inner,
              height: 9,
              level,
              logX: sweep!.logX,
              tightX: true,
              xTicks: sweep!.throughput.map((p) => p.x),
              xFmt: (v) => (v >= 1024 ? `${Math.round(v / 1024)}k` : String(Math.round(v))),
              series: sweepSeries,
            })}
          />
        </Panel>
      ) : null}

      {gotchas.length > 0 ? (
        <Box flexDirection="column">
          <Text color={COLORS.accent} bold>
            Gotchas — what somebody had to know to make this run work
          </Text>
          {gotchas.map((g, i) => (
            <SeverityNote key={i} severity={g.severity} text={g.text} link={g.link ?? null} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
