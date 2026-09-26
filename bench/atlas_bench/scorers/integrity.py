"""Token-integrity scorer: did a long generation come back with every token intact?

Every other scorer in this package asks whether an answer is *right*. This one asks
whether the decode path held together, which is a different failure and invisible to a
short answer. A serving build that corrupts roughly one token in several thousand can
score 100 % on maths, knowledge and instruction following and still be unusable for code,
because the defect only has room to appear in a long output.

What it looks like: one identifier or number in an otherwise coherent file welded
together from two fragments — ``carrierhed`` where the project defines ``carrier``,
``seedapse`` for ``seed``, ``128Pin`` for ``128``, or a bare word standing where a numeric
literal belongs (``[6, visible, 0]`` for ``[6, 1, 0]``). Nothing else about the file looks
wrong, which is exactly why it needs a mechanical check.

The scorer is pure Python — no node, no subprocess — and never raises: anything it cannot
parse is scored, not crashed on.

Five splice shapes count, and only these five:

``numeric``
    a digit-initial token that is not a valid JavaScript numeric literal, e.g. ``128Pin``.
    ``0x1F``, ``0b101``, ``0o7``, ``1e-5``, ``2.5e3`` and ``10n`` are literals and pass.

``identifier``
    a used identifier that is not defined anywhere, where some proper prefix *is* defined
    and the remainder is two to six lower-case letters. ``carrier`` + ``hed``,
    ``dirAngle`` + ``orton``, and ``z`` + ``hed`` when ``z`` is a declared name: the stem
    may be a single letter, because ``position.set(x, y, zhed)`` is the commonest shape
    the failure takes in real output.

``member``
    the same weld on a property name: ``ship.bobAmporton`` where the file itself uses
    ``bobAmp`` as a property or object key and never ``bobAmporton``. Property access is
    otherwise not a use of a name (``holder.carrierhed`` with no ``carrier`` property in
    sight is data, not a splice), which is why this is its own shape with its own
    definition set.

``word-for-number``
    an undefined bare identifier — or a dotted fragment like ``.src`` — sitting directly
    between two numeric literals in a comma-separated list: ``[6, visible, 0]``,
    ``f(1, visible, 2)``, ``[2, 0, .src, 4]``.

``non-ascii``
    any non-ASCII character in code (strings, comments and regex literals are masked
    first). ``[2, 0, 惯, 4]`` is a CJK token where a number belongs. JavaScript does allow
    Unicode identifiers, so a project that names things in a non-Latin script should not
    use this scorer; the workloads that do are English-prompted synthetic projects.

A spliced identifier or property that recurs is counted once per generation: once the
first ``zhed`` is in the context the model copies it, and five copies are one event.
An undefined identifier that is not one of those shapes is **not** counted. Models invent
helper names and forget to declare them all the time; that is an ordinary code error and
charging it here would drown the signal this suite exists for.

The definition set comes from ``row.meta.context_identifiers`` (the names the dataset's
own context defines) plus everything the output itself declares plus the JavaScript
globals. A row without that key still works: the scorer then treats every identifier in
the prompt as defined, which is looser but never accuses a name the prompt supplied.
"""

from __future__ import annotations

import re
from typing import Any

from . import ScoreResult, strip_fences, strip_think

__all__ = [
    "BUILTINS",
    "Splice",
    "declared_identifiers",
    "find_splices",
    "mask_literals",
    "score_integrity",
]

#: ``scores.items[].predicted`` is capped at 500 characters by the result schema, and the
#: splice list is the evidence that ends up in the published result file.
PREDICTED_LIMIT = 500

_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")

#: Reserved words plus the globals a browser or Node module may use without declaring them.
BUILTINS = frozenset(
    """
    await break case catch class const continue debugger default delete do else enum
    export extends false finally for function if implements import in instanceof
    interface let new null of package private protected public return static super
    switch this throw true try typeof var void while with yield async get set from as
    arguments constructor prototype
    Array ArrayBuffer Atomics BigInt BigInt64Array BigUint64Array Boolean DataView Date
    Error EvalError Float32Array Float64Array Function Infinity Int8Array Int16Array
    Int32Array Intl JSON Map Math NaN Number Object Promise Proxy RangeError
    ReferenceError Reflect RegExp Set SharedArrayBuffer String Symbol SyntaxError
    TypeError URIError Uint8Array Uint8ClampedArray Uint16Array Uint32Array WeakMap
    WeakRef WeakSet AggregateError FinalizationRegistry
    globalThis undefined console window document navigator location history screen
    performance crypto fetch Headers Request Response URL URLSearchParams AbortController
    AbortSignal Blob File FileReader FormData Image Audio Worker MessageChannel
    MessagePort Event EventTarget CustomEvent DOMParser XMLHttpRequest WebSocket
    TextEncoder TextDecoder structuredClone queueMicrotask requestAnimationFrame
    cancelAnimationFrame requestIdleCallback cancelIdleCallback setTimeout clearTimeout
    setInterval clearInterval parseInt parseFloat isNaN isFinite encodeURI decodeURI
    encodeURIComponent decodeURIComponent escape unescape eval
    module exports require process Buffer __dirname __filename
    """.split()
)

#: Words that may precede ``/`` and still leave it starting a regular expression rather
#: than dividing. Anything else (an identifier, a number, ``)``, ``]``) means division.
_REGEX_PRECEDING_WORDS = frozenset(
    "return typeof instanceof in of new delete void case do else yield await throw".split()
)

#: A complete JavaScript numeric literal, including separators and the BigInt suffix.
_VALID_NUMBER_RE = re.compile(
    r"""(?x)
    ^(?:
        0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?
      | 0[bB][01](?:_?[01])*n?
      | 0[oO][0-7](?:_?[0-7])*n?
      | 0[0-7]+
      | (?:0|[1-9](?:_?[0-9])*)n
      | (?:
             (?:0|[0-9](?:_?[0-9])*)(?:\.(?:[0-9](?:_?[0-9])*)?)?
           | \.[0-9](?:_?[0-9])*
        )(?:[eE][+-]?[0-9](?:_?[0-9])*)?
    )$
    """
)

#: The remainder of an identifier splice: a short run of lower-case letters, which is what
#: a wrongly decoded sub-word token looks like. ``carrierList`` is a name a person wrote,
#: ``carrierhed`` is not.
_SPLICE_TAIL_RE = re.compile(r"^[a-z]{2,6}$")

#: A run of non-ASCII characters in (masked) code. The tokenizer only knows ASCII
#: identifiers, so these would otherwise dissolve into single-character punctuation.
_NON_ASCII_RE = re.compile(r"[^\x00-\x7f]+")


class Splice:
    """One detected splice, and where in the generation it sits."""

    __slots__ = ("base", "kind", "line", "text")

    def __init__(self, kind: str, line: int, text: str, base: str) -> None:
        self.kind = kind
        self.line = line
        self.text = text
        self.base = base

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Splice({self.kind!r}, {self.line}, {self.text!r}, {self.base!r})"

    def render(self) -> str:
        """The entry that lands in ``scores.items[].predicted`` of the result file."""
        return f"{self.line}: {self.text} -> {self.base}"


# --------------------------------------------------------------------------------- masking


def mask_literals(code: str) -> str:
    """Blank out strings, comments and regex literals, keeping length and line breaks.

    Everything inside them is data, not code: ``'128px'`` is a CSS length, not a spliced
    number, and a stray word in a comment is prose. Template literals keep their ``${…}``
    substitutions as live code, because a splice inside an interpolation is a real one.

    Pure function, no shared state: the eval runner scores items on worker threads.
    """
    text = code or ""
    out = list(text)
    length = len(text)

    def blank(start: int, stop: int) -> None:
        for position in range(max(0, start), min(stop, length)):
            if out[position] != "\n":
                out[position] = " "

    #: Frames model where we are. ``["code", depth]`` counts braces so the ``}`` that ends
    #: a ``${…}`` substitution can be told from an ordinary block close; ``["template"]``
    #: means we are inside the literal part of a template string.
    frames: list[list] = [["code", 0]]
    index = 0
    last_significant = ""

    while index < length:
        char = text[index]
        frame = frames[-1]

        if frame[0] == "template":
            if char == "\\":
                blank(index, index + 2)
                index += 2
                continue
            if char == "`":
                blank(index, index + 1)
                frames.pop()
                index += 1
                last_significant = "'"
                continue
            if char == "$" and index + 1 < length and text[index + 1] == "{":
                blank(index, index + 2)
                frames.append(["code", 0])
                index += 2
                last_significant = "{"
                continue
            blank(index, index + 1)
            index += 1
            continue

        if char in "'\"":
            quote = char
            cursor = index + 1
            while cursor < length and text[cursor] != quote:
                if text[cursor] == "\\":
                    cursor += 1
                elif text[cursor] == "\n":
                    break
                cursor += 1
            blank(index, cursor + 1)
            index = cursor + 1
            last_significant = "'"
            continue

        if char == "`":
            blank(index, index + 1)
            frames.append(["template"])
            index += 1
            continue

        if char == "/" and index + 1 < length and text[index + 1] == "/":
            cursor = text.find("\n", index)
            cursor = length if cursor < 0 else cursor
            blank(index, cursor)
            index = cursor
            continue

        if char == "/" and index + 1 < length and text[index + 1] == "*":
            cursor = text.find("*/", index + 2)
            cursor = length if cursor < 0 else cursor + 2
            blank(index, cursor)
            index = cursor
            continue

        if char == "/" and _regex_can_start_here(text, index, last_significant):
            cursor = _end_of_regex(text, index)
            if cursor > 0:
                blank(index, cursor)
                index = cursor
                last_significant = "'"
                continue

        if char == "{":
            frame[1] += 1
        elif char == "}":
            if frame[1] == 0 and len(frames) > 1:
                # Closes a `${…}` substitution: back into the template's literal part.
                blank(index, index + 1)
                frames.pop()
                index += 1
                continue
            frame[1] = max(0, frame[1] - 1)

        if not char.isspace():
            last_significant = char
        index += 1

    return "".join(out)


def _end_of_regex(text: str, index: int) -> int:
    """Index just past a regex literal starting at *index*, or ``-1`` if it is division."""
    length = len(text)
    cursor = index + 1
    in_class = False
    while cursor < length:
        char = text[cursor]
        if char == "\\":
            cursor += 2
            continue
        if char == "\n":
            return -1
        if char == "[":
            in_class = True
        elif char == "]":
            in_class = False
        elif char == "/" and not in_class:
            cursor += 1
            while cursor < length and text[cursor].isalpha():
                cursor += 1
            return cursor
        cursor += 1
    return -1


def _regex_can_start_here(text: str, index: int, last_significant: str) -> bool:
    """Whether the ``/`` at *index* opens a regex rather than dividing."""
    if not last_significant:
        return True
    if last_significant in ")]}'\"`":
        return False
    if last_significant.isalnum() or last_significant in "_$":
        words = _IDENT_RE.findall(text[max(0, index - 24) : index])
        return bool(words) and words[-1] in _REGEX_PRECEDING_WORDS
    return True


# ---------------------------------------------------------------------------- definitions

_IMPORT_RE = re.compile(r"\bimport\b([^;\n]*?)\bfrom\b")
_FUNCTION_NAME_RE = re.compile(r"\b(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)")
_MEMBER_RE = re.compile(r"\.\s*([A-Za-z_$][\w$]*)")
_OBJECT_KEY_RE = re.compile(r"([A-Za-z_$][\w$]*)\s*:")
_DECLARATOR_RE = re.compile(r"\b(?:const|let|var)\b")
_CATCH_RE = re.compile(r"\bcatch\s*\(([^)]*)\)")

#: Keywords whose parenthesised group is a condition, not a parameter list.
_CONTROL_WORDS = frozenset({"if", "for", "while", "switch", "with"})


def _binding_targets(code: str, start: int) -> str:
    """The binding side of a ``const``/``let``/``var`` statement, as raw text.

    Skips each initialiser (everything after a top-level ``=`` up to the next ``,``), so
    ``const {a, b: c} = source, d = other`` yields the names and not the right-hand sides.
    """
    depth = 0
    collected: list[str] = []
    index = start
    length = len(code)
    skipping = False
    while index < length:
        char = code[index]
        if char in "([{":
            depth += 1
        elif char in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0:
            if char == ";":
                break
            if char == "=" and code[index : index + 2] != "=>":
                skipping = True
            elif char == ",":
                skipping = False
            elif char == "\n" and not skipping:
                break
        if not skipping:
            collected.append(char)
        index += 1
    return "".join(collected)


def _binding_names(text: str) -> set[str]:
    """Identifiers bound by a parameter list or destructuring pattern.

    Default values are dropped: in ``(step, budget = latticeSize)`` the parameters are
    ``step`` and ``budget``, and ``latticeSize`` is a *use* of a name from somewhere else.
    Folding it into the definition set would let a splice hide in a default.
    """
    kept: list[str] = []
    depth = 0
    skipping_at: int | None = None
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
            if skipping_at is not None and depth < skipping_at:
                skipping_at = None
        elif char == "," and skipping_at is not None and depth == skipping_at:
            skipping_at = None
        elif (
            char == "="
            and skipping_at is None
            and text[index + 1 : index + 2] not in ("=", ">")
            and text[index - 1 : index] not in ("=", "!", "<", ">")
        ):
            skipping_at = depth
        if skipping_at is None:
            kept.append(char)
        index += 1
    return set(_IDENT_RE.findall("".join(kept)))


def _parameter_groups(code: str) -> list[tuple[str | None, str]]:
    """``(name, parameters)`` for every parenthesised group that is a parameter list.

    A group counts when it is followed by ``=>`` or by ``{`` — which covers function
    declarations, class and object methods, and arrow functions at any nesting depth — and
    is not the condition of an ``if``/``for``/``while``/``switch``/``with``. ``catch`` is
    deliberately not on that list: its parameter really is a binding. ``name`` is the
    identifier immediately in front of the group, which is how a class or object method
    gets its own name into the definition set.
    """
    groups: list[tuple[str | None, str]] = []
    stack: list[int] = []
    for index, char in enumerate(code):
        if char == "(":
            stack.append(index)
        elif char == ")" and stack:
            start = stack.pop()
            tail = code[index + 1 : index + 10].lstrip()
            if not (tail.startswith("=>") or tail.startswith("{")):
                continue
            before = code[:start].rstrip()
            words = _IDENT_RE.findall(before[-32:])
            if words and words[-1] in _CONTROL_WORDS:
                continue
            name = words[-1] if words and before.endswith(words[-1]) else None
            groups.append((name, code[start + 1 : index]))
    return groups


def declared_identifiers(code: str) -> set[str]:
    """Every name the code itself introduces, plus every property it names.

    Deliberately generous. A name this misses becomes "undefined", and an undefined name
    is only ever reported when it *also* looks like a splice — so the cost of being
    generous is a missed splice, and the cost of being strict is a false accusation in a
    published result file. False accusations are the worse failure.
    """
    names: set[str] = set()
    for clause in _IMPORT_RE.findall(code):
        names.update(_IDENT_RE.findall(clause))
    names.update(_FUNCTION_NAME_RE.findall(code))
    names.update(_MEMBER_RE.findall(code))
    names.update(_OBJECT_KEY_RE.findall(code))
    for match in _DECLARATOR_RE.finditer(code):
        names.update(_binding_names(_binding_targets(code, match.end())))
    for name, group in _parameter_groups(code):
        if name:
            names.add(name)
        names.update(_binding_names(group))
    for match in _CATCH_RE.finditer(code):
        names.update(_binding_names(match.group(1)))
    return names


# --------------------------------------------------------------------------------- tokens


def _is_valid_number(token: str) -> bool:
    """Whether *token* is a numeric literal, or a literal with a property access on it."""
    if _VALID_NUMBER_RE.match(token):
        return True
    parts = token.split(".")
    for cut in range(len(parts) - 1, 0, -1):
        head = ".".join(parts[:cut])
        tail = parts[cut:]
        if _VALID_NUMBER_RE.match(head) and all(
            part and _IDENT_RE.fullmatch(part) for part in tail
        ):
            return True
    return False


def _tokenize(code: str) -> list[tuple[str, str, int]]:
    """``(kind, text, line)`` for every identifier, number and punctuation mark.

    ``kind`` is ``ident`` for a bare name, ``member`` for one that follows a ``.`` (a
    property access is not a use of a name), ``num`` for anything digit-initial,
    ``non-ascii`` for a run of characters outside ASCII, and ``punct`` for a single
    character of anything else.
    """
    tokens: list[tuple[str, str, int]] = []
    index = 0
    length = len(code)
    line = 1
    previous_kind = ""
    previous_text = ""
    while index < length:
        char = code[index]
        if char == "\n":
            line += 1
            index += 1
            continue
        if char.isspace():
            index += 1
            continue

        match = _IDENT_RE.match(code, index)
        if match:
            kind = "member" if previous_kind == "punct" and previous_text == "." else "ident"
            tokens.append((kind, match.group(0), line))
            previous_kind, previous_text = kind, match.group(0)
            index = match.end()
            continue

        if char.isdigit():
            cursor = index
            hexish = code[index : index + 2].lower() in ("0x", "0b", "0o")
            while cursor < length:
                current = code[cursor]
                exponent_sign = (
                    current in "+-"
                    and cursor > index
                    and code[cursor - 1] in "eE"
                    and not hexish
                )
                if not (current.isalnum() or current in "_$." or exponent_sign):
                    break
                cursor += 1
            tokens.append(("num", code[index:cursor], line))
            previous_kind, previous_text = "num", code[index:cursor]
            index = cursor
            continue

        run = _NON_ASCII_RE.match(code, index)
        if run:
            tokens.append(("non-ascii", run.group(0), line))
            previous_kind, previous_text = "non-ascii", run.group(0)
            index = run.end()
            continue

        tokens.append(("punct", char, line))
        previous_kind, previous_text = "punct", char
        index += 1
    return tokens


# ---------------------------------------------------------------------------------- rules


def _member_names(tokens: list[tuple[str, str, int]]) -> tuple[set[str], set[str]]:
    """``(used, defined)`` property names: every ``.name`` access or ``name:`` key the file
    has, and the subset the file itself defines (an object key, or a ``.name = …``
    assignment). A name that is only ever read is used, not defined."""
    used: set[str] = set()
    defined: set[str] = set()
    for position, (kind, text, _line) in enumerate(tokens):
        following = tokens[position + 1][1] if position + 1 < len(tokens) else ""
        after = tokens[position + 2][1] if position + 2 < len(tokens) else ""
        if kind == "member":
            used.add(text)
            if following == "=" and after != "=":
                defined.add(text)
        elif kind == "ident" and following == ":":
            used.add(text)
            defined.add(text)
    return used, defined


def _welded_prefix(text: str, known: set[str], min_stem: int = 1) -> str | None:
    """The known name *text* was welded onto, if it is a known name plus a splice tail."""
    for cut in range(len(text) - 2, min_stem - 1, -1):
        prefix = text[:cut]
        if prefix in known and _SPLICE_TAIL_RE.match(text[cut:]):
            return prefix
    return None


def find_splices(code: str, defined: set[str]) -> list[Splice]:
    """Every splice in *code*, given the set of names that are legitimately defined.

    Masks *code* first. :func:`mask_literals` is idempotent, so passing already-masked
    code (which is what :func:`score_integrity` does) costs a pass and changes nothing.
    """
    tokens = _tokenize(mask_literals(code))
    members, member_defs = _member_names(tokens)
    splices: list[Splice] = []
    seen: set[tuple[str, int | None]] = set()

    def record(kind: str, line: int, text: str, base: str) -> None:
        # A welded name recurs once the model has copied it; count the name, not the copies.
        key = (text, None if kind in ("identifier", "member") else line)
        if key in seen:
            return
        seen.add(key)
        splices.append(Splice(kind, line, text, base))

    def number_slot(position: int) -> bool:
        """Is token *position* the sole occupant of a ``, <num> , X , <num> ,`` slot?"""
        before, after = position - 1, position + 1
        if before >= 1 and tokens[before][1] == "." and tokens[before - 1][1] == ",":
            before -= 1  # `, .src ,`
        if before < 1 or after + 1 >= len(tokens):
            return False
        if tokens[before][1] != "," or tokens[after][1] != ",":
            return False
        return tokens[before - 1][0] == "num" and tokens[after + 1][0] == "num"

    for position, (kind, text, line) in enumerate(tokens):
        # (a) a digit-initial token that is not a valid numeric literal.
        if kind == "num":
            if _is_valid_number(text) or not re.search(r"\d[A-Za-z_$]", text):
                # A token that is merely malformed (`1.2.3`) is not the failure shape.
                continue
            digits = re.match(r"\d+", text)
            record("numeric", line, text, digits.group(0) if digits else text)
            continue

        # (e) anything outside ASCII is not a token this code could have meant.
        if kind == "non-ascii":
            record("non-ascii", line, text, "<ascii>")
            continue

        # (d) a property name welded from a property name the file actually uses.
        if kind == "member":
            if number_slot(position):
                record("word-for-number", line, text, "<number>")
                continue
            if text in member_defs or text in BUILTINS:
                continue
            # Property names are short words (`has`, `set`, `add`); a one- or two-letter
            # stem would accuse every one of them, so a member weld needs a real stem.
            prefix = _welded_prefix(text, members - {text}, min_stem=3)
            if prefix is not None:
                record("member", line, text, prefix)
            continue

        if kind != "ident" or text in defined or text in BUILTINS:
            continue

        # (c) a bare word standing where a numeric literal belongs. Checked before the
        # weld rule: `[20, 9, forms, 8]` is a word for a number, whatever `for` + `ms` says.
        if number_slot(position):
            record("word-for-number", line, text, "<number>")
            continue

        # (b) a defined name with a short run of lower-case letters welded onto it.
        prefix = _welded_prefix(text, defined)
        if prefix is not None:
            record("identifier", line, text, prefix)

    splices.sort(key=lambda splice: (splice.line, splice.text))
    return splices


# --------------------------------------------------------------------------------- scoring


def _row_meta(row: Any) -> dict[str, Any]:
    meta = getattr(row, "meta", None)
    return meta if isinstance(meta, dict) else {}


def _row_prompt(row: Any) -> str:
    """A row's prompt text, whether it carries ``prompt`` or ``messages``."""
    prompt = getattr(row, "prompt", None)
    if isinstance(prompt, str) and prompt:
        return prompt
    parts: list[str] = []
    for message in getattr(row, "messages", None) or ():
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
    return "\n".join(parts)


def _render(splices: list[Splice]) -> str:
    """The splice list, trimmed to what the result schema stores."""
    entries = [splice.render() for splice in splices]
    joined = "; ".join(entries)
    if len(joined) <= PREDICTED_LIMIT:
        return joined
    kept: list[str] = []
    for index, entry in enumerate(entries):
        more = f"; …(+{len(entries) - index} more)"
        if len("; ".join([*kept, entry])) + len(more) > PREDICTED_LIMIT:
            break
        kept.append(entry)
    if not kept:
        return f"…({len(entries)} splices)"[:PREDICTED_LIMIT]
    return f"{'; '.join(kept)}; …(+{len(entries) - len(kept)} more)"[:PREDICTED_LIMIT]


def score_integrity(output: str, row: Any) -> ScoreResult:
    """Correct when the generation carries no spliced token.

    Not a correctness check: a wrong-but-intact program scores correct here. The only
    question is whether the tokens the engine emitted are the tokens it meant to emit.
    """
    code = strip_fences(strip_think(output or "")).strip()
    if not code:
        return ScoreResult(
            False, predicted="empty output", expected="clean", detail="no code in response"
        )

    # Declarations are read from the masked source too: a name mentioned only in a
    # comment or a string has not been declared, and treating it as a definition would
    # let a comment silently excuse a splice further down the file.
    masked = mask_literals(code)
    context = _row_meta(row).get("context_identifiers")
    defined = declared_identifiers(masked) | set(BUILTINS)
    if isinstance(context, (list, tuple, set)):
        defined.update(str(name) for name in context)
    else:
        # No definition set on the row: treat everything the prompt names as defined, so a
        # dataset that reuses this scorer with a plain prompt gets a usable answer rather
        # than a page of false accusations.
        defined.update(_IDENT_RE.findall(_row_prompt(row)))

    try:
        splices = find_splices(masked, defined)
    except Exception as exc:  # pragma: no cover - the contract is "never raises"
        return ScoreResult(
            False,
            predicted="scorer error",
            expected="clean",
            scored=False,
            detail=f"integrity scorer failed: {exc}"[:200],
        )

    return ScoreResult(
        not splices,
        predicted=_render(splices) if splices else "clean",
        expected="clean",
        detail=f"splice_count={len(splices)} code_chars={len(code)}",
    )
