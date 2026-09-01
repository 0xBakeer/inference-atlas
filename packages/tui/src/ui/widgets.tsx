/** Small shared Ink pieces: panel, key hints, a windowed table with a selection bar. */

import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from './theme.js';

export function Panel({
  title,
  children,
  grow,
}: {
  title: string;
  children: React.ReactNode;
  grow?: boolean;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.muted}
      paddingX={1}
      flexGrow={grow ? 1 : 0}
    >
      <Text color={COLORS.accent} bold>
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function KeyHints({ hints }: { hints: Array<[string, string]> }): React.JSX.Element {
  return (
    <Text>
      {hints.map(([key, label], i) => (
        <React.Fragment key={key}>
          {i > 0 ? <Text color={COLORS.muted}> · </Text> : null}
          <Text color={COLORS.counter} bold>
            {key}
          </Text>
          <Text color={COLORS.muted}> {label}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
}

export interface Column {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

export interface TableProps {
  columns: Column[];
  /** Pre-formatted cell text per row; row colour is optional. */
  rows: Array<{ cells: string[]; color?: string | null }>;
  selected: number;
  /** Visible body rows. */
  height: number;
  /** Total width budget; columns shrink (widest first, floor 6) until the row fits. */
  width?: number;
}

const fit = (s: string, width: number, align: 'left' | 'right'): string => {
  const trimmed = s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
  return align === 'right' ? trimmed.padStart(width) : trimmed.padEnd(width);
};

function fitColumns(columns: Column[], width: number | undefined): Column[] {
  if (!width) return columns;
  const cols = columns.map((c) => ({ ...c }));
  const total = () => cols.reduce((sum, c) => sum + c.width, 0) + cols.length - 1;
  while (total() > width) {
    const widest = cols.reduce((a, b) => (b.width > a.width ? b : a));
    if (widest.width <= 6) break;
    widest.width -= 1;
  }
  return cols;
}

export function Table({
  columns: rawColumns,
  rows,
  selected,
  height,
  width,
}: TableProps): React.JSX.Element {
  const columns = fitColumns(rawColumns, width);
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), rows.length - height));
  const visible = rows.slice(start, start + height);
  return (
    <Box flexDirection="column">
      <Text color={COLORS.muted} bold>
        {columns.map((c) => fit(c.label, c.width, c.align ?? 'left')).join(' ')}
      </Text>
      {visible.map((row, i) => {
        const index = start + i;
        const line = columns
          .map((c, j) => fit(row.cells[j] ?? '', c.width, c.align ?? 'left'))
          .join(' ');
        return index === selected ? (
          <Text key={index} backgroundColor={COLORS.accent} color="#0b1020" bold>
            {line}
          </Text>
        ) : (
          <Text key={index} color={row.color ?? undefined}>
            {line}
          </Text>
        );
      })}
      {rows.length > height ? (
        <Text color={COLORS.muted}>
          {selected + 1}/{rows.length}
        </Text>
      ) : null}
    </Box>
  );
}

/** Pre-rendered chart/heatmap lines (they carry their own ANSI codes). */
export function ChartLines({ lines }: { lines: string[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}
