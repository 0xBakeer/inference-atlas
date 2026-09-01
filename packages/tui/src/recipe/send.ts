/**
 * Getting a recipe out of the terminal: write it to the recipes directory, copy it to the
 * clipboard, or hand it to a configured agent command. Clipboard goes through OSC 52 first —
 * it works over ssh — with the platform tool as fallback.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

export function copyToClipboard(text: string, out: NodeJS.WriteStream = process.stdout): boolean {
  // OSC 52 costs nothing and works over ssh/tmux for terminals that allow it.
  try {
    out.write(osc52(text));
  } catch {
    /* a closed stream is fine — the platform tool below still runs */
  }
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
        ];
  for (const [cmd, args] of tools) {
    const res = spawnSync(cmd, args, { input: text, timeout: 3000 });
    if (res.status === 0) return true;
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
