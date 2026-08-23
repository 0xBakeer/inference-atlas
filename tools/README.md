# `@atlas/tools`

The Node side of Inference Atlas: the commands that check the repository, compile it into
what the website reads, generate contribution packets, and ingest engine flags. Everything
here is TypeScript run through `tsx` — there is no build step for this package.

The shared logic (ids, canonicalization, plausibility, coverage, scoring, packets) lives in
`@atlas/core` and is not duplicated here. `dist/` of that package is gitignored, so build it
once after `pnpm install`:

```bash
pnpm install
pnpm --filter @atlas/core run build     # the tool scripts do this for you
```

## Commands

| from the repository root                            | what it does                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm validate`                                     | schema, ids, referential integrity, physics, ownership — SPEC §5 |
| `pnpm build:data`                                   | compiles `app/public/data/*` — SPEC §6                           |
| `pnpm packet -- <spec>`                             | prints the brief for one gap — SPEC §7                           |
| `pnpm --filter @atlas/tools run ingest -- …`        | reads an engine version's flags out of the engine                |
| `pnpm --filter @atlas/tools run resolve-users -- …` | login → numeric GitHub user id                                   |
| `pnpm --filter @atlas/tools run issue-to-pr -- …`   | "Submit result" issue → result file                              |
| `pnpm --filter @atlas/tools test`                   | the tests below                                                  |
| `pnpm --filter @atlas/tools run typecheck`          | `tsc --noEmit`                                                   |

Every command takes `--root <dir>` (defaults to the repository this file is in), which is how
the tests point the same code at a temporary fixture repository.

### `validate`

```bash
pnpm validate                                     # everything, locally
pnpm validate --json                              # machine output (CI reads this)
pnpm validate --strict                            # warnings fail too
pnpm validate --changed results/a.json results/b.json \
              --pr-author octocat --base origin/main
```

What it checks, in order:

1. **Schema.** Every JSON file under `hardware/ engines/ models/ workloads/ datasets/*/dataset.json
results/ site/` against the schema its _path_ implies (ajv, draft 2020-12). A file in one of
   those directories that matches no rule is an error (`unmapped-file`) — a stray JSON file
   in `results/` is always a mistake.
2. **Recomputed identity.** `config_id`, `cell_id`, `run_id` and `args_canonical` are
   recomputed from the engine version's params, the engine meta's `drop_params` and
   `param_aliases`; the filename must equal `<run_id>.json` and the path must be
   `results/<engine>/<model>/<hardware>/`.
3. **Referential integrity.** Engine, model, quantization, hardware and workload must exist;
   `result.kind` must mirror the workload's kind; the workload's dataset must be registered;
   `quant.engines` must include the engine. A missing engine _version_ file is a warning
   (`unknown-engine-version`) rather than an error, because a run on a version nobody has
   registered yet is still a real measurement — but no defaults get dropped from its
   fingerprint, which is why you are told.
4. **Physics** (`checkPlausibility` from core): the bandwidth ceiling, VRAM against device
   memory, request counts that add up, percentiles in order, power against TDP.
5. **Duplicates and payload size.** A repeated `run_id` fails; a `raw.payload` above 100 KB
   fails unless it declares `raw.truncated: true`.
6. **Cross-check.** A result whose key metric deviates from the median of other results with
   the _same_ `cell_id + config_id + workload_id` by more than
   `site.coverage.disputed_deviation_pct` gets a `needs-review` warning listing the files it
   disagrees with. Same configuration, different numbers: somebody should look.
7. **Ownership** — below.
8. **Dataset payloads.** Files listed in `dataset.json` exist, the row count matches `count`,
   and the first 50 rows carry the fields their kind needs (`answer`/`scorer` for an eval,
   `messages`/`prompt` for prompts, and so on).

`--changed` narrows what is _reported_, never what is _loaded_: duplicate ids and
cross-result disagreements can only be found by reading the whole repository. Exit code is 1
on any error, or on any warning under `--strict`.

## How ownership is enforced

> A pull request may only add, modify or delete a result file whose
> `provenance.github_login` equals its author.

This is what makes merge conflicts structurally impossible and every number attributable.
It runs only when `--pr-author` and `--base` are both given — a contributor running
`pnpm validate` locally is not a pull request — and it needs a checkout with history
(`fetch-depth: 0`).

`git diff --name-status -M <base>...HEAD` gives the changed files; for each one under
`results/`:

| change           | checked against                               | code on failure                                     |
| ---------------- | --------------------------------------------- | --------------------------------------------------- |
| added            | the new file's `provenance.github_login`      | `ownership-added`                                   |
| modified         | the new file **and** `git show <base>:<path>` | `ownership-modified`, `ownership-modified-previous` |
| deleted          | `git show <base>:<path>`                      | `ownership-deleted`                                 |
| renamed / copied | both, with the old path                       | as above                                            |

A modification is checked on _both_ sides deliberately: without the previous version,
overwriting somebody else's file with your own login would pass. Logins are compared
case-insensitively, the way GitHub treats them.

Two more signals:

- `--allow-override` downgrades every ownership error to an `ownership-override` warning.
  `validate.yml` passes it when the pull request carries the `maintainer-override` label.
- A pull request that touches `results/` _and_ files outside it is allowed but warned about
  (`mixed-pr`), because the two kinds of change want different review.

## How provenance stamping works

`provenance.commit` and `provenance.pr` are **never** written by a contributor. They are
derived by `build` from git history and written only into the compiled copy under
`app/public/data/runs/…`; the file in `results/` stays exactly as it was committed. That is
what makes them unfakeable.

One `git log --reverse --diff-filter=A --name-only` over the whole tree yields, per path, the
commit that first added it (one process, not one per file). From that commit:

- `provenance.commit` — the full sha, plus `commit_short`
- `provenance.pr` — `(#123)` from a squash-merge subject, or `Merge pull request #123 from …`
- `provenance.merged_at` — the commit's author date

Outside a git repository (a tarball, a fresh `git init` with no commits) or under `--no-git`,
all three stay `null` and `manifest.json` says `"git": false`.

The same history is the only source for _registry_ credits in the contributor scoring: a
`hardware/*.json` file carries no login, so the adding commit's author email is used, and
only GitHub's `1234+login@users.noreply.github.com` form yields one. Anything else is skipped
rather than guessed — putting points on the wrong account is worse than awarding none.

## `build:data`

```bash
pnpm build:data                        # → app/public/data (gitignored)
pnpm build:data --out /tmp/data --no-git --json
```

Output (SPEC §6 plus three files the app asked for):

```
manifest.json     built_at, git, commit, counts, shards{path → {sha256, bytes}}
registry.json     hardware[], engines[] (meta + overlay + versions[]), models[] (with quants[]),
                  workloads[], datasets[] (meta only), site
index.json        one slim row per run, compact (no whitespace) — the first-paint fetch
coverage.json     { thresholds, cells: { cell_id → CoverageCell } }
contributors.json scored leaderboard with avatars
gaps.json         the ranked wanted queue + missing_workloads, compact
workloads.json    the workload registry with run counts and its dataset
datasets.json     dataset metadata and counts — never the rows
stats.json        the landing-page headline numbers
engines/<id>/<version>.json                    params with overlay merged
runs/<engine>/<model>/<hardware>/<run_id>.json full results with stamped provenance
```

The build refuses to run if validation finds an error: publishing data compiled from a
repository that does not validate would make the site lie.

Output is deterministic — object keys sorted recursively, arrays sorted by an explicit key —
so a rebuild with no data change produces byte-identical files apart from `built_at`. GitHub
Pages does not let us control compression, so the two largest files (`index.json`,
`gaps.json`) are written without whitespace instead.

### Which engines can run on which device

`gaps.json` and `stats.cells_possible` cross the whole registry, so they need to know that
vLLM does not run on an M2 Max. Nothing new is declared for it: the engine already lists
`platforms`, the device already has `vendor` and `kind`, and `tools/src/lib/compat.ts` maps
between them.

| device                 | platforms it can host                                  |
| ---------------------- | ------------------------------------------------------ |
| `nvidia`, gpu or soc   | `linux-cuda`, `windows-cuda`                           |
| `amd`, gpu             | `linux-rocm`                                           |
| `apple`, soc           | `macos-metal`, `macos-cpu`                             |
| `intel`, gpu           | `linux-xpu`                                            |
| any vendor, kind `cpu` | `linux-cpu`, `windows-cpu` (plus `macos-cpu` on Apple) |
| unknown vendor         | the CPU platforms                                      |

An engine fits a device when the two sets intersect. Adding a device or an engine stays a
pull request that adds a JSON file.

### How gaps are ranked

Every (model, quant) × hardware × engine × registered engine _minor_ that is compatible, minus
the cells that have runs, scored by `site.wanted.weights`: featured model/hardware/engine,
newest engine minor, never-measured model/hardware/engine/quant, completes an axis that is
already partly filled, and `requested` when `site/wanted-requests.json` (written weekly by
`wanted-snapshot.yml`) names it — plus half a point per 👍, capped at twenty.

Cells that _do_ have runs but whose evidence is `stale` or `disputed` are ranked into the same
queue with `stale_refresh` / `disputed_tiebreak`, carrying their level: re-measuring a number
two people disagree about is a better use of an hour than a square nobody cares about. Cells
that are healthy but missing a workload are listed separately in `missing_workloads`.

Which workloads a cell is expected to carry comes from `site.wanted.workloads`, falling back
to `site.featured.workloads` and then to the whole registry. Ranking against _every_ workload
would make the queue meaningless.

## `packet`

```bash
pnpm packet -- --engine vllm --version 0.27.1 --model qwen3-8b --quant fp8 \
               --hardware nvidia-rtx-4090 \
               --workloads serve-single-i256-o256-v1,eval-math-v1 \
               --args gpu-memory-utilization=0.9 --args max-model-len=32768 \
               [--dtype auto] [--hw-count 1] [--format md|json|shell|issue] [--out task.json]

pnpm packet -- --new-hardware "RTX 5080"
pnpm packet -- --new-model Qwen/Qwen3-4B
pnpm packet -- --new-engine ktransformers
```

The generator is `buildPacket` from `@atlas/core`, shared with the app, so the brief printed
here is byte-for-byte the one the website hands out.

## `ingest`

```bash
pnpm --filter @atlas/tools run ingest -- --engine vllm --version 0.28.0            # docker
pnpm --filter @atlas/tools run ingest -- --engine sglang --version 0.5.5 --method pip
pnpm --filter @atlas/tools run ingest -- --engine llamacpp --version b7100 --method help-text
pnpm --filter @atlas/tools run ingest -- --engine vllm --version 0.28.0 --from dump.json --dry-run
```

Defaults in a version file are load-bearing: canonicalization drops any flag whose value
equals the default, so one wrong default silently merges two different configurations into
one fingerprint. Which is why they are read out of the engine rather than typed.

- **vLLM / SGLang** — a Python snippet runs inside the release container (or the current pip
  environment) and walks `EngineArgs.add_cli_args(FlexibleArgumentParser())._actions` /
  `ServerArgs.add_cli_args(...)`, emitting name, type, default, choices, help and aliases as
  JSON. It imports no CUDA and starts no model, so `ingest-engines.yml` runs it nightly on a
  plain CPU runner.
- **llama.cpp** — `llama-server --help`, parsed for the option column, the metavar and the
  trailing `(default: …)`.
- **Ollama** — `ollama serve --help` plus a curated list of the environment variables that
  actually change a number (`OLLAMA_NUM_PARALLEL`, `OLLAMA_FLASH_ATTENTION`,
  `OLLAMA_KV_CACHE_TYPE`, …), since Ollama's knobs are environment variables rather than flags.

The overlay (`engines/<id>/overlay.json`) and the previous version file supply the grouping
and impact annotations, so a new engine release does not lose them. `--from <file>` parses a
captured dump or help text without running anything, which is how the parsers are tested and
how somebody without docker can still contribute a version file.

The docker path is implemented but is not exercised by this repository's test run: it needs a
daemon and a multi-gigabyte pull. It runs in CI.

## `resolve-users` and `issue-to-pr`

`resolve-users --changed <files>` turns each result's `provenance.github_login` into the
permanent numeric id via `api.github.com/users/<login>` (one request per distinct login,
`GITHUB_TOKEN` honoured) and writes it into the file. A login that does not exist fails the
command; a rate limit or a network error leaves the field null and warns — a flaky API must
never fail somebody's contribution.

`issue-to-pr --body-file <file> --author <login> --issue <n> [--write] [--json]` parses the
"Submit result" issue form into a result file, computing every id, accepting either an Atlas
metric block or raw `vllm bench serve` / SGLang `bench_serving.py` output (wrapped by the
TypeScript port of `bench/atlas_bench/wrap.py` in `src/lib/wrap.ts`), validating the outcome,
and printing the branch name, pull request title and body for the workflow. The file is owned
by the _issue author_, not the bot, so the ownership rule keeps working.

## What CI does

| workflow              | when                           | what                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate.yml`        | every pull request             | installs, runs `pnpm test`, runs `validate --changed … --pr-author … --base … --json`, posts a sticky comment with the report, adds `results` / `needs-review` labels, then (same-repo branches only) resolves user ids and pushes `chore: stamp github_user_id` |
| `build-pages.yml`     | push to `main`, manual         | validates, `pnpm build`, uploads `app/dist` and deploys to Pages                                                                                                                                                                                                 |
| `ingest-engines.yml`  | nightly 03:30 UTC, manual      | asks the releases API for versions the registry lacks, ingests them via docker, opens `chore(engines): <engine> <version>`                                                                                                                                       |
| `issue-to-pr.yml`     | issue labelled `submit-result` | converts the form and opens a pull request co-authored by the issue author, or comments what was wrong with the form                                                                                                                                             |
| `wanted-snapshot.yml` | weekly                         | snapshots `request-config` issues and their reactions into `site/wanted-requests.json`                                                                                                                                                                           |

**Forks.** `validate.yml` cannot push to a fork's branch with the default token, so user ids
are not stamped there; the field stays `null` until it is resolved on `main`. Nothing
downstream may depend on it being set — the compiled contributor row falls back to
`https://github.com/<login>.png?size=64` for the avatar.

`maintainer-override` is the one escape hatch: a pull request carrying that label validates
with `--allow-override`, which turns ownership errors into warnings. It exists for withdrawing
a result whose author has gone; it is not for winning an argument about a number. Disputed
results are marked disputed and kept.

## Tests

```bash
pnpm --filter @atlas/tools test
```

122 tests across eight files. The interesting ones are not unit tests:

- `ownership.test.ts` builds a **real git repository** in a temp directory — base commit,
  branch, add/modify/delete/rename — and runs the validator against it. The rule this
  project rests on is not mocked.
- `validate.test.ts` starts from a fixture repository that validates clean, breaks exactly
  one thing, and asserts on the one code that fires.
- `build.test.ts` checks every compiled file's shape, that a rebuild is byte-identical, and
  that provenance stamping really reads a `(#42)` out of a commit subject.
- `ingest.test.ts` runs the parsers over captured argparse dumps and real `--help` layouts in
  `test/fixtures/`.
- `issue-to-pr.test.ts` asserts that the labels in `.github/ISSUE_TEMPLATE/submit-result.yml`
  are exactly the ones the parser reads, so renaming one there fails here rather than in
  production.

The fixture repository copies its registry files out of the real repository (`test/helpers/
fixture-repo.ts`) rather than inventing them: a fixture that drifts from the schemas would
pass while the thing it stands for fails.
