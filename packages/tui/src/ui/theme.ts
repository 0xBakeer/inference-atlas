/** The TUI palette — the web app's instrument-readout look: cobalt + signal orange. */

import type { FitLevel } from '../hw/fit.js';

export const COLORS = {
  accent: '#5b8cff', // cobalt — primary series, selection
  counter: '#f97316', // signal orange — the counterpart series (latency)
  ok: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  muted: '#8b93a7',
  ink: '#e6e9f0',
} as const;

/** Coverage/heat ramp: void → cobalt → hot. */
export const HEAT_RAMP = ['#1b2540', '#2d4a9e', '#5b8cff', '#9db9ff', '#f5f7ff'];

export const FIT_COLOR: Record<FitLevel, string> = {
  recommended: COLORS.ok,
  'should-fit': COLORS.accent,
  tight: COLORS.warn,
  'no-fit': COLORS.bad,
  'wrong-platform': COLORS.muted,
  unknown: COLORS.muted,
};
