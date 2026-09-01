/**
 * "My box is not in the registry." — turning that dead end into a registry request.
 *
 * The atlas grows by adding `hardware/<id>.json`, and the hard part for a newcomer is
 * knowing what to put in it. The TUI already probed the machine, so it can propose an id,
 * a kind and the detection strings, and hand the rest to the repository's own issue form
 * with those fields filled in.
 *
 * Two rules shape everything here. **Nothing is invented**: memory bandwidth is not
 * knowable from a probe, so the request says it is missing instead of guessing at a figure
 * the plausibility checks would then trust. And **nothing leaves the machine unseen**: the
 * caller shows the user this exact text and waits for a yes before opening anything.
 */

import type { SiteConfig } from '@atlas/core';
import type { CapturedHardware } from './capture.js';

export interface HardwareRequest {
  /** Proposed registry id, e.g. `nvidia-rtx-5090` or `apple-m4-max-128gb`. */
  id: string;
  name: string;
  kind: 'gpu' | 'soc' | 'cpu';
  /** The `memory` field: what was probed, and an explicit note about what was not. */
  memory: string;
  /** The `detect` field: what the machine actually printed. */
  detect: string;
  /** The `specs` field: everything the probe cannot answer, spelled out as open questions. */
  specs: string;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|®|™/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `NVIDIA GeForce RTX 5090` → `nvidia-rtx-5090`: drop the words the ids never carry. */
function gpuId(name: string): string {
  const cleaned = name.replace(/\b(GeForce|Radeon|Instinct)\b/gi, ' ');
  return slug(cleaned);
}

/** Apple ids carry the memory size, because unified memory is the binding constraint. */
function appleId(chip: string, memoryGb: number): string {
  return `${slug(chip)}-${Math.round(memoryGb)}gb`;
}

export function proposeHardware(captured: CapturedHardware): HardwareRequest {
  const gpu = captured.nvidiaGpus[0];
  const count = captured.nvidiaGpus.length;

  if (gpu) {
    return {
      id: gpuId(gpu),
      name: gpu,
      kind: 'gpu',
      memory:
        (captured.vramGb ? `${captured.vramGb} GB VRAM per device` : 'VRAM not reported') +
        ', memory bandwidth UNKNOWN — I have not filled this in rather than guess',
      detect: detectBlock(captured),
      specs: specsBlock(captured, count),
    };
  }

  if (captured.appleChip) {
    return {
      id: appleId(captured.appleChip, captured.memoryGb),
      name: `${captured.appleChip} (${Math.round(captured.memoryGb)} GB)`,
      kind: 'soc',
      memory: `${Math.round(captured.memoryGb)} GB unified, memory bandwidth UNKNOWN — I have not filled this in rather than guess`,
      detect: detectBlock(captured),
      specs: specsBlock(captured, 1),
    };
  }

  return {
    id: slug(captured.cpu) || 'unknown-device',
    name: captured.cpu || 'unidentified device',
    kind: 'cpu',
    memory: `${Math.round(captured.memoryGb)} GB system memory, bandwidth UNKNOWN — I have not filled this in rather than guess`,
    detect: detectBlock(captured),
    specs: specsBlock(captured, 1),
  };
}

function detectBlock(c: CapturedHardware): string {
  const lines = [`uname:  ${c.platform} ${c.arch}`, `cpu:    ${c.cpu || '(not reported)'}`];
  if (c.appleChip) lines.push(`apple:  ${c.appleChip}`);
  if (c.nvidiaGpus.length > 0) {
    lines.push(`nvidia-smi --query-gpu=name:`);
    for (const g of c.nvidiaGpus) lines.push(`        ${g}`);
  }
  lines.push(`memory: ${c.memoryGb} GB visible to the OS`);
  if (c.vramGb) lines.push(`vram:   ${c.vramGb} GB per device`);
  return lines.join('\n');
}

function specsBlock(c: CapturedHardware, count: number): string {
  return [
    'Captured by the Inference Atlas TUI on my own machine — everything above is probe',
    'output, not typed from a spec sheet.',
    '',
    'What I could not determine from the machine, and have deliberately left blank rather',
    'than guess (the plausibility checks depend on these):',
    '',
    '- memory_bandwidth_gbs:',
    '- compute (dense fp16/bf16/fp8 TFLOPs, and which figure was used):',
    '- tdp_w:',
    '- release_year / msrp_usd:',
    '- links.vendor:',
    '',
    count > 1 ? `This host has ${count} of these devices.` : '',
    '',
    'I can follow up with the full harness capture (`uv run atlas-bench hwinfo --json`)',
    'if that is useful.',
  ]
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .join('\n');
}

/**
 * The pre-filled issue URL. GitHub issue forms take one query parameter per field id, so
 * this lines up with `.github/ISSUE_TEMPLATE/new-hardware.yml` (`id`, `name`, `kind`,
 * `memory`, `detect`, `specs`).
 */
export function hardwareIssueUrl(request: HardwareRequest, site: SiteConfig): string {
  const host = site.repo.host ?? 'https://github.com';
  const params = new URLSearchParams({
    template: 'new-hardware.yml',
    title: `hardware: ${request.name}`,
    id: request.id,
    name: request.name,
    kind: request.kind,
    memory: request.memory,
    detect: request.detect,
    specs: request.specs,
  });
  return `${host}/${site.repo.owner}/${site.repo.name}/issues/new?${params.toString()}`;
}

/** What the confirmation dialog shows: exactly the text that would be sent. */
export function requestPreview(request: HardwareRequest): string[] {
  return [
    `id      ${request.id}`,
    `name    ${request.name}`,
    `kind    ${request.kind}`,
    `memory  ${request.memory}`,
    '',
    ...request.detect.split('\n'),
  ];
}
