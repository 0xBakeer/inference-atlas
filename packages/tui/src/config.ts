/**
 * `~/.config/inference-atlas/config.toml`. Written with commented defaults on first run so
 * the file documents itself; every field has a working default, so an empty or absent file
 * is a valid configuration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { configFile, expandHome } from './data/paths.js';

export interface TargetConfig {
  /** Hardware registry id the user selected, or null to use whatever is detected. */
  hardware: string | null;
  /** How many of them. */
  count: number;
}

export interface AgentTarget {
  /** Shell command; `{recipe}` is replaced with the recipe file path. */
  command: string;
  /** 'run' executes it from the TUI; 'copy' only copies the command to the clipboard. */
  mode: 'run' | 'copy';
}

export interface TuiConfig {
  data: {
    /** Base URL of the deployed site (the shards live under `<url>/data/`). */
    url: string;
    /** Local checkout; when set the network is never touched. */
    repo: string | null;
    /** Background re-check interval. 0 disables background refresh. */
    refreshMinutes: number;
  };
  ui: {
    color: 'auto' | 'truecolor' | '256' | 'mono';
  };
  recipes: {
    /** Where generated recipe files land. */
    dir: string;
  };
  agents: Record<string, AgentTarget>;
  /** The box every verdict is judged against. Written back when the user picks one. */
  target: TargetConfig;
}

export const DEFAULT_CONFIG: TuiConfig = {
  data: {
    url: 'https://0xbakeer.github.io/inference-atlas',
    repo: null,
    refreshMinutes: 15,
  },
  ui: { color: 'auto' },
  recipes: { dir: '~/inference-atlas/recipes' },
  agents: {
    claude: { command: 'claude "$(cat {recipe})"', mode: 'copy' },
    opencode: { command: 'opencode run "$(cat {recipe})"', mode: 'copy' },
  },
  target: { hardware: null, count: 1 },
};

const TEMPLATE = `# inference-atlas TUI configuration. Every key is optional; these are the defaults.

[data]
# Where the compiled data shards are fetched from (the deployed site).
url = "https://0xbakeer.github.io/inference-atlas"
# Point at a local checkout instead — then nothing is fetched:
# repo = "~/Projects/inference-atlas"
# Background data refresh, in minutes. 0 turns it off.
refresh_minutes = 15

[ui]
# auto | truecolor | 256 | mono
color = "auto"

[recipes]
# Generated recipe files land here.
dir = "~/inference-atlas/recipes"

# Agent targets for "send recipe". {recipe} becomes the recipe file path.
# mode = "copy" copies the command to the clipboard; "run" executes it from the TUI.
[agents.claude]
command = 'claude "$(cat {recipe})"'
mode = "copy"

[agents.opencode]
command = 'opencode run "$(cat {recipe})"'
mode = "copy"

# The box every verdict is judged against. The TUI detects this machine at startup and
# asks you to pick when it cannot recognise it; press 'b' to change it at any time and
# this section is rewritten for you. count is how many of that device you have.
# [target]
# hardware = "nvidia-rtx-6000-ada"
# count = 3
`;

type Toml = Record<string, unknown>;
const rec = (v: unknown): Toml => (typeof v === 'object' && v !== null ? (v as Toml) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseConfig(toml: string): TuiConfig {
  let raw: Toml = {};
  try {
    raw = rec(parse(toml));
  } catch {
    // A broken config never blocks the TUI; defaults win and the UI reports it elsewhere.
  }
  const data = rec(raw['data']);
  const ui = rec(raw['ui']);
  const recipes = rec(raw['recipes']);
  const agents: Record<string, AgentTarget> = { ...DEFAULT_CONFIG.agents };
  for (const [name, value] of Object.entries(rec(raw['agents']))) {
    const t = rec(value);
    const command = str(t['command']);
    if (!command) continue;
    agents[name] = { command, mode: t['mode'] === 'run' ? 'run' : 'copy' };
  }
  const targetRaw = rec(raw['target']);
  const count = num(targetRaw['count']);
  const color = str(ui['color']);
  return {
    data: {
      url: str(data['url']) ?? DEFAULT_CONFIG.data.url,
      repo: str(data['repo']),
      refreshMinutes: num(data['refresh_minutes']) ?? DEFAULT_CONFIG.data.refreshMinutes,
    },
    ui: {
      color: color === 'truecolor' || color === '256' || color === 'mono' ? color : 'auto',
    },
    recipes: { dir: str(rec(recipes)['dir']) ?? DEFAULT_CONFIG.recipes.dir },
    agents,
    target: {
      hardware: str(targetRaw['hardware']),
      count: count && count >= 1 ? Math.round(count) : 1,
    },
  };
}

/** Load the config, writing the commented template on first run. */
export function loadConfig(env: Record<string, string | undefined> = process.env): TuiConfig {
  const file = configFile(env);
  try {
    return parseConfig(fs.readFileSync(file, 'utf8'));
  } catch {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, TEMPLATE, { flag: 'wx' });
    } catch {
      // Read-only home is fine — run on defaults.
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function recipesDir(config: TuiConfig): string {
  return expandHome(config.recipes.dir);
}

/**
 * Persist the target selection into the config file **surgically**: the `[target]` section
 * is replaced or appended, and every other byte — including the user's comments — is left
 * exactly as it was. Re-serialising the whole document would silently eat them.
 */
export function renderTargetSection(hardware: string, count: number): string {
  return ['[target]', `hardware = "${hardware}"`, `count = ${Math.max(1, Math.round(count))}`].join(
    '\n',
  );
}

/** Pure text transform, so the rewrite is testable without touching a real file. */
export function withTargetSection(toml: string, hardware: string, count: number): string {
  const section = renderTargetSection(hardware, count);
  // A top-level table runs until the next line that starts a table.
  const pattern = /^[ \t]*\[target\][^\n]*\n(?:(?![ \t]*\[)[^\n]*\n?)*/m;
  if (pattern.test(toml)) return toml.replace(pattern, `${section}\n`);
  const base = toml.length === 0 || toml.endsWith('\n') ? toml : `${toml}\n`;
  return `${base}${base.endsWith('\n\n') || base === '' ? '' : '\n'}${section}\n`;
}

/** Write the selection back. Best-effort: a read-only config must not break the session. */
export function saveTarget(
  hardware: string,
  count: number,
  env: Record<string, string | undefined> = process.env,
): { ok: true; file: string } | { ok: false; error: string } {
  const file = configFile(env);
  try {
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      /* first write */
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, withTargetSection(existing, hardware, count));
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
