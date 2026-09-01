/** Hardware picker: which box, and how many of them. */

import React from 'react';
import { Box, Text } from 'ink';
import type { Hardware } from '@atlas/core';
import { fmtGB } from '@atlas/core';
import type { Target } from '../../hw/target.js';
import { describeTarget, targetLabel } from '../../hw/target.js';
import { COLORS } from '../theme.js';
import { Panel, Table } from '../widgets.js';

export interface HardwareChoice {
  hardware: Hardware;
  /** Count to select this row with — adjusted per row so it survives moving away and back. */
  count: number;
  /** True for the entry the local probe matched. */
  detected: boolean;
}

export interface HardwareViewProps {
  choices: HardwareChoice[];
  selected: number;
  target: Target;
  /** Shown instead of the normal title when the TUI could not identify this machine. */
  firstRun: boolean;
  status: string | null;
  height: number;
  width: number;
}

export function HardwareView({
  choices,
  selected,
  target,
  firstRun,
  status,
  height,
  width,
}: HardwareViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      {firstRun ? (
        <Panel title="Which box are you running models on?">
          <Text>
            This machine did not match anything in the hardware registry
            {target.captured ? ` (${target.captured.cpu}, ${target.captured.memoryGb} GB)` : ''}.
          </Text>
          <Text color={COLORS.muted}>
            Pick the box you actually deploy to — a GPU, a workstation, a server. Use +/- for how
            many of them you have. It is saved to your config and you can change it any time with b.
          </Text>
        </Panel>
      ) : (
        <Panel title="Target box — everything is judged against this">
          <Text>
            <Text color={COLORS.ok} bold>
              {targetLabel(target)}
            </Text>
            <Text color={COLORS.muted}> {describeTarget(target)}</Text>
          </Text>
        </Panel>
      )}

      {status ? <Text color={COLORS.ok}>{status}</Text> : null}

      <Panel title="Pick your hardware  ·  +/- how many  ·  enter to use it" grow>
        <Table
          height={height}
          width={width}
          selected={selected}
          columns={[
            { label: '', width: 2 },
            { label: 'hardware', width: 24 },
            { label: 'name', width: 26 },
            { label: 'n', width: 3, align: 'right' },
            { label: 'memory', width: 16, align: 'right' },
            { label: 'bandwidth', width: 12, align: 'right' },
            { label: '', width: 10 },
          ]}
          rows={choices.map((c) => {
            const active = target.hardware?.id === c.hardware.id && target.count === c.count;
            const pooled = c.count > 1 && c.hardware.kind === 'gpu';
            const mem = c.hardware.memory_gb;
            return {
              color: active ? COLORS.ok : c.detected ? COLORS.accent : undefined,
              cells: [
                active ? '▸' : c.detected ? '·' : ' ',
                c.hardware.id,
                c.hardware.name,
                c.count > 1 ? `${c.count}×` : '1',
                mem
                  ? pooled
                    ? `${fmtGB(mem * c.count)} GB pooled`
                    : `${fmtGB(mem)} GB${c.count > 1 ? ' each' : ''}`
                  : '–',
                c.hardware.memory_bandwidth_gbs ? `${c.hardware.memory_bandwidth_gbs} GB/s` : '–',
                c.detected ? 'detected' : c.count > 1 && !pooled ? 'separate' : '',
              ],
            };
          })}
        />
      </Panel>
      <Text color={COLORS.muted}>
        Several GPUs in one host pool their memory when the engine shards a model across them.
        Several whole machines (Macs, Sparks) do not — a model has to fit one of them.
      </Text>
    </Box>
  );
}
