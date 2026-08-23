# Inference Atlas

**A community owned map of LLM inference engine configurations, hosted entirely on GitHub Pages.**

Working title. Alternatives: *ServeBench*, *ConfigAtlas*, *The Serving Grid*, *tok/s.dev*.

Status: original design document (vision). The binding implementation contract is `docs/SPEC.md`.

---

## 1. One paragraph summary

Inference Atlas is a static web app that renders the *configuration space* of LLM serving engines (vLLM, SGLang, llama.cpp, TensorRT-LLM, MLX, TGI) as a browsable, searchable map. Every cell in that map is a combination of model, hardware, engine version, engine flags and workload. Cells that somebody has already benchmarked show real numbers, attributed to the GitHub user who ran them and the commit that added them. Cells nobody has tested show up as gaps, and the app hands you everything you need to fill the gap yourself: the exact shell command, a machine readable task packet for a coding agent, the output schema, and a one click path to a pull request. All data lives as JSON files in the same repository that serves the site. There is no backend, no database and no server cost.

---

## 2. The problem

Benchmark numbers for local inference are scattered across blog posts, Reddit threads, GitHub issues and Discord screenshots. They are almost never reproducible, because the thing that determines the result is not the model and not the GPU, it is the *combination*:

- engine and exact engine version (vLLM 0.26.1 vs 0.27.1 can differ by double digit percentages)
- quantization format and whether the hardware has a native kernel path for it
- flags like `--gpu-memory-utilization`, `--max-num-seqs`, `--enable-prefix-caching`, speculative decoding config, tensor and pipeline parallel size
- the workload itself: concurrency, input length, output length, dataset, whether prefixes are shared

Change one of those and the number changes. Almost nobody records all of them. So the same benchmark gets re-run thousands of times worldwide and the knowledge evaporates each time.

The gap this project fills is not "another leaderboard". It is **a coverage map plus a contribution funnel**. The interesting question is not "what is the fastest setup", it is "which parts of the space has nobody measured yet, and how do I measure one of them in the next twenty minutes".

---

## 3. Core design ideas

### 3.1 The configuration fingerprint

Every benchmark run is reduced to a deterministic hash of its normalized configuration. Two people who ran the same setup produce the same fingerprint, even if they wrote the flags in a different order or used an alias. This gives three things for free:

1. Deduplication across contributors.
2. A precise definition of "untested": a fingerprint with no result file.
3. Conflict detection: same fingerprint, two results, numbers far apart, so one of them is wrong or something unrecorded differs.

### 3.2 Coverage as the primary view

The landing view is not a top ten list. It is a heatmap of the space, where colour means *evidence*, not speed. Grey means nobody has tried this. That inverts the usual incentive: contributors are pulled towards gaps rather than towards re-benchmarking whatever is trending.

### 3.3 The agent task packet

Every gap can be exported as a self contained brief that a coding agent (Claude Code, opencode, Codex, an autonomous runner on somebody's idle GPU box) can execute end to end without any further human context: what to install, what to run, how to capture output, what schema to emit, where to write the file, how to validate it locally, how to open the PR. This turns idle hardware plus an agent into a contribution pipeline.

### 3.4 Engine parameters are ingested, not hand maintained

The list of supported flags per engine per version is generated automatically from the engine itself, not typed into a config file by hand.

### 3.5 Zero backend, full fork-ability

Everything is static. Any company can fork the repo, point it at their internal hardware, keep their results private and still get the whole UI.

---

## 4. Architecture

```
                 ┌──────────────────────────────────────────┐
                 │  GitHub repository (source of truth)      │
                 │  engines/ models/ hardware/ workloads/    │
                 │  datasets/ results/ (one JSON per run)    │
                 └───────────────┬──────────────────────────┘
                                 │
        ┌────────────────────────┼─────────────────────────┐
        │                        │                         │
  ingest-engines.yml       validate.yml               build-pages.yml
  (nightly, per release)   (on every PR)              (on main)
                                 ▼
                 ┌──────────────────────────────────────────┐
                 │  GitHub Pages: index.html + JS bundle     │
                 │  data/ compiled shards, fetched client side│
                 └──────────────────────────────────────────┘
```

- **Raw results stay as many small JSON files** in `main`. One file per run means two contributors never touch the same file.
- **The site consumes compiled artifacts**, not raw files.

---

## 5–17. (see original)

The remaining sections of the original design — data model, engine ingestion, web app views (atlas, config explorer, compare, pareto, timeline, contributors, registries, wanted queue), the agent task packet, contribution paths (CLI / agent packet / issue form), validation & trust (verification levels: self-reported, reproduced, ci-verified, disputed; never delete a disputed result), identity without rate limits (resolve login→user_id in CI, avatars from `avatars.githubusercontent.com/u/<id>`), scale plan (single index → shards → Parquet + DuckDB-WASM), tech stack (Lit 3 + TS + Vite, hash routing, uPlot, Vitest), roadmap (Phase 0 fingerprint → Phase 5 reach) and risks — are reflected in `docs/SPEC.md`, which supersedes this document where they differ.

Notable deviations decided on 2026-08-23:

- **Scope now includes capability evals** (math, reasoning, code, vision, instruction following, JSON, long-context needle) and **parallelism sweeps (1-2-4-8-16-32)** in addition to serving performance, because a serving number without a "did it still answer correctly under this quantization / engine" signal is incomplete. Evals are pinned workloads like everything else.
- Models are registered first, quantizations are child records referencing the model (HF style).
- Per-file ownership is enforced by CI: nobody can override another contributor's measurement.
