/** Every run in the atlas, filterable. */

import React from 'react';
import { Box, Text } from 'ink';
import type { IndexRow } from '@atlas/core';
import { headlineMetric } from '@atlas/core';
import { COLORS } from '../theme.js';
import { Table } from '../widgets.js';

export interface RunsProps {
  rows: IndexRow[];
  keyMetrics: string[];
  filter: string;
  filtering: boolean;
  selected: number;
  height: number;
  width: number;
}

export function RunsView({
  rows,
  keyMetrics,
  filter,
  filtering,
  selected,
  height,
  width,
}: RunsProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={COLORS.muted}>filter: </Text>
        <Text color={filtering ? COLORS.counter : COLORS.ink}>
          {filter || (filtering ? '' : '(press / to filter)')}
          {filtering ? '▌' : ''}
        </Text>
      </Text>
      <Table
        height={height}
        width={width}
        selected={selected}
        columns={[
          { label: 'model', width: 28 },
          { label: 'quant', width: 15 },
          { label: 'engine', width: 20 },
          { label: 'hardware', width: 22 },
          { label: 'workload', width: 28 },
          { label: 'kind', width: 8 },
          { label: 'headline', width: 15, align: 'right' },
        ]}
        rows={rows.map((row) => {
          const hl = headlineMetric(row, keyMetrics);
          return {
            cells: [
              row.model.id,
              row.model.quant_id,
              `${row.engine.id}@${row.engine.version}`,
              row.hardware.id,
              row.workload_id,
              row.kind,
              hl ? `${hl.def.fmt(hl.value)} ${hl.def.unit}` : '–',
            ],
          };
        })}
      />
    </Box>
  );
}
