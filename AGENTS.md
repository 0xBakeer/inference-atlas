# AGENTS.md — the contribution contract

This file is for coding agents (and the people supervising them). If you were handed an
Inference Atlas packet, read this once, in full, before you touch anything. It is short on
purpose. `docs/SPEC.md` is the long version and wins wherever the two disagree.

## What this repository is

Inference Atlas is a map of the *configuration space* of LLM inference: model × quantization
× hardware × engine version × flags × workload. Every square that somebody has measured shows
real numbers, attributed to the GitHub user who ran them. Every square nobody has measured is
a gap, and gaps come with a packet like the one you were given.

**The repository is the database.** There is no backend. Every measurement is one JSON file
committed to `main`, and the website is a static build of those files. That has one enormous
consequence for you:

> **Every result file has exactly one owner: the person whose GitHub login is in
> `provenance.github_login`. You may add your own. You may never modify or delete somebody
> else's.** CI enforces this on every pull request.

That rule is what makes merge conflicts structurally impossible and what makes the data
trustworthy. It is not negotiable and there is no situation in which working around it is the
right call.

## The rules

1. **Only add files you own.** Your own result files under `results/`, plus registry files
   (hardware, model, quant, engine) for things that genuinely do not exist yet. Nothing else.
2. **Never edit a number by hand.** If validation fails, fix the run or fix the metadata —
   never the measurement. A hand-patched number is data corruption with extra steps.
3. **Never silently lower the configuration.** If the requested flags do not fit — OOM,
   unsupported quantization, context too long — that *is* the result. Record it as a failure
   with the actual error. Only then, as a *separate* result, record what did fit, with `args`
   showing exactly what you changed and `provenance.notes` saying why.
4. **Report failures as failures.** An OOM, a crash, a 0 % success rate, an engine that will
   not start: all of these are valid, wanted contributions. A failure you quietly dropped is
   worse than no contribution at all, because it makes the map look explored when it is not.
5. **Run on an idle box.** No other GPU work, no compile in the background, no second model
   resident unless you say so. Put the conditions in `provenance.notes`: ambient temperature
   if you know it, what else was resident, anything unusual.
6. **Capture hardware, do not type it.** `uv run atlas-bench hwinfo --json`. Never copy
   specifications from a product page into a field the capture contradicts.
7. **Leave the fields CI owns alone.** `provenance.github_user_id`, `provenance.commit` and
   `provenance.pr` are `null` when you commit. CI and the build fill them in.
8. **Record the gotchas.** If you had to know something to make the run work — a flag whose
   default is a lie, a parser name that only resolves under one spelling, a container tag
   that exists only for aarch64 — put it in `gotchas[]`. That is the part of the run that
   outlives the number.

## The command sequence

```bash
# 1. get the repository and read this file
git clone https://github.com/<owner>/<repo>.git
cd <repo>

# 2. capture the hardware truthfully
uv run atlas-bench hwinfo --json

#    If the capture matches no hardware/*.json detect rule, STOP and add the hardware file
#    first, from the captured output. Say so in the PR.

# 3. install the engine at the pinned version and fetch the weights
docker pull vllm/vllm-openai:v0.27.1        # whatever the packet says
hf download Qwen/Qwen3.8-27B-FP8

# 4. serve with exactly the flags in the packet, and wait for health
vllm serve Qwen/Qwen3.8-27B-FP8 --max-model-len 262144 --gpu-memory-utilization 0.44 ...

# 5. run the workloads (task.json is the JSON packet)
uv run atlas-bench run --spec task.json

# 6. validate locally — the same code CI runs
pnpm install
pnpm validate

# 7. branch, commit, pull request
git checkout -b result/<engine>-<model>-<hardware>-<short>
git add results/
git commit -m "results: vllm 0.27.1 qwen3.8-27b/fp8 on nvidia-gb10-dgx-spark"
git push -u origin result/<engine>-<model>-<hardware>-<short>
gh pr create --base main \
  --title "results: vllm 0.27.1 qwen3.8-27b/fp8 on nvidia-gb10-dgx-spark" \
  --label results --body-file pr-body.md
```

Branch naming: `result/<engine>-<model>-<hardware>-<first 6 of cell_id>` for measurements,
`new-hardware/<slug>`, `new-model/<slug>`, `new-engine/<slug>` for registry additions.

### The PR body

In this order, and nothing else:

1. **Cells filled** — one line each: engine + version, model/quant, hardware, workload,
   headline number.
2. **What failed** — every failure, with the actual error text. "Nothing failed" if nothing did.
3. **Gotchas** — everything you had to learn to make it work.
4. **Conditions** — what the box was doing, what else was resident, anything unusual.

Your GitHub login must equal `provenance.github_login` in every file you add.

## What a result file looks like

Full shape: `schemas/result.schema.json` and `docs/SPEC.md` §4. The parts you must get right:

- `run_id`, `config_id`, `cell_id`, `args_canonical` are **computed**, never typed. The
  harness fills them in; the validator recomputes them and fails on any mismatch. The
  filename is exactly `<run_id>.json` and the path is
  `results/<engine-id>/<model-id>/<hardware-id>/`.
- `args` is what you actually passed. Not what you meant to pass, not what the packet asked
  for if you had to deviate.
- Metrics you did not measure stay `null`. A `null` is information; a plausible-looking
  invented number is not. Filling a metric you did not measure is the single worst thing you
  can do in this repository.
- `failures[]` and `gotchas[]` are first-class content, not an afterthought.

The validator additionally checks physics: per-request decode speed cannot exceed memory
bandwidth ÷ active weight bytes (times a tolerance, and lifted by speculative decoding),
`vram_peak_gb` cannot exceed the device's memory, request counts must add up, percentiles
must run in order. If one of those fires, something in the run or the metadata is wrong —
find out which, do not paper over it.

## Adding to the registry

Adding hardware, a model, a quantization or an engine is a PR that adds a file. It is never a
code change. All of these live under CC-BY-4.0 (see `DATA_LICENSE`).

### New hardware — `hardware/<id>.json`

- `id`: lowercase kebab-case, vendor first: `nvidia-rtx-5090`, `amd-mi300x`,
  `apple-m4-max-128gb`. Apple SoC ids include the memory size, because unified memory is the
  binding constraint for inference.
- Specifications (`memory_gb`, `memory_bandwidth_gbs`, `compute.*`, `tdp_w`, `release_year`,
  `msrp_usd`) come from the vendor's published figures. **If you are not sure about a figure,
  write `null` and say why in `notes`.** A null is worth more than a guess: the plausibility
  checks are derived from these numbers, so a wrong bandwidth figure silently invalidates
  every future measurement on that device.
- Prefer *dense* tensor throughput over the marketing figure that includes structured
  sparsity, and say which you used in `notes`.
- `detect`: the strings the capture actually printed (`nvidia_smi_name`, `apple_chip`,
  `cpu_model`, `rocm_smi_name`), so the next person on the same machine is matched
  automatically.

### New model — `models/<id>/model.json`

- `id`: readable, not the Hugging Face path: `qwen3-8b`, `llama-3.3-70b`,
  `nemotron-3.5-lightning-30b-a3b`. `hf_id` carries the repo.
- `params_b`, `active_params_b`, `architecture`, `context_length`, `modalities` and `licence`
  come from `config.json` and the model card, **not from the launch blog post**.
- `active_params_b` matters more than anything else here: it is what the bandwidth
  plausibility bound is computed from. For a dense model it equals `params_b`.

### New quantization — `models/<model-id>/quants/<quant-id>.json`

- `id` follows the existing vocabulary: `bf16`, `fp8`, `nvfp4`, `mxfp4`, `awq-int4`,
  `gptq-int4`, `gguf-q4-k-m`, `mlx-4bit`, `exl3-4.0bpw`.
- `size_gb` is the resident weight size. Measure it if you can; if you estimate it, say so in
  `notes`.
- `engines` lists the engines that can load it. A result whose engine is not in that list
  fails validation, which is usually the list being wrong rather than the result.
- `source` is `official`, `community` or `self-quantized`. Community repos that you have not
  verified get a `notes` saying so.

### New engine — `engines/<id>/meta.json` + `engines/<id>/versions/<version>.json`

- `meta.json`: install methods, serve template, api flavour, health paths, `drop_params`
  (paths, ports, credentials — anything that cannot change a number), `param_aliases`,
  platforms, `quant_formats`.
- `versions/<version>.json`: the flags that exact version accepts, with their **real
  defaults**. Take them from `--help` on the actual build or from that version's docs, and
  set `extraction_method` honestly (`help`, `docs`, `hand-seeded`, `generated`).
- Defaults are load-bearing: canonicalization drops any flag whose value equals the version
  default, so a wrong default silently merges two different configurations into one
  fingerprint. When a default depends on the model rather than being a constant, write
  `null` — a null default is never dropped, which is the safe direction.

## When something does not fit

Report it. Come back with what happened, what you tried and the exact error. A packet you
could not execute, honestly reported, is more useful than a result that quietly measured
something else.
