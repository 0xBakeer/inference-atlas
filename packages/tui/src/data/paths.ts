/** Where the TUI keeps things. XDG on every platform — predictable beats platform-native. */

import os from 'node:os';
import path from 'node:path';

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const base = env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(base, 'inference-atlas');
}

export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  const base = env['XDG_CACHE_HOME'] || path.join(os.homedir(), '.cache');
  return path.join(base, 'inference-atlas');
}

export function configFile(env: Record<string, string | undefined> = process.env): string {
  return path.join(configDir(env), 'config.toml');
}

/** `~` expansion for paths coming out of the config file. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
