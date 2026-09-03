/**
 * Getting a recipe out of the terminal: write it to the recipes directory, copy it to the
 * clipboard, or hand it to a configured agent command. Clipboard goes through OSC 52 first —
 * it works over ssh — with the platform tool as fallback.
 *
 * "The platform" is not one thing. WSL reports itself as linux and has neither a display
 * server nor, usually, `xdg-open`: the Linux path fails there with a bare ENOENT, so both
 * the browser and the clipboard need the Windows-side tools tried as well. Each helper
 * therefore walks a list of candidates rather than trusting one command, and reports which
 * ones it tried when none of them worked — a silent failure here reads to the user as the
 * key doing nothing at all.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentTarget } from '../config.js';

export function writeRecipe(dir: string, fileName: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, content);
  return file;
}

/** OSC 52 sequence that asks the terminal to set its clipboard. */
export function osc52(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `\u001b]52;c;${b64}\u0007`;
}

/**
 * Are we inside WSL? `process.platform` says linux, but the browser and the clipboard live
 * on the Windows side. WSL2 puts "microsoft" in the kernel release; WSL1 and every distro
 * launched by the standard interop set `WSL_DISTRO_NAME`.
 */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env['WSL_DISTRO_NAME'] || process.env['WSL_INTEROP']) return true;
  try {
    return /microsoft/i.test(os.release());
  } catch {
    return false;
  }
}

/** A command to try, with its arguments already built for this URL/text. */
export type Candidate = [cmd: string, args: string[]];

/** PowerShell single-quoted string: the only escape inside one is a doubled quote. */
const psQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/**
 * The browser openers to try, most likely to work first. Exported for testing, because
 * the interesting part of `openUrl` is exactly this ordering.
 */
export function urlOpeners(
  url: string,
  platform: NodeJS.Platform = process.platform,
  wsl: boolean = isWsl(),
): Candidate[] {
  if (platform === 'darwin') return [['open', [url]]];
  if (platform === 'win32') return [['cmd', ['/c', 'start', '', url]]];

  const candidates: Candidate[] = [];
  if (wsl) {
    // wslu's opener when it is installed, then Windows itself. `Start-Process` takes the
    // URL as one quoted argument, so the `&` between issue-form fields survives — which
    // `cmd /c start` would swallow.
    candidates.push(['wslview', [url]]);
    candidates.push([
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process ${psQuote(url)}`],
    ]);
  }
  const browser = process.env['BROWSER'];
  if (browser) candidates.push([browser, [url]]);
  candidates.push(['xdg-open', [url]]);
  candidates.push(['gio', ['open', url]]);
  candidates.push(['sensible-browser', [url]]);
  candidates.push(['x-www-browser', [url]]);
  return candidates;
}

/**
 * Hand a URL to the desktop browser. Never called without the user having confirmed what
 * the URL contains — opening a page is an outward-facing act.
 *
 * Returns the command that worked so the UI can say so, and the list of failures when
 * nothing did, so "nothing happened" is never the whole story.
 */
export function openUrl(url: string): { ok: boolean; via?: string; error?: string } {
  const tried: string[] = [];
  for (const [cmd, args] of urlOpeners(url)) {
    const res = spawnSync(cmd, args, { timeout: 5000, stdio: 'ignore' });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      // Not installed is the normal case for most of this list; keep walking quietly.
      tried.push(code === 'ENOENT' ? `${cmd} (not installed)` : `${cmd} (${res.error.message})`);
      continue;
    }
    if (res.status === 0) return { ok: true, via: cmd };
    tried.push(`${cmd} exited ${res.status ?? '?'}`);
  }
  return { ok: false, error: `tried ${tried.join(', ')}` };
}

/** The clipboard tools to try, in order. Exported for the same reason as `urlOpeners`. */
export function clipboardTools(
  platform: NodeJS.Platform = process.platform,
  wsl: boolean = isWsl(),
): Candidate[] {
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [['clip', []]];
  const candidates: Candidate[] = [];
  // On WSL the Windows clipboard is the one the user pastes from, and clip.exe is always
  // there — no X server, no Wayland socket, no package to install.
  if (wsl) {
    candidates.push(['clip.exe', []]);
    candidates.push([
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'],
    ]);
  }
  candidates.push(['wl-copy', []]);
  candidates.push(['xclip', ['-selection', 'clipboard']]);
  candidates.push(['xsel', ['--input', '--clipboard']]);
  return candidates;
}

export function copyToClipboard(text: string, out: NodeJS.WriteStream = process.stdout): boolean {
  // OSC 52 costs nothing and works over ssh/tmux for terminals that allow it.
  try {
    out.write(osc52(text));
  } catch {
    /* a closed stream is fine — the platform tool below still runs */
  }
  for (const [cmd, args] of clipboardTools()) {
    const res = spawnSync(cmd, args, { input: text, timeout: 3000 });
    if (!res.error && res.status === 0) return true;
  }
  return false;
}

export function agentCommand(target: AgentTarget, recipeFile: string): string {
  // Single quotes around the path would break `$(cat {recipe})`; the path is ours (slug + dir).
  return target.command.replaceAll('{recipe}', recipeFile);
}

export interface RunResult {
  ok: boolean;
  output: string;
}

/** Run an agent target's command through the shell, capturing output for the UI. */
export function runAgentCommand(command: string, onDone: (result: RunResult) => void): void {
  const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const grab = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > 20000) output = output.slice(-20000);
  };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  child.on('close', (code) => onDone({ ok: code === 0, output }));
  child.on('error', (err) => onDone({ ok: false, output: String(err) }));
}
