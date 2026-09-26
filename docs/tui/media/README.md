# Terminal app recordings

The GIFs the manual and the READMEs embed. Each one is the real `inference-atlas` from this
repository, driven key by key in a pseudo-terminal against the live published data.

| File                                                       | Shows                                                                         | Used in                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`tui-00-tour.gif`](tui-00-tour.gif)                       | The whole loop in half a minute: ranking, Pareto, coverage, a run, its recipe | [README](../../../README.md), [manual](../README.md), [package](../../../packages/tui/README.md) |
| [`tui-01-launch.gif`](tui-01-launch.gif)                   | First run: detection, the ranked list, `s`, `?`                               | [Getting started](../getting-started.md)                                                         |
| [`tui-02-run-detail.gif`](tui-02-run-detail.gif)           | Filtering to one run and reading it in full                                   | [The views](../views.md#run-detail-enter)                                                        |
| [`tui-03-recipe.gif`](tui-03-recipe.gif)                   | `g`, scrolling the recipe, `c` copy, `1` send to an agent                     | [Recipes](../recipes.md)                                                                         |
| [`tui-04-runs-filter.gif`](tui-04-runs-filter.gif)         | The runs view, multi-word `/` filters, `s` sort                               | [The views](../views.md#2--runs)                                                                 |
| [`tui-05-pareto-coverage.gif`](tui-05-pareto-coverage.gif) | Walking the Pareto frontier, then the coverage map                            | [The views](../views.md#3--pareto)                                                               |
| [`tui-06-hardware.gif`](tui-06-hardware.gif)               | The picker: 4 × H100 pools, 2 × Spark does not                                | [The target box](../target-box.md#choosing-a-box)                                                |
| [`tui-07-cli.gif`](tui-07-cli.gif)                         | `--help`, `--sync`, `--hardware`/`--count`                                    | [Command line](../cli.md)                                                                        |

## What is real and what is simulated

Everything on screen is the app's own output. The one thing simulated is the **host**: the
recordings were made on a laptop, not on a DGX Spark, so the recorder tells the app it is on
one — `make/sim-dgx.mjs` reports Linux on 20 Cortex-X925 cores, and `make/bin/` puts a fake
`lscpu` and a fake `nvidia-smi` (`NVIDIA GB10, [N/A]`, which is what the Spark prints) first on
`PATH`. Detection then runs its normal code path and lands on `nvidia-gb10-dgx-spark`. The
clipboard helpers are stubbed too, so `c` and `1` report success without touching a real
clipboard. HOME is a throwaway directory shown as `/home/user`.

The run data, the fit verdicts, the charts and the recipes are the atlas's own, as published
at the commit the header shows.

## Regenerating them

After a change to the TUI, rebuild and rerecord. Needs Python 3 with
[`pyte`](https://pypi.org/project/pyte/), [`agg`](https://github.com/asciinema/agg) and
`ffmpeg` (with libass), and network access to the published data.

```bash
pnpm install && pnpm --filter @atlas/tui build
python3 docs/tui/media/make/scenes.py            # all scenes, or name some: launch recipe
python3 docs/tui/media/make/render.py            # writes the GIFs here; MP4s stay in make/.build
```

`scenes.py` is the storyboard: one function per recording, each a list of key presses,
waits on what the screen says, and the caption shown under the terminal. `rec.py` drives the
pseudo-terminal and writes an asciicast; `render.py` turns it into a GIF with the caption
band and key badges. Every scene waits for the screen it expects before pressing the next
key, so a slow network makes a recording take longer, not go wrong. The recorder refuses to
write a cast that contains the real home directory or the checkout path.

The terminal is 132 × 57. Two views currently overflow a shorter terminal — the run detail
has no scrolling of its own, and the recipe pane counts Markdown lines rather than wrapped
rows — which is why the recipe recording stops scrolling before the flag table.
