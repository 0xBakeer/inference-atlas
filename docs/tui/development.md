# Development

For working on the app itself. For using it, start at the [manual](README.md).

## Running from source

```bash
pnpm install
pnpm tui                                  # tsx, no build step
pnpm --filter @atlas/tui test             # vitest
pnpm --filter @atlas/tui run typecheck    # tsc, sources and tests
pnpm --filter @atlas/tui run build        # dist/, what the installed wrapper runs
```

From the repository root, `pnpm lint`, `pnpm typecheck` and `pnpm test` cover every package.

## The stack

|                                                         |                                    |
| ------------------------------------------------------- | ---------------------------------- |
| [Ink](https://github.com/vadimdemedes/ink) 7 + React 19 | React reconciler for the terminal  |
| [smol-toml](https://github.com/squirrelchat/smol-toml)  | Config parsing                     |
| `@atlas/core`                                           | Everything shared with the website |

Three runtime dependencies in total. The charts are written from scratch — no plotting
library reaches the terminal well enough to be worth a fourth.

## Module map

```
src/
  cli.tsx          argument parsing, target resolution, render()
  config.ts        config.toml: parse, defaults, surgical [target] rewrite
  derive.ts        view models — filtering, pareto, coverage grid, sweep series, ranking

  canvas/          drawing primitives, no React
    braille.ts     2×4 dot grid: set, line, mark, render
    blocks.ts      sparklines, bars, column charts, heatmap rows, resampling
    chart.ts       the chart compositor: axes, fill, dual scales, ticks, legend
    color.ts       truecolor / 256 / mono detection, painting, ramps
    scale.ts       linear scales, nice ticks, domain padding

  data/
    source.ts      RemoteSource (manifest + sha diff + cache) and LocalSource (a checkout)
    load.ts        shards → AtlasData with the lookups every view needs
    paths.ts       XDG config and cache locations

  hw/
    capture.ts     probe this machine
    match.ts       capture → registry entry, via the detect blocks
    target.ts      the Target model: hardware + count, pooling, platform tags
    fit.ts         the fit verdict and its reasoning
    request.ts     propose a registry entry for an unknown box

  recipe/
    generate.ts    a run → the Markdown recipe
    send.ts        write, clipboard (OSC 52 + platform tool), open a URL, run an agent

  ui/
    App.tsx        the shell: state, keyboard, view routing, background refresh
    theme.ts       palette, ramps, severity colours
    widgets.tsx    Panel, Table, KeyHints, ChartLines, SeverityNote
    views/         home, runs, pareto, coverage, hardware, detail, recipe
```

The dependency direction is one-way: `ui/` uses `canvas/`, `hw/`, `recipe/`, `derive`; those
use `data/` and `@atlas/core`; nothing below `ui/` imports React.

## What belongs in `@atlas/core` instead

Anything the website would also need. Ids, canonicalization, the shard types, plausibility
math, scoring, coverage, packet and serve-command rendering, and the chart-feeding
derivations (`arms`, `pareto`, `requests`, `metrics`, `format`, `diff`, `neighbours`) all
live there, so both frontends compute identical numbers from identical inputs.

If you find yourself writing something the site would want, put it in core and import it.

## Testing

```bash
pnpm --filter @atlas/tui test
```

Roughly 120 tests across five areas:

| Area                      | Covers                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas/canvas.test.ts`   | Braille bit layout, block characters, colour levels, tick planning, area fill, dual axes, resampling, and a width invariant — no chart line may exceed the width it was given |
| `data/source.test.ts`     | First sync, 304 handling, per-shard hash diffing, offline fallback, immutable run caching, local mode                                                                         |
| `hw/hw.test.ts`           | Capture, registry matching, pooling rules, every fit verdict path                                                                                                             |
| `hw/request.test.ts`      | Id proposal, the refusal to guess bandwidth, URL construction, no personal data                                                                                               |
| `recipe/generate.test.ts` | Every section of a recipe, from a fixture run                                                                                                                                 |
| `ui/app.test.tsx`         | The whole app through `ink-testing-library` against a fixture repository: navigation, filtering, the picker, counts, the first-run prompt, the add-box confirmation           |

Rendering tests use `level: 'mono'`, which emits no escape codes, so assertions are about
shape rather than colour.

## Adding a view

1. Write it in `src/ui/views/`, taking data and returning JSX. No fetching, no state — the
   shell owns both.
2. Add its id to the `View` union in `App.tsx`.
3. Route a key to it in `useInput`, add it to the `tab` order, and render it in the tree.
4. Add its keys to the status-bar hints and the help screen.
5. Cover it in `app.test.tsx`.

## Adding a chart

Compose from `canvas/`. `renderChart` handles line and scatter plots with fills, dual axes
and explicit ticks; `columnRows`, `hbar`, `sparkline` and `heatmapRows` cover the rest. All
of them return arrays of strings — `<ChartLines>` prints them.

Two rules the existing charts follow:

- **Label what was measured.** Explicit `xTicks` and `tightX` for a sweep, rather than
  round numbers between the levels that were actually run.
- **Never exceed the width you were given.** There is a test for it.

## Style

The repository's conventions apply: no `any`, `noUncheckedIndexedAccess` is on, type-only
imports are explicit, and comments explain _why_ rather than restating the code. Prettier and
ESLint are enforced by `pnpm lint`.

## Reference

- [`docs/SPEC.md`](../SPEC.md) — ids, fingerprints, the result shape, the shard contract
- [`docs/DESIGN.md`](../DESIGN.md) — what the atlas is for
- [`AGENTS.md`](../../AGENTS.md) — the contribution contract
- [`packages/core/`](../../packages/core/) — the shared logic
