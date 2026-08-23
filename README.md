# Inference Atlas

**A community-owned map of LLM inference engine configurations, hosted entirely on GitHub Pages.**

> Benchmark numbers for local inference are scattered across blog posts, Reddit threads and
> Discord screenshots, and almost none of them are reproducible — because what determines the
> number is not the model and not the GPU, it is the *combination*: engine, exact version,
> quantization, flags, and the workload. Change one and the number changes. So the same
> benchmark gets re-run thousands of times worldwide and the knowledge evaporates each time.

Inference Atlas is the opposite of a leaderboard. It is a **coverage map plus a contribution
funnel**. The landing view is a heatmap of the configuration space where colour means
*evidence*, not speed — grey means nobody has tried this. The interesting question is not
"what is the fastest setup", it is "which parts of the space has nobody measured yet, and how
do I measure one of them in the next twenty minutes".

<!-- screenshot: the atlas heatmap goes here -->
<!-- screenshot: the config explorer with a live fingerprint goes here -->
<!-- screenshot: the Add-measurement packet modal goes here -->

## How it works

- **The repository is the database.** No backend, no external DB, no server cost. Every
  measurement is one JSON file committed to `main`; the site is a static build of those files.
- **One file per measurement, one owner per file.** A result records the GitHub login of
  whoever ran it, and CI rejects any pull request that touches somebody else's result. Merge
  conflicts are structurally impossible and nobody can overwrite your numbers.
- **Every configuration has a fingerprint.** Flags are normalized (aliases resolved, defaults
  dropped, values canonicalized) and hashed. Two people who ran the same setup produce the
  same `config_id` even if they wrote the flags in a different order — which gives
  deduplication, a precise definition of "untested", and conflict detection for free.
- **Everything is data.** Hardware, engines, engine versions and their flags, models,
  quantizations, workloads, eval suites, scoring weights, navigation — all JSON under the
  registries. Adding a new GPU or a new engine is a pull request that adds a file, never a
  code change.
- **Numbers are checked against physics.** You cannot decode faster than memory bandwidth
  divided by the active weight bytes allows, you cannot use more VRAM than the device has,
  request counts have to add up. Validation runs the same code in your terminal and in CI.

## Quickstart

### If you just want to look

Open the site. Nothing to install. Pick a model row and a hardware column, switch the metric,
open a run to see the exact command line and every flag it was started with.

### If you want to contribute a measurement

Find a grey square, press **Add**, and take one of the four tabs: an agent prompt, a shell
script, a JSON packet for the harness, or a pre-filled issue. Then:

```bash
git clone https://github.com/<owner>/<repo>.git && cd <repo>
pnpm install
uv run atlas-bench hwinfo --json          # identify the machine — captured, never typed
uv run atlas-bench run --spec task.json   # run the workloads, write the result files
pnpm validate                             # the same checks CI runs
gh pr create --label results
```

Read `CONTRIBUTING.md` first. The rules that matter: never invent a number, metrics you did
not measure stay `null`, failures are contributions, and you only ever add your own files.

### If you are a coding agent

Read **`AGENTS.md`**. It is the contract, and every packet points at it. Short version: only
add files you own, never edit a number by hand, never silently lower the configuration to
make it fit, report failures as failures, and record the gotchas — the gotchas are the part
of a run that outlives the number.

### If you want to work on the code

```bash
pnpm install
pnpm test        # vitest across the workspace
pnpm typecheck
pnpm validate    # every JSON file: schema, recomputed ids, plausibility
pnpm dev         # compile data + Vite dev server
```

## Repository layout

```
schemas/     JSON Schema (draft 2020-12) for every data kind, plus golden test vectors
hardware/    one file per device: specs, detection rules
engines/     per engine: meta.json, overlay.json, versions/<version>.json (the flag schema)
models/      per model: model.json + quants/<quant-id>.json
workloads/   pinned, immutable definitions of what gets run
datasets/    test data authored in this repository (synthetic, MIT)
results/     one JSON file per measurement, owned by its contributor
site/        branding, navigation, colours, scoring weights, thresholds
packages/    @atlas/core — shared types, fingerprinting, ids, plausibility, coverage, packets
tools/       node CLIs: validate, build, packet, ingest
app/         the Vite + Lit 3 site
bench/       atlas-bench, the Python harness
docs/        DESIGN.md (the vision) and SPEC.md (the binding contract)
```

## Status

Early. The schemas, the fingerprint definition, the shared core and the first measurements
are in place; the harness, the tools and the app are being built. `docs/SPEC.md` is the
authoritative description of what exists and what it must do.

## Licence

Code is [MIT](LICENSE). Data — everything under `hardware/`, `engines/`, `models/`,
`workloads/`, `datasets/` and `results/` — is [CC BY 4.0](DATA_LICENSE). No model weights and
no third-party datasets are mirrored here.
