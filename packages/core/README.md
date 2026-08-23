# @atlas/core

Everything in Inference Atlas that must behave identically in the browser, in Node and —
re-implemented and golden-vector tested — in the Python harness.

No filesystem, no network, no Node-only API. The config explorer recomputes a fingerprint on
every keystroke with the same code CI validates pull requests with, which is also why hashing
is synchronous (`@noble/hashes`) rather than Web Crypto.

| module            | what                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `types.ts`        | TypeScript mirrors of every JSON Schema, plus the compiled/derived shapes                                           |
| `canonical.ts`    | `canonicalizeArgs` — SPEC §3 config fingerprinting                                                                  |
| `ids.ts`          | `cellId`, `runId`, `parseRunId`, `engineMinor`, `resultPath`, `parseResultPath`, `isModelId`, `modelSlug` — SPEC §2 |
| `plausibility.ts` | `checkPlausibility` — the physical sanity bounds of SPEC §5 item 5                                                  |
| `coverage.ts`     | `computeCoverage` — none / single / reproduced / disputed / stale                                                   |
| `scoring.ts`      | `computeScores` — contributor points, weights from `site/config.json`                                               |
| `packet.ts`       | `buildPacket` — the Markdown / JSON / shell / issue renderings of SPEC §7                                           |

```bash
pnpm --filter @atlas/core run build      # tsc to dist/
pnpm --filter @atlas/core run test       # vitest, including the golden vectors
pnpm --filter @atlas/core run typecheck
```

Model ids are the one identifier that is not lowercase kebab-case: they are Hugging Face repo
ids, verbatim (`Qwen/Qwen3.8-27B`), hashed as written and spending two path segments wherever
they appear. `isModelId` validates the shape, `modelSlug` flattens one into a branch-safe
label, and `parseResultPath` is the inverse of `resultPath`.

**Canonicalization is a contract.** `schemas/fixtures/fingerprint-vectors.json` and
`id-vectors.json` are shared with `bench/atlas_bench`. A failing vector is a regression in the
algorithm, never a stale fixture: changing it means a SPEC change, a coordinated update of
both implementations, and every `config_id` in the repository moving.
