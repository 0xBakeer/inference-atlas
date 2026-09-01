/** Target picker: this machine, configured boxes, an ad-hoc ssh probe, or a registry entry. */

import React from 'react';
import { Box, Text } from 'ink';
import type { Hardware } from '@atlas/core';
import { fmtGB } from '@atlas/core';
import type { Target } from '../../hw/target.js';
import { COLORS } from '../theme.js';
import { Panel, Table } from '../widgets.js';

export type BoxChoiceKind = 'local' | 'configured' | 'registry';

export interface BoxChoice {
  kind: BoxChoiceKind;
  /** Target id this choice resolves to, for marking the active one. */
  id: string;
  name: string;
  detail: string;
  hardware: Hardware | null;
  ssh: string | null;
}

export interface BoxesProps {
  choices: BoxChoice[];
  selected: number;
  active: Target;
  height: number;
  width: number;
  /** ssh destination being typed, or null when not prompting. */
  sshPrompt: string | null;
  /** Probe in flight / failed. */
  status: string | null;
}

const KIND_LABEL: Record<BoxChoiceKind, string> = {
  local: 'this machine',
  configured: 'configured',
  registry: 'registry',
};

export function BoxesView({
  choices,
  selected,
  active,
  height,
  width,
  sshPrompt,
  status,
}: BoxesProps): React.JSX.Element {
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title="Target box — everything is judged against this">
        <Text>
          <Text color={COLORS.ok} bold>
            {active.label}
          </Text>
          <Text color={COLORS.muted}>
            {active.hardware ? `  ·  ${active.hardware.id}` : '  ·  not in the hardware registry'}
            {active.ssh ? `  ·  ssh ${active.ssh}` : ''}
            {active.kind === 'registry' ? '  ·  nothing probed' : ''}
          </Text>
        </Text>
      </Panel>

      {sshPrompt !== null ? (
        <Panel title="Probe a box over ssh">
          <Text>
            <Text color={COLORS.muted}>ssh destination: </Text>
            <Text color={COLORS.counter}>{sshPrompt}▌</Text>
          </Text>
          <Text color={COLORS.muted}>
            an alias from ~/.ssh/config or user@host · enter to probe · esc to cancel
          </Text>
        </Panel>
      ) : null}

      {status ? (
        <Text color={status.startsWith('probing') ? COLORS.accent : COLORS.bad}>{status}</Text>
      ) : null}

      <Panel title="Pick a box" grow>
        <Table
          height={height}
          width={width}
          selected={selected}
          columns={[
            { label: '', width: 2 },
            { label: 'box', width: 26 },
            { label: 'source', width: 13 },
            { label: 'memory', width: 9, align: 'right' },
            { label: 'bandwidth', width: 11, align: 'right' },
            { label: 'detail', width: 34 },
          ]}
          rows={choices.map((c) => ({
            color: c.id === active.id ? COLORS.ok : undefined,
            cells: [
              c.id === active.id ? '▸' : ' ',
              c.name,
              KIND_LABEL[c.kind],
              c.hardware?.memory_gb ? `${fmtGB(c.hardware.memory_gb)} GB` : '–',
              c.hardware?.memory_bandwidth_gbs ? `${c.hardware.memory_bandwidth_gbs} GB/s` : '–',
              c.detail,
            ],
          }))}
        />
      </Panel>
    </Box>
  );
}
