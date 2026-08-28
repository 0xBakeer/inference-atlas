# Workloads

A workload is a pinned answer to "what exactly was run". One JSON file per
workload, schema in [`schemas/workload.schema.json`](../schemas/workload.schema.json),
shape summarised in SPEC §4.

A result is only comparable to another result when both name the same
`workload_id`. That is the whole reason this directory exists: the model, the
quantization, the engine and the flags are recorded in the result, and the
_question that was asked of them_ is recorded here.

## Immutability

**A published workload is never edited.** Not the concurrency, not the number of
requests, not the dataset it points at, not a typo in a number. Every existing
result that references it was produced under the old definition, and silently
changing it turns those numbers into a lie.

`immutable: true` and the mandatory `-vN` suffix say so in the data. The only
edits ever allowed on a published file are the ones that cannot change what runs:
`name`, `description`, `notes`.

### Proposing a v2

1. Copy the file to `<same-name>-v2.json` and change `id` to match the filename.
2. Set `"supersedes": "<the v1 id>"`.
3. Change what you meant to change, set `created` to today.
4. Leave the v1 file exactly as it is. It keeps its results; the site can show
   them side by side and mark the v1 cells stale rather than wrong.
5. If the change is really "the dataset changed", the dataset needs a `-v2` too
   (see [`datasets/README.md`](../datasets/README.md)) — a workload pointing at
   different bytes is a different workload.

Naming: `<kind>-<shape>-v<N>`, lower-case kebab, with the shape readable at a
glance (`c8` = concurrency 8, `i1k` = ~1k input tokens, `o256` = 256 output
tokens).

## Kinds

| kind      | what it measures                                           | runner    | required shape                             |
| --------- | ---------------------------------------------------------- | --------- | ------------------------------------------ |
| `serving` | steady-state throughput and latency at a fixed concurrency | `serving` | `sweep` and `eval` are null                |
| `sweep`   | one axis walked, a metric block per point                  | `sweep`   | `sweep` has exactly one axis               |
| `prefill` | time to first token on a long input, almost no decode      | `prefill` | tiny `output_tokens`                       |
| `longctx` | behaviour as the prompt grows, with a retrieval check      | `longctx` | may carry a `sweep` and/or an `eval` block |
| `eval`    | capability, scored per item                                | `eval`    | `eval` and `dataset_id` required           |

`metrics_required` lists the metric paths a result must carry non-null. Dotted
paths address into a distribution (`ttft_ms.p50`). For `kind: eval` the three
required names — `accuracy`, `success_rate`, `avg_latency_ms` — live in the
result's `scores` block rather than in `metrics`; `success_rate` there means "the
share of requests that completed at all", independently of whether the answers
were right.

## All workloads

| id                                 | kind    | dataset                    | shape                                         |
| ---------------------------------- | ------- | -------------------------- | --------------------------------------------- |
| `serve-single-i256-o256-v1`        | serving | `prompts-mixed-v1`         | c1, n=50, in≈256, out=256                     |
| `serve-short-c16-i128-o128-v1`     | serving | `prompts-mixed-v1`         | c16, n=320, in≈128, out=128                   |
| `serve-chat-c8-i1k-o256-v1`        | serving | `prompts-mixed-v1`         | c8, n=200, in≈1k, out=256                     |
| `serve-chat-c32-i1k-o256-v1`       | serving | `prompts-mixed-v1`         | c32, n=400, in≈1k, out=256                    |
| `serve-chat-c64-i1k-o256-v1`       | serving | `prompts-mixed-v1`         | c64, n=640, in≈1k, out=256                    |
| `serve-long-c4-i8k-o512-v1`        | serving | `prompts-mixed-v1`         | c4, n=40, in≈8k, out=512                      |
| `serve-code-c8-i2k-o1k-v1`         | serving | `prompts-code-v1`          | c8, n=160, in≈2k, out=1k                      |
| `serve-prefix-c16-v1`              | serving | `prompts-shared-prefix-v1` | c16, n=200, grouped by prefix                 |
| `sweep-parallel-1-32-i512-o256-v1` | sweep   | `prompts-mixed-v1`         | concurrency 1,2,4,8,16,32                     |
| `sweep-parallel-1-64-i1k-o256-v1`  | sweep   | `prompts-mixed-v1`         | concurrency 1,2,4,8,16,32,64                  |
| `prefill-8k-v1`                    | prefill | `haystack-v1`              | c1, n=10, in=8k, out=16                       |
| `prefill-32k-v1`                   | prefill | `haystack-v1`              | c1, n=10, in=32k, out=16                      |
| `prefill-128k-v1`                  | prefill | `haystack-v1`              | c1, n=10, in=128k, out=16                     |
| `longctx-depth-sweep-v1`           | longctx | `haystack-v1`              | input_tokens 1k…256k, out=256, needle checked |
| `longctx-needle-32k-v1`            | longctx | `eval-longctx-v1`          | c1, n=6, in=32k, needle scored                |
| `longctx-needle-128k-v1`           | longctx | `eval-longctx-v1`          | c1, n=6, in=128k, needle scored               |
| `eval-math-v1`                     | eval    | `eval-math-v1`             | `numeric`, max_out 4096                       |
| `eval-reasoning-v1`                | eval    | `eval-reasoning-v1`        | `exact` (rows may be `mc`), max_out 2048      |
| `eval-code-v1`                     | eval    | `eval-code-v1`             | `code-exec`, max_out 4096                     |
| `eval-knowledge-v1`                | eval    | `eval-knowledge-v1`        | `mc`, max_out 2048                            |
| `eval-instruction-v1`              | eval    | `eval-instruction-v1`      | `instruction`, max_out 2048                   |
| `eval-json-v1`                     | eval    | `eval-json-v1`             | `json`, max_out 2048                          |
| `eval-tools-v1`                    | eval    | `eval-tools-v1`            | `json` on `tool_calls[0]`, max_out 2048       |
| `eval-vision-v1`                   | eval    | `eval-vision-v1`           | `vision`, max_out 2048                        |
| `eval-multilingual-v1`             | eval    | `eval-multilingual-v1`     | `contains`, max_out 2048                      |
| `eval-longctx-v1`                  | eval    | `eval-longctx-v1`          | `needle`, max_out 1024, c1                    |
| `eval-format-v1`                   | eval    | `eval-format-v1`           | `exact`, max_out 256                          |

## Conventions a runner must honour

- **`params` is the contract, `description` is prose.** Anything a runner needs is
  a key in `params`, never only in the text.
- **`input_tokens` is nominal.** It says which prompts to pick, not what the
  tokenizer will produce. Record the real count in `metrics.input_tokens_total`.
- **`dataset_buckets`** (serving/sweep) filters `prompts-*` rows by length bucket;
  **`dataset_categories`** and **`dataset_target_tokens`** filter eval rows.
- **Sweep points.** For the two parallelism sweeps, requests per point are
  `max(params.num_requests, concurrency * params.requests_per_concurrency)`, so a
  low-concurrency point is not dominated by warmup. `params.concurrency` is the
  first point of the axis and is otherwise ignored.
- **`serve-prefix-c16-v1`** must send all rows of one `prefix_id` back to back
  (`params.group_by`), must not shuffle, and excludes `warmup_per_group` requests
  per group from the aggregate. Run it twice on the same engine, with and without
  the prefix-cache flag, and compare `ttft_ms`.
- **`longctx-depth-sweep-v1`** checks the needle at every point. A wrong needle
  answer is a failed request — it lowers `success_rate` and adds a `failures[]`
  entry with category `malformed-output`. A point that exceeds the served
  `max-model-len` is recorded as a failure with category `context-overflow`, never
  omitted, because "did not fit" is a result.
- **Eval concurrency does not change the score**, only the wall clock. It is 4
  everywhere except `eval-longctx-v1`, which runs at 1 to keep KV cache pressure
  honest.
- **`params.reasoning: "default"`** means "leave the engine's own default alone".
  Whatever it was, record it in the result's `args` — reasoning settings move eval
  scores and latency more than most flags.
- **Scorer names.** `eval.scorer` uses the kebab-case vocabulary of
  `workload.schema.json` (`code-exec`); dataset rows use the snake_case scorer
  module name from SPEC §8 (`code_exec`). They mean the same thing. Always prefer
  the row's own `scorer` when a dataset mixes them.

## Adding a workload

A new workload is a PR that adds one file. Before writing it, check the table
above: a workload that differs from an existing one only in `num_requests` splits
the coverage map for no gain. Good reasons to add one: a new axis (a concurrency
the sweeps do not reach), a new dataset, or a shape that models a real deployment
nobody has captured yet.

Checklist:

- id ends in `-v1`, filename equals `id + ".json"`;
- `dataset_id` exists under `datasets/`;
- `metrics_required` only names metrics the runner can actually fill for that kind;
- `immutable: true`, `created` today, `supersedes` null;
- `pnpm validate` passes.
