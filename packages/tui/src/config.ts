/**
 * `~/.config/inference-atlas/config.toml`. Written with commented defaults on first run so
 * the file documents itself; every field has a working default, so an empty or absent file
 * is a valid configuration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { configFile, expandHome } from './data/paths.js';

export interface BoxConfig {
  /** ssh destination — an alias from ~/.ssh/config, or user@host. */
  ssh: string | null;
  /** Skip the probe and use this hardware registry id outright. */
  hardware: string | null;
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
  /** Named boxes the target picker offers besides the local machine. */
  boxes: Record<string, BoxConfig>;
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
  boxes: {},
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

# Boxes the target picker offers besides this machine, so you can judge runs against
# the machine you actually deploy to. Press 'b' in the TUI to switch; 's' probes an ssh
# destination on the fly. ssh is anything ssh understands (a ~/.ssh/config alias works).
# [boxes.gpu-server]
# ssh = "gpu-server"
# Skip the probe entirely and pin a hardware registry id instead:
# [boxes.rented-4090]
# hardware = "nvidia-rtx-4090"
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
  const boxes: Record<string, BoxConfig> = {};
  for (const [name, value] of Object.entries(rec(raw['boxes']))) {
    const b = rec(value);
    const ssh = str(b['ssh']);
    const hardware = str(b['hardware']);
    if (!ssh && !hardware) continue;
    boxes[name] = { ssh, hardware };
  }
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
    boxes,
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
