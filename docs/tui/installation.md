# Installation

## Requirements

|              |                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**  | 20 or newer (`node --version`)                                                                                               |
| **git**      | any recent version                                                                                                           |
| **pnpm**     | installed automatically through `corepack` if you do not have it                                                             |
| **Terminal** | anything that draws Unicode. Braille (`⣿`) and block (`█`) glyphs are used for the charts; almost every modern font has them |
| **Network**  | once, for the first data sync. After that it works offline                                                                   |

Nothing else. No Python, no Docker, no database — the atlas is a set of JSON files and the
app reads them.

## The one-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/0xBakeer/inference-atlas/main/install.sh | sh
```

What it does, and nothing else:

1. Clones (or updates) the repository under `~/.local/share/inference-atlas/src`
2. Installs workspace dependencies with pnpm and builds `@atlas/core` and `@atlas/tui`
3. Writes an `inference-atlas` wrapper into `~/.local/bin`

Then:

```bash
inference-atlas
```

If the installer warns that `~/.local/bin` is not on your `PATH`, add it to your shell
profile:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
```

### Choosing where it goes

Two environment variables override the locations:

```bash
INFERENCE_ATLAS_HOME=/opt/atlas BIN_DIR=/usr/local/bin sh install.sh
```

| Variable               | Default                          | What it controls                                              |
| ---------------------- | -------------------------------- | ------------------------------------------------------------- |
| `INFERENCE_ATLAS_HOME` | `~/.local/share/inference-atlas` | Where the source checkout lives (`$INFERENCE_ATLAS_HOME/src`) |
| `BIN_DIR`              | `~/.local/bin`                   | Where the `inference-atlas` wrapper is written                |

### If you would rather not pipe a script into a shell

That is a reasonable instinct. Read it first — it is about sixty lines:

```bash
curl -fsSL https://raw.githubusercontent.com/0xBakeer/inference-atlas/main/install.sh -o install.sh
less install.sh
sh install.sh
```

Or skip it entirely and do the three steps yourself, below.

## From a checkout

If you already have the repository (or want to contribute), you do not need the installer:

```bash
git clone https://github.com/0xBakeer/inference-atlas.git
cd inference-atlas
pnpm install
pnpm tui                      # run from source, TypeScript compiled on the fly
```

To get an `inference-atlas` command out of a checkout, build once and point a wrapper at it:

```bash
pnpm --filter @atlas/tui run build

cat > ~/.local/bin/inference-atlas <<'EOF'
#!/bin/sh
exec node "$HOME/path/to/inference-atlas/packages/tui/dist/cli.js" "$@"
EOF
chmod +x ~/.local/bin/inference-atlas
```

Remember to re-run the build after pulling changes — the wrapper runs `dist/`, not the
TypeScript sources.

## Updating

**Installed with the script:** run it again. It fetches and hard-resets the checkout to
`origin/main`, reinstalls dependencies and rebuilds.

```bash
curl -fsSL https://raw.githubusercontent.com/0xBakeer/inference-atlas/main/install.sh | sh
```

**From a checkout:**

```bash
git pull && pnpm install && pnpm --filter @atlas/tui run build
```

Note that updating the _app_ is separate from updating the _data_. The data refreshes
itself — see [Data and syncing](data-and-sync.md).

## Uninstalling

```bash
rm ~/.local/bin/inference-atlas            # the command
rm -rf ~/.local/share/inference-atlas      # the checkout the installer made
rm -rf ~/.cache/inference-atlas            # the data cache
rm -rf ~/.config/inference-atlas           # your configuration
```

Your generated recipes are not touched by any of that — they live wherever
`recipes.dir` points, `~/inference-atlas/recipes` by default.

## Verifying the install

```bash
inference-atlas --help     # prints usage, exits 0
inference-atlas --sync     # fetches the data, prints "updated: …" or "fresh"
inference-atlas            # the app
```

If `--sync` prints `offline` and an error, see [Troubleshooting](troubleshooting.md).

## What gets written where

| Path                                    | What                                  | Safe to delete?                                                 |
| --------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `~/.local/bin/inference-atlas`          | The command                           | Yes — reinstall to restore                                      |
| `~/.local/share/inference-atlas/src`    | The checkout the installer built from | Yes — reinstall to restore                                      |
| `~/.config/inference-atlas/config.toml` | Your settings and target box          | Yes — defaults are used, and the file is rewritten on first run |
| `~/.cache/inference-atlas/`             | The data cache                        | Yes — it re-syncs on next launch                                |
| `~/inference-atlas/recipes/`            | Recipes you generated                 | Yours; nothing else reads them                                  |

Paths honour `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` if you set them.
