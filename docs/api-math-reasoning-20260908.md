# Stock mathematics and reasoning v2 via authenticated API routes

Measured by [plotarmordev](https://github.com/plotarmordev) on 2026-09-08 using
[Inference Atlas](https://github.com/0xBakeer/inference-atlas) revision
[`3b8b6676dfb85e9fce4d45fa83bb3a86a1f70403`](https://github.com/0xBakeer/inference-atlas/tree/3b8b6676dfb85e9fce4d45fa83bb3a86a1f70403).
This is a **report-only contribution, not canonical Atlas result files**: no hardware
cells are filled and these measurements do not enter the site's hardware comparison.
The identifiers below are requested API route selectors, not authenticated model weights,
provider-confirmed release names, or Hugging Face repositories.

## Results

| Requested route              | eval-math-v2 | eval-reasoning-v2 | Combined |
| ---------------------------- | ------------ | ----------------- | -------- |
| `openai-codex/gpt-5.6-terra` | 139/140      | 138/140           | 277/280  |
| `openai-codex/gpt-5.6-luna`  | 138/140      | 137/140           | 275/280  |
| `anthropic/claude-opus-5`    | 140/140      | 139/140           | 279/280  |

Every suite used all 140 items in source order, once per route: **840 client requests,
840 scored outcomes, zero client retries**. All completed normally; zero transport
failures, unscored/excluded requests, empty finals, or length stops. Thus each fraction
uses both the full planned denominator and the native scored denominator. Nine answers
were incorrect; completion success is not answer accuracy.

[Per-item outcomes](api-math-reasoning-20260908.csv) preserve every native correctness
boolean, keyed by exact route, suite, and source item ID. They omit response text,
request envelopes, account metadata, latency and cost. These near-ceiling single runs do
not establish a general capability ranking or a statistically robust winner.

## Method and conditions

The original `run_eval`, row loader, `ChatClient` request construction and native scorers
were unmodified. A custom recording transport retained request/response evidence, and an
authenticated gateway routed the API requests. This was a direct evaluator invocation,
not a canonical hardware/engine run through the Atlas result-writing CLI. No custom
prompt suffixes, answer-key changes, grade repairs, or selected subsets were used.

Requested controls: nonstreaming, `max_tokens=4096`, `temperature=0`, `seed=42`, no
`reasoning_effort` override, no `top_p` override, 300-second request timeout, concurrency
4 per route/suite, one repetition and no warmups. Three route blocks overlapped;
each ran mathematics followed by reasoning. The supplied workload definitions and each
row's scorer were used: mathematics mixes numeric and multiple-choice scoring; reasoning
mixes exact, numeric and multiple-choice scoring.

These are **requested controls, not authenticated effective compute budgets**. On
`openai-codex/gpt-5.6-luna`, `math2-0130` completed normally and scored correct while
reporting **8,743 completion tokens, including 8,220 reasoning tokens**, despite requested
`max_tokens=4096`. The score is retained. A strict combined-token ceiling was not
established; this observation does not establish an Atlas bug.

The client used Python 3.13.15 and httpx 0.28.1. The captured Python dependency versions:

```text
annotated-doc==0.0.5
annotated-types==0.8.0
anyio==4.15.1
attrs==26.1.0
certifi==2026.7.22
h11==0.16.0
httpcore==1.0.9
httpx==0.28.1
idna==3.19
jsonschema==4.26.0
jsonschema-specifications==2025.9.1
markdown-it-py==4.2.0
mdurl==0.1.2
psutil==7.2.2
pydantic==2.13.5
pydantic-core==2.46.5
pygments==2.21.0
referencing==0.37.0
rich==15.0.0
rpds-py==2026.6.3
shellingham==1.5.4
typer==0.27.2
typing-extensions==4.16.0
typing-inspection==0.4.4
```

No local serving engine, hardware telemetry, or generated-code execution was used.
Backend hardware, load, engine versions, quantization, loaded weights, effective reasoning
defaults, gateway/provider transformations and hidden upstream retries are unreported or
unauthenticated. Client hardware is not serving hardware. No speed, hardware, energy or
billing comparison is claimed. Public/training exposure is unknown; 56 of the 280 question
stems per route had appeared in an earlier adapted trial. No adapted-trial scores are
included here, and this is not a first-exposure claim.

## All nine incorrect outcomes

The retained independent review checked only these nine failures, using arithmetic,
enumeration, date subtraction, primality checks and explicit die-face rotations, without
model calls. It found no answer-key challenges and made no canonical grade changes.
The predictions below are the native extracted answers, not full model responses.

| Route suffix  | Item         | Predicted  | Expected   | Retained independent check                                                  |
| ------------- | ------------ | ---------- | ---------- | --------------------------------------------------------------------------- |
| gpt-5.6-luna  | math2-0025   | -28        | 12         | Dividing the third equation by two gives +12, not -12; x=12, y=0, z=0.      |
| gpt-5.6-luna  | math2-0096   | 23410      | 15301      | C(14,6)=3003, not 300; C(17,8)-C(14,6)×C(3,2)=24310-9009=15301.             |
| gpt-5.6-terra | math2-0127   | B          | A          | For p=2,3,5,7 the bounded claim gives 3,7,31,127, all prime.                |
| gpt-5.6-luna  | reason2-0072 | 89         | 85         | Both forbidden pairs fill all four seats: C(9,4)-2×C(7,2)+1=85.             |
| gpt-5.6-luna  | reason2-0089 | 1995-12-30 | 1995-12-29 | 1997-07-19 minus 568 days; no internal cause inferred from the bare answer. |
| claude-opus-5 | reason2-0091 | 2039-11-03 | 2039-11-02 | 2041-07-15 minus 621 days; no internal cause inferred from the bare answer. |
| gpt-5.6-luna  | reason2-0102 | 5          | 2          | Explicit die rotations give top sequence 2,4,5,4,6,2.                       |
| gpt-5.6-terra | reason2-0103 | 3          | 4          | Explicit die rotations give top sequence 5,3,2,6,4.                         |
| gpt-5.6-terra | reason2-0120 | north      | west       | Three left turns and one right turn net two left turns; east becomes west.  |

## Verification and reproducibility boundary

The frozen verification records 840 raw-response hash checks and 840 offline replays with
the original scorers. During contribution preparation, all 37 pinned source/data files
and all 10 verification-listed evidence files matched their recorded SHA-256 hashes;
the exported outcome counts were checked against the frozen native scores. This is
contributor-held verification, not a new independent run or public attestation.

To inspect the exact questions, prompts, row metadata, request construction and scorers,
use the pinned revision above, not moving `main`. Relevant paths are
`datasets/eval-{math,reasoning}-v2/{dataset.json,items.jsonl}`,
`workloads/eval-{math,reasoning}-v2.json`, `bench/atlas_bench/data.py`,
`bench/atlas_bench/client.py`, `bench/atlas_bench/workloads/eval.py` and
`bench/atlas_bench/scorers/`. Dataset item-file SHA-256 pins:

- Mathematics: `f166e2ae408b64a1de19f4e4d3d2f64e1a31794f8848be6516827e4c0535e5e2`
- Reasoning: `34ad333c2618de5c126a62958458cd89585a57d377a4b6118c845e0c8c00966f`

Public readers can join the CSV to those item IDs and recompute all denominators and
correct counts. **They cannot independently replay the original scoring decisions from
this contribution:** full outputs and transport/controller implementation are not
redistributed, and a correctness boolean or hash is not a substitute for an output.
Do not use the nine extracted predictions as substitutes for full-output replay.

If full outputs become separately authorized and available, offline replay consists of
loading the original `EvalRow` for each item and calling the pinned
`get_scorer(row.scorer or workload["eval"]["scorer"])(full_output, row)`, comparing
`scored` and `correct` to the original records, without model requests or grade changes.
A new measurement would require separately authorized API access, the same pinned rows
and settings, and a documented transport. It would not reproduce the original serving
state or establish equal effective budgets. This report is not a turnkey reproduction
of the private gateway.

## Attribution and licence

Questions, keys, workloads and scorers are credited to **Inference Atlas contributors**,
Copyright (c) 2026, at the pinned source linked above. This report and its outcome CSV are
contributed by `plotarmordev` under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), subject to the contributor's
publication authorization. The export is a reduced presentation of original measurements,
not changed grades. No source snapshot, full question corpus, model weights, or full
responses are redistributed.

The repository's [DATA_LICENSE](../DATA_LICENSE) covers repository-authored datasets and
measurements under CC BY 4.0; both pinned dataset manifests separately declare MIT.
Both notices are retained by reference rather than silently resolving that discrepancy.
The original code and associated documentation retain the repository's
[MIT notice](../LICENSE). Route and provider names identify requested services only and
imply no endorsement.
