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
import { chooseTarget, detectTarget } from './hw/target.js';
import { App } from './ui/App.js';

interface CliArgs {
  repo: string | null;
  url: string | null;
  hardware: string | null;
  count: number | null;
  sync: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    repo: null,
    url: null,
    hardware: null,
    count: null,
    sync: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--repo') args.repo = argv[++i] ?? null;
    else if (a.startsWith('--repo=')) args.repo = a.slice('--repo='.length);
    else if (a === '--url') args.url = argv[++i] ?? null;
    else if (a.startsWith('--url=')) args.url = a.slice('--url='.length);
    else if (a === '--hardware') args.hardware = argv[++i] ?? null;
    else if (a.startsWith('--hardware=')) args.hardware = a.slice('--hardware='.length);
    else if (a === '--count') args.count = Number(argv[++i]);
    else if (a.startsWith('--count=')) args.count = Number(a.slice('--count='.length));
    else if (a === '--sync') args.sync = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `inference-atlas — browse the Inference Atlas, check fit against this box,
and generate agent-ready install recipes. Charts included.

  --repo <path>   read a local checkout (no network at all)
  --url <url>     override the data URL (default: the deployed site)
  --hardware <id> target this hardware registry id instead of what is
                  detected (also selectable in the TUI with 'b')
  --count <n>     how many of that device you have (default 1)
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

  // Detect first — it is right often enough to be worth doing — then let the config
  // override it, because the box you deploy to is frequently not the box you browse from.
  const detected = detectTarget(data.registry.hardware);
  let target = detected;

  const wantedId = args.hardware ?? config.target.hardware;
  const wantedCount = args.count ?? config.target.count;
  if (wantedId) {
    const hw = data.registry.hardware.find((h) => h.id === wantedId);
    if (hw) target = chooseTarget(hw, wantedCount || 1, detected.captured);
    else console.error(`unknown hardware id '${wantedId}' — falling back to detection`);
  } else if (wantedCount > 1 && target.hardware) {
    target = chooseTarget(target.hardware, wantedCount, detected.captured);
  }

  const level = config.ui.color === 'auto' ? detectColorLevel() : config.ui.color;

  render(
    <App source={source} config={config} initialData={data} initialTarget={target} level={level} />,
  );
}

void main();
