/** Coverage heatmap: model × hardware, colour = how much evidence exists. */

import React from 'react';
import { Box, Text } from 'ink';
import type { ColorLevel } from '../../canvas/color.js';
import { heatmapRows } from '../../canvas/blocks.js';
import { ramp } from '../../canvas/color.js';
import type { CoverageGrid } from '../../derive.js';
import { COLORS, HEAT_RAMP } from '../theme.js';
import { ChartLines, Panel } from '../widgets.js';

const LABEL_WIDTH = 28;
const CELL_WIDTH = 3;

export interface CoverageProps {
  grid: CoverageGrid;
  level: ColorLevel;
}

export function CoverageView({ grid, level }: CoverageProps): React.JSX.Element {
  const max = Math.max(1, ...grid.counts.flat());
  const colorFor = (count: number): string | null =>
    count === 0 ? null : ramp(HEAT_RAMP, 0.25 + 0.75 * (count / max));

  // Each grid row is CELL_WIDTH cells wide so the columns are readable; every model gets
  // its own text line (no half-block pairing) to keep the row labels aligned.
  const lines = grid.rowLabels.map((label, r) => {
    const cells = grid.colLabels.map((_, c) => {
      const colour = colorFor(grid.counts[r]![c]!);
      const block: Array<string | null> = Array.from({ length: CELL_WIDTH }, () => colour);
      return block;
    });
    const body = heatmapRows([cells.flat(), cells.flat()], level).join('');
    const trimmed = label.length > LABEL_WIDTH ? `…${label.slice(-(LABEL_WIDTH - 1))}` : label;
    return `${trimmed.padStart(LABEL_WIDTH)} ${body}`;
  });

  const header = grid.colLabels
    .map((h, i) => `${i + 1}`.padEnd(CELL_WIDTH))
    .join('')
    .trimEnd();

  return (
    <Box flexDirection="column" gap={1}>
      <Panel title="Coverage — runs per model × hardware" grow>
        <Text color={COLORS.muted}>{`${''.padStart(LABEL_WIDTH)} ${header}`}</Text>
        <ChartLines lines={lines} />
      </Panel>
      <Box flexDirection="column">
        {grid.colLabels.map((h, i) => (
          <Text key={h} color={COLORS.muted}>
            {i + 1} = {h}
          </Text>
        ))}
        <Text color={COLORS.muted}>
          dark → bright: 1 → {max} runs · blank: never measured (a gap to fill)
        </Text>
      </Box>
    </Box>
  );
}
