/**
 * TypeScript mirrors of every JSON Schema under `schemas/`.
 *
 * These types are hand-written rather than generated: they are the contract the app,
 * the tools and the tests all read, and a generated shape would be much harder to
 * document inline. When a schema changes, change the type in the same commit.
 */

/* ------------------------------------------------------------------ primitives */

export type ArgValue = string | number | boolean | null | ArgValue[] | { [k: string]: ArgValue };
export type Args = Record<string, ArgValue>;

export type Platform =
  | 'linux-cuda'
  | 'linux-rocm'
  | 'linux-cpu'
  | 'linux-xpu'
  | 'macos-metal'
  | 'macos-cpu'
  | 'windows-cuda'
  | 'windows-cpu';

export type Impact = 'high' | 'medium' | 'low';

export interface Links {
  [label: string]: string | null | undefined;
}

/** Summary statistics of a per-request measurement. Everything optional: record only what was measured. */
export interface Distribution {
  mean?: number | null;
  p50?: number | null;
  p90?: number | null;
  p95?: number | null;
  p99?: number | null;
  min?: number | null;
  max?: number | null;
  stddev?: number | null;
}

/** The metrics of one measurement, or of one point of a sweep. */
export interface MetricBlock {
  requests_total?: number | null;
  requests_ok?: number | null;
  requests_failed?: number | null;
  success_rate?: number | null;
  duration_s?: number | null;
  output_tokens_total?: number | null;
  input_tokens_total?: number | null;
  output_tok_s?: number | null;
  total_tok_s?: number | null;
  req_s?: number | null;
  prefill_tok_s?: number | null;
  ttft_ms?: Distribution | null;
  tpot_ms?: Distribution | null;
  itl_ms?: Distribution | null;
  e2e_ms?: Distribution | null;
  decode_tok_s_per_request?: Distribution | null;
  vram_peak_gb?: number | null;
  ram_peak_gb?: number | null;
  kv_cache_tokens?: number | null;
  power_avg_w?: number | null;
  power_peak_w?: number | null;
  energy_wh?: number | null;
  gpu_util_avg_pct?: number | null;
  temp_max_c?: number | null;
  thermal_throttle_detected?: boolean | null;
  acceptance_rate?: number | null;
  accepted_tokens_per_step?: number | null;
}

/* -------------------------------------------------------------------- hardware */

export type HardwareKind = 'gpu' | 'soc' | 'cpu' | 'accelerator';

export interface HardwareCompute {
  arch?: string | null;
  sm?: string | null;
  cores?: number | null;
  clock_mhz?: number | null;
  fp32_tflops?: number | null;
  fp16_tflops?: number | null;
  bf16_tflops?: number | null;
  fp8_tflops?: number | null;
  fp4_tflops?: number | null;
  int8_tops?: number | null;
}

export interface HardwareDetect {
  nvidia_smi_name?: string[];
  rocm_smi_name?: string[];
  apple_chip?: string[];
  cpu_model?: string[];
  lspci?: string[];
  memory_gb?: number | null;
}

export interface Hardware {
  schema_version: 1;
  id: string;
  name: string;
  vendor: string;
  kind: HardwareKind;
  aliases?: string[];
  memory_gb: number | null;
  memory_type?: string | null;
  memory_bandwidth_gbs?: number | null;
  compute?: HardwareCompute;
  tdp_w?: number | null;
  release_year?: number | null;
  msrp_usd?: number | null;
  typical_cloud_usd_per_h?: number | null;
  form_factor?: string | null;
  notes?: string | null;
  detect?: HardwareDetect;
  links?: Links;
}

/* ---------------------------------------------------------------------- engine */

export type InstallMethod =
  'docker' | 'pip' | 'uv' | 'brew' | 'binary' | 'source' | 'script' | 'npm' | 'app';

export interface EngineInstall {
  method: InstallMethod;
  image?: string | null;
  package?: string | null;
  command?: string | null;
  arch?: string[];
  platforms?: Platform[];
  notes?: string | null;
}

export interface EngineServe {
  command_template: string;
  model_ref: 'hf_id' | 'local_path' | 'gguf_path' | 'ollama_tag' | 'mlx_path' | 'engine_dir';
  flag_style: string;
  bool_style?: string | null;
  bool_false_style?: string | null;
  env_style?: string | null;
  notes?: string | null;
}

export interface EngineMeta {
  schema_version: 1;
  id: string;
  name: string;
  repo: string;
  docs?: string | null;
  description?: string | null;
  api: 'openai' | 'ollama' | 'custom';
  default_port?: number;
  platforms: Platform[];
  quant_formats: string[];
  install: EngineInstall[];
  serve: EngineServe;
  health?: { path?: string | null; models_path?: string | null; ready_timeout_s?: number | null };
  bench_harness?: 'atlas-bench';
  drop_params: string[];
  param_aliases?: Record<string, string>;
  version_source?: {
    kind: 'github-releases' | 'github-tags' | 'pypi' | 'manual' | 'docker-tags';
    repo?: string | null;
    package?: string | null;
    tag_prefix?: string | null;
    version_scheme?: 'semver' | 'build-number' | 'calver' | 'opaque';
  };
  versions_available?: string[];
  links?: Links;
  notes?: string | null;
}

export type EngineParamType = 'bool' | 'int' | 'float' | 'str' | 'enum' | 'json' | 'list' | 'path';

export interface EngineParam {
  name: string;
  type: EngineParamType;
  /** What the engine uses when the flag is absent. Values equal to this are dropped from the fingerprint. */
  default: ArgValue;
  choices?: Array<string | number | boolean> | null;
  range?: Array<number | null> | null;
  help?: string | null;
  aliases?: string[];
  group?: string | null;
  impact?: Impact | null;
  env?: string | null;
  deprecated?: boolean;
}

export interface EngineVersion {
  schema_version: 1;
  engine_id: string;
  version: string;
  released?: string | null;
  extraction_method: 'hand-seeded' | 'help' | 'argparse' | 'docs' | 'generated';
  extracted_at?: string | null;
  source?: string | null;
  notes?: string | null;
  params: EngineParam[];
}

export interface EngineOverlayEntry {
  group?: string;
  impact?: Impact;
  notes?: string | null;
  featured?: boolean;
}

export interface EngineOverlay {
  schema_version: 1;
  engine_id: string;
  groups?: string[];
  params: Record<string, EngineOverlayEntry>;
}

/* ----------------------------------------------------------------------- model */

export interface Model {
  schema_version: 1;
  id: string;
  name: string;
  hf_id: string | null;
  family?: string | null;
  vendor: string;
  params_b: number;
  active_params_b?: number | null;
  architecture?: string | null;
  moe?: boolean;
  experts?: number | null;
  experts_active?: number | null;
  attention?: 'mha' | 'gqa' | 'mla' | 'hybrid' | 'mamba' | 'linear' | null;
  modalities?: Array<'text' | 'image' | 'audio' | 'video'>;
  context_length: number;
  licence?: string;
  released?: string | null;
  tags?: string[];
  links?: Links;
  notes?: string | null;
}

export type QuantFormat =
  | 'bf16'
  | 'fp16'
  | 'fp8'
  | 'nvfp4'
  | 'mxfp4'
  | 'int8'
  | 'int4'
  | 'awq-int4'
  | 'gptq-int4'
  | 'compressed-tensors'
  | 'bitsandbytes'
  | 'gguf'
  | 'mlx'
  | 'exl3'
  | 'exl2';

export interface Quant {
  schema_version: 1;
  id: string;
  model_id: string;
  format: QuantFormat;
  bits: number;
  hf_id?: string | null;
  revision?: string | null;
  files?: string[];
  ollama_tag?: string | null;
  size_gb?: number | null;
  engines: string[];
  source: 'official' | 'community' | 'self-quantized';
  calibration?: string | null;
  links?: Links;
  notes?: string | null;
}

/* -------------------------------------------------------------------- workload */

export type WorkloadKind = 'serving' | 'sweep' | 'prefill' | 'longctx' | 'eval';

export type ScorerKind =
  'exact' | 'numeric' | 'mc' | 'contains' | 'json' | 'code-exec' | 'judge' | 'needle' | 'vision';

export type SweepAxis = 'concurrency' | 'input_tokens' | 'output_tokens' | 'num_requests';

export interface Workload {
  schema_version: 1;
  id: string;
  name: string;
  kind: WorkloadKind;
  description?: string | null;
  dataset_id?: string | null;
  params: Record<string, string | number | boolean | unknown[] | null>;
  sweep?: Partial<Record<SweepAxis, number[]>> | null;
  eval?: {
    suite: string;
    scorer: ScorerKind;
    pass_threshold?: number | null;
    max_output_tokens?: number | null;
    judge_model?: string | null;
    categories?: string[];
    notes?: string | null;
  } | null;
  metrics_required: string[];
  immutable?: boolean;
  created?: string;
  supersedes?: string | null;
  notes?: string | null;
}

export interface Dataset {
  schema_version: 1;
  id: string;
  name: string;
  kind: 'prompts' | 'eval' | 'images' | 'haystack';
  description?: string | null;
  licence: string;
  files: string[];
  count: number;
  topics?: string[];
  categories?: string[];
  length_buckets?: Record<string, [number, number]>;
  schema?: { fields: string[]; notes?: string | null };
  generator?: string | null;
  created?: string | null;
  notes?: string | null;
}

/* ---------------------------------------------------------------------- result */

export type VerificationLevel = 'self-reported' | 'reproduced' | 'ci-verified' | 'disputed';

export interface SweepPoint {
  concurrency?: number;
  input_tokens?: number;
  output_tokens?: number;
  num_requests?: number;
  label?: string | null;
  metrics: MetricBlock;
}

export interface Counted {
  total: number;
  correct: number;
}

export interface EvalItemResult {
  id: string;
  category?: string | null;
  difficulty?: string | null;
  correct: boolean;
  predicted?: string | null;
  expected?: string | null;
  latency_ms?: number | null;
  output_tokens?: number | null;
}

export interface Scores {
  suite: string;
  total: number;
  correct: number;
  accuracy: number;
  by_category?: Record<string, Counted>;
  by_difficulty?: Record<string, Counted>;
  avg_output_tokens?: number | null;
  avg_latency_ms?: number | null;
  failures?: number;
  items?: EvalItemResult[];
}

export interface Failure {
  at: 'install' | 'load' | 'serve' | 'warmup' | 'request' | 'score';
  count: number;
  category:
    | 'timeout'
    | 'oom'
    | 'context-overflow'
    | 'http-5xx'
    | 'http-4xx'
    | 'malformed-output'
    | 'refusal'
    | 'crash'
    | 'unsupported'
    | 'other';
  message?: string | null;
  sample_request_id?: string | null;
}

export interface Gotcha {
  severity: 'info' | 'warn' | 'blocker';
  text: string;
  link?: string | null;
}

export interface Provenance {
  github_login: string;
  github_user_id?: number | null;
  started_at: string;
  finished_at?: string | null;
  submitted_at?: string | null;
  commit?: string | null;
  pr?: number | null;
  method: 'atlas-bench' | 'manual' | 'issue-form' | 'agent';
  agent?: { name: string; model?: string | null } | null;
  notes?: string | null;
}

export interface ResultRecord {
  schema_version: 1;
  run_id: string;
  config_id: string;
  cell_id: string;
  workload_id: string;
  kind: WorkloadKind;
  engine: {
    id: string;
    version: string;
    commit?: string | null;
    container?: string | null;
    install_method?: InstallMethod | null;
    build_flags?: string | null;
  };
  model: {
    id: string;
    quant_id: string;
    hf_id?: string | null;
    revision?: string | null;
    dtype?: string | null;
    local_path?: string | null;
  };
  hardware: {
    id: string;
    count: number;
    driver?: string | null;
    cuda?: string | null;
    rocm?: string | null;
    host?: {
      cpu?: string | null;
      cpu_cores?: number | null;
      ram_gb?: number | null;
      os?: string | null;
      kernel?: string | null;
      arch?: string | null;
    };
    fingerprint?: string | null;
    captured?: Record<string, unknown> | null;
  };
  args: Args;
  args_canonical: string;
  env?: Record<string, string | number | boolean | null> | null;
  serve_command?: string | null;
  workload?: {
    id: string;
    resolved_params?: Record<string, string | number | boolean | unknown[] | null>;
  };
  metrics?: MetricBlock | null;
  sweep?: SweepPoint[] | null;
  scores?: Scores | null;
  failures?: Failure[];
  gotchas?: Gotcha[];
  derived?: {
    cost_per_1m_output_tokens_usd?: number | null;
    tokens_per_watt?: number | null;
    tok_s_per_gb_bandwidth?: number | null;
    bandwidth_efficiency?: number | null;
    memory_headroom_gb?: number | null;
  };
  raw?: {
    harness?: string | null;
    harness_version?: string | null;
    sha256?: string | null;
    payload_path?: string | null;
    payload?: Record<string, unknown> | null;
    truncated?: boolean;
  };
  provenance: Provenance;
  verification: {
    level: VerificationLevel;
    reproduced_by?: string[];
    flags?: string[];
  };
}

/* ------------------------------------------------------------------ site config */

export interface SiteConfig {
  schema_version: 1;
  repo: {
    owner: string;
    name: string;
    default_branch: string;
    host?: string;
    branch_prefix?: string;
    results_label?: string;
  };
  site: {
    title: string;
    tagline: string;
    description?: string;
    base_path: string;
    url?: string;
    theme_default?: 'light' | 'dark' | 'system';
  };
  nav: Array<{ label: string; route: string; group?: string; primary?: boolean }>;
  atlas: {
    default_axes: { x: string; y: string };
    axes: string[];
    default_metric: string;
    metrics?: Array<{
      key: string;
      label: string;
      unit?: string;
      better?: 'higher' | 'lower';
      format?: string;
    }>;
    default_workload_id?: string;
  };
  evidence_colors: Record<CoverageLevel, string>;
  scoring: {
    weights: {
      fill_empty_cell: number;
      additional_run?: number;
      reproduction: number;
      new_hardware: number;
      new_model: number;
      new_engine: number;
      new_quant?: number;
      new_workload?: number;
      gotcha?: number;
      sweep_point?: number;
      eval_run?: number;
      wanted_bonus?: number;
    };
    diminishing: {
      per_cell_factor: number;
      min_factor?: number;
      max_runs_counted_per_cell?: number | null;
    };
  };
  coverage: {
    stale_minors_behind: number;
    disputed_deviation_pct: number;
    key_metrics: string[];
    reproduced_min_logins?: number;
  };
  plausibility: {
    bandwidth_tolerance: number;
    vram_tolerance: number;
    warn_bandwidth_fraction?: number;
    min_weight_gb?: number;
  };
  wanted: { weights: Record<string, number>; max_gaps?: number; workloads?: string[] };
  featured?: { hardware?: string[]; models?: string[]; engines?: string[]; workloads?: string[] };
  packet?: {
    packet_version?: number;
    agents_file?: string;
    harness_command?: string;
    validate_command?: string;
    issue_labels?: string[];
  };
  links?: Links;
}

/* ------------------------------------------------------- compiled / derived data */

/** One slim row of `index.json` — everything the tables and the heatmap need without fetching runs. */
export interface CompiledIndexRow {
  run_id: string;
  cell_id: string;
  config_id: string;
  workload_id: string;
  kind: WorkloadKind;
  engine: { id: string; version: string; minor: string };
  model: { id: string; quant_id: string };
  hardware: { id: string; count: number };
  metrics: {
    output_tok_s?: number | null;
    ttft_p50?: number | null;
    ttft_p95?: number | null;
    tpot_p50?: number | null;
    success_rate?: number | null;
    accuracy?: number | null;
    vram_peak_gb?: number | null;
    power_avg_w?: number | null;
    decode_tok_s_per_request?: number | null;
  };
  provenance: {
    login: string;
    user_id?: number | null;
    commit?: string | null;
    pr?: number | null;
    submitted_at?: string | null;
    started_at?: string | null;
  };
  verification_level: VerificationLevel;
  gotchas?: number;
  sweep_points?: number;
  path: string;
}

export type CoverageLevel = 'none' | 'single' | 'reproduced' | 'disputed' | 'stale';

export interface CoverageCell {
  cell_id: string;
  model_id: string;
  quant_id: string;
  hardware_id: string;
  hw_count: number;
  engine_id: string;
  engine_minor: string;
  runs: number;
  logins: string[];
  workloads: string[];
  configs: string[];
  level: CoverageLevel;
  /** The run that shows best on the first key metric it has. */
  best: CompiledIndexRow | null;
  /** Set when level === 'disputed': the config+workload groups that disagree. */
  disputes?: Array<{
    config_id: string;
    workload_id: string;
    metric: string;
    median: number;
    max_deviation_pct: number;
    run_ids: string[];
  }>;
  /** Set when level === 'stale': how many engine minors newer exist in the registry. */
  minors_behind?: number;
}

export interface ContributorScoreBreakdown {
  cells_filled: number;
  reproductions: number;
  additional_runs: number;
  sweep_points: number;
  eval_runs: number;
  gotchas: number;
  registry_hardware: number;
  registry_models: number;
  registry_engines: number;
  registry_quants: number;
  registry_workloads: number;
}

export interface Contributor {
  login: string;
  user_id: number | null;
  runs: number;
  cells_filled: number;
  reproductions: number;
  hardware_ids: string[];
  first_seen: string | null;
  last_seen: string | null;
  points: number;
  breakdown: ContributorScoreBreakdown;
}

/** One entry of the wanted queue: a cell nobody has measured, ranked. */
export interface Gap {
  cell_id: string;
  model_id: string;
  quant_id: string;
  hardware_id: string;
  hw_count: number;
  engine_id: string;
  engine_version: string;
  engine_minor: string;
  workload_ids: string[];
  score: number;
  reasons: string[];
  level: CoverageLevel;
}

/* --------------------------------------------------------------------- packets */

export type PacketKind = 'cell' | 'new-hardware' | 'new-model' | 'new-engine';

export interface PacketJson {
  packet_version: number;
  kind: PacketKind;
  repo: { owner: string; name: string; url: string; default_branch: string };
  cell: {
    cell_id: string | null;
    model_id: string | null;
    quant_id: string | null;
    hardware_id: string | null;
    hw_count: number;
    engine_id: string | null;
    engine_minor: string | null;
  };
  engine: {
    id: string | null;
    version: string | null;
    install: EngineInstall | null;
    serve_command_template: string | null;
    api: string | null;
    default_port: number | null;
  };
  model: {
    id: string | null;
    quant_id: string | null;
    hf_id: string | null;
    ollama_tag: string | null;
    files: string[];
    dtype: string | null;
  };
  hardware: {
    id: string | null;
    expected_detect: HardwareDetect | null;
    memory_gb: number | null;
  };
  args: Args;
  workloads: Array<{ id: string; kind: WorkloadKind | null; name: string | null }>;
  output_dir: string;
  branch: string;
  pr_title: string;
  agent_rules: string[];
}

export interface Packet {
  markdown: string;
  json: PacketJson;
  shell: string;
  issueUrl: string;
}
