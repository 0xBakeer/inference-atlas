import { canonicalizeArgs } from './canonical.js';
import { cellId, engineMinor, resultDir } from './ids.js';
import type {
  Args,
  EngineInstall,
  EngineMeta,
  EngineServe,
  EngineVersion,
  Hardware,
  Model,
  Packet,
  PacketJson,
  PacketKind,
  Quant,
  SiteConfig,
  Workload,
} from './types.js';

/**
 * The "Add measurement" packet — SPEC §7.
 *
 * One gap in, four renderings out: a self-contained Markdown brief for a coding agent, the
 * machine-readable JSON the harness consumes, a shell script for a human who would rather
 * paste commands, and a pre-filled issue URL for somebody who has the hardware but not the
 * time. All four describe exactly the same run.
 *
 * This module is pure and shared by the app and `tools/packet`, so the brief a contributor
 * copies out of the website is byte-for-byte the one CI would have generated.
 */

export interface PacketSpec {
  kind?: PacketKind;
  engine_id?: string | null;
  engine_version?: string | null;
  model_id?: string | null;
  quant_id?: string | null;
  hardware_id?: string | null;
  hw_count?: number;
  args?: Args;
  dtype?: string | null;
  workload_ids?: string[];
  /** Free text appended to the brief — why this cell is wanted, what to watch out for. */
  note?: string | null;
  /** For the `new-*` variants: the thing being added, as the requester describes it. */
  target_name?: string | null;
}

export interface PacketEngineEntry {
  meta: EngineMeta;
  versions?: EngineVersion[];
}

export interface PacketModelEntry {
  model: Model;
  quants: Quant[];
}

export interface PacketRegistry {
  hardware: Hardware[];
  engines: PacketEngineEntry[];
  models: PacketModelEntry[];
  workloads: Workload[];
}

const PACKET_VERSION = 1;

/* --------------------------------------------------------------- command rendering */

/** Render one flag the way this engine wants it written. */
function renderFlag(name: string, value: unknown, serve: EngineServe): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') {
    if (value) return (serve.bool_style ?? '--{name}').replace('{name}', name);
    if (serve.bool_false_style) return serve.bool_false_style.replace('{name}', name);
    return null;
  }
  const rendered =
    typeof value === 'object' ? `'${JSON.stringify(value)}'` : shellQuote(String(value));
  return serve.flag_style.replace('{name}', name).replace('{value}', rendered);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@,+-]*$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderFlags(args: Args, serve: EngineServe): string {
  return Object.keys(args)
    .sort()
    .map((name) => renderFlag(name, args[name], serve))
    .filter((s): s is string => s !== null)
    .join(' ');
}

/** The exact command line that starts the engine — what goes into `result.serve_command`. */
export function renderServeCommand(
  meta: EngineMeta,
  modelRef: string,
  args: Args,
  port?: number | null,
): string {
  const flags = renderFlags(args, meta.serve);
  return meta.serve.command_template
    .replace('{model_ref}', shellQuote(modelRef))
    .replace('{flags}', flags)
    .replace('{port}', String(port ?? meta.default_port ?? 8000))
    .replace(/\s+/g, ' ')
    .trim();
}

function renderInstall(install: EngineInstall | null, version: string | null): string {
  if (!install) return '# (no install method registered for this engine — see its repo)';
  const v = version ?? 'latest';
  switch (install.method) {
    case 'docker':
      return `docker pull ${(install.image ?? '<image>').replace('{version}', v)}`;
    case 'pip':
      return `uv pip install ${(install.package ?? '<package>').replace('{version}', v)}`;
    case 'uv':
      return `uv tool install ${(install.package ?? '<package>').replace('{version}', v)}`;
    case 'brew':
      return `brew install ${install.package ?? '<package>'}`;
    default:
      return (install.command ?? `# install ${install.method}`).replace('{version}', v);
  }
}

/* ------------------------------------------------------------------------ lookups */

function findEngine(registry: PacketRegistry, id: string | null | undefined) {
  return registry.engines.find((e) => e.meta.id === id) ?? null;
}
function findModel(registry: PacketRegistry, id: string | null | undefined) {
  return registry.models.find((m) => m.model.id === id) ?? null;
}
function findWorkload(registry: PacketRegistry, id: string) {
  return registry.workloads.find((w) => w.id === id) ?? null;
}

/* -------------------------------------------------------------------- agent rules */

/**
 * SPEC §7 step 8. These are the rules that make the data set trustworthy; they are repeated
 * in the Markdown, carried in the JSON and restated in `AGENTS.md`.
 */
export const AGENT_RULES: readonly string[] = [
  'Only add files you own: your result files under results/, plus registry files for hardware, models, quants or engines that genuinely do not exist yet. Never modify a result file authored by somebody else — CI rejects it.',
  'Never edit a number by hand. If validation fails, fix the run or the metadata, not the measurement.',
  'Never silently lower the configuration. If the requested flags do not fit (OOM, unsupported quant, context too long), report that as a failure with the error, and only then, in a separate result, record what did fit — with args showing exactly what you changed.',
  'Report failures as failures. An OOM, a crash or a 0% success rate is a valid contribution; an omitted failure is data corruption.',
  'Run on an idle box. No other GPU work, no compile in the background. Say in provenance.notes what else was resident and anything unusual about the conditions.',
  'Capture hardware with the harness (uv run atlas-bench hwinfo --json), never by typing specs from a spec sheet.',
  'Leave provenance.github_user_id, provenance.commit and provenance.pr null — CI and the build stamp them.',
  'Record the gotchas. If you had to know something to make this work, put it in gotchas[] — that is the part of the run that outlives the number.',
];

/* ---------------------------------------------------------------------- the packet */

export function buildPacket(spec: PacketSpec, registry: PacketRegistry, site: SiteConfig): Packet {
  const kind: PacketKind = spec.kind ?? 'cell';
  const repoUrl = `${site.repo.host ?? 'https://github.com'}/${site.repo.owner}/${site.repo.name}`;
  const engineEntry = findEngine(registry, spec.engine_id);
  const modelEntry = findModel(registry, spec.model_id);
  const quant = modelEntry?.quants.find((q) => q.id === spec.quant_id) ?? null;
  const hardware = registry.hardware.find((h) => h.id === spec.hardware_id) ?? null;
  const version = spec.engine_version ?? engineEntry?.meta.versions_available?.at(-1) ?? null;
  const versionFile = engineEntry?.versions?.find((v) => v.version === version) ?? null;
  const hwCount = spec.hw_count ?? 1;
  const args = spec.args ?? {};
  const workloads = (spec.workload_ids ?? []).map((id) => {
    const w = findWorkload(registry, id);
    return { id, kind: w?.kind ?? null, name: w?.name ?? null };
  });

  const minor = version ? engineMinor(version) : null;
  const cell =
    spec.model_id && spec.quant_id && spec.hardware_id && spec.engine_id && minor
      ? cellId({
          model_id: spec.model_id,
          quant_id: spec.quant_id,
          hardware_id: spec.hardware_id,
          hw_count: hwCount,
          engine_id: spec.engine_id,
          engine_minor: minor,
        })
      : null;

  const canonical =
    spec.quant_id !== undefined && spec.quant_id !== null
      ? canonicalizeArgs({
          engine_id: spec.engine_id ?? '',
          engine_version: version,
          args,
          quant_id: spec.quant_id,
          dtype: spec.dtype ?? null,
          params: versionFile?.params ?? null,
          drop_params: engineEntry?.meta.drop_params ?? [],
          param_aliases: engineEntry?.meta.param_aliases ?? null,
        })
      : null;

  const install = engineEntry?.meta.install?.[0] ?? null;
  const modelRef = resolveModelRef(engineEntry?.meta ?? null, modelEntry?.model ?? null, quant);
  const outputDir =
    spec.engine_id && spec.model_id && spec.hardware_id
      ? resultDir(spec.engine_id, spec.model_id, spec.hardware_id)
      : 'results/<engine>/<model>/<hardware>';
  const branch = buildBranchName(site, kind, spec, cell);
  const prTitle = buildPrTitle(kind, spec, version);

  const json: PacketJson = {
    packet_version: site.packet?.packet_version ?? PACKET_VERSION,
    kind,
    repo: {
      owner: site.repo.owner,
      name: site.repo.name,
      url: repoUrl,
      default_branch: site.repo.default_branch,
    },
    cell: {
      cell_id: cell,
      model_id: spec.model_id ?? null,
      quant_id: spec.quant_id ?? null,
      hardware_id: spec.hardware_id ?? null,
      hw_count: hwCount,
      engine_id: spec.engine_id ?? null,
      engine_minor: minor,
    },
    engine: {
      id: engineEntry?.meta.id ?? spec.engine_id ?? null,
      version,
      install,
      serve_command_template: engineEntry?.meta.serve.command_template ?? null,
      api: engineEntry?.meta.api ?? null,
      default_port: engineEntry?.meta.default_port ?? null,
    },
    model: {
      id: modelEntry?.model.id ?? spec.model_id ?? null,
      quant_id: quant?.id ?? spec.quant_id ?? null,
      hf_id: quant?.hf_id ?? modelEntry?.model.hf_id ?? null,
      ollama_tag: quant?.ollama_tag ?? null,
      files: quant?.files ?? [],
      dtype: spec.dtype ?? null,
    },
    hardware: {
      id: hardware?.id ?? spec.hardware_id ?? null,
      expected_detect: hardware?.detect ?? null,
      memory_gb: hardware?.memory_gb ?? null,
    },
    args,
    workloads,
    output_dir: outputDir,
    branch,
    pr_title: prTitle,
    agent_rules: [...AGENT_RULES],
  };

  const markdown = renderMarkdown({
    kind,
    spec,
    site,
    repoUrl,
    engine: engineEntry?.meta ?? null,
    versionFile,
    version,
    model: modelEntry?.model ?? null,
    quant,
    hardware,
    workloads,
    args,
    json,
    install,
    modelRef,
    canonicalString: canonical?.canonical ?? null,
    configId: canonical?.configId ?? null,
    cellIdValue: cell,
    outputDir,
    branch,
    prTitle,
  });

  const shell = renderShell({
    site,
    repoUrl,
    engine: engineEntry?.meta ?? null,
    version,
    install,
    modelRef,
    args,
    workloads,
    branch,
    prTitle,
    kind,
  });

  const issueUrl = renderIssueUrl(site, kind, spec, prTitle, json);

  return { markdown, json, shell, issueUrl };
}

function resolveModelRef(
  meta: EngineMeta | null,
  model: Model | null,
  quant: Quant | null,
): string {
  if (!meta) return quant?.hf_id ?? model?.hf_id ?? '<model>';
  switch (meta.serve.model_ref) {
    case 'ollama_tag':
      return quant?.ollama_tag ?? `${model?.id ?? '<model>'}:latest`;
    case 'gguf_path':
      return quant?.files?.[0] ? `./models/${quant.files[0]}` : './models/<file>.gguf';
    case 'local_path':
    case 'mlx_path':
    case 'engine_dir':
      return `./models/${quant?.hf_id ?? model?.hf_id ?? '<model>'}`;
    case 'hf_id':
    default:
      return quant?.hf_id ?? model?.hf_id ?? '<model>';
  }
}

function buildBranchName(
  site: SiteConfig,
  kind: PacketKind,
  spec: PacketSpec,
  cell: string | null,
): string {
  const prefix = site.repo.branch_prefix ?? 'result/';
  if (kind !== 'cell') {
    const slug = slugify(spec.target_name ?? kind.replace('new-', ''));
    return `${kind}/${slug}`;
  }
  const short = (cell ?? 'unknown').slice(0, 6);
  return `${prefix}${spec.engine_id ?? 'engine'}-${spec.model_id ?? 'model'}-${spec.hardware_id ?? 'hardware'}-${short}`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

function buildPrTitle(kind: PacketKind, spec: PacketSpec, version: string | null): string {
  switch (kind) {
    case 'new-hardware':
      return `hardware: add ${spec.target_name ?? spec.hardware_id ?? 'new device'}`;
    case 'new-model':
      return `model: add ${spec.target_name ?? spec.model_id ?? 'new model'}`;
    case 'new-engine':
      return `engine: add ${spec.target_name ?? spec.engine_id ?? 'new engine'}`;
    default:
      return `results: ${spec.engine_id ?? 'engine'} ${version ?? ''} ${spec.model_id ?? 'model'}/${
        spec.quant_id ?? 'quant'
      } on ${spec.hardware_id ?? 'hardware'}`.replace(/\s+/g, ' ');
  }
}

/* --------------------------------------------------------------------- markdown */

interface MarkdownContext {
  kind: PacketKind;
  spec: PacketSpec;
  site: SiteConfig;
  repoUrl: string;
  engine: EngineMeta | null;
  versionFile: EngineVersion | null;
  version: string | null;
  model: Model | null;
  quant: Quant | null;
  hardware: Hardware | null;
  workloads: Array<{ id: string; kind: string | null; name: string | null }>;
  args: Args;
  json: PacketJson;
  install: EngineInstall | null;
  modelRef: string;
  canonicalString: string | null;
  configId: string | null;
  cellIdValue: string | null;
  outputDir: string;
  branch: string;
  prTitle: string;
}

function renderMarkdown(ctx: MarkdownContext): string {
  const {
    kind,
    site,
    repoUrl,
    engine,
    version,
    model,
    quant,
    hardware,
    workloads,
    args,
    json,
    install,
    modelRef,
    outputDir,
    branch,
    prTitle,
  } = ctx;
  const agentsFile = site.packet?.agents_file ?? 'AGENTS.md';
  const harness = site.packet?.harness_command ?? 'uv run atlas-bench';
  const validate = site.packet?.validate_command ?? 'pnpm validate';
  const label = site.repo.results_label ?? 'results';
  const lines: string[] = [];

  const title =
    kind === 'cell'
      ? `Measure ${model?.id ?? ctx.spec.model_id}/${quant?.id ?? ctx.spec.quant_id} on ${
          hardware?.id ?? ctx.spec.hardware_id
        } with ${engine?.id ?? ctx.spec.engine_id} ${version ?? ''}`.trim()
      : kind === 'new-hardware'
        ? `Register new hardware: ${ctx.spec.target_name ?? ctx.spec.hardware_id ?? 'this machine'}`
        : kind === 'new-model'
          ? `Register new model: ${ctx.spec.target_name ?? ctx.spec.model_id ?? 'a model'}`
          : `Register new engine: ${ctx.spec.target_name ?? ctx.spec.engine_id ?? 'an engine'}`;

  lines.push(`# ${title}`, '');
  lines.push(
    `You are contributing one measurement to **${site.site.title}** — ${site.site.tagline}`,
    '',
    'The repository is the database: every measurement is one JSON file, owned by the person who ran it. Work through the steps below in order and do not skip the validation step.',
    '',
  );

  if (ctx.spec.note) lines.push(`> ${ctx.spec.note}`, '');

  if (kind === 'cell') {
    lines.push('## What to measure', '');
    lines.push('| | |', '|---|---|');
    lines.push(
      `| Engine | \`${engine?.id ?? '?'}\` **${version ?? '?'}** (${engine?.name ?? '?'}) |`,
    );
    lines.push(`| Model | \`${model?.id ?? '?'}\` — ${model?.name ?? '?'} |`);
    lines.push(
      `| Quantization | \`${quant?.id ?? '?'}\` (${quant?.format ?? '?'}, ${quant?.bits ?? '?'} bit) |`,
    );
    lines.push(`| Weights | \`${quant?.hf_id ?? model?.hf_id ?? 'n/a'}\` |`);
    lines.push(
      `| Hardware | \`${hardware?.id ?? '?'}\` x${json.cell.hw_count} — ${hardware?.name ?? '?'} |`,
    );
    lines.push(
      `| Workloads | ${workloads.map((w) => `\`${w.id}\``).join(', ') || '(none given)'} |`,
    );
    lines.push(`| cell_id | \`${ctx.cellIdValue ?? '(computed by the harness)'}\` |`);
    lines.push(`| expected config_id | \`${ctx.configId ?? '(computed by the harness)'}\` |`);
    lines.push('');
    if (ctx.canonicalString) {
      lines.push(
        'The canonical fingerprint of this configuration is:',
        '',
        '```',
        ctx.canonicalString,
        '```',
        '',
        'If your run produces a different `config_id`, you ran a different configuration. That is fine — but say so in the PR, do not force the id.',
        '',
      );
    }
  }

  lines.push('## Steps', '');

  // 1. clone
  lines.push(
    '### 1. Get the repository',
    '',
    '```bash',
    `git clone ${repoUrl}.git`,
    `cd ${site.repo.name}`,
    '```',
    '',
    `Read \`${agentsFile}\` before you touch anything — it is the contribution contract and it is shorter than this brief.`,
    '',
  );

  // 2. hardware
  lines.push('### 2. Capture the hardware truthfully', '');
  lines.push('```bash', `${harness} hwinfo --json`, '```', '');
  if (kind === 'new-hardware') {
    lines.push(
      'This machine is not in the registry yet. Take the captured output and write `hardware/<id>.json` from it:',
      '',
      '- `id`: lowercase kebab-case, vendor first, e.g. `nvidia-rtx-5090`, `apple-m4-max-128gb`. Apple SoC ids include the memory size because unified memory is the binding constraint.',
      '- `memory_gb`, `memory_bandwidth_gbs`, `compute.*`, `tdp_w`, `release_year`, `msrp_usd`: publicly documented specifications. If you are not sure about a figure, set it to `null` and say why in `notes` — a null is worth more than a guess.',
      '- `detect`: the strings the capture actually printed (`nvidia_smi_name`, `apple_chip`, `cpu_model`), so the next person on the same machine is matched automatically.',
      '- Never copy specs from a marketing page into fields the capture contradicts.',
      '',
    );
  } else {
    lines.push(
      `Expected match: \`${hardware?.id ?? '?'}\`` +
        (hardware?.detect ? ` (detected via ${describeDetect(hardware)})` : ''),
      '',
      'If the capture does not match any `hardware/*.json` entry, **stop and add the hardware file first** from the captured output, and say so in the PR. Never type specifications by hand and never force a near-match.',
      '',
    );
  }

  // 3. install
  lines.push('### 3. Install the engine and fetch the weights', '');
  lines.push('```bash', renderInstall(install, version), '```', '');
  if (kind === 'new-engine') {
    lines.push(
      'This engine is not in the registry yet. Add `engines/<id>/meta.json` (install methods, serve template, api, health paths, `drop_params`, `param_aliases`, platforms, `quant_formats`) and `engines/<id>/versions/<version>.json` with the flags the engine really accepts — take them from `--help` or the docs of that exact version, and record `extraction_method` honestly.',
      '',
    );
  }
  if (kind === 'new-model') {
    lines.push(
      'This model is not in the registry yet. Add `models/<id>/model.json` from the Hugging Face `config.json` and model card — `params_b`, `active_params_b`, `architecture`, `context_length`, `modalities`, `licence` must match the metadata, not the launch blog post. Then add one `models/<id>/quants/<quant-id>.json` per quantization you actually intend to run.',
      '',
    );
  }
  if (quant?.hf_id) {
    lines.push('```bash', `hf download ${quant.hf_id}`, '```', '');
  }

  // 4. serve
  lines.push('### 4. Start the engine with exactly these flags', '');
  if (engine) {
    lines.push(
      'Preferred: let the harness start it from the packet (it applies the install method, the exact flags and the health wait for you):',
      '',
      '```bash',
      `${harness} serve --spec task.json`,
      '```',
      '',
      'Equivalent manual command (this exact line, with the flags, goes into `serve_command` of the result):',
      '',
    );
    const serveLine = renderServeCommand(engine, modelRef, args);
    if (install?.method === 'docker' && install.image) {
      const image = install.image.replace('{version}', version ?? 'latest');
      const port = engine.default_port ?? 8000;
      lines.push(
        '```bash',
        `docker run --rm --gpus all --ipc=host -p ${port}:${port} -v ~/.cache/huggingface:/root/.cache/huggingface \\`,
        `  --entrypoint ${serveLine.split(' ')[0]} ${image} ${serveLine.split(' ').slice(1).join(' ')}`,
        '```',
        '',
      );
    } else {
      lines.push('```bash', serveLine, '```', '');
    }
    lines.push(
      `Wait for health at \`${engine.health?.path ?? '/health'}\` on port ${engine.default_port ?? 8000} before running anything. Do not add, drop or "improve" a flag; if the engine refuses to start with them, that refusal is the result — record it in \`failures[]\` and say so in the PR. If you attach to an engine you started yourself, pass \`--base-url\` to \`run\` and make sure the flags are exactly the ones above.`,
      '',
    );
  } else {
    lines.push(
      'Start the engine as documented for its version, then wait for its health endpoint.',
      '',
    );
  }

  // 5. run
  lines.push('### 5. Run the workloads', '');
  lines.push(
    'Save the JSON packet at the bottom of this brief as `task.json`, then:',
    '',
    '```bash',
    `${harness} run --spec task.json`,
    '```',
    '',
    `The harness executes every workload, computes the ids and writes one file per run into \`${outputDir}/<run_id>.json\`. Metrics it could not measure stay \`null\`; that is correct and expected.`,
    '',
  );

  // 6. validate
  lines.push('### 6. Validate locally', '');
  lines.push('```bash', 'pnpm install', validate, '```', '');
  lines.push(
    'Fix nothing by hand in the numbers. If validation fails, report what it said — a failing validation is a legitimate outcome to bring back, a hand-patched number is not.',
    '',
  );

  // 7. PR
  lines.push('### 7. Commit and open the pull request', '');
  lines.push(
    '```bash',
    `git checkout -b ${branch}`,
    `git add ${kind === 'cell' ? outputDir : '.'}`,
    `git commit -m ${shellQuote(prTitle)}`,
    `git push -u origin ${branch}`,
    `gh pr create --base ${site.repo.default_branch} --title ${shellQuote(prTitle)} --label ${label} --body-file pr-body.md`,
    '```',
    '',
    'The PR body must list, in this order: the cells filled (one line each: engine + version, model/quant, hardware, workload, the headline number), anything that failed, every gotcha you hit, and the conditions the box was in. Your GitHub login must equal `provenance.github_login` in every file you add — CI enforces it.',
    '',
  );

  // 8. rules
  lines.push('### 8. Rules', '');
  for (const rule of AGENT_RULES) lines.push(`- ${rule}`);
  lines.push('');

  lines.push(
    '## Packet (save as `task.json`)',
    '',
    '```json',
    JSON.stringify(json, null, 2),
    '```',
    '',
  );

  return lines.join('\n');
}

function describeDetect(hardware: Hardware): string {
  const d = hardware.detect ?? {};
  const parts: string[] = [];
  if (d.nvidia_smi_name?.length) parts.push(`nvidia-smi name "${d.nvidia_smi_name[0]}"`);
  if (d.apple_chip?.length) parts.push(`Apple chip "${d.apple_chip[0]}"`);
  if (d.cpu_model?.length) parts.push(`CPU model "${d.cpu_model[0]}"`);
  if (d.rocm_smi_name?.length) parts.push(`rocm-smi name "${d.rocm_smi_name[0]}"`);
  return parts.join(' or ') || 'no detect rule registered';
}

/* ------------------------------------------------------------------------ shell */

function renderShell(ctx: {
  site: SiteConfig;
  repoUrl: string;
  engine: EngineMeta | null;
  version: string | null;
  install: EngineInstall | null;
  modelRef: string;
  args: Args;
  workloads: Array<{ id: string }>;
  branch: string;
  prTitle: string;
  kind: PacketKind;
}): string {
  const harness = ctx.site.packet?.harness_command ?? 'uv run atlas-bench';
  const validate = ctx.site.packet?.validate_command ?? 'pnpm validate';
  const label = ctx.site.repo.results_label ?? 'results';
  const serve = ctx.engine
    ? renderServeCommand(ctx.engine, ctx.modelRef, ctx.args)
    : '# start the engine';
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `# ${ctx.prTitle}`,
    `git clone ${ctx.repoUrl}.git && cd ${ctx.site.repo.name}`,
    `git checkout -b ${ctx.branch}`,
    '',
    '# 1. hardware — captured, never typed',
    `${harness} hwinfo --json | tee hwinfo.json`,
    '',
    '# 2. engine',
    renderInstall(ctx.install, ctx.version),
    '',
    '# 3. serve (leave this running in another shell)',
    serve,
    '',
    '# 4. measure — writes results/<engine>/<model>/<hardware>/<run_id>.json',
    `${harness} run --spec task.json`,
    '',
    '# 5. validate, then open the PR',
    'pnpm install',
    validate,
    `git add results/ && git commit -m ${shellQuote(ctx.prTitle)}`,
    `git push -u origin ${ctx.branch}`,
    `gh pr create --base ${ctx.site.repo.default_branch} --title ${shellQuote(ctx.prTitle)} --label ${label}`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------------ issue */

function renderIssueUrl(
  site: SiteConfig,
  kind: PacketKind,
  spec: PacketSpec,
  prTitle: string,
  json: PacketJson,
): string {
  const base = `${site.repo.host ?? 'https://github.com'}/${site.repo.owner}/${site.repo.name}/issues/new`;
  const labels = (site.packet?.issue_labels ?? ['wanted']).join(',');
  const body = [
    kind === 'cell'
      ? `Nobody has measured this yet. If you have a \`${spec.hardware_id ?? 'matching machine'}\`, this is a twenty minute job.`
      : `This is a request to widen the registry (${kind}).`,
    '',
    '```json',
    JSON.stringify(json, null, 2),
    '```',
    '',
    `Full brief: open the Add dialog on the site and copy the *Agent prompt* tab, or run \`pnpm packet -- '${JSON.stringify(
      compactSpec(spec),
    )}'\`.`,
  ].join('\n');
  // Hand-rolled instead of URLSearchParams so this module stays free of any platform global.
  const params = [
    ['title', prTitle],
    ['body', body],
    ['labels', labels],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  return `${base}?${params}`;
}

function compactSpec(spec: PacketSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}
