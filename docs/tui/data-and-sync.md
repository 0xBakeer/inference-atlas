# Data and syncing

The app shows the same numbers the website shows, because it reads the same files.

## Where the numbers come from

The atlas has no backend. **The repository is the database**: every measurement is one JSON
file committed to `main`, and CI compiles those files into a handful of shards that the
website — and this app — read.

```
results/**.json  ─┐
hardware/*.json   ├─ pnpm build:data ─→  app/public/data/*  ─→  GitHub Pages
models/**.json    │                                              ↑
engines/**.json  ─┘                                              │
                                                    inference-atlas syncs from here
```

Nothing is measured by CI, and there is no seed data. Every number was produced on a
contributor's own machine and submitted as a pull request.

## The shards

Fetched from `<url>/data/`:

| File                                           | What                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `manifest.json`                                | Build commit, timestamp, counts, and a **sha256 per shard**                |
| `index.json`                                   | One row per run: identity, headline metrics, provenance, path              |
| `registry.json`                                | Hardware, engines, models, quantizations, workloads, datasets, site config |
| `coverage.json`                                | Per-cell evidence state                                                    |
| `workloads.json`, `datasets.json`              | Workload and dataset definitions                                           |
| `stats.json`, `contributors.json`, `gaps.json` | Totals, contributors, unmeasured squares                                   |

Two more kinds are fetched only when you need them:

| On demand                                              | When                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `data/runs/<engine>/<owner>/<name>/<hw>/<run_id>.json` | You open a run — the full record with per-request samples and the raw payload                     |
| `data/engines/<id>/<version>.json`                     | You open a run or generate a recipe — the engine version's parameter table, for the per-flag help |

## How a sync works

1. `GET <url>/data/manifest.json` with an `If-None-Match` header carrying the previous ETag.
2. **304 Not Modified** → nothing changed, done. That is the common case, and it costs about
   1.5 KB of headers.
3. **200** → compare the sha256 of every shard against the cached manifest, and re-fetch
   _only_ the ones whose contents differ.
4. Write the new manifest last, so the manifest on disk always describes the shards next to
   it.

Run records are **immutable** — a `run_id` is derived from the content, so a given id always
means the same bytes. They are cached forever and never re-fetched.

## When it syncs

| Trigger    |                                                    |
| ---------- | -------------------------------------------------- |
| On launch  | Always                                             |
| `r`        | Manual refresh, any time                           |
| Background | Every `refresh_minutes` (default 15, `0` disables) |

The header shows the result: `fresh` (nothing changed), `updated` (shards re-fetched), or
`offline (cache)`, plus how long ago it checked and the commit the data was built from.

Polling faster than ten minutes cannot help: the published shards sit behind a CDN with a
`max-age=600`, so a more frequent request returns the same cached bytes.

## Offline

Everything is cached under `~/.cache/inference-atlas/data/`. If a sync fails — no network, a
DNS failure, the site down — the app says `offline (cache)` in the header and carries on with
what it has. Every view works; only new data is missing.

The **first** run needs the network once. After that you can fly.

To pre-warm the cache without opening the UI (in a provisioning script, or over a connection
you have now and will not have later):

```bash
inference-atlas --sync
```

## Local mode

Point the app at a checkout and it never touches the network:

```bash
inference-atlas --repo ~/Projects/inference-atlas
```

or permanently:

```toml
[data]
repo = "~/Projects/inference-atlas"
```

In this mode it reads `app/public/data/*` for the shards, and prefers the **raw** files for
everything else — `results/**.json` directly, and `engines/<id>/versions/<v>.json` for
parameter tables. So a result you have added locally but not yet committed shows up
immediately.

It does need the compiled shards to exist. If they do not, the app says so:

```
no compiled data at …/app/public/data — run `pnpm build:data` in the repo first
```

## Data freshness versus app freshness

They are separate. The **data** refreshes itself on a timer; the **app** only changes when
you update it. The header's `data @ 46e00af` is the commit the _data_ was built from, not
the version of the app.

## Verifying what you have

```bash
inference-atlas --sync          # prints "fresh", or "updated: index.json, registry.json, …"
cat ~/.cache/inference-atlas/data/manifest.json | head -20
```

The manifest names the commit, so you can go look at exactly what the numbers were built
from:

```
https://github.com/0xBakeer/inference-atlas/commit/<commit>
```

## Deleting the cache

Safe at any time. It re-syncs on the next launch.

```bash
rm -rf ~/.cache/inference-atlas
```
