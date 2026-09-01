/** Hardware picker: which box, and how many of them. */

import React from 'react';
import { Box, Text } from 'ink';
import type { Hardware } from '@atlas/core';
import { fmtGB } from '@atlas/core';
import type { HardwareRequest } from '../../hw/request.js';
import { requestPreview } from '../../hw/request.js';
import type { Target } from '../../hw/target.js';
import { describeTarget, targetLabel } from '../../hw/target.js';
import { COLORS } from '../theme.js';
import { Panel, Table } from '../widgets.js';

/** The trailing row: not a device, an escape hatch when none of them is yours. */
export interface AddChoice {
  kind: 'add';
}

export interface HardwareChoice {
  hardware: Hardware;
  /** Count to select this row with — adjusted per row so it survives moving away and back. */
  count: number;
  /** True for the entry the local probe matched. */
  detected: boolean;
}

export type PickerRow = HardwareChoice | AddChoice;

/** The origin and form, without three screens of percent-encoding. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const fields = [...u.searchParams.keys()].filter((k) => k !== 'template' && k !== 'title');
    return `${u.origin}${u.pathname}?template=${u.searchParams.get('template')}\n${fields.length} fields pre-filled: ${fields.join(', ')}`;
  } catch {
    return url;
  }
}

export const isAddRow = (row: PickerRow): row is AddChoice => (row as AddChoice).kind === 'add';

export interface HardwareViewProps {
  rows: PickerRow[];
  selected: number;
  target: Target;
  /** Shown instead of the normal title when the TUI could not identify this machine. */
  firstRun: boolean;
  status: string | null;
  height: number;
  width: number;
  /** When set, the confirmation dialog is up and owns the keyboard. */
  pending: { request: HardwareRequest; url: string } | null;
}

export function HardwareView({
  rows,
  selected,
  target,
  firstRun,
  status,
  height,
  width,
  pending,
}: HardwareViewProps): React.JSX.Element {
  if (pending) {
    return (
      <Box flexDirection="column" gap={1}>
        <Panel title="Add your box to the registry?" borderColor={COLORS.warn}>
          <Text>
            This opens the atlas issue form in your browser with the fields below already filled in
            from what was probed on this machine. Nothing is sent until you submit the form there,
            and you can edit every field first.
          </Text>
        </Panel>
        <Panel title="What it will carry">
          {requestPreview(pending.request).map((line, i) => (
            <Text key={i} color={line ? COLORS.ink : COLORS.muted}>
              {line || ' '}
            </Text>
          ))}
          <Text color={COLORS.muted}>
            Memory bandwidth and compute figures are left blank — a probe cannot know them, and the
            plausibility checks trust whatever goes in.
          </Text>
        </Panel>
        <Panel title="Where it goes">
          <Text color={COLORS.muted}>{shortUrl(pending.url)}</Text>
        </Panel>
      </Box>
    );
  }
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
          rows={rows.map((row) => {
            if (isAddRow(row)) {
              return {
                color: COLORS.counter,
                cells: [
                  '＋',
                  'not listed?',
                  'add your box to the registry',
                  '',
                  '',
                  '',
                  'opens an issue',
                ],
              };
            }
            const active = target.hardware?.id === row.hardware.id && target.count === row.count;
            const pooled = row.count > 1 && row.hardware.kind === 'gpu';
            const mem = row.hardware.memory_gb;
            return {
              color: active ? COLORS.ok : row.detected ? COLORS.accent : undefined,
              cells: [
                active ? '▸' : row.detected ? '·' : ' ',
                row.hardware.id,
                row.hardware.name,
                row.count > 1 ? `${row.count}×` : '1',
                mem
                  ? pooled
                    ? `${fmtGB(mem * row.count)} GB pooled`
                    : `${fmtGB(mem)} GB${row.count > 1 ? ' each' : ''}`
                  : '–',
                row.hardware.memory_bandwidth_gbs
                  ? `${row.hardware.memory_bandwidth_gbs} GB/s`
                  : '–',
                row.detected ? 'detected' : row.count > 1 && !pooled ? 'separate' : '',
              ],
            };
          })}
        />
      </Panel>
      <Text color={COLORS.muted}>
        Several GPUs in one host pool their memory when the engine shards a model across them.
        Several whole machines (Macs, Sparks) do not — a model has to fit one of them.
        {'\n'}Not listed? The last row opens a pre-filled registry request for this box.
      </Text>
    </Box>
  );
}
