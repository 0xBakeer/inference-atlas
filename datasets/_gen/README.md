# Dataset generators

Every directory under `datasets/` is produced by **exactly one** script in here, and
the generated output is committed. You never need to run these to use the repo —
clone it and the data is there. You run them when you want to change a dataset,
and then you ship a **new versioned id**, because published datasets are pinned to
workloads and are immutable (see `workloads/README.md`).

## Running

Each script carries [PEP 723](https://peps.python.org/pep-0723/) inline metadata,
so `uv` resolves its dependencies on the fly with no project setup:

```bash
uv run datasets/_gen/gen_prompts_mixed.py
uv run datasets/_gen/check.py            # validate everything
```

Requirements: Python ≥ 3.11. Only `gen_eval_vision.py` has a dependency (Pillow);
everything else is standard library, and `check.py` is standard library on purpose
so CI can run it with a bare interpreter.

Regenerate everything:

```bash
for f in datasets/_gen/gen_*.py; do uv run "$f"; done
uv run datasets/_gen/check.py
```

## Which script owns which directory

| script                          | produces                     | notes                                                          |
| ------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| `gen_prompts_mixed.py`          | `prompts-mixed-v1/`          | 600 prompts, 11 topics × 6 length buckets                      |
| `gen_prompts_shared_prefix.py`  | `prompts-shared-prefix-v1/`  | 100 prompts over 4 long system prompts                         |
| `gen_prompts_code.py`           | `prompts-code-v1/`           | 150 coding prompts in 5 languages                              |
| `gen_haystack.py`               | `haystack-v1/`               | 32 recipes + static files ≤ 32k tokens                         |
| `gen_eval_math.py`              | `eval-math-v1/`              | answers computed, never typed                                  |
| `gen_eval_reasoning.py`         | `eval-reasoning-v1/`         | puzzles brute-forced for a unique solution                     |
| `gen_eval_code.py`              | `eval-code-v1/`              | reference solutions run against their own tests                |
| `gen_eval_knowledge.py`         | `eval-knowledge-v1/`         | MC, correct letter balanced over A–D                           |
| `gen_eval_instruction.py`       | `eval-instruction-v1/`       | rule DSL, each item verified against a compliant example       |
| `gen_eval_json.py`              | `eval-json-v1/`              | expected objects computed from the same data as the prompt     |
| `gen_eval_tools.py`             | `eval-tools-v1/`             | expected arguments validated against the tool schema           |
| `gen_eval_vision.py`            | `eval-vision-v1/`            | draws every PNG; needs Pillow                                  |
| `gen_eval_multilingual.py`      | `eval-multilingual-v1/`      | native text lives in `_multilingual.py`                        |
| `gen_eval_longctx.py`           | `eval-longctx-v1/`           | recipes verified against `haystack-v1/build.py`                |
| `gen_eval_format.py`            | `eval-format-v1/`            | hand-written, 30 items                                         |
| `gen_eval_math_v2.py`           | `eval-math-v2/`              | harder v2: CRT, totients, claims brute-forced over ranges      |
| `gen_eval_reasoning_v2.py`      | `eval-reasoning-v2/`         | harder v2: bigger search spaces, all brute-forced unique       |
| `gen_eval_knowledge_v2.py`      | `eval-knowledge-v2/`         | harder v2: second-tier stable facts, in-table distractors      |
| `gen_eval_science_v2.py`        | `eval-science-v2/`           | applied physics/chemistry, constants pinned in prompts         |
| `gen_eval_commonsense_v2.py`    | `eval-commonsense-v2/`       | goal traps + altered riddles; text_selfref rows computed       |
| `gen_eval_security_v2.py`       | `eval-security-v2/`          | defensive security; crypto/CIDR/log answers computed           |
| `gen_eval_longgen_integrity.py` | `eval-longgen-integrity-v1/` | synthetic JS projects; context identifiers computed, not typed |

Shared, not a generator:

| file               | role                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `_lib.py`          | seeded text machinery: topic banks, template filler, document/code/transcript composers, dataset.json helpers, the scorer vocabulary |
| `_multilingual.py` | natively written German, French, Spanish, Italian, Portuguese, Arabic, Chinese, Japanese and Turkish text                            |
| `check.py`         | validates every dataset; exit code 1 on any problem                                                                                  |

Two reference implementations live **with their data**, not here, because the
Python harness in `bench/` has to import them:

- `datasets/haystack-v1/build.py` — the normative haystack materialisation algorithm
- `datasets/eval-instruction-v1/rules.py` — the normative instruction rule DSL

## The rules these scripts follow

1. **Deterministic.** Every script seeds its own `random.Random(SEED)` and never
   touches the global `random`. Nothing depends on dict ordering, on the clock, on
   the filesystem or on `PYTHONHASHSEED`. Re-running produces byte-identical files;
   `git status` staying clean after a regeneration is the test.
2. **Idempotent.** Scripts clear what they own (`images/`, `static/`) before
   writing, so a rerun never leaves stale files behind.
3. **Answers are computed, never typed.** Maths answers come out of the same
   arithmetic that built the question; puzzle answers are brute-forced and rejected
   unless unique; code tests are executed against a reference solution; instruction
   rule sets are checked against a compliant example; tool arguments are validated
   against the tool's own JSON schema; image answers are the values the picture was
   drawn from. A generator that cannot prove its key fails loudly instead of
   emitting a dataset.
4. **Uniqueness over volume.** Long prompts are composed from templates with wide
   slot vocabularies plus running reference numbers, because repeated text is
   absorbed by prefix caching and by tokenizer merges and would flatter prefill
   throughput. `_lib._audit_banks()` refuses a sentence template that has no
   numeric slot.
5. **Nothing is downloaded.** No corpora, no scraping, no model output. Everything
   here was written or generated in this repository and is MIT licensed.

## Changing a dataset

Editing a published dataset in place breaks every result that references it,
because a result is only comparable to another result from the same pinned data.
So:

1. copy the generator to `gen_<name>_v2.py`, change `DATASET_ID` to `<name>-v2`
   and pick a new `SEED` if the content changes;
2. run it, run `check.py`;
3. add the matching `-v2` workload with `supersedes` pointing at the old id;
4. leave the v1 directory and its workload exactly as they are.

Adding a brand-new dataset: one new script, one new directory, an entry in the
table above and in `datasets/README.md`, and a workload that references it.
