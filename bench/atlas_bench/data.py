"""Dataset loading and deterministic prompt sampling.

Prompt rows (``datasets/<id>/*.jsonl``) look like::

    {"id": "p-0001", "topic": "code", "bucket": "m", "approx_tokens": 900,
     "messages": [{"role": "user", "content": "..."}]}

Eval rows look like::

    {"id": "math-0001", "category": "algebra", "difficulty": "easy",
     "prompt": "...", "answer": "42", "scorer": "numeric", "choices": [...],
     "tests": "...", "image": "images/x.png"}

The loaders are deliberately tolerant: a dataset that has not been authored yet falls back
to deterministic synthetic filler so the harness can still be exercised (the run records a
``dataset-missing`` warning, and the caller turns that into a gotcha).
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .registry import Registry

__all__ = [
    "AgenticTurn",
    "load_agentic_conversations",
    "WORDS_PER_TOKEN",
    "EvalRow",
    "PromptRow",
    "build_haystack",
    "load_eval_rows",
    "load_prompt_rows",
    "load_rows",
    "sample_prompts",
    "synthetic_prompt",
]

#: Rough words-per-token ratio used only for synthetic filler sizing.
WORDS_PER_TOKEN = 0.75

_FILLER_WORDS = (
    "atlas inference engine kernel tensor cache latency throughput batch decode prefill "
    "memory bandwidth quantization scheduler sequence attention router adapter sampler "
    "context window checkpoint gradient runtime pipeline cluster benchmark harness result"
).split()


@dataclass
class PromptRow:
    """One chat prompt from a prompts dataset."""

    id: str
    messages: list[dict[str, Any]]
    approx_tokens: int = 0
    topic: str | None = None
    bucket: str | None = None
    lang: str | None = None
    shared_prefix: str | None = None
    prefix_id: str | None = None
    padded: bool = False

    @classmethod
    def from_dict(cls, raw: dict[str, Any], index: int = 0) -> PromptRow:
        """Build a row from raw JSONL, accepting ``prompt`` as a shorthand."""
        messages = raw.get("messages")
        if not messages:
            prompt = raw.get("prompt") or raw.get("text") or ""
            messages = [{"role": "user", "content": prompt}]
        return cls(
            id=str(raw.get("id") or f"row-{index:05d}"),
            messages=list(messages),
            approx_tokens=int(raw.get("approx_tokens") or 0),
            topic=raw.get("topic"),
            bucket=raw.get("bucket"),
            lang=raw.get("lang"),
            shared_prefix=raw.get("shared_prefix"),
            prefix_id=raw.get("prefix_id"),
        )

    def chat_messages(self) -> list[dict[str, Any]]:
        """What actually goes on the wire.

        ``shared_prefix`` is a contract, not a hint: when it is non-null it must be sent as
        a leading system message (``approx_tokens`` already accounts for it). Dropping it
        would turn a prefix-caching measurement into a different workload.
        """
        if not self.shared_prefix:
            return list(self.messages)
        return [{"role": "system", "content": self.shared_prefix}, *self.messages]


@dataclass
class EvalRow:
    """One eval item (question + expected answer + scorer)."""

    id: str
    messages: list[dict[str, Any]]
    answer: Any = None
    scorer: str = "exact"
    category: str = "uncategorized"
    difficulty: str = "unknown"
    choices: list[str] | None = None
    tests: str | None = None
    image: str | None = None
    max_tokens: int | None = None
    #: Per-scorer extras: tolerance, answer_aliases, match, tools, haystack, timeout_s …
    meta: dict[str, Any] = field(default_factory=dict)
    #: Directory the row was loaded from; the ``instruction`` scorer needs it for rules.py.
    dataset_dir: Path | None = None
    #: Filled by the eval runner for tool-calling rows before scoring.
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any], index: int = 0) -> EvalRow:
        """Build an eval row from raw JSONL (``prompt`` or ``messages``)."""
        messages = raw.get("messages")
        if not messages:
            messages = [{"role": "user", "content": raw.get("prompt") or ""}]
        known = {
            "id",
            "messages",
            "prompt",
            "answer",
            "scorer",
            "category",
            "difficulty",
            "choices",
            "tests",
            "image",
            "max_tokens",
            "meta",
        }
        return cls(
            id=str(raw.get("id") or f"item-{index:05d}"),
            messages=list(messages),
            answer=raw.get("answer"),
            scorer=str(raw.get("scorer") or "exact"),
            category=str(raw.get("category") or "uncategorized"),
            difficulty=str(raw.get("difficulty") or "unknown"),
            choices=raw.get("choices"),
            tests=raw.get("tests"),
            image=raw.get("image"),
            max_tokens=raw.get("max_tokens"),
            meta=dict(raw.get("meta") or {}),
            extra={k: v for k, v in raw.items() if k not in known},
        )

    @property
    def target_tokens(self) -> int | None:
        """Nominal prompt length of a long-context row, when it declares one."""
        value = self.meta.get("target_tokens") or self.meta.get("approx_tokens")
        return int(value) if isinstance(value, (int, float)) else None


@dataclass(slots=True)
class AgenticTurn:
    """One recorded turn of an agentic session.

    ``role`` is ``user``, ``assistant`` or ``tool``. A user turn carries the text plus the
    session's ``system`` prompt and ``tools``; an assistant turn carries the recorded
    ``tool_calls`` and ``reasoning_content``; a tool turn carries ``tool_results`` and the
    ``delay_seconds`` the real tool took.
    """

    conversation_id: str
    turn: int
    role: str
    content: str | None = None
    system: str | None = None
    tools: list[dict[str, Any]] | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_results: list[dict[str, Any]] | None = None
    reasoning_content: str | None = None
    delay_seconds: float = 0.0


def load_agentic_conversations(
    registry: Registry, dataset_id: str
) -> list[list[AgenticTurn]]:
    """Recorded sessions, each a turn-ordered list, ordered by conversation id.

    Ordering is deterministic on purpose: two runs of the same workload must send the same
    sessions in the same order, or the comparison is between two different measurements.
    """
    grouped: dict[str, list[AgenticTurn]] = {}
    for row in load_rows(registry, dataset_id):
        cid = str(row.get("conversation_id") or "")
        if not cid:
            continue
        grouped.setdefault(cid, []).append(
            AgenticTurn(
                conversation_id=cid,
                turn=int(row.get("turn") or 0),
                role=str(row.get("role") or ""),
                content=row.get("content"),
                system=row.get("system"),
                tools=row.get("tools"),
                tool_calls=row.get("tool_calls"),
                tool_results=row.get("tool_results"),
                reasoning_content=row.get("reasoning_content"),
                delay_seconds=float(row.get("delay_seconds") or 0.0),
            )
        )
    return [sorted(turns, key=lambda t: t.turn) for _, turns in sorted(grouped.items())]


def _jsonl_files(registry: Registry, dataset_id: str) -> list[Path]:
    """Data files of a dataset: ``dataset.json.files`` if present, else every ``*.jsonl``."""
    directory = registry.dataset_dir(dataset_id)
    meta = registry.dataset(dataset_id)
    if meta and meta.get("files"):
        files = [directory / str(name) for name in meta["files"]]
        return [f for f in files if f.suffix == ".jsonl" and f.is_file()]
    return sorted(directory.glob("*.jsonl")) if directory.is_dir() else []


def load_rows(registry: Registry, dataset_id: str) -> list[dict[str, Any]]:
    """Read every JSONL row of a dataset (empty list when the dataset is absent)."""
    rows: list[dict[str, Any]] = []
    for path in _jsonl_files(registry, dataset_id):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("//"):
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    rows.append(parsed)
    return rows


def load_prompt_rows(registry: Registry, dataset_id: str) -> list[PromptRow]:
    """Prompt rows of a dataset."""
    return [PromptRow.from_dict(r, i) for i, r in enumerate(load_rows(registry, dataset_id))]


def load_eval_rows(registry: Registry, dataset_id: str) -> list[EvalRow]:
    """Eval rows of a dataset, each tagged with the directory it came from."""
    directory = registry.dataset_dir(dataset_id)
    rows = [EvalRow.from_dict(r, i) for i, r in enumerate(load_rows(registry, dataset_id))]
    for row in rows:
        row.dataset_dir = directory
    return rows


def filter_prompt_rows(rows: list[PromptRow], buckets: Any = None) -> list[PromptRow]:
    """Apply a workload's ``dataset_buckets`` filter (no filter → everything)."""
    if not buckets:
        return rows
    wanted = {str(b).lower() for b in buckets}
    filtered = [row for row in rows if (row.bucket or "").lower() in wanted]
    return filtered or rows


def filter_eval_rows(
    rows: list[EvalRow], categories: Any = None, target_tokens: Any = None
) -> list[EvalRow]:
    """Apply a workload's ``dataset_categories`` / ``dataset_target_tokens`` filters."""
    filtered = rows
    if categories:
        wanted = {str(c).lower() for c in categories}
        filtered = [row for row in filtered if (row.category or "").lower() in wanted]
    if target_tokens:
        sizes = (
            {int(t) for t in target_tokens}
            if isinstance(target_tokens, (list, tuple, set))
            else {int(target_tokens)}
        )
        filtered = [row for row in filtered if row.target_tokens in sizes]
    return filtered


def synthetic_prompt(approx_tokens: int, index: int, seed: int = 42) -> PromptRow:
    """Deterministic filler prompt of roughly ``approx_tokens`` tokens."""
    rng = random.Random(f"{seed}:{index}:{approx_tokens}")
    word_count = max(4, int(approx_tokens * WORDS_PER_TOKEN))
    body = " ".join(rng.choice(_FILLER_WORDS) for _ in range(word_count))
    content = f"[synthetic-{index:05d}] Summarize the following notes in one paragraph.\n{body}"
    return PromptRow(
        id=f"synthetic-{index:05d}",
        messages=[{"role": "user", "content": content}],
        approx_tokens=approx_tokens,
        topic="synthetic",
        padded=True,
    )


def _pad_to(row: PromptRow, target_tokens: int, seed: int) -> PromptRow:
    """Append deterministic filler until a row is close to ``target_tokens``."""
    missing = target_tokens - row.approx_tokens
    if missing <= 0:
        return row
    filler = synthetic_prompt(missing, index=abs(hash(row.id)) % 100000, seed=seed)
    messages = [dict(m) for m in row.messages]
    for message in reversed(messages):
        if message.get("role") == "user" and isinstance(message.get("content"), str):
            message["content"] = message["content"] + "\n\n" + filler.messages[0]["content"]
            break
    else:  # pragma: no cover - rows always carry a user turn in practice
        messages.append({"role": "user", "content": filler.messages[0]["content"]})
    return PromptRow(
        id=row.id,
        messages=messages,
        approx_tokens=target_tokens,
        topic=row.topic,
        bucket=row.bucket,
        padded=True,
    )


def sample_prompts(
    rows: list[PromptRow],
    count: int,
    *,
    seed: int = 42,
    target_tokens: int | None = None,
    pad: bool = True,
) -> list[PromptRow]:
    """Pick ``count`` prompts deterministically.

    Without ``target_tokens`` the rows are shuffled with ``seed`` and cycled. With a target
    the rows nearest to that length are preferred, and (when ``pad``) rows shorter than 60 %
    of the target are extended with filler so a prefill/long-context workload really does
    send the requested number of tokens.
    """
    if not rows:
        return [synthetic_prompt(target_tokens or 512, index=i, seed=seed) for i in range(count)]
    rng = random.Random(seed)
    if target_tokens:
        pool = sorted(rows, key=lambda r: abs((r.approx_tokens or 0) - target_tokens))
        pool = pool[: max(count, min(len(pool), max(8, count)))]
    else:
        pool = list(rows)
    rng.shuffle(pool)
    picked = [pool[i % len(pool)] for i in range(count)]
    if target_tokens and pad:
        floor = target_tokens * 0.6
        picked = [
            _pad_to(row, target_tokens, seed) if (row.approx_tokens or 0) < floor else row
            for row in picked
        ]
    return picked


def build_haystack(
    *,
    input_tokens: int,
    depth_pct: float,
    needle: str = "The Atlas access code is 7431-KILO.",
    question: str = "What is the Atlas access code? Answer with the code only.",
    seed: int = 42,
) -> tuple[list[dict[str, Any]], str]:
    """Build a needle-in-a-haystack prompt and return ``(messages, expected_answer)``.

    Used when the long-context dataset does not ship a prebuilt haystack. The filler is
    deterministic for a given ``seed``/``input_tokens`` so repeats are comparable.
    """
    body = synthetic_prompt(input_tokens, index=int(depth_pct * 100), seed=seed)
    words = body.messages[0]["content"].split()
    cut = max(0, min(len(words), int(len(words) * (depth_pct / 100.0))))
    haystack = " ".join([*words[:cut], needle, *words[cut:]])
    content = (
        "Read the document and answer the question at the end.\n\n"
        f"<document>\n{haystack}\n</document>\n\n{question}"
    )
    return [{"role": "user", "content": content}], "7431-KILO"


@dataclass
class HaystackRow:
    """One materialized long-context point: the prompt, its length and its needle."""

    id: str
    input_tokens: int
    depth_pct: float
    prompt: PromptRow
    answer: str


def _load_builder(directory: Path) -> Any | None:
    """Import a dataset's ``build.py`` (the normative materialisation algorithm).

    ``haystack-v1`` stores *recipes*, not text — a 256k-token document has no business
    being in git — and ships the reference implementation next to them. Reconstructing the
    document here rather than re-inventing it is what makes two contributors' long-context
    runs comparable.
    """
    build = directory / "build.py"
    if not build.is_file():
        return None
    import importlib.util

    spec = importlib.util.spec_from_file_location(f"atlas_haystack_{directory.name}", build)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module if hasattr(module, "build_prompt") else None


def _depth_pct(value: Any, default: float = 50.0) -> float:
    """Accept a depth as a fraction (``0.9``) or a percentage (``90``)."""
    try:
        depth = float(value)
    except (TypeError, ValueError):
        return default
    return depth * 100.0 if depth <= 1.0 else depth


def load_haystack_rows(registry: Registry, dataset_id: str) -> list[HaystackRow]:
    """Materialize every long-context point of a haystack dataset.

    Handles three row shapes, in order of preference: a recipe (``needles`` + ``question``)
    materialized through the dataset's ``build.py``; a pre-rendered ``static_file``; and a
    plain row that already carries ``messages``/``prompt``.
    """
    directory = registry.dataset_dir(dataset_id)
    builder = _load_builder(directory)
    rows: list[HaystackRow] = []
    for index, raw in enumerate(load_rows(registry, dataset_id)):
        row_id = str(raw.get("id") or f"hay-{index:04d}")
        length = int(
            raw.get("target_tokens") or raw.get("input_tokens") or raw.get("approx_tokens") or 0
        )
        needles = raw.get("needles") or []
        depth = _depth_pct(needles[0].get("depth") if needles else raw.get("depth"))
        answer = str(raw.get("answer") or (needles[0].get("answer") if needles else "") or "")
        content: str | None = None
        if builder is not None and raw.get("question"):
            content = builder.build_prompt(raw)
        elif raw.get("static_file") and (directory / str(raw["static_file"])).is_file():
            haystack = (directory / str(raw["static_file"])).read_text(encoding="utf-8")
            content = f"{haystack}\n\n{raw.get('question', '')}".strip()
        if content is not None and raw.get("sha256") and builder is not None:
            import hashlib

            document = builder.build_haystack(raw)
            if hashlib.sha256(document.encode("utf-8")).hexdigest() != raw["sha256"]:
                content = None  # fall through to the row's own messages, flagged by the caller
        if content is not None:
            prompt = PromptRow(
                id=row_id,
                messages=[{"role": "user", "content": content}],
                approx_tokens=length or int(len(content) / 4),
            )
        else:
            prompt = PromptRow.from_dict(raw, index)
            if not length:
                length = prompt.approx_tokens
        rows.append(
            HaystackRow(
                id=row_id,
                input_tokens=length or prompt.approx_tokens,
                depth_pct=depth,
                prompt=prompt,
                answer=answer,
            )
        )
    return sorted(rows, key=lambda r: (r.input_tokens, r.depth_pct))


def _haystack_builder(
    registry: Registry, row_meta: dict[str, Any], dataset_dir: Path
) -> Any | None:
    """The ``build.py`` that materializes a recipe: the row's own dir, else its source dataset."""
    builder = _load_builder(dataset_dir)
    if builder is not None:
        return builder
    source = str(row_meta.get("haystack_dataset") or "haystack-v1")
    return _load_builder(registry.dataset_dir(source))


def render_haystack_prompt(
    row: EvalRow, registry: Registry
) -> tuple[list[dict[str, Any]], list[str]]:
    """Materialize a long-context row into the messages that must actually be sent.

    ``eval-longctx-v1`` rows carry the *question only*; the document lives in
    ``meta.haystack`` as a recipe. Sending the prompt without the document is not a smaller
    measurement, it is a wrong one — it reads as a catastrophic accuracy drop. The rebuilt
    document is checked against the row's recorded ``sha256``.
    """
    recipe = row.meta.get("haystack")
    if not isinstance(recipe, dict):
        return list(row.messages), []
    builder = _haystack_builder(registry, row.meta, row.dataset_dir or Path())
    if builder is None:
        return list(row.messages), [f"haystack-builder-missing:{row.id}"]

    warnings: list[str] = []
    document = builder.build_haystack(recipe)
    expected = row.meta.get("sha256")
    if expected:
        import hashlib

        digest = hashlib.sha256(document.encode("utf-8")).hexdigest()
        if digest != expected:
            warnings.append(f"haystack-sha256-mismatch:{row.id}")
    question = str(row.messages[-1].get("content") or "") if row.messages else ""
    preamble = getattr(builder, "PREAMBLE", "")
    joined = f"{document}\n\n{question}"
    content = f"{preamble}\n\n{joined}" if preamble else joined
    messages = [dict(m) for m in row.messages]
    if messages:
        messages[-1] = {**messages[-1], "content": content}
    else:  # pragma: no cover - eval rows always carry a turn
        messages = [{"role": "user", "content": content}]
    return messages, warnings
