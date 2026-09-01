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
  line: '#39415c', // panel frames: present, never louder than the content
} as const;

/** Coverage/heat ramp: void → cobalt → hot. */
export const HEAT_RAMP = ['#1b2540', '#2d4a9e', '#5b8cff', '#9db9ff', '#f5f7ff'];

/** Latency ramp: quick and cool → slow and hot. Used for percentiles and request columns. */
export const LATENCY_RAMP = ['#5b8cff', '#7f7fe8', '#c46fb0', '#f97316'];

/**
 * Gotcha severities. A blocker is a wall, a warning is a trap, and an info note is
 * institutional knowledge — three different things that were all grey before.
 */
export const SEVERITY: Record<string, { color: string; label: string }> = {
  blocker: { color: '#ef4444', label: 'blocker' },
  warn: { color: '#f59e0b', label: 'warning' },
  info: { color: '#8b93a7', label: 'note' },
};

export const FIT_COLOR: Record<FitLevel, string> = {
  recommended: COLORS.ok,
  'should-fit': COLORS.accent,
  tight: COLORS.warn,
  'no-fit': COLORS.bad,
  'wrong-platform': COLORS.muted,
  unknown: COLORS.muted,
};
