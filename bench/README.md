# atlas-bench

The Inference Atlas benchmark harness. It measures an OpenAI-compatible inference server and
writes **one JSON file per run** into `results/<engine>/<model>/<hardware>/<run_id>.json`.

Everything it emits is either measured, computed from the registries in this repo, or copied
from the task packet. Nothing is guessed — unknown values stay `null`.

- Contract: [`docs/SPEC.md`](../docs/SPEC.md) (§2 ids, §3 canonicalization, §4 result shape,
  §7 packet, §8 harness). When this README and the SPEC disagree, the SPEC wins.
- Python ≥ 3.11, managed with [uv](https://docs.astral.sh/uv/).

```bash
cd bench
uv sync                 # creates .venv and installs the harness + dev tools
uv run atlas-bench --help
```

## Attach to a running engine in three commands

The common path: you (or someone else) already started the engine; the harness only measures
it. This works for **every** engine, including ones without an adapter.

```bash
# 1. Who is this machine? (never type specs by hand)
uv run atlas-bench hwinfo

# 2. What am I measuring? (writes task.json)
uv run atlas-bench packet \
  --cell 'vllm@0.27.1/Qwen/Qwen3.8-27B/fp8/nvidia-gb10-dgx-spark' \
  --workload serve-chat-c8-i1k-o256-v1 \
  --arg max-model-len=262144 --arg gpu-memory-utilization=0.44 \
  --arg enable-prefix-caching=true \
  --out task.json

# 3. Measure it
uv run atlas-bench run --spec task.json --base-url http://127.0.0.1:8000 --out ../results
```

Then validate and submit:

```bash
uv run atlas-bench validate ../results/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark/*.json
uv run atlas-bench submit --dir ../results/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark --draft
```

## Attaching to a server with its own model names

`model.id` is an identity; the name a _server_ answers to is a separate string. LM Studio
serves the repo `google/gemma-4-E2B-it` under the key `google/gemma-4-e2b`; vLLM answers to
whatever `--served-model-name` said. Put that key in **`model.served_model_id`** (the older
spelling `served_name` is still accepted):

```jsonc
{
  "packet_version": 1,
  "engine": {
    "id": "lmstudio",
    "version": "0.4.21",
    "install": { "method": "app" },
    "base_url": "http://localhost:1234/v1",
  },
  "model": {
    "id": "google/gemma-4-E2B-it", // identity: hashed, pathed, validated
    "quant_id": "mlx-4bit",
    "hf_id": "google/gemma-4-E2B-it",
    "served_model_id": "google/gemma-4-e2b", // transport: the OpenAI `model` field
    "dtype": "auto",
  },
  "hardware": { "id": "apple-m2-max-32gb", "count": 1 },
  "args": {},
  "workloads": ["eval-format-v1"],
  "request": { "temperature": 0, "seed": 42 },
}
```

```bash
uv run atlas-bench run --spec task.json --base-url http://localhost:1234/v1 --out ../results
```

What the harness does with it:

- sends `served_model_id` verbatim as the `model` field, and warns
  (`served-model-not-advertised`) if `/v1/models` does not list it — it still sends it, since
  some servers load on demand;
- without one, it looks for `model.id` in `/v1/models` **case-insensitively**, and only then
  falls back to the first advertised model — saying so (`served-model-guessed`) when more
  than one is loaded;
- records the resolved key, everything `/v1/models` advertised, the base URL and whether the
  server was already running in `raw.payload.engine_endpoint`, so a run against the wrong
  model can be spotted after the fact;
- records `serve_command: null` in attach mode. The harness did not start that server and
  does not claim to know how it was started. (`atlas-bench serve` still prints and runs a
  real command, and with the `lms` CLI present the LM Studio adapter can `lms load` the key.)

`stream_options: {"include_usage": true}` is sent by default; a server that rejects it —
LM Studio answers 400 without naming the field — gets one automatic retry without it, after
which token counts come from counting streamed deltas. The run never fails over this.

## Full auto path (harness starts the engine)

```bash
uv run atlas-bench serve --spec task.json          # pulls the image, starts it, waits for /health
uv run atlas-bench run   --spec task.json --out ../results
```

`serve --engine-adapter-only` prints the exact command and base URL without starting
anything — useful to paste into a terminal on a box where you want to keep control.

Adapters live in `atlas_bench/engines/`: `vllm`, `sglang`, `llamacpp`, `ollama`, `mlx-lm`,
`tensorrt-llm`, `tgi`, `lmstudio` (attach + `lms load`), `exllamav3` (attach-only). An engine
without an adapter falls back to attach mode.

## Commands

| command                                                         | what it does                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hwinfo [--json] [--registry-dir DIR]`                          | captures GPU/CPU/RAM/OS from `nvidia-smi` / `rocm-smi` / `system_profiler` / `lscpu`, computes the sanitized fingerprint, prints the matched `hardware_id` **or `null` plus a ready-to-fill `hardware/<id>.json` draft** |
| `serve --spec task.json [--engine-adapter-only]`                | starts the engine via its adapter and waits for health                                                                                                                                                                   |
| `run --spec task.json [--base-url URL] [--out DIR] [--dry-run]` | runs every workload in the packet, writes result files, prints a summary table                                                                                                                                           |
| `validate FILE...`                                              | local pre-flight: schema, recomputed ids, filename/path, referential integrity, plausibility (a port of `packages/core/src/plausibility.ts`, so passing here means passing `pnpm validate`)                              |
| `submit --dir DIR [--draft]`                                    | branch `result/<engine>-<model>-<hardware>-<short>`, commits **only** result files, `gh pr create --label results`                                                                                                       |
| `packet --cell ...`                                             | prints the agent task packet (SPEC §7) for a cell                                                                                                                                                                        |
| `wrap raw.json --spec task.json`                                | wraps `vllm bench serve` / SGLang `bench_serving` JSON into a result file                                                                                                                                                |
| `restamp FILE... --build REF`                                   | names the build behind an already-written result, recomputes `config_id`/`run_id` and moves the file (the cell is unchanged); for results written before `engine.build` existed                                          |

Useful `run` flags: `--gotcha "text"` (repeatable), `--notes "ambient 22C, box idle"`,
`--no-telemetry`, `--tokenizer <hf-id>`, `--login <github-login>`.

## Model ids are Hugging Face repo ids

`model_id` is the HF repo id, **verbatim and case-preserved**, with exactly one slash:
`Qwen/Qwen3.8-27B`, `google/gemma-4-E2B-it`. A re-upload or a fine-tune under another
account is a different repo and therefore a different model (SPEC §2, decision 20). Nothing
in the harness lowercases or kebab-cases it — it is what `cell_id` hashes, what the registry
directory is, and what the result path is built from.

Consequences you will notice:

- registries nest one level deeper: `models/<owner>/<name>/{model.json,quants/<q>.json}`;
- result paths do too: `results/<engine>/<owner>/<name>/<hardware>/<run_id>.json`;
- `model.json.hf_id` must equal `id`, and so must a result's `model.hf_id`. The **weights**
  repo is a different thing and lives in the quant record — usually somebody else's account,
  `lmstudio-community/gemma-4-E2B-it-MLX-4bit`. That is what an engine is handed to serve
  (a packet may carry it as `model.quant_hf_id`); serving the base repo when the packet says
  `mlx-4bit` would benchmark different weights than the result claims;
- two model directories that differ only by case are a validation error — on macOS and
  Windows they are one directory and one of them silently wins;
- git branches cannot hold a slash, so `submit` uses a **slug** — lowercased, every character
  outside `[a-z0-9.-]` replaced by `-` (`Qwen/Qwen3.8-27B` → `qwen-qwen3.8-27b`). The slug is
  used for branch names and nothing else; it is never written into a result file.
- `--cell` takes the model id as two segments:
  `lmstudio@0.4.21/google/gemma-4-E2B-it/mlx-4bit/apple-m2-max-32gb`.

## How results are named

```
results/<engine_id>/<owner>/<name>/<hardware_id>/<run_id>.json
```

- `config_id` = `sha256(canonical)[:16]` where _canonical_ is the normalized non-default
  engine configuration (SPEC §3)
- `cell_id` = `sha256("model|quant|hardware|count|engine|engine_minor")[:12]`
- `run_id` = `<config_id>--<workload_id>--<sha256("<login>|<started_at>")[:6]>`
- the filename is exactly `<run_id>.json` — the validator recomputes all of it

The canonical string is built by `atlas_bench/canonical.py`, a byte-for-byte port of
`packages/core/src/canonical.ts`: aliases resolved, defaults dropped, values normalized
(booleans `true`/`false`, numbers shortest round-trip with at most 6 decimal places, nested
objects as compact JSON with sorted keys), the pseudo params `@quant=` and `@dtype=`
prepended, keys sorted by byte order, joined `k=v;k=v`. Both implementations are tested
against `schemas/fixtures/fingerprint-vectors.json`.

## What gets measured

Token counts come from the engine's `usage` block (`stream_options: {"include_usage": true}`).
If an engine does not report usage, the harness falls back to its `/tokenize` endpoint, then
to a local tokenizer (only with `--tokenizer`), then to counting streamed deltas. A generic
tokenizer is never assumed for an arbitrary model.

Metric definitions (also in `atlas_bench/metrics.py`):

| metric                     | formula                                             |
| -------------------------- | --------------------------------------------------- |
| `output_tok_s`             | Σ completion tokens (ok) / wall-clock duration      |
| `total_tok_s`              | Σ (prompt + completion) tokens / duration           |
| `req_s`                    | successful requests / duration                      |
| `prefill_tok_s`            | Σ input tokens / (Σ TTFT / concurrency)             |
| `ttft_ms`                  | first content delta − request start                 |
| `tpot_ms`                  | (e2e − ttft) / (completion tokens − 1), per request |
| `itl_ms`                   | gaps between consecutive content deltas, pooled     |
| `decode_tok_s_per_request` | (completion tokens − 1) / (e2e − ttft), per request |

A request whose whole completion arrived in a single delta reports no `tpot_ms` and no
`decode_tok_s_per_request`: with one chunk there is no inter-token interval to measure, and
`(tokens - 1) / ~0s` would put an invented four-digit number into a published metric. TTFT and
end-to-end latency are still real for those requests.

Percentiles interpolate linearly between neighbouring ranks (numpy default). Warmup requests
are excluded from every aggregate. With `repeat > 1` the **median iteration** by
`output_tok_s` is reported and all iterations are kept in `raw.payload`.

Telemetry (1 Hz, background thread): `nvidia-smi --query-gpu=utilization.gpu,memory.used,
power.draw,temperature.gpu,clocks_throttle_reasons.active`, `rocm-smi` on AMD, `psutil` for
host RAM. On macOS `powermetrics` needs root, so unless the harness already runs as root
`power_avg_w` is `null` — a guessed wattage is worse than no wattage.

## Workloads

| kind      | what it does                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serving` | fixed concurrency, fixed input/output lengths; `dataset_buckets` filters the prompt lengths                                                                           |
| `sweep`   | repeats the serving measurement along `concurrency` (or `input_tokens`) and **stops escalating** when `success_rate` drops below the threshold, recording the failure |
| `prefill` | large input, one output token → `prefill_tok_s` and TTFT; haystack-backed workloads send real documents, not filler                                                   |
| `longctx` | needle-in-a-haystack per (context length, depth); headline metrics = longest fully successful context                                                                 |
| `eval`    | dataset accuracy → `scores` with `by_category` / `by_difficulty` / `items`                                                                                            |

Workload parameters the runners read, beyond the obvious ones:
`dataset_buckets`, `dataset_categories`, `dataset_target_tokens`, `timeout_s`, `reasoning`
(`"default"` means "do not touch the engine's setting"), `requests_per_concurrency` (a sweep
point runs `max(num_requests, concurrency × requests_per_concurrency)` requests),
`group_by` / `shuffle` / `warmup_per_group` (the shared-prefix workload sends all rows of one
prefix back to back and excludes the cold request per group), `needle_check` / `needle_depth`.
An eval's output cap is `eval.max_output_tokens`.

### What the datasets contract obliges the harness to do

- **`shared_prefix` is sent as a leading system message.** Dropping it turns a prefix-caching
  measurement into a different workload.
- **Long-context rows carry the question only.** `haystack-v1` and `eval-longctx-v1` store
  _recipes_; the document is rebuilt with the dataset's own `build.py` and the rebuild is
  checked against the recorded `sha256`. Sending the question alone is not a smaller
  measurement, it is a wrong one.
- **The row's own `scorer` wins** over the workload's `eval.scorer`, which is only a default —
  several datasets mix scorers. `code-exec` (workload vocabulary) and `code_exec` (row
  vocabulary) are the same scorer.
- **Tool rows** send `meta.tools` with `tool_choice: "auto"` and score `tool_calls[0]`;
  `answer.tool_call: null` is correct only when no call was made at all.
- **Vision rows** attach `row.image` as a `data:image/…;base64,…` part next to the text.
- **A missed needle is a failed request** in a `longctx` workload: it lowers `success_rate`
  and adds a `failures[]` entry with category `malformed-output`, while the request's timing
  numbers are still reported.
- For `kind: eval`, all three names an eval workload's `metrics_required` lists —
  `accuracy`, `avg_latency_ms` and `success_rate` — live in `scores`. `success_rate` is the
  share of requests that _completed at all_, independent of whether the answers were right,
  and it is mirrored in the reduced request-layer `metrics` block. A malformed answer, a
  refusal or a preamble where one word was asked for is a wrong answer (it lowers
  `accuracy`); a timeout, a 5xx or a context overflow is a failed request (it lowers
  `success_rate`, appears in `failures[]`, and is excluded from `scores.items` because it
  could not be judged at all).

Answer extraction, applied to the raw output before every scorer except `instruction`:
drop `<think>…</think>` → drop code fences, keep the content → keep the capture of the last
`Answer:` line → strip whitespace, matching quotes and one trailing `.`/`!`.

Scorers: `exact` (+ `meta.answer_aliases`), `numeric` (last number, absolute tolerance from
`meta.tolerance`), `mc`, `contains` (`{all, any}`, an entry may be a list of alternatives),
`json` (`meta.match`, `meta.array_order`), `code-exec` (`meta.timeout_s`), `needle`,
`instruction`, `vision`, `judge` (stub — judged items are recorded with `scored: false` until
a judge model is pinned).

`instruction` does not re-implement the rule DSL: it imports
`datasets/eval-instruction-v1/rules.py`, the normative implementation, and evaluates it
against the **raw** output. A test asserts the two agree on every sampled row.

`code-exec` runs the candidate in a subprocess with `python -I`, a cleared environment, the
row's timeout and an address-space limit. It is isolation, not a sandbox — do not point it at
untrusted models on a machine you care about.

## For agents

1. `uv run atlas-bench hwinfo --json` — if `hardware_id` is `null`, add the printed `draft`
   as `hardware/<id>.json` **first** and say so in the PR. Never guess a hardware id.
2. `uv run atlas-bench run --spec task.json` — one result file per workload.
3. `uv run atlas-bench validate <files>` then `pnpm validate` at the repo root.
4. `uv run atlas-bench submit --dir <dir>` — branch, commit (result files only), PR with the
   `results` label.

Provenance is filled automatically: the GitHub login comes from `--login`,
`ATLAS_GITHUB_LOGIN`, `gh api user` or `git config github.user` (in that order). Set
`ATLAS_AGENT_NAME` / `ATLAS_AGENT_MODEL` and `provenance.method` becomes `agent` with the
agent block filled in. `github_user_id`, `commit` and `pr` are left `null` — CI stamps them.

Rules that the harness enforces rather than trusts:

- it refuses to submit when a _tracked_ file outside `results/` has been modified (untracked
  scratch files such as your `task.json`, or a brand-new `hardware/<id>.json`, are fine — the
  commit only ever contains the files passed to `git add`)
- it refuses to run without a resolvable GitHub login (`run_id` depends on it)
- it records every deviation (missing dataset, unknown engine version, thermal throttling,
  warmup outlier, OOM, context overflow) as a `gotcha` instead of hiding it

## Environment

| variable                                | effect                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ATLAS_REPO`                            | checkout to read registries from and write results into (otherwise discovered by walking up from the cwd, or `--registry-dir`) |
| `ATLAS_GITHUB_LOGIN`                    | provenance login when `gh` is not authenticated                                                                                |
| `ATLAS_AGENT_NAME`, `ATLAS_AGENT_MODEL` | set `provenance.method` to `agent` and fill the agent block                                                                    |
| `HF_HOME`                               | host path mounted into the vLLM / SGLang / TGI containers                                                                      |

## Development

```bash
uv run pytest          # unit tests, no network, no model downloads
uv run ruff check .    # lint
uv run ruff format .   # format
```

`tests/test_corpus.py` and `tests/test_corpus_e2e.py` run against the real `datasets/` and
`workloads/` in the checkout (and skip when they are absent): every dataset loads, every
workload resolves to a runner, every scorer accepts each row's own reference answer and
rejects an obviously wrong one, the reference code solutions pass their own tests, the
instruction scorer agrees with `rules.py`, and the haystack recipes rebuild to their recorded
digests. Every workload kind is then run end to end against a fake streaming server.

Tests cover canonicalization vectors (including the shared fixture file when present), id
computation, scorers, metric aggregation from synthetic traces, error categorization, hwinfo
parsing from recorded tool output, the result path, packet round-trip, and a full serving run
against a fake streaming OpenAI server (`httpx.MockTransport`) that produces a valid result
file. Nothing in the test suite talks to a real engine.
