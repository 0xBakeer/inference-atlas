# The views

Five top-level views, plus three you reach from them. The header always tells you where you
are, which box you are judging against, and how fresh the data is:

```
INFERENCE ATLAS [target] · box NVIDIA DGX Spark (GB10) · data @ 46e00af · fresh · checked 6m ago
                 ▲         ▲                             ▲                ▲       ▲
                 view      target box (b to change)      data commit      sync    age
```

`fresh` means the last check found nothing new. `updated` means shards were re-fetched.
`offline (cache)` means the check failed and you are reading the cache — everything still
works.

---

## 1 · Target

The launch screen, and the one that answers "what should I run here?".

**Your box** — what the app knows about the target: the registry id, memory, bandwidth, and
whether it was detected on this machine or chosen by you.

**Worth running on \<box\>** — every measurement in the atlas, ranked. Fit first
(`✓ recommended` before `~ should fit` before `! tight` before `✗`), then by the site's
headline metric within each group. Columns:

| Column   |                                                                                 |
| -------- | ------------------------------------------------------------------------------- |
| fit      | the verdict for your box — see [The target box](target-box.md#the-fit-verdicts) |
| model    | Hugging Face repo id of the model                                               |
| quant    | the quantization id within that model                                           |
| engine   | engine and exact version                                                        |
| workload | the pinned workload definition that was run                                     |
| headline | the metric that matters for that kind of run                                    |

The footer counts what the atlas holds: runs, models, hardware, engines.

---

## 2 · Runs

The same measurements, unranked and unfiltered — the whole table, with the identity columns
in full and `/` to narrow it.

Use this when you know what you are looking for: a model, an engine, a piece of hardware you
do not own. Unlike the target view it does not sort by fit, so it is also how you see what
other people are running.

---

## 3 · Pareto

Throughput against latency for every serving run: **x** is TTFT p50 (lower is better, on a
log scale because the range spans milliseconds to minutes), **y** is output tok/s (higher is
better).

The **frontier** — the set of runs that nothing else beats on both axes at once — is drawn
bright and connected. Everything else is a dim dot. Walking with `j`/`k` moves the `◉`
marker and names the run underneath.

This is the view for "what am I giving up?". A configuration far off the frontier is being
beaten by another one on both axes, and the panel underneath tells you which.

---

## 4 · Coverage

Model × hardware, one coloured cell per square, brightness by how many runs exist. Blank
means **nobody has measured it** — which in this atlas is the interesting part, not a gap in
the UI.

The legend under the map numbers the hardware columns, since device ids are too long to sit
above three-character cells.

This is the contribution view: a blank square is twenty minutes of work that nobody has done
yet, and [`AGENTS.md`](../../AGENTS.md) explains how to fill one.

---

## 5 · Hardware (also `b`)

Pick the box every verdict is judged against, and how many devices you have. Fully covered
in [The target box](target-box.md).

---

## Run detail (`enter`)

Everything known about one measurement.

**Identity** — model, quantization, engine and version, the hardware it ran on and how many
devices, the workload, who ran it, and the verification level (`self-reported` until someone
else reproduces it). Underneath: only the headline metrics that run actually carries, so an
eval shows accuracy and an evaluation of a serving run shows tok/s and TTFT.

**Fit on \<your box\>** — the verdict, framed in its own colour, with every reason listed.
This is the reasoning, not a score: what was measured, what was estimated, what it means for
your hardware.

**Latency distribution** — TTFT p50 / p90 / p95 / p99 as bars from zero, with the colour
deepening towards p99 so a tight tail is still readable.

**Requests** — every request in the run as one column, tallest = slowest, resampled across
the whole run so nothing is hidden. Failures are red. This is where you see a run warm up,
or a queue building, or one call that hung.

**Sweep** — for sweep and long-context runs, throughput (filled, cobalt, left axis) against
latency (orange, right axis) over the swept variable. The x axis is labelled with the levels
that were actually run.

**Gotchas** — one framed note per gotcha, coloured by severity: **red** for a blocker,
**orange** for a warning, **grey** for a note. This is the institutional knowledge that
outlives the number — a flag whose default is a lie, a container tag that only exists for
one architecture, a parser name that resolves under one spelling.

Press `g` here to turn all of it into a recipe.

---

## Recipe (`g` from the detail)

The generated Markdown, scrollable, with the file path it was written to at the top and your
configured agents listed underneath. Covered in [Recipes](recipes.md).

---

## Help (`?`)

The keyboard reference. `?` again, or `esc`, returns you to where you were.
