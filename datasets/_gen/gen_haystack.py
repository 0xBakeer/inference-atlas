# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/haystack-v1/`.

32 needle-in-a-haystack recipes: eight token targets (1k .. 256k) x three needle
depths, plus one three-needle item per target for aggregation questions. Only the
*recipe* is committed — seed, target, depths, needle text and expected answer —
because the 256k variant alone would be a megabyte of text. The harness rebuilds
the document with `datasets/haystack-v1/build.py`, which is the normative
algorithm and is committed next to the data.

Everything at or below 32k tokens is *also* materialised into `static/<id>.txt`
for engines and harnesses that would rather point at a file than run Python.

Run: `uv run datasets/_gen/gen_haystack.py`
"""

from __future__ import annotations

import importlib.util
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260826
DATASET_ID = "haystack-v1"
STATIC_MAX_TOKENS = 32_768

TARGET_TOKENS = (1_024, 4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144)
DEPTHS = (0.1, 0.5, 0.9)

TOKEN_LABEL = {1_024: "1k", 4_096: "4k", 8_192: "8k", 16_384: "16k",
               32_768: "32k", 65_536: "64k", 131_072: "128k", 262_144: "256k"}

SECRET_KINDS = (
    (
        "passphrase",
        "The maintenance passphrase for the {city} vault is {code}.",
        "What is the maintenance passphrase for the {city} vault? Reply with the passphrase only.",
    ),
    (
        "override",
        "The override code recorded for crane {tag} is {code}.",
        "What is the override code recorded for crane {tag}? Reply with the code only.",
    ),
    (
        "tag",
        "The sealed inventory tag on pallet {tag} reads {code}.",
        "What does the sealed inventory tag on pallet {tag} read? Reply with the tag value only.",
    ),
)

CITIES = ("Aberholt", "Valcrest", "Threeford", "Kesswater", "Marren Bay", "Dunhallow",
          "Stonereach", "Oldmarsh")

ORDINALS = ("first", "second", "third")


def load_builder():
    """Import the committed reference implementation rather than duplicating it."""
    path = L.DATASETS_DIR / DATASET_ID / "build.py"
    spec = importlib.util.spec_from_file_location("haystack_build", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> None:
    rng = random.Random(SEED)
    hb = load_builder()
    d = L.dataset_dir(DATASET_ID)
    static_dir = d / "static"
    static_dir.mkdir(exist_ok=True)
    for old in static_dir.glob("*.txt"):
        old.unlink()

    items: list[dict] = []

    for target in TARGET_TOKENS:
        label = TOKEN_LABEL[target]
        for depth in DEPTHS:
            kind, text_tpl, question_tpl = SECRET_KINDS[len(items) % len(SECRET_KINDS)]
            fields = {
                "city": rng.choice(CITIES),
                "tag": f"{rng.randint(100, 989)}-{rng.choice('ABCDEFGHJK')}",
                "code": str(rng.randint(10_000, 99_999)),
            }
            items.append(
                {
                    "id": f"hay-{label}-d{int(depth * 100):02d}",
                    "kind": "single",
                    "target_tokens": target,
                    "seed": 7_000_000 + target + int(depth * 100),
                    "algorithm": "haystack-v1",
                    "secret_kind": kind,
                    "needles": [
                        {
                            "depth": depth,
                            "text": text_tpl.format(**fields),
                            "answer": fields["code"],
                        }
                    ],
                    "question": question_tpl.format(**fields),
                    "answer": fields["code"],
                }
            )

        codes = [rng.randint(100, 999) for _ in range(3)]
        items.append(
            {
                "id": f"hay-{label}-multi",
                "kind": "multi",
                "target_tokens": target,
                "seed": 7_500_000 + target,
                "algorithm": "haystack-v1",
                "secret_kind": "sum",
                "needles": [
                    {
                        "depth": depth,
                        "text": f"The {ordinal} secret number in this log is {code}.",
                        "answer": str(code),
                    }
                    for depth, ordinal, code in zip(DEPTHS, ORDINALS, codes)
                ],
                "question": "Three lines in the log state a secret number. Add all three together "
                "and reply with the sum only.",
                "answer": str(sum(codes)),
            }
        )

    # materialise once to record the verified facts: real size, line numbers, digest
    static_files: list[str] = []
    for item in items:
        text = hb.build_haystack(item)
        lines = text.split("\n")
        index = {}
        for i, line in enumerate(lines, start=1):
            body = line.split(": ", 1)[1]
            index.setdefault(body, i)
        for needle in item["needles"]:
            needle["line_number"] = index[needle["text"]]
            assert needle["answer"] in lines[needle["line_number"] - 1]

        item["chars"] = len(text)
        item["lines"] = len(lines)
        item["approx_tokens"] = L.approx_tokens_from_chars(len(text))
        item["sha256"] = hb.sha256(text)
        if item["target_tokens"] <= STATIC_MAX_TOKENS:
            name = f"{item['id']}.txt"
            (static_dir / name).write_text(text + "\n", encoding="utf-8")
            item["static_file"] = f"static/{name}"
            static_files.append(name)
        else:
            item["static_file"] = None

        # deterministic rebuild must be byte-identical
        assert hb.sha256(hb.build_haystack(item)) == item["sha256"]

    n = L.write_jsonl(d / "items.jsonl", items)
    L.write_json(
        d / "dataset.json",
        L.base_dataset_json(
            DATASET_ID,
            "Needle-in-a-haystack recipes v1",
            "haystack",
            "32 long-context recipes: eight token targets from 1k to 256k, each with a needle at "
            "10 %, 50 % and 90 % depth plus one three-needle variant for aggregation questions. "
            "Rows are recipes, not text; datasets/haystack-v1/build.py is the normative "
            "materialisation algorithm and every row carries the sha256 of its output.",
            ["items.jsonl", "build.py"],
            n,
            "gen_haystack.py",
            seed=SEED,
            target_tokens=list(TARGET_TOKENS),
            depths=list(DEPTHS),
            static={
                "dir": "static",
                "materialised_up_to_tokens": STATIC_MAX_TOKENS,
                "files": sorted(static_files),
                "note": "Static files carry one trailing newline that is not part of the hashed text.",
            },
            schema={
                "fields": [
                    "id", "kind", "target_tokens", "seed", "algorithm", "secret_kind", "needles",
                    "question", "answer", "chars", "lines", "approx_tokens", "sha256", "static_file",
                ],
                "needles": "[{depth, text, answer, line_number}] — line_number is the 1-based line "
                "of the needle in the materialised document, verified by the generator.",
                "kind": "single = one needle; multi = three needles whose answers must be aggregated.",
            },
            usage=[
                "Materialise with build_haystack(item); prompt with build_prompt(item), which is "
                "preamble + document + question.",
                "Serving/prefill workloads use these documents purely as input padding and ignore "
                "the answer; longctx workloads must check it.",
                "The sha256 field is the contract between implementations: a re-implementation of "
                "the algorithm is correct iff every digest matches.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
