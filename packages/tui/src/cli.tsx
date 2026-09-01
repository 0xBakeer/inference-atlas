#!/usr/bin/env node
/**
 * inference-atlas — the Inference Atlas in your terminal.
 *
 *   inference-atlas                # fetch the published data, browse, generate recipes
 *   inference-atlas --repo ~/src/inference-atlas   # read a local checkout instead
 *   inference-atlas --sync         # refresh the data cache and exit (for scripts/cron)
 *
 * Config: ~/.config/inference-atlas/config.toml (written with defaults on first run).
 * Cache:  ~/.cache/inference-atlas/
 */

import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { loadConfig } from './config.js';
import { detectColorLevel } from './canvas/color.js';
import { loadAtlas } from './data/load.js';
import { cacheDir, expandHome } from './data/paths.js';
import { LocalSource, RemoteSource } from './data/source.js';
import { loadState, saveState } from './data/state.js';
import { localTarget, registryTarget, remoteTarget } from './hw/target.js';
import { App } from './ui/App.js';

interface CliArgs {
  repo: string | null;
  url: string | null;
  box: string | null;
  sync: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repo: null, url: null, box: null, sync: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--repo') args.repo = argv[++i] ?? null;
    else if (a.startsWith('--repo=')) args.repo = a.slice('--repo='.length);
    else if (a === '--url') args.url = argv[++i] ?? null;
    else if (a.startsWith('--url=')) args.url = a.slice('--url='.length);
    else if (a === '--box') args.box = argv[++i] ?? null;
    else if (a.startsWith('--box=')) args.box = a.slice('--box='.length);
    else if (a === '--sync') args.sync = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `inference-atlas — browse the Inference Atlas, check fit against this box,
and generate agent-ready install recipes. Charts included.

  --repo <path>   read a local checkout (no network at all)
  --url <url>     override the data URL (default: the deployed site)
  --box <box>     target another machine: an ssh destination, a hardware
                  registry id, or a box named in the config ('local' resets
                  to this machine; also switchable in the TUI with 'b')
  --sync          refresh the data cache and exit
  -h, --help      this

Config: ~/.config/inference-atlas/config.toml · Cache: ~/.cache/inference-atlas/`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const config = loadConfig();
  if (args.url) config.data.url = args.url;
  const repo = args.repo ?? config.data.repo;
  const source = repo
    ? new LocalSource(path.resolve(expandHome(repo)))
    : new RemoteSource(config.data.url, path.join(cacheDir(), 'data'));

  if (args.sync) {
    const res = await source.sync();
    console.log(`${res.status}${res.fetched.length ? `: ${res.fetched.join(', ')}` : ''}`);
    if (res.error) console.error(res.error);
    process.exitCode = res.status === 'offline' && !res.manifest ? 1 : 0;
    return;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('inference-atlas is a TUI — run it in a terminal (or use --sync in scripts).');
    process.exitCode = 1;
    return;
  }

  const data = await loadAtlas(source);
  if (data.index.length === 0) {
    console.error(
      data.sync.error ??
        'No data: the first sync needs the network once (afterwards the cache carries you).',
    );
    process.exitCode = 1;
    return;
  }

  // The local box is always resolved: it is what the picker offers as "this machine",
  // and the fallback whenever a requested target cannot be reached.
  const local = localTarget(data.registry.hardware);
  let target = local;

  // --box wins over the remembered selection; a named box from the config resolves first.
  const requested = args.box ?? loadState().targetId ?? null;
  if (requested && requested !== 'local') {
    const named = config.boxes[requested];
    const spec = named?.ssh ?? (requested.startsWith('ssh:') ? requested.slice(4) : null);
    const hardwareId =
      named?.hardware ??
      (requested.startsWith('hw:')
        ? requested.slice(3)
        : data.registry.hardware.some((h) => h.id === requested)
          ? requested
          : null);
    if (spec) {
      const result = remoteTarget(spec, data.registry.hardware);
      if ('error' in result) console.error(`${result.error} — falling back to this machine`);
      else target = result.target;
    } else if (hardwareId) {
      const hw = data.registry.hardware.find((h) => h.id === hardwareId);
      if (hw) target = registryTarget(hw);
      else console.error(`unknown hardware id '${hardwareId}' — falling back to this machine`);
    } else if (args.box) {
      // A bare --box that is neither configured nor a hardware id is treated as an ssh host.
      const result = remoteTarget(args.box, data.registry.hardware);
      if ('error' in result) console.error(`${result.error} — falling back to this machine`);
      else target = result.target;
    }
  }
  if (args.box) saveState({ targetId: target.id });

  const level = config.ui.color === 'auto' ? detectColorLevel() : config.ui.color;

  render(
    <App source={source} config={config} initialData={data} initialTarget={target} level={level} />,
  );
}

void main();
