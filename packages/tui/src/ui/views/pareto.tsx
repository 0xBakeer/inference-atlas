/** Pareto view: TTFT p50 vs output tok/s, frontier drawn bright, arrow keys walk points. */

import React from 'react';
import { Box, Text } from 'ink';
import { fmtMs, fmtTokS } from '@atlas/core';
import type { ColorLevel } from '../../canvas/color.js';
import { renderChart } from '../../canvas/chart.js';
import type { ParetoPointRow } from '../../derive.js';
import { COLORS } from '../theme.js';
import { ChartLines, Panel } from '../widgets.js';

export interface ParetoProps {
  points: ParetoPointRow[];
  frontier: Set<number>;
  selected: number;
  width: number;
  height: number;
  level: ColorLevel;
}

export function ParetoView({
  points,
  frontier,
  selected,
  width,
  height,
  level,
}: ParetoProps): React.JSX.Element {
  if (points.length === 0) {
    return <Text color={COLORS.muted}>No serving runs with both TTFT and tok/s yet.</Text>;
  }
  const frontierPoints = [...frontier]
    .sort((a, b) => points[a]!.x - points[b]!.x)
    .map((i) => points[i]!);
  const rest = points.filter((_, i) => !frontier.has(i));
  const selectedIdx = Math.max(0, Math.min(selected, points.length - 1));
  const sel = points[selectedIdx]!;
  const selInFrontier = frontier.has(selectedIdx);
  const chartSeries = [
    { label: 'runs', color: COLORS.muted, connect: false, points: rest },
    { label: 'frontier', color: COLORS.accent, connect: true, points: frontierPoints },
  ];
  const lines = renderChart({
    width,
    height,
    level,
    logX: true,
    series: chartSeries,
    xFmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`),
    yFmt: (v) => `${Math.round(v)}`,
    highlight: selInFrontier
      ? { series: 1, point: frontierPoints.indexOf(sel) }
      : { series: 0, point: rest.indexOf(sel) },
  });
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title="Pareto — TTFT p50 (x) vs output tok/s (y)" grow>
        <ChartLines lines={lines} />
      </Panel>
      <Panel title={frontier.has(selectedIdx) ? '◉ selected (on the frontier)' : '◉ selected'}>
        <Text>
          {sel.row.model.id} · {sel.row.model.quant_id} · {sel.row.engine.id}@
          {sel.row.engine.version} · {sel.row.hardware.id}
        </Text>
        <Text color={COLORS.muted}>
          {sel.row.workload_id} — {fmtTokS(sel.y)} tok/s at {fmtMs(sel.x)} ms TTFT p50
        </Text>
      </Panel>
    </Box>
  );
}
