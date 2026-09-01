/**
 * Session state that outlives a run but is not configuration: which box the user last
 * targeted. It lives in the cache directory rather than the config file, so the config
 * stays a hand-written document the TUI never rewrites (and never strips comments from).
 */

import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './paths.js';

export interface TuiState {
  /** Target id: `local`, `ssh:<destination>` or `hw:<hardware-id>`. */
  targetId?: string;
}

function stateFile(env: Record<string, string | undefined> = process.env): string {
  return path.join(cacheDir(env), 'state.json');
}

export function loadState(env: Record<string, string | undefined> = process.env): TuiState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile(env), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as TuiState) : {};
  } catch {
    return {};
  }
}

/** Best-effort: a read-only cache directory must never break the session. */
export function saveState(
  state: TuiState,
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    const file = stateFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* ignore */
  }
}
