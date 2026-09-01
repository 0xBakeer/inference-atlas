# Troubleshooting

## Installation

### `command not found: inference-atlas`

The wrapper is in `~/.local/bin`, which is not on your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
exec $SHELL
```

### `Node.js >= 20 is required`

Check with `node --version`. Install a newer Node (nvm, Homebrew, your package manager) and
run the installer again.

### `pnpm is required`

The installer tries `corepack enable pnpm` first. If corepack is unavailable:

```bash
npm install -g pnpm
```

### The install succeeded but the app is the old version

The wrapper runs `dist/`, not the TypeScript sources. After pulling changes in a checkout:

```bash
pnpm --filter @atlas/tui run build
```

## Starting up

### `inference-atlas is a TUI — run it in a terminal`

stdin or stdout is not a terminal — you piped it, redirected it, or ran it from something
non-interactive. Use `--sync` for scripts.

### `No data: the first sync needs the network once`

The very first run has to fetch the shards. Check you can reach the site:

```bash
curl -I https://0xbakeer.github.io/inference-atlas/data/manifest.json
```

Behind a proxy, set `HTTPS_PROXY` before launching. Or point at a checkout instead:

```bash
inference-atlas --repo ~/Projects/inference-atlas
```

### `no compiled data at … — run pnpm build:data in the repo first`

You used `--repo` against a checkout that has never been built. `app/public/data/` is
generated, not committed:

```bash
cd ~/Projects/inference-atlas && pnpm install && pnpm build:data
```

### It says `offline (cache)` in the header

The refresh failed but the cache is intact — everything works, you are just not seeing new
runs. Common causes: no network, DNS, a proxy, or the site being briefly down. Press `r` to
retry.

## The box

### It did not recognise my machine

Expected for any device the registry does not know yet — the registry has 19 entries, and
the world has more. The app asks you to pick, which is the right answer for browsing, and
the picker's **not listed?** row proposes yours for the registry. See
[The target box](target-box.md#your-box-is-not-in-the-registry).

### It picked the wrong variant of my chip

Memory disambiguates size variants (`apple-m2-max-32gb` vs `-96gb`), so this happens when
the installed memory does not match what the registry expects. Just pick the right one with
`b` — your choice is saved and detection never overrides it again.

### The GPU count is wrong

Detection counts `nvidia-smi` lines. If some cards are hidden by `CUDA_VISIBLE_DEVICES`, or
you are targeting a machine other than this one, set it by hand with `+`/`-` in the picker.

### Every verdict says "wrong platform"

Your target's platform does not match the engines you are looking at — a Metal engine
against a CUDA box, or the reverse. Check which box is selected in the header; a stale
`[target]` in your config is the usual cause.

## The display

### Boxes, question marks or blanks instead of `⣿`

Your font lacks braille glyphs. Almost every programming font has them — JetBrains Mono,
Fira Code, Menlo, DejaVu Sans Mono, Cascadia Code. Switching font fixes it. There is no
ASCII fallback for the line charts; the tables and bars remain readable regardless.

### The colours are wrong, washed out, or invisible

The app is guessing your terminal's colour depth. Force it:

```toml
[ui]
color = "256"     # or "truecolor", or "mono"
```

Under tmux, truecolor needs tmux to be told about it:

```
set -ga terminal-overrides ",*256col*:Tc"
```

### Everything is one colour

`NO_COLOR` is set in your environment. It is honoured before every other setting, by design.

### The layout is cramped or wrapping

The app lays out to your terminal's reported width. Very narrow terminals (under ~80
columns) will be tight — the tables shrink their columns, but charts need room. Resize and
the app redraws itself.

### Charts do not fill the panel

Fixed in current versions. If you see it, your terminal is reporting a width of 0 — check
`tput cols`.

## Recipes

### `could not write recipe: …`

The recipes directory is not writable. Change it:

```toml
[recipes]
dir = "~/somewhere/writable"
```

### `c` did not copy anything

Copying tries OSC 52 first, then the platform tool. On Linux, install one:

```bash
sudo apt install xclip        # X11
sudo apt install wl-clipboard # Wayland
```

Over ssh, OSC 52 needs your local terminal to permit clipboard writes — many do by default,
some need it enabled.

### An agent target did nothing

`mode = "copy"` (the default) puts the **command** on your clipboard rather than running it
— paste it into a shell. Use `mode = "run"` if you want the app to execute it.

## Data

### The numbers differ from the website

Check the commit in the header against the site's footer. If yours is older, press `r`. The
published shards are behind a ten-minute CDN cache, so a very recent merge can take that
long to reach you.

### I added a result locally and do not see it

Only `--repo` mode reads local files, and only after the shards are built:

```bash
pnpm build:data && inference-atlas --repo .
```

## Starting over

Nothing here is precious:

```bash
rm -rf ~/.cache/inference-atlas      # forces a full re-sync
rm ~/.config/inference-atlas/config.toml   # back to defaults, rewritten on next launch
```

Your generated recipes are untouched.

## Still stuck

Open an issue with what you ran, what you expected and what happened:
<https://github.com/0xBakeer/inference-atlas/issues>. Useful to include:

```bash
inference-atlas --help | head -1
node --version
echo "$TERM / $COLORTERM / $TERM_PROGRAM"
cat ~/.cache/inference-atlas/data/manifest.json | head -6
```
