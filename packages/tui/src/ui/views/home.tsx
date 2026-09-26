/** Launch screen: the target box, and what is worth running on it. */

import React from 'react';
import { Box, Text } from 'ink';
import type { IndexRow } from '@atlas/core';
import { headlineMetric } from '@atlas/core';
import type { AtlasData } from '../../data/load.js';
import type { FitLevel } from '../../hw/fit.js';
import type { Target } from '../../hw/target.js';
import { describeTarget, targetLabel } from '../../hw/target.js';
import { COLORS, FIT_COLOR } from '../theme.js';
import { Panel, Table } from '../widgets.js';

export interface HomeProps {
  data: AtlasData;
  target: Target;
  ranked: Array<{ row: IndexRow; fitLevel: FitLevel; fitLabel: string }>;
  keyMetrics: string[];
  sortByMetric: boolean;
  selected: number;
  height: number;
  width: number;
  /** Outcome of the last hardware selection — the picker hands its confirmation over here. */
  status?: string | null;
}

const SOURCE_NOTE: Record<Target['source'], string> = {
  detected: 'detected on this machine',
  chosen: 'your selection',
  unknown: 'not identified yet',
};

export function HomeView({
  data,
  target,
  ranked,
  keyMetrics,
  sortByMetric,
  selected,
  height,
  width,
  status,
}: HomeProps): React.JSX.Element {
  const stats = data.manifest?.counts ?? {};
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title={`Target box — ${SOURCE_NOTE[target.source]}  ·  press b to change`}>
        <Text>
          <Text bold>{targetLabel(target)}</Text>
          <Text color={COLORS.muted}> {describeTarget(target)}</Text>
        </Text>
        {target.hardware ? (
          <Text>
            atlas id: <Text color={COLORS.ok}>{target.hardware.id}</Text>
            {target.hardware.memory_bandwidth_gbs
              ? `  ·  ${target.hardware.memory_bandwidth_gbs} GB/s memory bandwidth`
              : ''}
          </Text>
        ) : (
          <Text color={COLORS.warn}>
            no hardware selected — press b to pick the box you run models on
          </Text>
        )}
      </Panel>
      {status ? <Text color={COLORS.ok}>{status}</Text> : null}
      <Panel
        title={`Worth running on ${targetLabel(target)}  ·  sorted by ${sortByMetric ? 'headline metric' : 'fit'}  ·  press s to change`}
        grow
      >
        <Table
          height={height}
          width={width}
          selected={selected}
          columns={[
            { label: 'fit', width: 15 },
            { label: 'model', width: 30 },
            { label: 'quant', width: 14 },
            { label: 'engine', width: 18 },
            { label: 'workload', width: 26 },
            { label: 'headline', width: 16, align: 'right' },
          ]}
          rows={ranked.map(({ row, fitLevel, fitLabel }) => {
            const hl = headlineMetric(row, keyMetrics);
            return {
              color: FIT_COLOR[fitLevel],
              cells: [
                fitLabel,
                row.model.id,
                row.model.quant_id,
                `${row.engine.id}@${row.engine.version}`,
                row.workload_id,
                hl ? `${hl.def.fmt(hl.value)} ${hl.def.unit}` : '–',
              ],
            };
          })}
        />
      </Panel>
      <Text color={COLORS.muted}>
        {String(stats['runs'] ?? data.index.length)} runs · {String(stats['models'] ?? '?')} models
        · {String(stats['hardware'] ?? '?')} hardware · {String(stats['engines'] ?? '?')} engines
      </Text>
    </Box>
  );
}
