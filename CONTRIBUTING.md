# Contributing

Thank you — the whole point of this project is that it belongs to whoever fills it in.

There are three ways to contribute, in increasing order of effort and decreasing order of how
much we have to trust you.

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
git clone https://github.com/<owner>/<repo>.git && cd <repo>
pnpm install
uv run atlas-bench hwinfo --json            # what am I?
pnpm packet -- '{"engine_id":"vllm","engine_version":"0.27.1","model_id":"qwen3-8b","quant_id":"fp8","hardware_id":"nvidia-rtx-4090","workload_ids":["serve-single-i256-o256-v1"]}'
uv run atlas-bench run --spec task.json
pnpm validate
```

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

## 3. Work on the code

```bash
pnpm install
pnpm test          # vitest across the workspace
pnpm typecheck
pnpm validate      # every JSON file against its schema, ids recomputed, physics checked
pnpm dev           # compile the data, then the app on localhost
```

Layout:

| path | what |
|---|---|
| `packages/core` | shared TypeScript: types, canonicalization, ids, plausibility, coverage, scoring, packets. Runs in the browser and in Node, no filesystem, no network. |
| `tools/` | Node CLIs: validate, build, packet, ingest. |
| `app/` | the Vite + Lit 3 site. |
| `bench/` | the Python harness, `atlas-bench` (uv, Python ≥ 3.11). |
| `schemas/` | JSON Schema for every data kind, plus the golden vectors. |

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
code that is already there: same idioms, same naming, comments that explain *why* rather than
restating the line below. Tests live next to what they test (`src/foo.ts` → `src/foo.test.ts`).

## Licence

Code is MIT. Data — everything under `hardware/`, `engines/`, `models/`, `workloads/`,
`datasets/` and `results/` — is CC BY 4.0 (`DATA_LICENSE`). By contributing you agree to
those terms and confirm that you actually ran what you are reporting.
