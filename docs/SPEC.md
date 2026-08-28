# Inference Atlas — Implementation Contract (v1)

This is the binding contract for everyone (human or agent) working in this repo.
`docs/DESIGN.md` is the vision; this file is what is actually implemented. When they
disagree, this file wins.

## 0. Non-negotiables

1. **The repo is the database.** Every piece of data is a JSON file committed to `main`.
   No backend, no external DB. The site (GitHub Pages and `localhost`) reads compiled
   copies of those files.
2. **One file per measurement.** A result is one JSON file. Nobody ever edits another
   contributor's result file. CI enforces: a PR may only add/modify result files whose
   `provenance.github_login` equals the PR author; modifying a result file authored by
   someone else fails validation. This is what makes merge conflicts structurally
   impossible and makes every contributor the owner of their own numbers.
3. **Provenance is mandatory and verifiable.** Each result records the GitHub login
   (numeric user id resolved in CI), and the build step derives the _adding commit hash_
   and PR number from `git log` so they cannot be faked.
4. **Everything is configurable through data.** Hardware, engines, engine versions and
   flags, models, quantizations, workloads, datasets, eval suites, scoring weights, site
   navigation — all JSON under the registries below. Adding a new GPU or engine is a PR
   that adds a file, never a code change.
5. **Shared ids are computed identically everywhere.** TypeScript (`packages/core`) is
   the reference implementation of canonicalization/fingerprinting. The Python harness
   re-implements it and both are tested against the same golden vectors in
   `schemas/fixtures/fingerprint-vectors.json`.
6. **No weights, no datasets with unclear licences are mirrored.** Test data in
   `datasets/` is authored in this repo (synthetic or hand-written) and MIT licensed.

## 1. Repository layout (authoritative)

```
/
├── README.md                      # public front page
├── AGENTS.md                      # the contribution contract for coding agents (what a packet references)
├── CONTRIBUTING.md
├── LICENSE                        # MIT (code) — data is CC-BY-4.0, see DATA_LICENSE
├── docs/
│   ├── DESIGN.md                  # original vision document (verbatim)
│   └── SPEC.md                    # this file
├── schemas/                       # JSON Schema (draft 2020-12) for every data kind
│   ├── hardware.schema.json
│   ├── engine.schema.json         # engines/<id>/meta.json
│   ├── engine-version.schema.json # engines/<id>/versions/<ver>.json
│   ├── model.schema.json          # models/<id>/model.json
│   ├── quant.schema.json          # models/<id>/quants/<quant-id>.json
│   ├── workload.schema.json
│   ├── dataset.schema.json        # datasets/<id>/dataset.json
│   ├── result.schema.json
│   ├── site.schema.json           # site/config.json
│   └── fixtures/fingerprint-vectors.json
├── hardware/<hardware-id>.json
├── engines/<engine-id>/meta.json
├── engines/<engine-id>/overlay.json                 # hand-curated group/impact per flag
├── engines/<engine-id>/versions/<version>.json      # flag schema per version (generated or hand-seeded)
├── models/<hf-owner>/<hf-name>/model.json        # model_id IS the Hugging Face repo id, verbatim (e.g. models/Qwen/Qwen3.8-27B/)
├── models/<hf-owner>/<hf-name>/quants/<quant-id>.json
├── workloads/<workload-id>.json
├── datasets/<dataset-id>/dataset.json + data files (jsonl / png)
├── results/<engine-id>/<hf-owner>/<hf-name>/<hardware-id>/<run-file>.json
├── site/config.json               # nav, default axes, scoring weights, colours, branding
├── packages/core/                 # TS: types, ids, canonicalization, validation helpers (node + browser)
├── tools/                         # TS node scripts: validate, build, packet, ingest
├── app/                           # Vite + Lit 3 web app (GitHub Pages)
├── bench/                         # Python harness `atlas-bench` (uv project)
└── .github/workflows/             # validate.yml, build-pages.yml, ingest-engines.yml, issue-to-pr.yml
```

Workspace tooling: **pnpm workspaces** (`pnpm-workspace.yaml`: `packages/*`, `tools`, `app`),
TypeScript strict, Vitest, ESLint flat config (light), Prettier. Python side uses **uv**
(`bench/pyproject.toml`, Python ≥ 3.11), pytest, ruff.

Top-level scripts (root `package.json`):

| script                  | does                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm validate`         | validates every JSON file in the registries + results against schemas, recomputes ids, runs plausibility + ownership checks (same code CI runs) |
| `pnpm build:data`       | compiles registries + results into `app/public/data/*` (index, shards, contributors, coverage, manifest)                                        |
| `pnpm dev`              | `build:data` then Vite dev server for `app/`                                                                                                    |
| `pnpm build`            | `build:data` + Vite production build into `app/dist`                                                                                            |
| `pnpm test`             | vitest across packages + tools + app unit tests                                                                                                 |
| `pnpm packet -- <spec>` | prints an agent packet for a cell (same generator the app uses)                                                                                 |

## 2. Identifiers

All ids except `model_id` are lowercase kebab-case `[a-z0-9][a-z0-9.-]*`. `model_id` is the
Hugging Face repo id verbatim (see below). Registry ids are chosen by humans and stable forever
(renaming = new id + `aliases`).

| id              | where                                                      | rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hardware_id`   | `hardware/<id>.json`                                       | e.g. `nvidia-rtx-4090`, `nvidia-gb10-dgx-spark`, `apple-m2-max-32gb`, `apple-m3-ultra-96gb` (Apple SoC ids include memory because it is the binding constraint)                                                                                                                                                                                                                                                                                                                          |
| `engine_id`     | `engines/<id>/`                                            | `vllm`, `sglang`, `llamacpp`, `ollama`, `mlx-lm`, `tensorrt-llm`, `tgi`, `lmstudio`, `exllamav3`                                                                                                                                                                                                                                                                                                                                                                                         |
| `model_id`      | `models/<owner>/<name>/`                                   | **The Hugging Face repo id, verbatim and case-preserved**: `Qwen/Qwen3.8-27B`, `google/gemma-4-E2B-it`, `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16`. Pattern `^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$` (exactly one `/`). A fine-tune or re-upload by somebody else is a different HF repo and therefore a different model. `model.json.hf_id` must equal `id`. Directory path = id (two levels). The validator rejects two model dirs that differ only by case. |
| `quant_id`      | `models/<model-id>/quants/<quant-id>.json`                 | `bf16`, `fp8`, `nvfp4`, `awq-int4`, `gptq-int4`, `gguf-q4-k-m`, `gguf-q5-k-m`, `gguf-q8-0`, `mlx-4bit`, `mlx-8bit`, `exl3-4.0bpw`. Unique within the model; the quant record's `hf_id` is the full HF repo that holds the weights (official or community, e.g. `lmstudio-community/gemma-4-E2B-it-MLX-4bit`). Full ref = `<model-id>/<quant-id>`.                                                                                                                                        |
| `workload_id`   | `workloads/<id>.json`                                      | versioned suffix mandatory: `serve-chat-c8-i1k-o256-v1`, `sweep-parallel-1-32-v1`, `eval-math-v1`, `eval-code-v1`, `eval-vision-v1`, `longctx-needle-32k-v1`, `prefill-32k-v1`. Immutable once published.                                                                                                                                                                                                                                                                                |
| `cell_id`       | computed                                                   | `sha256("model_id                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | quant_id              | hardware_id | hw_count | engine_id | engine_minor")[:12]`where`engine_minor` = first two semver components (`0.27`). One square on the coverage map. |
| `config_id`     | computed                                                   | canonical non-default engine args (see §3) → `sha256(canonical)[:16]`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `run_id`        | computed                                                   | `<config_id>--<workload_id>--<sha256(github_login + "                                                                                                                                                                                                                                                                                                                                                                                                                                    | " + started_at)[:6]>` |
| result filename | `results/<engine>/<owner>/<name>/<hardware>/<run_id>.json` | exactly `run_id + ".json"`; `<owner>/<name>` is the model_id                                                                                                                                                                                                                                                                                                                                                                                                                             |

`hw_count` = number of devices (1 for single GPU / one Mac). Multi-node is out of scope v1.

## 3. Canonicalization (`config_id`)

Input: `engine_id`, `engine_version`, `args` (object of flag→value as passed to the engine),
`quant_id`, `dtype`. Steps, in order, implemented in `packages/core/src/canonical.ts` and
`bench/atlas_bench/canonical.py`:

1. Resolve aliases: `engines/<id>/versions/<ver>.json` params carry `aliases: ["-tp"]`; map
   every alias to the canonical `name`. Unknown flags are kept verbatim (lowercased,
   leading dashes stripped, `_` → `-`).
2. Drop any param whose value equals that version's `default`. If the version file is
   unknown, drop nothing (and the validator emits a warning `unknown-engine-version`).
3. Normalize values: booleans → `true`/`false`; numbers → shortest round-trip string with
   up to 6 significant decimals (`0.92`, `8192`); strings trimmed; arrays → JSON with sorted
   scalar elements; objects → JSON with sorted keys. Params in `drop_params` of the engine
   meta (paths, ports, host, api-key, served-model-name, download-dir, model, revision) are
   removed entirely.
4. Prepend two pseudo-params: `@quant=<quant_id>` and `@dtype=<dtype|auto>`. (They sort
   first because `@` < `a`.)
5. Sort keys lexicographically (byte order), join as `k=v;k=v`. Empty set → `@dtype=auto;@quant=bf16`-style string still non-empty.
6. `config_id = sha256(utf8(canonical))[:16]`.

`args_canonical` (the joined string) is stored in the result for debuggability; the validator
recomputes it and fails on mismatch.

## 4. Data shapes (summaries — schemas are authoritative)

### hardware/<id>.json

```jsonc
{
  "schema_version": 1,
  "id": "nvidia-gb10-dgx-spark",
  "name": "NVIDIA DGX Spark (GB10)",
  "vendor": "nvidia",
  "kind": "soc", // gpu | soc | cpu | accelerator
  "aliases": ["asus-ascent-gx10", "gb10"],
  "memory_gb": 128,
  "memory_type": "LPDDR5x",
  "memory_bandwidth_gbs": 273,
  "compute": {
    "arch": "blackwell",
    "sm": "12.1",
    "fp16_tflops": 250,
    "fp8_tflops": 500,
    "fp4_tflops": 1000,
  },
  "tdp_w": 140,
  "release_year": 2025,
  "msrp_usd": 3999,
  "typical_cloud_usd_per_h": null,
  "form_factor": "desktop",
  "notes": "...",
  "detect": {
    // how the harness maps a machine to this id, no guessing
    "nvidia_smi_name": ["NVIDIA GB10"],
    "apple_chip": [],
    "cpu_model": [],
    "lspci": [],
  },
  "links": { "vendor": "...", "wiki": "..." },
}
```

### engines/<id>/meta.json

```jsonc
{
  "schema_version": 1,
  "id": "vllm",
  "name": "vLLM",
  "repo": "https://github.com/vllm-project/vllm",
  "docs": "...",
  "api": "openai", // openai | ollama | custom — what the harness talks to
  "default_port": 8000,
  "platforms": ["linux-cuda", "linux-rocm"], // + macos-metal, linux-cpu
  "quant_formats": [
    "bf16",
    "fp8",
    "nvfp4",
    "awq-int4",
    "gptq-int4",
    "compressed-tensors",
    "bitsandbytes",
    "gguf",
  ],
  "install": [
    { "method": "docker", "image": "vllm/vllm-openai:v{version}", "arch": ["x86_64", "aarch64"] },
    { "method": "pip", "package": "vllm=={version}" },
  ],
  "serve": {
    "command_template": "vllm serve {model_ref} {flags}",
    "model_ref": "hf_id",
    "flag_style": "--{name} {value}",
    "bool_style": "--{name}",
  },
  "health": { "path": "/health", "models_path": "/v1/models" },
  "bench_harness": "atlas-bench", // we always use our harness; engine-native harness optional
  "drop_params": [
    "model",
    "host",
    "port",
    "api-key",
    "served-model-name",
    "download-dir",
    "revision",
    "hf-token",
  ],
  "param_aliases": { "tp": "tensor-parallel-size", "pp": "pipeline-parallel-size" },
  "version_source": { "kind": "github-releases", "tag_prefix": "v" },
  "versions_available": ["0.26.1", "0.27.1"], // must match files in versions/
}
```

### engines/<id>/versions/<version>.json

Same as DESIGN §6.1 (`params[]` with name, type, default, choices, range, help, aliases,
group, impact). `overlay.json` = `{ "params": { "<name>": { "group": "...", "impact": "high|medium|low" } } }`
merged at build time.

### models/<owner>/<name>/model.json

```jsonc
{ "schema_version": 1, "id": "Qwen/Qwen3.8-27B", "name": "Qwen3.8-27B", "hf_id": "Qwen/Qwen3.8-27B",
  "family": "qwen3.8", "vendor": "alibaba", "params_b": 27, "active_params_b": 27, "architecture": "Qwen3_5ForConditionalGeneration",
  "moe": false, "modalities": ["text","image"], "context_length": 262144, "licence": "Apache-2.0",
  "released": "2026-08-14", "tags": ["chat","reasoning","vision"], "links": {...}, "notes": "..." }
```

### models/<owner>/<name>/quants/<quant-id>.json

```jsonc
{
  "schema_version": 1,
  "id": "fp8",
  "model_id": "Qwen/Qwen3.8-27B",
  "format": "fp8",
  "bits": 8,
  "hf_id": "Qwen/Qwen3.8-27B-FP8",
  "revision": null,
  "files": [],
  "size_gb": 28.5,
  "engines": ["vllm", "sglang"],
  "source": "official",
  "notes": "",
}
```

GGUF quants: `"files": ["Qwen3.8-27B-Q5_K_M.gguf"]`, `"engines": ["llamacpp","ollama","lmstudio"]`,
`"ollama_tag": "qwen3.8:27b-q5_K_M"`.

### workloads/<id>.json

```jsonc
{
  "schema_version": 1,
  "id": "serve-chat-c8-i1k-o256-v1",
  "name": "...",
  "kind": "serving",
  // serving | sweep | prefill | longctx | eval
  "description": "...",
  "dataset_id": "prompts-mixed-v1",
  "params": {
    "concurrency": 8,
    "num_requests": 200,
    "input_tokens": 1024,
    "output_tokens": 256,
    "seed": 42,
    "warmup_requests": 10,
    "temperature": 0,
    "repeat": 3,
  },
  "sweep": null, // sweep kind: { "concurrency": [1,2,4,8,16,32] }
  "eval": null, // eval kind: { "suite": "math", "scorer": "exact|mc|code-exec|json|judge|contains|needle", "pass_threshold": ... }
  "metrics_required": ["ttft_ms", "tpot_ms", "output_tok_s", "prefill_tok_s", "success_rate"],
  "immutable": true,
  "created": "2026-08-23",
  "supersedes": null,
}
```

### datasets/<id>/dataset.json

```jsonc
{
  "schema_version": 1,
  "id": "prompts-mixed-v1",
  "name": "...",
  "kind": "prompts", // prompts | eval | images | haystack
  "licence": "MIT",
  "files": ["prompts.jsonl"],
  "count": 600,
  "topics": [
    "code",
    "math",
    "science",
    "history",
    "law",
    "medicine",
    "creative",
    "business",
    "multilingual",
    "everyday",
  ],
  "length_buckets": {
    "xs": [16, 64],
    "s": [65, 256],
    "m": [257, 1024],
    "l": [1025, 4096],
    "xl": [4097, 16384],
    "xxl": [16385, 65536],
  },
  "schema": { "fields": ["id", "topic", "bucket", "approx_tokens", "messages"] },
}
```

Eval rows: `{ "id", "category", "difficulty", "prompt"|"messages", "answer", "scorer", "choices"?, "tests"?, "image"? }`.

### results/…/<run_id>.json (one run = one config × one workload)

```jsonc
{
  "schema_version": 1,
  "run_id": "...", "config_id": "...", "cell_id": "...", "workload_id": "...",
  "kind": "serving",                                          // mirrors workload.kind
  "engine":   { "id": "vllm", "version": "0.27.1", "commit": null, "container": "vllm/vllm-openai:v0.27.1-aarch64", "install_method": "docker" },
  "model":    { "id": "Qwen/Qwen3.8-27B", "quant_id": "fp8", "hf_id": "Qwen/Qwen3.8-27B-FP8", "revision": "abc123", "dtype": "auto" },
  "hardware": { "id": "nvidia-gb10-dgx-spark", "count": 1, "driver": "580.95", "cuda": "13.0",
                "host": { "cpu": "...", "ram_gb": 121, "os": "Ubuntu 24.04", "kernel": "..." },
                "fingerprint": "sha256:…", "captured": { /* sanitized raw hwinfo: nvidia-smi -q subset / system_profiler subset */ } },
  "args": { "gpu-memory-utilization": 0.44, "max-model-len": 262144, "enable-prefix-caching": true,
            "speculative-config": { "method": "mtp", "num_speculative_tokens": 3 } },
  "args_canonical": "@dtype=auto;@quant=fp8;enable-prefix-caching=true;…",
  "serve_command": "docker run … vllm serve …",              // exact reproducible command line
  "workload": { "id": "...", "resolved_params": { ... } },   // snapshot of what was run
  "metrics": {                                                // serving/prefill/longctx kinds
    "requests_total": 200, "requests_ok": 200, "requests_failed": 0, "success_rate": 1.0,
    "duration_s": 123.4,
    "output_tok_s": 2841.6, "total_tok_s": 11203.4, "req_s": 11.1,
    "prefill_tok_s": 9800.0,                                  // input tokens / sum(ttft) at concurrency
    "ttft_ms": { "mean": 184.2, "p50": 161.0, "p90": 350.1, "p95": 402.7, "p99": 611.3, "min": 90, "max": 800 },
    "tpot_ms": { "mean": 11.3, "p50": 10.9, "p95": 15.2 },
    "itl_ms":  { "mean": 11.1, "p95": 14.8 },
    "e2e_ms":  { "mean": 3100, "p50": 2950, "p95": 4100 },
    "decode_tok_s_per_request": { "mean": 88.5, "p50": 90.1 },
    "vram_peak_gb": 54.1, "ram_peak_gb": null, "kv_cache_tokens": 271315,
    "power_avg_w": 110, "power_peak_w": 125, "energy_wh": 3.9, "gpu_util_avg_pct": 97, "temp_max_c": 71,
    "thermal_throttle_detected": false
  },
  "sweep": [ { "concurrency": 1, "metrics": { /* same metric block */ } }, { "concurrency": 2, ... } ],   // sweep kind
  "scores": {                                                 // eval kind
    "suite": "math", "total": 100, "correct": 87, "accuracy": 0.87,
    "by_category": { "arithmetic": {"total": 20, "correct": 20}, "algebra": {...} },
    "by_difficulty": { "easy": {...}, "medium": {...}, "hard": {...} },
    "avg_output_tokens": 312, "avg_latency_ms": 4200, "failures": 0,
    "items": [ { "id": "math-0001", "correct": true, "predicted": "42", "expected": "42", "latency_ms": 3100, "output_tokens": 280 } ]
  },
  "failures": [ { "at": "request", "count": 3, "category": "timeout|oom|context-overflow|http-5xx|http-4xx|malformed-output|refusal|other",
                  "message": "…", "sample_request_id": "…" } ],
  "gotchas": [ { "severity": "info|warn|blocker", "text": "Prefix caching defaults OFF for hybrid models; pass --enable-prefix-caching explicitly." } ],
  "derived": { "cost_per_1m_output_tokens_usd": null, "tokens_per_watt": 25.8, "tok_s_per_gb_bandwidth": 0.32 },
  "raw": { "harness": "atlas-bench", "harness_version": "0.1.0", "sha256": "…", "payload_path": null, "payload": { /* bounded <=100KB */ } },
  "provenance": {
    "github_login": "khaledbakeer", "github_user_id": null,    // user_id resolved by CI, left null by contributor
    "started_at": "2026-08-23T10:00:00Z", "finished_at": "...", "submitted_at": "...",
    "commit": null, "pr": null,                                  // stamped by build from git history; contributor leaves null
    "method": "atlas-bench|manual|issue-form|agent",
    "agent": { "name": "claude-code", "model": "claude-fable-5" } | null,
    "notes": "Ambient 22C, box otherwise idle, embed engine resident (10 GiB)."
  },
  "verification": { "level": "self-reported", "reproduced_by": [], "flags": [] }
}
```

Bounded: any `raw.payload` above 100 KB must be truncated with `raw.truncated: true` (keep the
aggregates). Per-item eval results keep at most `predicted` truncated to 500 chars.

## 5. Ownership & provenance enforcement (validate.yml + `tools/validate`)

On every PR:

1. Schema-validate every changed JSON file (ajv 2020-12).
2. Recompute `config_id`, `cell_id`, `run_id`, `args_canonical`; filename must equal `run_id.json`; path must match `results/<engine>/<owner>/<name>/<hardware>/` where `<owner>/<name>` is the model_id verbatim.
3. **Ownership:** for each changed file under `results/`: `provenance.github_login` must equal the PR author login (`github.event.pull_request.user.login`), both for added and modified files, and for a modified file the _previous_ version's login must also equal the author. Deleting another person's file is rejected. (Maintainers can bypass with label `maintainer-override`.)
4. Referential integrity: engine/model/quant/hardware/workload ids must exist; `quant.engines` must include the engine; engine version file exists (warning otherwise).
5. Plausibility: `output_tok_s_per_request <= memory_bandwidth_gbs / weight_gb * 1.5` (MoE uses active weights), `vram_peak_gb <= memory_gb`, non-negative latencies, `success_rate ∈ [0,1]`, `requests_ok + requests_failed == requests_total`.
6. Duplicate `run_id` → fail. Same `cell_id+config_id+workload_id` with metric deviation > 25 % from the median of existing → warning + `needs-review` label comment.
7. Resolve login → numeric user id via `api.github.com/users/<login>` (CI token) and write it into the file in a bot commit on the PR branch (or fail if the login does not exist).

On `main` build (`build-pages.yml`): `tools/build` stamps `provenance.commit` (the commit that
added the file, from `git log --diff-filter=A --format=%H -- <path>`) and `provenance.pr`
(parsed from that commit's message `(#123)`) into the compiled data — the raw files stay as
the author committed them.

## 6. Compiled data for the app (`tools/build` → `app/public/data/`)

```
manifest.json        { built_at, commit, counts, shards: { path: {sha256, bytes} } }
registry.json        { hardware[], engines[] (meta+overlay, versions list), models[] (with quants[]), workloads[], datasets[] (meta only), site }
index.json           [ slim run rows: run_id, cell_id, config_id, workload_id, kind, engine{id,version}, model{id,quant_id}, hardware{id,count},
                       key metrics (output_tok_s, ttft_p50/p95, tpot_p50, success_rate, accuracy, vram_peak_gb, power_avg_w), provenance{login,user_id,commit,pr,submitted_at}, verification.level, path ]
coverage.json        { cells: { cell_id: { model_id, quant_id, hardware_id, engine_id, engine_minor, runs, workloads[], level: none|single|reproduced|disputed|stale, best: {...} } } }
contributors.json    [ { login, user_id, runs, cells_filled, reproductions, hardware_ids[], first_seen, last_seen, points } ]
engines/<id>/<version>.json     param schemas with overlay merged
runs/<engine>/<owner>/<name>/<hardware>/<run_id>.json   full result files (copied, with stamped provenance)
gaps.json            ranked list of untested/wanted cells (registry × workload cross product scored by site.config wanted weights + requests)
```

The app fetches `manifest.json` first, then `registry.json` + `index.json` + `coverage.json`;
full runs are fetched lazily per run. Base path = Vite `base` from env `VITE_BASE` (default `/`).

## 7. The "Add measurement" packet (app + `tools/packet`)

Every gap (cell × workload, or "new hardware"/"new model"/"new engine") has an **Add** button →
modal with tabs: _Agent prompt (Markdown)_, _Packet (JSON)_, _Shell_, _Issue_. The Markdown
prompt is self-contained and instructs the agent to:

1. Clone `https://github.com/<owner>/<repo>` (from `site/config.json.repo`), `cd`, read `AGENTS.md`.
2. **Capture hardware truthfully** with `uv run atlas-bench hwinfo --json` (never type specs by
   hand; if the machine does not match any `hardware/*.json` `detect` rule, the agent must first
   create a new hardware file from the captured info, and say so in the PR).
3. Install the engine at the pinned version with the listed install method; download model/quant.
4. Start the engine with the exact flags (`atlas-bench serve --spec` or manual) and wait for health.
5. Run `uv run atlas-bench run --spec task.json` (the JSON packet) — it executes the workload(s),
   writes result files into the correct `results/...` path with computed ids.
6. `pnpm validate` locally; fix nothing by hand in the numbers — if it fails, report.
7. Commit on branch `result/<engine>-<model>-<hardware>-<short>`, open PR via `gh pr create`
   with the title template, body listing cells filled, and `--label results`.
8. Rules block (no edits outside own result files, do not lower the config silently, idle box, note conditions).

The JSON packet carries: `packet_version`, `repo`, `cell`, `engine {id, version, install}`,
`model {id, quant_id, hf_id}`, `hardware {id or null, expected_detect}`, `args`, `workloads[]`,
`output_dir`, `branch`, `pr_title`, `agent_rules[]`.

## 8. Harness (`bench/`, Python, `atlas-bench`)

Commands: `hwinfo`, `serve` (start engine via adapter: docker/pip/ollama/llama-server/mlx_lm.server;
or `--base-url` to attach to a running one), `run --spec`, `validate`, `submit`, `packet`.
Adapters per engine under `atlas_bench/engines/`. Workload runners under `atlas_bench/workloads/`:
`serving`, `sweep`, `prefill`, `longctx`, `eval`. Scorers under `atlas_bench/scorers/`:
`exact`, `numeric`, `mc`, `contains`, `json`, `code_exec` (subprocess, timeout, no network),
`needle`, `vision` (same scorers; image attached as base64 data URL). Telemetry sampler:
`nvidia-smi --query-gpu` loop, macOS `powermetrics` if available (sudo) else `ioreg`/none, `psutil`.
All talk goes through the OpenAI-compatible chat/completions streaming API (Ollama via its
`/v1`). Streaming is how TTFT/ITL are measured (first token timestamp vs request start).

## 9. Web app (`app/`, Vite + Lit 3 + TS, hash routing)

Routes: `#/` atlas heatmap · `#/explore` config explorer · `#/results` filterable table ·
`#/run/<run_id>` detail · `#/compare?runs=a,b` · `#/pareto` · `#/timeline` · `#/evals` ·
`#/parallelism` · `#/models`, `#/models/<id>` · `#/hardware`, `#/hardware/<id>` ·
`#/engines`, `#/engines/<id>` · `#/workloads` · `#/contributors`, `#/contributors/<login>` ·
`#/gaps` (wanted queue) · `#/contribute` (how-to + packet builder). Charts: uPlot. Every
page has Add/Contribute buttons where a gap is visible. Mobile responsive. Light/dark.

## 10. Seeding

There is no seed data. Every result in `results/` is a real run produced by the harness on a
contributor's own machine and submitted through a PR by that contributor. CI never runs
benchmarks — it only validates and builds the site. `docs/reference-measurements.md` keeps a
few historical hand-measured numbers as context for plausibility and gotchas; they are not in
the atlas.

## Decisions log

Decisions taken while implementing the foundation, in places where this document was silent
or where reality disagreed with it. Each one is binding until superseded here.

**2026-08-23 — wave 1 (schemas, `packages/core`, registries, seed results)**

1. **`schemas/common.schema.json`.** §1's file list does not mention it, but `$defs` for
   `id`, `iso_datetime`, `distribution`, `metric_block`, `links`, `platform` and friends are
   shared by nine schemas and duplicating them would guarantee drift. It is a definitions-only
   document: nothing validates against it directly, and tooling that globs
   `schemas/*.schema.json` must load it into the validator like any other.

2. **`additionalProperties: false` everywhere except `dataset.schema.json`.** Typos should
   fail, so every top-level record and every `metrics` / `provenance` / `verification` block
   is closed. Dataset records are the exception: each dataset _kind_ carries its own metadata
   (haystack depths and target token counts, prefix-group structure, per-topic counts,
   generator seeds) and enumerating them would mean a schema change per dataset. The dataset
   contract is its required fields; the rest is documentation. `dataset.notes` additionally
   accepts an array of strings.

3. **Fingerprint steps 2 and 3 are fused.** §3 lists "drop defaults" before "normalize
   values". Comparing raw values would make `"0.90"` differ from a default of `0.9` and
   `"True"` differ from a default of `true`. So the value and the default are both normalized
   with the same rules and the resulting _strings_ are compared. This can only merge
   configurations that really are identical.

4. **Value normalization is typed by the version file.** `"1"` folds to `true` only when the
   engine version declares the flag boolean (or its default is a boolean). Without that
   knowledge `1` stays the number one. A string that parses as a JSON object or array is
   always treated as JSON, since that is how `--speculative-config '{...}'` arrives from a
   shell.

5. **A `null` default is never dropped.** Flags whose default depends on the model rather
   than being a constant (`enable-prefix-caching`, `enable-chunked-prefill`,
   `mem-fraction-static`, `block-size`) carry `default: null` in the version files. A null
   default never matches, so an explicitly passed value always survives into the fingerprint.
   That can split two configurations that were in fact identical; it can never merge two that
   were not, which is the safe direction. A `null` _value_ in `args`, by contrast, means the
   flag was not passed and is dropped.

6. **`resolved` includes the pseudo-params.** `canonicalizeArgs` returns exactly the pairs
   that make up the canonical string, `@quant` and `@dtype` included, so the string is
   reconstructible from `resolved`. Tested as an invariant.

7. **`engineMinor` on non-semver schemes.** Versions that are not dotted numbers (llama.cpp's
   `b7000`, LM Studio's dates) have no minor, so the whole string is the minor and every
   build is its own coverage square. Numeric components keep their literal text, so
   `2026.08.1 → 2026.08`.

8. **`run_id` collisions.** §2 derives `run_id` from `config_id`, `workload_id`, login and
   `started_at` — not from the engine version. Two runs of identical args and workload by the
   same contributor on two engine versions therefore collide unless `started_at` differs. In
   practice it always does (you cannot start two engines on one box at the same instant), and
   the seed data uses distinct times for exactly this reason. Left as is rather than changing
   the id definition; the validator's duplicate-`run_id` check catches the pathological case.

9. **Plausibility: speculative decoding lifts the bandwidth ceiling.** §5 item 5's bound is
   `bandwidth / weight_gb * 1.5`, which real MTP runs beat legitimately: several tokens leave
   one pass over the weights. The bound is therefore multiplied by the tokens per forward
   pass — the measured `metrics.accepted_tokens_per_step` if present, otherwise the
   configured draft length + 1, otherwise a generous 4 when a speculative method is
   configured without a count. The separate low-efficiency _warning_ is measured against the
   plain bound, because speculative decoding changes what is possible, not what "leaving
   bandwidth on the table" means.

10. **Plausibility severities.** Bandwidth ceiling, VRAM over device memory, negative metrics,
    out-of-order percentiles, request counts that do not add up, success rate outside [0, 1]
    and eval accuracy that contradicts its own counts are **errors**. Undescribed failures,
    a success rate inconsistent with the counts, power above TDP, detected thermal throttling,
    weights larger than device memory, an absent metrics block and low bandwidth efficiency
    are **warnings**.

11. **Coverage level precedence: disputed > stale > reproduced > single.** A wrong number is
    worse than an old one, and a cell reproduced on an engine three minors ago tells you
    nothing about today. Disputes are only computed within one `config_id` + `workload_id`
    group and only across two or more distinct logins — different flags are _supposed_ to give
    different numbers, and one person running something twice is not a dispute. Thresholds
    come from `site.coverage` (`stale_minors_behind` 2, `disputed_deviation_pct` 25,
    `reproduced_min_logins` 2). `computeCoverage` returns only cells that have runs; a cell id
    that is absent is `none` by definition.

12. **Contributor scoring.** DESIGN §8.6 is not in the repository copy of the design document,
    so the algorithm is defined here and its weights live in `site.scoring`: filling an empty
    cell 10, reproducing somebody else 6, an additional run 2, plus 0.5 per sweep point, 2 per
    gotcha, 4 for an eval run and 5 for filling a cell that was on the wanted queue. Each
    further run by the same contributor **in the same cell** is multiplied by `per_cell_factor`
    (0.5) to the power of their prior runs there, floored at `min_factor` (0.1); different
    cells never diminish each other. Registering a new engine (40), a new device (25), a new
    model (15), a new quantization (5) or a new workload (8) is credited from git history by
    the build and is not diminished. Runs are scored in submission order, ties broken by
    `run_id`, so the output does not depend on input order.

13. **Site config shape.** `site/config.json` grew four blocks this document did not name:
    `coverage` (staleness and dispute thresholds, key metric preference order), `plausibility`
    (tolerance factors), `wanted` (gap ranking weights) and `packet` (packet version, the
    harness and validate commands, issue labels). `evidence_colors` is keyed by the five
    coverage levels.

14. **Workload kinds and the `sweep` block.** `sweep` is required for `kind: "sweep"` and
    permitted for `longctx` and `prefill`, which frequently walk an axis (`input_tokens`)
    without being a parallelism sweep. `eval` additionally requires `dataset_id`. The two
    long-context seed results are filed as `kind: "longctx"` with a `sweep` array on the axis
    `input_tokens`, against workload `longctx-depth-sweep-v1`; if that workload is published
    as `kind: "sweep"`, the seed files must change to match, because the validator requires
    `result.kind` to mirror `workload.kind`.

15. **`quant.size_gb` is decimal GB.** The measured footprints in `docs/seed-notes.md` are
    quoted in GiB in places; the registry records the figure the bandwidth arithmetic in those
    notes uses (BF16 Qwen3.8-27B = 55.6, giving the stated ~4.9 tok/s ceiling at 273 GB/s).
    Where a number was recorded as GiB and converted, the quant's `notes` says so.

16. **Golden vector file shape.** `schemas/fixtures/fingerprint-vectors.json` and
    `id-vectors.json` are objects, not bare arrays: `{ "$comment", "spec", "vectors": [...] }`
    for fingerprints and `{ "$comment", "spec", "cell_id": [...], "run_id": [...],
"engine_minor": [...], "result_path": [...] }` for ids. Each fingerprint vector is
    `{ name, description?, equivalence_group?, input, expected }`, where `input` is exactly
    the argument object `canonicalizeArgs` takes (snake_case, so TypeScript and Python can eat
    the fixture unchanged) and vectors sharing an `equivalence_group` must produce the same
    `config_id`. Expected values are generated by
    `packages/core/scripts/gen-fingerprint-vectors.mjs` / `gen-id-vectors.mjs` from the
    reference implementation and are never typed by hand — but a failing vector is a
    regression in the algorithm, not a stale fixture, and must never be "fixed" by
    regenerating.

17. **Wave-1 scripts under `packages/core/scripts/`.** `check-registries.mjs` (ajv 2020
    validation, id recomputation, referential integrity, plausibility) and `wrap-result.mjs`
    (fills the computed fields of a draft result and writes it to its canonical path) are
    stand-ins for `tools/validate` and `atlas-bench submit`. They are kept, not deleted, when
    wave 2 lands: the generators are still the way to add a golden vector.

18. **Root scripts delegate to the workspace.** `pnpm validate` / `build:data` / `packet` run
    `pnpm --filter @atlas/tools run …`, and `dev` / `build` chain into
    `pnpm --filter @atlas/app run …`. `tools/package.json` and `app/package.json` currently
    hold placeholder scripts that print "not implemented yet"; wave 2 replaces those packages
    wholesale and the root needs no change.

19. **`@atlas/core` hashes synchronously.** `crypto.subtle.digest` is async, and the config
    explorer recomputes `config_id` on every keystroke. `@noble/hashes` gives a sync,
    dependency-light SHA-256 that works identically in the browser and in Node; the package
    contains no filesystem, network or Node-only API.

20. **Model ids are Hugging Face repo ids (2026-08-23, Khaled).** `model_id` is the HF repo id
    verbatim and case-preserved (`Qwen/Qwen3.8-27B`), because a fine-tune or re-upload by another
    account is a different model. Directories nest one extra level (`models/<owner>/<name>/`,
    `results/<engine>/<owner>/<name>/<hardware>/`). `cell_id` hashes the verbatim id. The app
    encodes the slash as a path segment (`#/models/Qwen/Qwen3.8-27B`). Case-only collisions between
    model directories are rejected by the validator (case-insensitive filesystems). Quant records keep
    short ids unique within the model and carry the full `hf_id` of the weights repo.

21. **No seed results; measurements run on contributors' machines only.** The 8 hand-entered seed
    files were removed; `docs/reference-measurements.md` keeps the numbers as reference.
