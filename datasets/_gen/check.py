# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Validate everything under `datasets/`.

Standard library only, so it runs anywhere without an environment:

    uv run datasets/_gen/check.py          # or: python3 datasets/_gen/check.py

What it checks, per dataset:

  * dataset.json parses and carries the required fields (SPEC section 4);
  * `count` equals the number of rows actually in the jsonl;
  * every file listed in `files` exists;
  * row ids are unique and non-empty, and every row has the fields its kind needs;
  * prompt rows: bucket matches approx_tokens, approx_tokens matches the chars/4
    heuristic, messages are well-formed, shared_prefix is a string or null;
  * eval rows: category/difficulty/scorer are known values, mc rows have choices
    and an answer that is one of the labels, code_exec rows have tests, vision
    rows point at an image that exists, and at least 95 % of answers are non-empty;
  * haystack recipes rebuild to the recorded sha256, and every static file matches;
  * eval-longctx recipes rebuild to their recorded sha256 too;
  * the eval-instruction rule DSL self-test passes and every rule used by an item
    is one the reference implementation knows;
  * cross-dataset: every workload in `workloads/` points at a dataset that exists.

Exit code 0 when everything passes; 1 with a list of failures otherwise. Sizes are
printed either way, because the corpus has a 25 MB budget.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from pathlib import Path

DATASETS = Path(__file__).resolve().parent.parent
REPO = DATASETS.parent
WORKLOADS = REPO / "workloads"
SIZE_BUDGET_BYTES = 25 * 1024 * 1024

KINDS = {"prompts", "eval", "images", "haystack"}
DIFFICULTIES = {"easy", "medium", "hard"}
SCORERS = {"exact", "numeric", "mc", "contains", "json", "code_exec", "needle", "instruction",
           "vision", "judge", "integrity"}
BUCKETS = {"xs": (16, 64), "s": (65, 256), "m": (257, 1024), "l": (1025, 4096),
           "xl": (4097, 16384), "xxl": (16385, 65536)}

problems: list[str] = []


def fail(where: str, message: str) -> None:
    problems.append(f"{where}: {message}")


def human(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.2f} MB"


def dir_size(path: Path) -> int:
    """Bytes that would actually be committed — __pycache__ is gitignored."""
    return sum(p.stat().st_size for p in path.rglob("*")
               if p.is_file() and "__pycache__" not in p.parts)


def load_jsonl(path: Path, where: str) -> list[dict]:
    rows = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            fail(where, f"line {i} is not valid JSON: {exc}")
    return rows


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------------------
# per-kind row checks
# --------------------------------------------------------------------------------------


def check_prompt_rows(rows: list[dict], where: str) -> None:
    for row in rows:
        rid = row.get("id", "<no id>")
        for field in ("id", "topic", "bucket", "approx_tokens", "messages"):
            if field not in row:
                fail(where, f"{rid} is missing '{field}'")
        messages = row.get("messages")
        if not isinstance(messages, list) or not messages:
            fail(where, f"{rid} has no messages")
            continue
        chars = 0
        for message in messages:
            if message.get("role") not in {"system", "user", "assistant"}:
                fail(where, f"{rid} has message role {message.get('role')!r}")
            if not isinstance(message.get("content"), str) or not message["content"]:
                fail(where, f"{rid} has an empty message content")
            chars += len(message.get("content", ""))
        prefix = row.get("shared_prefix")
        if prefix is not None:
            if not isinstance(prefix, str) or not prefix:
                fail(where, f"{rid} has a non-string shared_prefix")
            else:
                chars += len(prefix)
        expected = math.ceil(chars / 4)
        if row.get("approx_tokens") != expected:
            fail(where, f"{rid} approx_tokens is {row.get('approx_tokens')}, chars/4 gives {expected}")
        bucket = row.get("bucket")
        if bucket not in BUCKETS:
            fail(where, f"{rid} has unknown bucket {bucket!r}")
        else:
            low, high = BUCKETS[bucket]
            if not low <= expected <= high:
                fail(where, f"{rid} is {expected} approx tokens, outside bucket {bucket} {low}-{high}")


def check_eval_rows(rows: list[dict], where: str, directory: Path) -> None:
    empty = 0
    for row in rows:
        rid = row.get("id", "<no id>")
        for field in ("id", "category", "difficulty", "answer", "scorer"):
            if field not in row:
                fail(where, f"{rid} is missing '{field}'")
        if "prompt" not in row and "messages" not in row:
            fail(where, f"{rid} has neither prompt nor messages")
        if row.get("difficulty") not in DIFFICULTIES:
            fail(where, f"{rid} has difficulty {row.get('difficulty')!r}")
        scorer = row.get("scorer")
        if scorer not in SCORERS:
            fail(where, f"{rid} has unknown scorer {scorer!r}")
        answer = row.get("answer")
        if answer is None or answer == "" or answer == {} or answer == []:
            empty += 1
        if scorer == "mc":
            choices = row.get("choices")
            if not isinstance(choices, list) or len(choices) < 2:
                fail(where, f"{rid} is scored mc but has no choices")
            elif len(set(choices)) != len(choices):
                fail(where, f"{rid} has duplicate choices")
            labels = [chr(ord("A") + i) for i in range(len(choices or []))]
            if answer not in labels:
                fail(where, f"{rid} answer {answer!r} is not one of {labels}")
        if scorer == "code_exec" and not row.get("tests"):
            fail(where, f"{rid} is scored code_exec but has no tests")
        if scorer == "numeric":
            try:
                float(str(answer))
            except ValueError:
                fail(where, f"{rid} is scored numeric but its answer {answer!r} is not a number")
        if "image" in row:
            path = directory / row["image"]
            if not path.exists():
                fail(where, f"{rid} references missing image {row['image']}")
            elif path.stat().st_size > 30 * 1024:
                fail(where, f"{rid} image is {human(path.stat().st_size)}, over the 30 KB limit")
    if rows:
        share = 1 - empty / len(rows)
        if share < 0.95:
            fail(where, f"only {share:.1%} of answers are non-empty (95 % required)")


def check_haystack_rows(rows: list[dict], where: str, directory: Path) -> None:
    build = directory / "build.py"
    if not build.exists():
        fail(where, "build.py is missing")
        return
    hb = load_module(build, "haystack_build_check")
    for row in rows:
        rid = row.get("id", "<no id>")
        for field in ("id", "seed", "target_tokens", "needles", "question", "answer", "sha256"):
            if field not in row:
                fail(where, f"{rid} is missing '{field}'")
                break
        else:
            text = hb.build_haystack(row)
            digest = hb.sha256(text)
            if digest != row["sha256"]:
                fail(where, f"{rid} rebuilds to {digest[:12]}, recorded {row['sha256'][:12]}")
            if row.get("chars") != len(text):
                fail(where, f"{rid} chars is {row.get('chars')}, rebuild gives {len(text)}")
            for needle in row["needles"]:
                line_no = needle.get("line_number")
                lines = text.split("\n")
                if not line_no or line_no > len(lines) or needle["text"] not in lines[line_no - 1]:
                    fail(where, f"{rid} needle line_number {line_no} does not hold the needle")
            static = row.get("static_file")
            if static:
                path = directory / static
                if not path.exists():
                    fail(where, f"{rid} static file {static} is missing")
                elif path.read_text(encoding="utf-8").rstrip("\n") != text:
                    fail(where, f"{rid} static file {static} does not match the rebuild")


def check_longctx_recipes(rows: list[dict], where: str) -> None:
    build = DATASETS / "haystack-v1" / "build.py"
    if not build.exists():
        fail(where, "datasets/haystack-v1/build.py is missing; recipes cannot be verified")
        return
    hb = load_module(build, "haystack_build_longctx")
    for row in rows:
        hay = row.get("meta", {}).get("haystack")
        if not hay:
            fail(where, f"{row.get('id')} has no meta.haystack recipe")
            continue
        digest = hb.sha256(hb.build_haystack(hay))
        if digest != row["meta"].get("sha256"):
            fail(where, f"{row.get('id')} recipe rebuilds to {digest[:12]}, "
                        f"recorded {str(row['meta'].get('sha256'))[:12]}")


def check_instruction_rules(rows: list[dict], where: str, directory: Path) -> None:
    path = directory / "rules.py"
    if not path.exists():
        fail(where, "rules.py is missing")
        return
    ir = load_module(path, "instruction_rules_check")
    if ir.self_test():
        fail(where, "rules.py --self-test does not pass")
    for row in rows:
        answer = row.get("answer")
        if not isinstance(answer, dict) or "all" not in answer:
            fail(where, f"{row.get('id')} answer is not a rule set")
            continue
        example = row.get("meta", {}).get("example_pass")
        if example is None:
            fail(where, f"{row.get('id')} has no meta.example_pass")
            continue
        try:
            ok, failures = ir.evaluate(answer, example)
        except ValueError as exc:
            fail(where, f"{row.get('id')} uses an unknown rule: {exc}")
            continue
        if not ok:
            fail(where, f"{row.get('id')} example_pass fails its own rules: {failures}")


def check_tool_rows(rows: list[dict], where: str) -> None:
    for row in rows:
        tools = row.get("meta", {}).get("tools")
        if not tools:
            fail(where, f"{row.get('id')} has no meta.tools")
            continue
        names = {t["function"]["name"] for t in tools}
        call = row.get("answer", {}).get("tool_call")
        if call is None:
            continue
        if call["name"] not in names:
            fail(where, f"{row.get('id')} expects {call['name']}, which is not in meta.tools")
            continue
        schema = next(t for t in tools if t["function"]["name"] == call["name"])
        properties = schema["function"]["parameters"]["properties"]
        for key in call["arguments"]:
            if key not in properties:
                fail(where, f"{row.get('id')} expects argument {key!r} the tool does not define")
        for key in schema["function"]["parameters"].get("required", []):
            if key not in call["arguments"]:
                fail(where, f"{row.get('id')} omits required argument {key!r}")


# --------------------------------------------------------------------------------------


def check_dataset(directory: Path) -> tuple[str, str, int, int]:
    where = directory.name
    meta_path = directory / "dataset.json"
    if not meta_path.exists():
        fail(where, "dataset.json is missing")
        return where, "?", 0, dir_size(directory)
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(where, f"dataset.json is not valid JSON: {exc}")
        return where, "?", 0, dir_size(directory)

    for field in ("schema_version", "id", "name", "kind", "licence", "files", "count"):
        if field not in meta:
            fail(where, f"dataset.json is missing '{field}'")
    if meta.get("id") != directory.name:
        fail(where, f"dataset.json id is {meta.get('id')!r} but the directory is {directory.name!r}")
    if meta.get("kind") not in KINDS:
        fail(where, f"unknown kind {meta.get('kind')!r}")
    if meta.get("licence") != "MIT":
        fail(where, f"licence is {meta.get('licence')!r}; datasets/ is MIT (SPEC section 0.6)")

    for name in meta.get("files", []):
        target = directory / name.rstrip("/")
        if not target.exists():
            fail(where, f"files lists {name!r}, which does not exist")

    rows_path = directory / ("items.jsonl" if (directory / "items.jsonl").exists()
                             else "prompts.jsonl")
    if not rows_path.exists():
        fail(where, "no items.jsonl or prompts.jsonl")
        return where, meta.get("kind", "?"), 0, dir_size(directory)

    rows = load_jsonl(rows_path, where)
    ids = [r.get("id") for r in rows]
    if len(set(ids)) != len(ids):
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        fail(where, f"duplicate row ids: {duplicates[:5]}")
    if any(not i for i in ids):
        fail(where, "some rows have an empty id")
    if meta.get("count") != len(rows):
        fail(where, f"dataset.json count is {meta.get('count')} but the file has {len(rows)} rows")

    kind = meta.get("kind")
    if kind == "prompts":
        check_prompt_rows(rows, where)
    elif kind == "eval":
        check_eval_rows(rows, where, directory)
        if directory.name == "eval-instruction-v1":
            check_instruction_rules(rows, where, directory)
        if directory.name == "eval-tools-v1":
            check_tool_rows(rows, where)
        if directory.name == "eval-longctx-v1":
            check_longctx_recipes(rows, where)
    elif kind == "haystack":
        check_haystack_rows(rows, where, directory)

    return where, kind or "?", len(rows), dir_size(directory)


def check_workload_references(dataset_ids: set[str]) -> None:
    if not WORKLOADS.exists():
        return
    for path in sorted(WORKLOADS.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        dataset_id = doc.get("dataset_id")
        if dataset_id and dataset_id not in dataset_ids:
            fail("workloads", f"{path.name} references unknown dataset {dataset_id!r}")


def main() -> int:
    directories = sorted(d for d in DATASETS.iterdir()
                         if d.is_dir() and not d.name.startswith("_"))
    if not directories:
        print("no datasets found")
        return 1

    table = [check_dataset(d) for d in directories]
    check_workload_references({d.name for d in directories})

    total = dir_size(DATASETS)
    width = max(len(name) for name, *_ in table)
    print(f"{'dataset'.ljust(width)}  {'kind'.ljust(8)} {'rows'.rjust(6)}  size")
    for name, kind, rows, size in table:
        print(f"{name.ljust(width)}  {kind.ljust(8)} {str(rows).rjust(6)}  {human(size)}")
    generators = dir_size(DATASETS / "_gen") if (DATASETS / "_gen").exists() else 0
    print(f"{'_gen (scripts)'.ljust(width)}  {'-'.ljust(8)} {'-'.rjust(6)}  {human(generators)}")
    print(f"{'TOTAL'.ljust(width)}  {''.ljust(8)} {sum(r for _, _, r, _ in table):>6}  "
          f"{human(total)} of {human(SIZE_BUDGET_BYTES)} budget")

    if total > SIZE_BUDGET_BYTES:
        fail("datasets/", f"total size {human(total)} exceeds the {human(SIZE_BUDGET_BYTES)} budget")

    if problems:
        print(f"\n{len(problems)} problem(s):")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
