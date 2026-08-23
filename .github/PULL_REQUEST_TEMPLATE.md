<!--
For a measurement, keep the four sections below and delete nothing else — AGENTS.md
prescribes them in this order. For a registry addition or a code change, replace the four
sections with a description and keep the checklist.
-->

## Cells filled

<!-- One line each: engine + version, model/quant, hardware, workload, the headline number. -->

## What failed

<!-- Every failure with the actual error text. "Nothing failed" if nothing did. An omitted
     failure is worse than no contribution: it makes the map look explored when it is not. -->

## Gotchas

<!-- Everything you had to learn to make this work: a flag whose default is a lie, a
     container tag that only exists for one architecture, a parser name that resolves under
     exactly one spelling. This is the part of the run that outlives the number. -->

## Conditions

<!-- What the box was doing, what else was resident, ambient temperature if you know it. -->

---

- [ ] Every result file in this pull request is **mine** — `provenance.github_login` is my login, and I have not modified or deleted anybody else's file.
- [ ] The hardware was **captured**, not typed (`uv run atlas-bench hwinfo --json`), and it matches an existing `hardware/*.json` (or this pull request adds the device, and says so).
- [ ] `pnpm validate` passes locally, and I fixed the run or the metadata rather than the numbers.
- [ ] The box was **idle** apart from this run, or the Conditions section says what else was on it.
- [ ] Metrics I did not measure are `null`. I filled in nothing plausible-looking.
- [ ] `provenance.github_user_id`, `provenance.commit` and `provenance.pr` are `null` — CI and the build own those.
