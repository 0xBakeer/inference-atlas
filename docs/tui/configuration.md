# Configuration

Everything lives in one TOML file:

```
~/.config/inference-atlas/config.toml
```

It is written for you on first run, with every default present and commented. **Every key is
optional** — an empty or missing file is a valid configuration, and so is a broken one: if
the TOML fails to parse, the app runs on defaults rather than refusing to start.

Set `XDG_CONFIG_HOME` to move it.

## The whole file

```toml
# inference-atlas TUI configuration. Every key is optional; these are the defaults.

[data]
# Where the compiled data shards are fetched from (the deployed site).
url = "https://0xbakeer.github.io/inference-atlas"
# Point at a local checkout instead — then nothing is fetched:
# repo = "~/Projects/inference-atlas"
# Background data refresh, in minutes. 0 turns it off.
refresh_minutes = 15

[ui]
# auto | truecolor | 256 | mono
color = "auto"

[recipes]
# Generated recipe files land here.
dir = "~/inference-atlas/recipes"

# Agent targets for "send recipe". {recipe} becomes the recipe file path.
# mode = "copy" copies the command to the clipboard; "run" executes it from the TUI.
[agents.claude]
command = 'claude "$(cat {recipe})"'
mode = "copy"

[agents.opencode]
command = 'opencode run "$(cat {recipe})"'
mode = "copy"

# The box every verdict is judged against. The TUI detects this machine at startup and
# asks you to pick when it cannot recognise it; press 'b' to change it at any time and
# this section is rewritten for you. count is how many of that device you have.
# [target]
# hardware = "nvidia-rtx-6000-ada"
# count = 3
```

## `[data]`

| Key               | Type   | Default                                      | Means                                                                                                                                              |
| ----------------- | ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`             | string | `https://0xbakeer.github.io/inference-atlas` | Base URL of the deployed site. Shards are read from `<url>/data/`                                                                                  |
| `repo`            | string | unset                                        | Path to a local checkout. **When set, the network is never touched** — the app reads `app/public/data/` and the raw registries from that directory |
| `refresh_minutes` | number | `15`                                         | How often to re-check for new data in the background. `0` disables it; `r` still refreshes manually                                                |

`repo` accepts `~`. Setting it is the offline/development mode; see
[Data and syncing](data-and-sync.md#local-mode).

A note on `refresh_minutes`: the published shards sit behind a CDN with a ten-minute cache,
so polling faster than that cannot see fresher data. Fifteen minutes is deliberately just
above it.

## `[ui]`

| Key     | Type                                     | Default | Means                                        |
| ------- | ---------------------------------------- | ------- | -------------------------------------------- |
| `color` | `auto` \| `truecolor` \| `256` \| `mono` | `auto`  | Force a colour depth instead of detecting it |

`auto` reads `NO_COLOR`, `TERM` and `COLORTERM`. `NO_COLOR` wins over an explicit setting.
An unrecognised value falls back to `auto` rather than erroring. See
[Reading the charts](charts.md#colour).

## `[recipes]`

| Key   | Type   | Default                     | Means                                                        |
| ----- | ------ | --------------------------- | ------------------------------------------------------------ |
| `dir` | string | `~/inference-atlas/recipes` | Where generated recipe files are written. Created if missing |

## `[agents.<name>]`

Any number of them. The name is yours; it appears in the recipe view, and the numbers
`1`–`9` select them in the order they appear.

| Key       | Type            | Default | Means                                                                                                            |
| --------- | --------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `command` | string          | —       | Shell command. `{recipe}` is replaced with the generated file's path. Required — an entry without one is ignored |
| `mode`    | `copy` \| `run` | `copy`  | `copy` puts the command on your clipboard; `run` executes it and shows the output                                |

Two defaults (`claude`, `opencode`) are always present. Defining an agent with the same name
replaces it; defining new ones adds to them.

```toml
[agents.gpu-box]
command = 'ssh gpu-box "cd ~/work && claude -p \"$(cat {recipe})\""'
mode = "run"
```

## `[target]`

| Key        | Type   | Default | Means                                                                |
| ---------- | ------ | ------- | -------------------------------------------------------------------- |
| `hardware` | string | unset   | A hardware registry id. When unset, the app uses whatever it detects |
| `count`    | number | `1`     | How many of that device. Values below 1 are floored to 1             |

**This is the one section the app writes.** Selecting a box in the picker (or passing
`--hardware` / `--count`) rewrites it — and _only_ it. The rewrite is a surgical text
replacement, so your comments, key order and every other setting survive byte for byte.

Valid ids are whatever the registry holds; the picker lists them all, or see
[`hardware/`](../../hardware/) in the repository.

## Every path the app touches

| Path                                       | Written by                      | What                                                                                                                                                                |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/inference-atlas/config.toml`    | first run, and target selection | This file                                                                                                                                                           |
| `~/.cache/inference-atlas/data/`           | every sync                      | Compiled shards: `manifest.json`, `index.json`, `registry.json`, `coverage.json`, `workloads.json`, `datasets.json`, `stats.json`, `contributors.json`, `gaps.json` |
| `~/.cache/inference-atlas/data/runs/…`     | on demand                       | Full run records, cached permanently (a run id never changes content)                                                                                               |
| `~/.cache/inference-atlas/data/engines/…`  | on demand                       | Engine version parameter tables                                                                                                                                     |
| `~/.cache/inference-atlas/data/.sync.json` | every sync                      | The ETag of the last manifest fetch                                                                                                                                 |
| `~/inference-atlas/recipes/`               | pressing `g`                    | Generated recipes                                                                                                                                                   |

`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` are honoured. Nothing is written outside these.

## Precedence

For the target box:

```
--hardware / --count  >  [target] in config  >  detection
```

A command-line selection is also persisted, so it becomes the config value for next time.

For data:

```
--repo  >  [data].repo  >  --url  >  [data].url
```
