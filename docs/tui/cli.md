# Command line

```
inference-atlas [options]
```

With no options it syncs the data, detects your box, and opens the app.

## Options

```
  --repo <path>   read a local checkout (no network at all)
  --url <url>     override the data URL (default: the deployed site)
  --hardware <id> target this hardware registry id instead of what is
                  detected (also selectable in the TUI with 'b')
  --count <n>     how many of that device you have (default 1)
  --sync          refresh the data cache and exit
  -h, --help      this
```

Both `--flag value` and `--flag=value` forms work.

### `--repo <path>`

Read a local checkout instead of the published site. Nothing is fetched. Accepts `~`.

```bash
inference-atlas --repo ~/Projects/inference-atlas
```

Requires the checkout to have been built once (`pnpm build:data`). See
[Local mode](data-and-sync.md#local-mode).

### `--url <url>`

Point at a different deployment — a fork's Pages site, or a local preview server. Shards are
read from `<url>/data/`.

```bash
inference-atlas --url http://localhost:5173/inference-atlas
```

### `--hardware <id>` and `--count <n>`

Set the target box without opening the picker. The id must exist in the registry; an unknown
one prints a warning and falls back to detection.

```bash
inference-atlas --hardware nvidia-h100-80gb --count 8
```

**This persists.** A selection made on the command line is written to your config, so the
next plain `inference-atlas` remembers it. To go back to detection, delete the `[target]`
section from the config or pick the detected row in the picker.

### `--sync`

Refresh the cache and exit without drawing anything. For scripts, cron jobs, provisioning,
or warming the cache before a flight.

```bash
$ inference-atlas --sync
updated: index.json, registry.json, coverage.json, workloads.json, stats.json
```

Prints one of:

| Output                         | Means                                                     |
| ------------------------------ | --------------------------------------------------------- |
| `fresh`                        | The manifest was unchanged; nothing to fetch              |
| `updated: a.json, b.json`      | Those shards had new content and were re-fetched          |
| `offline` + an error on stderr | The fetch failed; the cache is untouched and still usable |

## Exit codes

| Code | When                                                                           |
| ---- | ------------------------------------------------------------------------------ |
| `0`  | Normal exit, including `--help`, and `--sync` that fell back to a usable cache |
| `1`  | `--sync` could not reach the source **and** there is no cached manifest        |
| `1`  | Not a terminal — stdin or stdout is not a TTY, and `--sync` was not given      |
| `1`  | The data is empty (first run with no network)                                  |

## Using it in scripts

The app itself needs a TTY and refuses to run without one:

```
inference-atlas is a TUI — run it in a terminal (or use --sync in scripts).
```

`--sync` is the scriptable half. A daily refresh, for example:

```cron
17 6 * * *  /home/you/.local/bin/inference-atlas --sync >/dev/null 2>&1
```

For anything else programmatic, read the shards directly — they are plain JSON under
`~/.cache/inference-atlas/data/`, and their shapes are documented in
[`docs/SPEC.md`](../SPEC.md) §6.

```bash
jq '[.[] | select(.hardware.id == "nvidia-gb10-dgx-spark")] | length' \
  ~/.cache/inference-atlas/data/index.json
```

## Environment

| Variable                            | Effect                                     |
| ----------------------------------- | ------------------------------------------ |
| `XDG_CONFIG_HOME`                   | Moves the config directory                 |
| `XDG_CACHE_HOME`                    | Moves the cache directory                  |
| `NO_COLOR`                          | Forces monochrome, over any config setting |
| `TERM`, `COLORTERM`, `TERM_PROGRAM` | Read to detect colour depth                |

The installer additionally reads `INFERENCE_ATLAS_HOME` and `BIN_DIR` — see
[Installation](installation.md#choosing-where-it-goes).

## The other command name

The package installs two bins pointing at the same program: `inference-atlas` and
`atlas-tui`. Use whichever you prefer.
