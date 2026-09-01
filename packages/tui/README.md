# `@atlas/tui`

The Inference Atlas in your terminal: browse every measured configuration, see the charts,
check what fits _your_ box, and turn any run into an agent-ready install recipe.

```bash
curl -fsSL https://raw.githubusercontent.com/0xBakeer/inference-atlas/main/install.sh | sh
inference-atlas
```

Or from a checkout: `pnpm install && pnpm tui`.

## What it does

- **Your box, first.** On launch the TUI captures the local hardware (`system_profiler` /
  `nvidia-smi` / `lscpu`), matches it against the hardware registry via the same `detect`
  blocks `atlas-bench hwinfo` uses, and ranks every run by whether it would actually work
  here: `✓ recommended`, `~ should fit` (estimate — and it says so), `! tight`, `✗ won't
fit`, `✗ wrong platform`.
- **Charts in the terminal.** Braille-canvas sweep curves and the Pareto frontier (log-x),
  latency percentile bars, a per-request strip, and a coverage heatmap. Truecolor with
  256-colour and mono fallbacks; `NO_COLOR` honoured.
- **Recipes.** Press `g` on any run and the TUI writes a Markdown recipe containing the
  pinned weights (`hf_id` + revision), the engine install commands for the exact version,
  the reconstructed serve command, every flag with its registered help text and impact, the
  run's gotchas, the numbers to expect, the fit verdict for the target box, and the
  `atlas-bench` loop to verify and contribute the result back — plus the AGENTS.md rules.
  When the target is remote the recipe says so up front: every command runs on that host,
  not on the machine reading it.
  Copy it, or hand it to a configured agent (`claude`, `opencode`, your own).
- **Data that keeps itself fresh.** The compiled shards come from the deployed site: one
  conditional GET on `manifest.json`, and only shards whose sha256 changed are re-fetched.
  Everything is cached under `~/.cache/inference-atlas/`, so the TUI works offline after
  the first sync. `--repo <path>` reads a local checkout instead and never touches the
  network.

## Keys

`1–5` views (target · runs · pareto · coverage · boxes) · `b` switch target box ·
`s` (in boxes) probe an ssh host · `j/k` move · `enter` open · `/` filter · `g` recipe ·
`c` copy (in recipe) · `1–9` send to agent (in recipe) · `r` refresh · `?` help · `q` quit

## Configuration

`~/.config/inference-atlas/config.toml` — written with commented defaults on first run:
data URL or local repo path, refresh interval, colour mode, recipes directory, the agent
targets `{recipe}` is substituted into, and named boxes:

```toml
[boxes.dgx]
ssh = "spark"              # probed on selection, matched against the registry

[boxes.rented-4090]
hardware = "nvidia-rtx-4090"   # no probe: judge against the registry entry
```

The selected box is remembered in `~/.cache/inference-atlas/state.json`, so the config file
stays a document the TUI never rewrites.

## Development

```bash
pnpm --filter @atlas/tui run start      # run from source (tsx)
pnpm --filter @atlas/tui test           # vitest
pnpm --filter @atlas/tui run typecheck
pnpm --filter @atlas/tui run build      # dist/ for the wrapper + npm packaging
```

The heavy lifting — ids, canonicalization, the shard contract, chart derivations
(`paretoFrontier`, `requestSamples`, `arms`), plausibility math and the packet/serve-command
rendering — lives in `@atlas/core`, shared verbatim with the web app.
