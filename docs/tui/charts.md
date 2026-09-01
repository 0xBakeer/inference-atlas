# Reading the charts

Everything is drawn with text. No images, no sixel, no escape-code graphics protocol — so it
works over ssh, inside tmux, in the VS Code terminal, and in a CI log.

## How the plots are drawn

Line charts use **braille** characters. Each terminal cell is a 2 × 4 dot matrix, so a
40 × 10 character plot is really an 80 × 40 pixel canvas — enough resolution for a curve to
have a shape rather than a staircase.

```
  550┤                                 ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣶⣶│
     │                              ⣀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿├20k
  500┤                           ⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿├15k
     └┬──┬────┬─────────┬────────────────────┬────────────────────────────┬
      1  2    4         8                   16                           32
```

**The area under a curve is filled.** A bare polyline across a wide panel reads as scattered
dots; a filled body reads as a magnitude. The measured points themselves are always drawn,
because they are the data — the line between them is a reading aid.

**Two axes, one plot.** Throughput (cobalt, left, filled) and latency (orange, right) share
the plot area with independent scales, marked `┤` on the left and `├` on the right. Stacking
them as two short charts wasted the vertical space and made them hard to correlate.

**The x axis labels what was actually run.** A concurrency sweep of 1, 2, 4, 8, 16, 32 is
labelled 1, 2, 4, 8, 16, 32 — not rounded to 0, 17, 34, and not padded out to −1. Inventing
tick values between measured levels describes a measurement nobody made.

**A y label is never repeated.** If two ticks would both format to `20k`, the second is
dropped instead of drawing three identical rows.

## Latency distribution

TTFT percentiles as bars from zero, with the colour deepening cobalt → orange from p50 to
p99:

```
TTFT p50 ████████████████████████████████                       1,005 ms
TTFT p90 ████████████████████████████████████████               1,245 ms
TTFT p95 ██████████████████████████████████████████             1,295 ms
TTFT p99 ███████████████████████████████████████████            1,333 ms
         0                                            1,333 ms
```

Bars are drawn to eighth-of-a-character precision, so small differences are visible. When
the tail is tight all four bars are nearly the same length — that is the honest picture, and
the colour ramp is what keeps the rows distinguishable.

The line underneath is the scale: zero on the left, the maximum on the right.

## Requests

Every request in the run as one column, tallest = slowest, three rows deep:

```
        ▃    ▃▄▆█▆▅█▅▇▅▆▆▄▄▄▃▅▄▄▅▅▄▄▅▄▆▅▄▃▄
   ▁▂▂▂▂▁▁ ▂▃▂▁▂▁▁▁  █▃▂▂▅██████████████████████████
▆▆▆▆▆▅▆▆▆▆▆▆▅▆▆▆▇▆▆▇▇▇▆▆▆▇▆▇█▇▇█▆▇▇███████████████████
first                                    last · peak 52,135 ms
```

**Time runs left to right across the whole run.** The series is resampled to the panel width
— averaged down when there are more requests than columns, repeated up when there are fewer
— so a 400-request sweep shows all of its arms and a 20-request run still fills the panel.
Colour follows the latency ramp; a column containing a **failed** request is red.

This is where you see a run warm up, a queue build as concurrency rises, or one call that
hung.

## Sweep curves

For sweep and long-context runs: throughput and latency over the swept variable.

- **cobalt, filled, left axis** — tokens per second
- **orange, right axis** — TTFT
- x is concurrency, or input tokens on a log₂ scale for context sweeps

The classic shape is throughput climbing then flattening while latency climbs steadily —
the knee is where more concurrency stops buying you anything.

## Pareto

A scatter of every serving run: x is TTFT p50 (log scale — the range runs from milliseconds
to minutes), y is output tok/s. The **frontier** is drawn bright and connected; everything
else is a dim dot. The selected point is `◉`.

A point far below the frontier is beaten by another configuration on both axes at once.

## Coverage

Model × hardware, one coloured cell per square, brightness rising with the number of runs:

```
                        1  2
…seek-v4-flash-0731-spark   ███
        Qwen/Qwen3.6-35B-A3B   ███
            Qwen/Qwen3.8-27B   ███
       google/gemma-4-E2B-it ██████
```

**Blank means nobody has measured it.** In this atlas that is the interesting signal, not
missing UI. The numbered legend underneath maps columns to hardware ids.

## Colour

Three levels, detected automatically:

| Level       | When                                                                                                            | What you get                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `truecolor` | `COLORTERM=truecolor` or `24bit`, or a terminal known to support it (kitty, ghostty, iTerm, WezTerm, Alacritty) | The full palette, exactly as designed                                                         |
| `256`       | anything else                                                                                                   | Nearest match from the xterm-256 cube or greyscale ramp                                       |
| `mono`      | `NO_COLOR` set, or `TERM=dumb`, or no `TERM`                                                                    | No escape codes at all — heatmaps fall back to block characters that encode presence by shape |

Force one in the config:

```toml
[ui]
color = "mono"     # auto | truecolor | 256 | mono
```

`NO_COLOR` is honoured before everything else, including an explicit `truecolor` setting.

## Palette

| Colour                  | Used for                                                |
| ----------------------- | ------------------------------------------------------- |
| cobalt `#5b8cff`        | throughput, selection, panel titles, the primary series |
| signal orange `#f97316` | latency — the counterpart series                        |
| green `#22c55e`         | `✓ recommended`, the active target                      |
| amber `#f59e0b`         | `! tight`, warning gotchas                              |
| red `#ef4444`           | `✗ won't fit`, failed requests, blocker gotchas         |
| grey `#8b93a7`          | secondary text, notes, absent values                    |

Latency ramps run cobalt → violet → orange, so "slow" is always warmer than "fast".

## If the charts look wrong

Boxes or question marks instead of `⣿` mean your font lacks braille glyphs — rare, but
switching to a programming font (JetBrains Mono, Fira Code, Menlo, DejaVu Sans Mono) fixes
it. See [Troubleshooting](troubleshooting.md).
