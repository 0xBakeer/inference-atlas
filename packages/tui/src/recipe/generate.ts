/**
 * Turn one measured run into an agent-ready Markdown recipe: everything needed to install
 * the engine, fetch the exact weights, start the server with the exact flags, and verify the
 * result against the numbers the atlas holds. Every value comes from the registries or the
 * run itself — nothing is invented, and estimates are labelled as estimates.
 */

import type {
  EngineInstall,
  EngineVersion,
  Hardware,
  IndexRow,
  Quant,
  RegistryEngine,
  RegistryModel,
  ResultRecord,
  SiteConfig,
  Workload,
} from '@atlas/core';
import { AGENT_RULES, fmtGB, fmtMs, fmtPct, fmtTokS, fmtW, renderServeCommand } from '@atlas/core';
import type { FitVerdict } from '../hw/fit.js';

export interface RecipeInput {
  row: IndexRow;
  record: ResultRecord;
  engine: RegistryEngine;
  model: RegistryModel | null;
  quant: Quant | null;
  measuredOn: Hardware | null;
  workload: Workload | null;
  /** Param table of the engine version, for per-flag help. Null when not registered. */
  engineVersion: EngineVersion | null;
  fit: FitVerdict | null;
  /** Human name of the box the recipe targets ("this box" fit was computed for). */
  targetLabel: string | null;
  site: SiteConfig;
}

const fence = (lang: string, body: string): string => `\`\`\`${lang}\n${body}\n\`\`\``;

function installBlock(installs: EngineInstall[], version: string): string[] {
  if (installs.length === 0) return ['_No install method registered — see the engine repo._'];
  const out: string[] = [];
  for (const inst of installs) {
    const sub = (s: string | null | undefined) => (s ?? '').replace('{version}', version);
    let cmd: string;
    switch (inst.method) {
      case 'docker':
        cmd = `docker pull ${sub(inst.image) || '<image>'}`;
        break;
      case 'pip':
        cmd = `uv pip install '${sub(inst.package) || '<package>'}'`;
        break;
      case 'uv':
        cmd = `uv tool install '${sub(inst.package) || '<package>'}'`;
        break;
      case 'brew':
        cmd = `brew install ${inst.package ?? '<package>'}`;
        break;
      case 'npm':
        cmd = `npm install -g ${sub(inst.package) || '<package>'}`;
        break;
      default:
        cmd = sub(inst.command) || `# ${inst.method} install — see the engine docs`;
    }
    const arch = inst.arch?.length ? ` (arch: ${inst.arch.join(', ')})` : '';
    out.push(`- **${inst.method}**${arch}: \`${cmd}\``);
    if (inst.notes) out.push(`  - ${inst.notes}`);
  }
  return out;
}

function paramsTable(record: ResultRecord, version: EngineVersion | null): string[] {
  const args = record.args ?? {};
  const names = Object.keys(args).sort();
  if (names.length === 0) return ['_Engine defaults — no flags set._'];
  const byName = new Map((version?.params ?? []).map((p) => [p.name, p]));
  const out = [
    '| flag | value | default | impact | what it does |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const name of names) {
    const p = byName.get(name);
    const value = JSON.stringify(args[name]);
    const def = p ? JSON.stringify(p.default ?? null) : '?';
    const help = p?.help ?? '_not in the registered param table_';
    out.push(`| \`${name}\` | \`${value}\` | \`${def}\` | ${p?.impact ?? '?'} | ${help} |`);
  }
  return out;
}

function expectedNumbers(record: ResultRecord): string[] {
  const m = record.metrics;
  if (!m) return ['_The run carries no metrics block._'];
  const rows: Array<[string, string]> = [];
  const push = (label: string, v: string) => {
    if (!v.includes('–')) rows.push([label, v]);
  };
  push('output tok/s', fmtTokS(m.output_tok_s));
  push('decode tok/s per request', fmtTokS(m.decode_tok_s_per_request?.mean));
  push('prefill tok/s', fmtTokS(m.prefill_tok_s));
  push('TTFT p50 / p95 (ms)', `${fmtMs(m.ttft_ms?.p50)} / ${fmtMs(m.ttft_ms?.p95)}`);
  push('TPOT p50 (ms)', fmtMs(m.tpot_ms?.p50));
  push('success rate', fmtPct(m.success_rate));
  push('accuracy', fmtPct((m as { accuracy?: number | null }).accuracy ?? null));
  push('peak RAM (GB)', fmtGB(m.ram_peak_gb));
  push('peak VRAM (GB)', fmtGB(m.vram_peak_gb));
  push('avg power (W)', fmtW(m.power_avg_w));
  if (rows.length === 0) return ['_The run carries no metrics block._'];
  return ['| metric | measured |', '| --- | --- |', ...rows.map(([l, v]) => `| ${l} | ${v} |`)];
}

export function generateRecipe(input: RecipeInput): string {
  const { row, record, engine, quant, workload } = input;
  const meta = engine.meta;
  const version = row.engine.version;
  const modelRef =
    meta.serve.model_ref === 'hf_id'
      ? (quant?.hf_id ?? record.model.hf_id ?? row.model.id)
      : meta.serve.model_ref === 'ollama_tag'
        ? (quant?.ollama_tag ?? row.model.id)
        : (quant?.hf_id ?? row.model.id);
  const serveCmd = renderServeCommand(meta, modelRef, record.args ?? {}, meta.default_port);
  const siteUrl = (input.site.site.url ?? '').replace(/\/+$/, '');
  const runUrl = siteUrl ? `${siteUrl}/#/run/${row.run_id}` : null;

  const lines: string[] = [];
  lines.push(`# Recipe: ${row.model.id} · ${row.model.quant_id} · ${meta.id}@${version}`);
  lines.push('');
  lines.push(
    `Measured configuration from the Inference Atlas — run \`${row.run_id}\`` +
      (runUrl ? ` ([open](${runUrl}))` : '') +
      `, workload \`${row.workload_id}\`, measured on **${input.measuredOn?.name ?? row.hardware.id}** by @${row.provenance.login ?? 'unknown'} (${row.verification_level}).`,
  );
  lines.push('');

  if (input.fit) {
    lines.push(`## Fit: ${input.fit.label}${input.targetLabel ? ` on ${input.targetLabel}` : ''}`);
    lines.push('');
    for (const r of input.fit.reasons) lines.push(`- ${r}`);
    if (input.fit.memoryBasis === 'estimated')
      lines.push('- _Memory judgement is an estimate, not a measurement on this box._');
    lines.push('');
  }

  lines.push('## Model & weights');
  lines.push('');
  lines.push(`- Model: \`${row.model.id}\` (${input.model?.model.params_b ?? '?'}B params)`);
  if (quant) {
    lines.push(
      `- Quantization: \`${quant.id}\` — ${quant.format}, ${quant.bits} bits` +
        (quant.size_gb ? `, ${quant.size_gb} GB on disk` : ''),
    );
    if (quant.hf_id) {
      lines.push(
        `- Weights: [\`${quant.hf_id}\`](https://huggingface.co/${quant.hf_id})` +
          (quant.revision ? ` — **pin revision \`${quant.revision}\`**` : ''),
      );
    }
    if (quant.ollama_tag) lines.push(`- Ollama tag: \`${quant.ollama_tag}\``);
    if (quant.links?.recipe) lines.push(`- Quantization recipe: ${quant.links.recipe}`);
    if (quant.notes) lines.push(`- Notes: ${quant.notes}`);
  } else {
    lines.push(`- Quantization: \`${row.model.quant_id}\` (not in the registry snapshot)`);
  }
  lines.push('');

  lines.push(`## Engine: ${meta.name} ${version}`);
  lines.push('');
  lines.push(`- Repo: ${meta.repo}${meta.docs ? ` · Docs: ${meta.docs}` : ''}`);
  lines.push(`- Platforms: ${meta.platforms.join(', ')}`);
  lines.push('');
  lines.push('Install (pick one):');
  lines.push('');
  lines.push(...installBlock(meta.install, version));
  lines.push('');

  lines.push('## Serve command');
  lines.push('');
  lines.push(fence('bash', serveCmd));
  if (record.serve_command && record.serve_command !== serveCmd) {
    lines.push('');
    lines.push('As recorded by the harness on the measured box:');
    lines.push('');
    lines.push(fence('bash', record.serve_command));
  }
  if (meta.serve.notes) {
    lines.push('');
    lines.push(`> ${meta.serve.notes}`);
  }
  const health = meta.health?.path;
  if (health) {
    lines.push('');
    lines.push(
      `Health: \`GET http://127.0.0.1:${meta.default_port ?? 8000}${health}\` until 200` +
        (meta.health?.ready_timeout_s ? ` (allow up to ${meta.health.ready_timeout_s}s)` : '') +
        '.',
    );
  }
  lines.push('');

  lines.push('## Parameters');
  lines.push('');
  lines.push(...paramsTable(record, input.engineVersion));
  lines.push('');

  const gotchas = record.gotchas ?? [];
  if (gotchas.length > 0) {
    lines.push('## Gotchas from the measured run');
    lines.push('');
    for (const g of gotchas) lines.push(`- **${g.severity}**: ${g.text}`);
    lines.push('');
  }

  lines.push(`## Expected numbers (measured on ${row.hardware.id})`);
  lines.push('');
  lines.push(...expectedNumbers(record));
  if (input.fit?.decodeCeiling) {
    lines.push('');
    lines.push(
      `On the target box the bandwidth-bound decode ceiling is ≈ ${Math.round(input.fit.decodeCeiling)} tok/s — expect less, never more.`,
    );
  }
  lines.push('');

  lines.push('## Verify & contribute back');
  lines.push('');
  lines.push('Reproduce the measurement with the atlas harness and compare:');
  lines.push('');
  const args = Object.entries(record.args ?? {})
    .map(
      ([k, v]) =>
        ` \\\n  --arg ${k}=${typeof v === 'object' ? `'${JSON.stringify(v)}'` : String(v)}`,
    )
    .join('');
  const cell = `${meta.id}@${version}/${row.model.id}/${row.model.quant_id}/<your-hardware-id>`;
  lines.push(
    fence(
      'bash',
      [
        `git clone ${input.site.repo.host ?? 'https://github.com'}/${input.site.repo.owner}/${input.site.repo.name}.git && cd ${input.site.repo.name}/bench`,
        'uv sync && uv run atlas-bench hwinfo   # identify this box — never type specs',
        `uv run atlas-bench packet --cell '${cell}' \\\n  --workload ${row.workload_id}${args} \\\n  --out task.json`,
        'uv run atlas-bench run --spec task.json --base-url http://127.0.0.1:8000/v1 --out ../results',
      ].join('\n'),
    ),
  );
  lines.push('');
  if (workload?.description) lines.push(`Workload \`${workload.id}\`: ${workload.description}`);
  lines.push('');

  lines.push('## Rules for the agent doing this');
  lines.push('');
  for (const rule of AGENT_RULES) lines.push(`- ${rule}`);
  lines.push('');
  lines.push(
    `---\nGenerated by the Inference Atlas TUI from data commit \`${row.provenance.commit?.slice(0, 7) ?? 'unknown'}\`. The atlas: ${siteUrl || 'https://0xbakeer.github.io/inference-atlas/'}`,
  );
  lines.push('');
  return lines.join('\n');
}

/** File name for a recipe: `qwen3-8b--fp8--vllm-0.27.1--serve-chat.md`-ish, fs-safe. */
export function recipeFileName(row: IndexRow): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return `${slug(row.model.id)}--${slug(row.model.quant_id)}--${slug(row.engine.id)}-${slug(row.engine.version)}--${slug(row.workload_id)}.md`;
}
