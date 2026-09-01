/** One run in full: identity, fit, latency distribution, request strip, sweep, gotchas. */

import React from 'react';
import { Box, Text } from 'ink';
import type { IndexRow, ResultRecord } from '@atlas/core';
import { fmtMs, fmtPct, fmtTokS, requestSamples } from '@atlas/core';
import { hbar, sparkline } from '../../canvas/blocks.js';
import type { ColorLevel } from '../../canvas/color.js';
import { paint } from '../../canvas/color.js';
import { renderChart } from '../../canvas/chart.js';
import { sweepChartData } from '../../derive.js';
import type { FitVerdict } from '../../hw/fit.js';
import { COLORS, FIT_COLOR } from '../theme.js';
import { ChartLines, Panel } from '../widgets.js';

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

function latencyBars(record: ResultRecord, width: number): string[] {
  const dist = record.metrics?.ttft_ms;
  if (!dist) return [];
  const entries: Array<[string, number | null | undefined]> = [
    ['p50', dist.p50],
    ['p90', dist.p90],
    ['p95', dist.p95],
    ['p99', dist.p99],
  ];
  const max = Math.max(...entries.map(([, v]) => (typeof v === 'number' ? v : 0)), 1);
  const barWidth = Math.max(10, width - 24);
  return entries
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .map(([label, v]) => `TTFT ${label} ${hbar(v / max, barWidth)} ${fmtMs(v)} ms`);
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
  const strip = record ? requestSamples(record).filter((s) => !s.warmup) : [];
  const stripLine =
    strip.length > 0
      ? sparkline(strip.slice(0, Math.max(10, width - 6)).map((s) => s.e2e_ms))
      : null;
  const failures = strip.filter((s) => !s.ok).length;
  const sweep = record ? sweepChartData(record) : null;

  return (
    <Box flexDirection="column" gap={1}>
      <Panel
        title={`${row.model.id} · ${row.model.quant_id} · ${row.engine.id}@${row.engine.version}`}
      >
        <Text>
          {row.hardware.id} · {row.workload_id} ({row.kind}) · by @{row.provenance.login ?? '?'} ·{' '}
          {row.verification_level}
        </Text>
        <Text color={COLORS.muted}>
          {fmtTokS(row.metrics.output_tok_s)} tok/s · TTFT p50 {fmtMs(row.metrics.ttft_p50)} ms ·
          success {fmtPct(row.metrics.success_rate)}
          {typeof row.metrics.accuracy === 'number'
            ? ` · accuracy ${fmtPct(row.metrics.accuracy)}`
            : ''}
        </Text>
      </Panel>

      {fit ? (
        <Panel title={`Fit on ${targetLabel}: ${fit.label}`}>
          {fit.reasons.map((r, i) => (
            <Text key={i} color={FIT_COLOR[fit.level]}>
              • {r}
            </Text>
          ))}
        </Panel>
      ) : null}

      {loading ? <Text color={COLORS.muted}>loading full run…</Text> : null}

      {record && latencyBars(record, width).length > 0 ? (
        <Panel title="Latency distribution">
          <ChartLines
            lines={latencyBars(record, width).map((l) => paint(l, { fg: COLORS.counter }, level))}
          />
        </Panel>
      ) : null}

      {stripLine ? (
        <Panel
          title={`Requests (${strip.length}${failures > 0 ? `, ${failures} failed` : ''}) — e2e time per request`}
        >
          <Text color={failures > 0 ? COLORS.bad : COLORS.accent}>{stripLine}</Text>
        </Panel>
      ) : null}

      {sweep ? (
        <Panel title={`Sweep over ${sweep.xLabel}`}>
          <ChartLines
            lines={[
              ...(sweep.throughput.length > 1
                ? renderChart({
                    width: width - 4,
                    height: 5,
                    level,
                    logX: sweep.logX,
                    xFmt: (v) => String(Math.round(v)),
                    series: [{ label: 'tok/s', color: COLORS.accent, points: sweep.throughput }],
                  })
                : []),
              ...(sweep.latencyP95.length > 1
                ? renderChart({
                    width: width - 4,
                    height: 5,
                    level,
                    logX: sweep.logX,
                    xFmt: (v) => String(Math.round(v)),
                    series: [{ label: 'TTFT ms', color: COLORS.counter, points: sweep.latencyP95 }],
                  })
                : []),
            ]}
          />
        </Panel>
      ) : null}

      {record?.gotchas?.length ? (
        <Panel title="Gotchas">
          {record.gotchas.map((g, i) => (
            <Text key={i} color={g.severity === 'info' ? COLORS.muted : COLORS.warn}>
              [{g.severity}] {g.text}
            </Text>
          ))}
        </Panel>
      ) : null}
    </Box>
  );
}
