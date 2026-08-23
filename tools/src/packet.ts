#!/usr/bin/env tsx
/**
 * `pnpm packet` — print the brief for one gap (SPEC §7).
 *
 *   pnpm packet -- --engine vllm --version 0.27.1 --model qwen3-8b --quant fp8 \
 *                  --hardware nvidia-rtx-4090 --workloads serve-chat-c8-i1k-o256-v1,eval-math-v1 \
 *                  --args gpu-memory-utilization=0.9 --args max-model-len=32768
 *   pnpm packet -- --new-hardware "RTX 5080" --format md
 *   pnpm packet -- --new-model Qwen/Qwen3-4B
 *   pnpm packet -- --new-engine ktransformers --format shell
 *
 * The generator itself lives in `@atlas/core` and is shared with the app, so the brief a
 * contributor copies out of the website is byte-for-byte the one this prints. All this file
 * does is read the registry off disk and pick a rendering.
 */
import { realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPacket } from '@atlas/core';
import type { Args, Packet, PacketKind, PacketRegistry, PacketSpec } from '@atlas/core';
import { parseArgv } from './lib/args.js';
import { loadRepo } from './lib/repo.js';
import type { Repo } from './lib/repo.js';
import { Reporter } from './lib/report.js';
import { REPO_ROOT } from './lib/root.js';

export type PacketFormat = 'md' | 'json' | 'shell' | 'issue';

/** The registry shape `buildPacket` wants, from the on-disk one. */
export function packetRegistry(repo: Repo): PacketRegistry {
  return {
    hardware: [...repo.hardware.values()],
    engines: [...repo.engines.values()].map((entry) => ({
      meta: entry.meta,
      versions: [...entry.versions.values()],
    })),
    models: [...repo.models.values()].map((entry) => ({
      model: entry.model,
      quants: [...entry.quants.values()],
    })),
    workloads: [...repo.workloads.values()],
  };
}

export interface PacketCliOptions {
  root: string;
  spec: PacketSpec;
  format: PacketFormat;
}

export function renderPacket(options: PacketCliOptions): { packet: Packet; text: string } {
  const repo = loadRepo(options.root, new Reporter());
  if (!repo.site) throw new Error('site/config.json is missing; a packet needs the repo config');
  const packet = buildPacket(options.spec, packetRegistry(repo), repo.site);
  const text =
    options.format === 'json'
      ? `${JSON.stringify(packet.json, null, 2)}\n`
      : options.format === 'shell'
        ? `${packet.shell}\n`
        : options.format === 'issue'
          ? `${packet.issueUrl}\n`
          : `${packet.markdown}\n`;
  return { packet, text };
}

/* ----------------------------------------------------------------------- CLI */

function specFromArgs(argv: string[]): {
  spec: PacketSpec;
  format: PacketFormat;
  out: string | null;
} {
  const args = parseArgv(argv, { variadic: [], boolean: ['new-hardware', 'new-engine'] });

  // `--new-*` may carry the name of the thing being added, or stand alone.
  let kind: PacketKind = 'cell';
  let target: string | null = null;
  if (args.has('new-hardware')) {
    kind = 'new-hardware';
    target = args.str('new-hardware');
  }
  if (args.has('new-model')) {
    kind = 'new-model';
    target = args.str('new-model');
  }
  if (args.has('new-engine')) {
    kind = 'new-engine';
    target = args.str('new-engine');
  }

  const spec: PacketSpec = {
    kind,
    engine_id: args.str('engine'),
    engine_version: args.str('version'),
    model_id: args.str('model'),
    quant_id: args.str('quant'),
    hardware_id: args.str('hardware'),
    hw_count: args.num('hw-count', 1),
    args: args.pairs('args') as Args,
    dtype: args.str('dtype'),
    workload_ids: args.list('workloads'),
    note: args.str('note'),
    target_name: target,
  };

  const format = (args.str('format', 'md') as PacketFormat) ?? 'md';
  return { spec, format, out: args.str('out') };
}

function main(argv: string[]): number {
  const { spec, format, out } = specFromArgs(argv);
  const root = resolve(parseArgv(argv).str('root', REPO_ROOT));
  if (!['md', 'json', 'shell', 'issue'].includes(format)) {
    process.stderr.write(`unknown --format "${format}"; use md, json, shell or issue\n`);
    return 2;
  }

  const { text } = renderPacket({ root, spec, format });
  if (out) {
    writeFileSync(resolve(root, out), text, 'utf8');
    process.stderr.write(`written ${out}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
