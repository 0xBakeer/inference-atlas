# Contributing

Thank you — the whole point of this project is that it belongs to whoever fills it in.

There are three ways to contribute, in increasing order of effort and decreasing order of how
much we have to trust you.

Before anything else, the one structural fact: **every measurement runs on the contributor's
own machine.** CI validates the JSON and builds the site; it never starts an engine and never
benchmarks anything, and there is no seed data. You (or your agent) run it locally and open
the pull request with the result files — that pull request is the contribution.

## 1. Run a measurement (the main one)

1. Open the site, find a grey square, press **Add**.
2. Pick a tab:
   - **Agent prompt** — paste into Claude Code, Codex, opencode or whatever you use. It is
     self-contained: install, serve, run, validate, PR.
   - **Shell** — the same thing as commands, if you would rather drive it yourself.
   - **Packet (JSON)** — `task.json` for `atlas-bench`.
   - **Issue** — open a pre-filled issue if you have the hardware but not the time.
3. Run it, then open a pull request.

Or from a clone:

```bash
git clone https://github.com/Inference-Atlas/inference-atlas.git && cd inference-atlas
pnpm install
uv run atlas-bench hwinfo --json            # what am I?
pnpm packet -- '{"engine_id":"vllm","engine_version":"0.27.1","model_id":"Qwen/Qwen3-8B","quant_id":"fp8","hardware_id":"nvidia-rtx-4090","workload_ids":["serve-single-i256-o256-v1"]}'
uv run atlas-bench run --spec task.json
pnpm validate
gh pr create --base main --label results    # the last step is yours, not CI's
```

`model_id` is the Hugging Face repo id, verbatim: `Qwen/Qwen3-8B`, `google/gemma-4-E2B-it`.
It is the only id in the repository that is not lowercase kebab-case, and it is two directory
levels wherever it appears — `models/Qwen/Qwen3-8B/model.json`,
`results/vllm/Qwen/Qwen3-8B/nvidia-rtx-4090/<run_id>.json`.

`AGENTS.md` is the full contract and applies to humans too. The short version:

- Your result files are yours. Nobody else's are. CI enforces it.
- Metrics you did not measure stay `null`. Never invent a number, never round one up.
- Failures are contributions. Report the OOM, the crash, the engine that would not start.
- Do not silently lower the configuration to make it fit — record what happened, then record
  what did fit as a separate run.
- Run on an idle machine and say in `provenance.notes` what else was going on.

## 2. Widen the registry

Adding a GPU, a model, a quantization or a whole engine is a pull request that adds a JSON
file — never a code change. `AGENTS.md` has the field-by-field guidance, including the rule
that matters most: **if you are not sure of a specification, write `null` and say why.** The
plausibility checks are derived from those numbers.

A model goes to `models/<owner>/<name>/model.json` under its Hugging Face repo id, with
`hf_id` equal to `id`; its quantizations go to `models/<owner>/<name>/quants/<quant-id>.json`
with a short lowercase id (`fp8`, `mlx-4bit`, `gguf-q4-k-m`) and the `hf_id` of whichever
repository — official or community — actually holds those weights.

## 3. Work on the code

```bash
pnpm install
pnpm test          # vitest across the workspace
pnpm typecheck
pnpm validate      # every JSON file against its schema, ids recomputed, physics checked
pnpm dev           # compile the data, then the app on localhost
```

Layout:

| path            | what                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core` | shared TypeScript: types, canonicalization, ids, plausibility, coverage, scoring, packets. Runs in the browser and in Node, no filesystem, no network. |
| `tools/`        | Node CLIs: validate, build, packet, ingest.                                                                                                            |
| `app/`          | the Vite + Lit 3 site.                                                                                                                                 |
| `bench/`        | the Python harness, `atlas-bench` (uv, Python ≥ 3.11).                                                                                                 |
| `schemas/`      | JSON Schema for every data kind, plus the golden vectors.                                                                                              |

Two things to know before changing anything:

**Canonicalization is a contract.** `packages/core/src/canonical.ts` and
`bench/atlas_bench/canonical.py` must produce identical output, and both are tested against
`schemas/fixtures/fingerprint-vectors.json`. Changing the algorithm changes every
`config_id` in the repository, so it needs a SPEC change, a coordinated update of both
implementations and regenerated vectors. If a golden vector starts failing, that is a
regression, not a stale fixture.

**Registries are data.** If you find yourself adding an `if (engine === 'vllm')` to make
something work, the answer is a field in `engines/vllm/meta.json` instead.

## Code style

TypeScript strict, ESM, Prettier defaults from `.prettierrc`, ESLint flat config. Match the
code that is already there: same idioms, same naming, comments that explain _why_ rather than
restating the line below. Tests live next to what they test (`src/foo.ts` → `src/foo.test.ts`).

## Licence

Code is MIT. Data — everything under `hardware/`, `engines/`, `models/`, `workloads/`,
`datasets/` and `results/` — is CC BY 4.0 (`DATA_LICENSE`). By contributing you agree to
those terms and confirm that you actually ran what you are reporting.
