/** Generated recipe: preview, written file, copy, and the configured agent targets. */

import React from 'react';
import { Box, Text } from 'ink';
import type { AgentTarget } from '../../config.js';
import { agentCommand } from '../../recipe/send.js';
import { COLORS } from '../theme.js';
import { Panel } from '../widgets.js';

export interface RecipeProps {
  markdown: string;
  file: string | null;
  scroll: number;
  height: number;
  agents: Record<string, AgentTarget>;
  status: string | null;
}

export function RecipeView({
  markdown,
  file,
  scroll,
  height,
  agents,
  status,
}: RecipeProps): React.JSX.Element {
  const lines = markdown.split('\n');
  const visible = lines.slice(scroll, scroll + height);
  const names = Object.keys(agents);
  return (
    <Box flexDirection="column" gap={1}>
      <Panel title={file ? `Recipe → ${file}` : 'Recipe'} grow>
        {visible.map((l, i) => (
          <Text key={scroll + i} color={l.startsWith('#') ? COLORS.accent : undefined}>
            {l || ' '}
          </Text>
        ))}
        <Text color={COLORS.muted}>
          {Math.min(scroll + height, lines.length)}/{lines.length} — j/k to scroll
        </Text>
      </Panel>
      <Panel title="Send to an agent">
        {names.map((name, i) => (
          <Text key={name}>
            <Text color={COLORS.counter} bold>
              {i + 1}
            </Text>
            <Text> {name} </Text>
            <Text color={COLORS.muted}>
              ({agents[name]!.mode}) {file ? agentCommand(agents[name]!, file) : '…'}
            </Text>
          </Text>
        ))}
        {status ? <Text color={COLORS.ok}>{status}</Text> : null}
      </Panel>
    </Box>
  );
}
