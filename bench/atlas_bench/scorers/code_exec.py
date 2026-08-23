"""Code execution scorer: run the model's code against the row's tests in a subprocess.

Isolation is best effort but deliberate: a fresh temp directory, ``python -I`` (no user
site, no ``PYTHONPATH``), an emptied environment (which also removes proxy variables, so
the snippet has no configured network path), a hard wall-clock timeout and an address-space
limit on Unix. This is not a sandbox — never point it at untrusted models on a machine you
care about.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import ScoreResult, strip_think

__all__ = ["extract_code", "run_candidate", "score_code_exec"]

#: Wall-clock limit for one candidate program.
TIMEOUT_S = 10.0
#: Address-space limit (bytes) applied on Unix.
MEMORY_LIMIT_BYTES = 2 * 1024**3

_PY_FENCE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL)


def extract_code(output: str) -> str:
    """Take the fenced Python block if there is one, else the whole response."""
    body = strip_think(output or "")
    blocks = _PY_FENCE.findall(body)
    if blocks:
        return max(blocks, key=len).strip()
    return body.strip()


def _limits() -> None:  # pragma: no cover - runs in the child process
    """Apply resource limits in the child before exec (Unix only)."""
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    except Exception:
        pass


def run_candidate(code: str, tests: str, *, timeout_s: float = TIMEOUT_S) -> tuple[bool, str]:
    """Run ``code`` followed by ``tests`` and return ``(passed, output_tail)``."""
    with tempfile.TemporaryDirectory(prefix="atlas-code-") as tmp:
        directory = Path(tmp)
        program = directory / "candidate.py"
        program.write_text(f"{code}\n\n{tests}\n", encoding="utf-8")
        env = {"PATH": "/usr/bin:/bin", "HOME": str(directory), "TMPDIR": str(directory)}
        try:
            proc = subprocess.run(
                [sys.executable, "-I", str(program)],
                capture_output=True,
                text=True,
                timeout=timeout_s,
                cwd=directory,
                env=env,
                check=False,
                preexec_fn=_limits if os.name == "posix" else None,
            )
        except subprocess.TimeoutExpired:
            return False, "timeout"
        except OSError as exc:
            return False, f"spawn failed: {exc}"
        tail = (proc.stderr or proc.stdout or "").strip()[-500:]
        return proc.returncode == 0, tail


def score_code_exec(output: str, row: Any) -> ScoreResult:
    """Pass when the candidate program plus the row's asserts exit with status 0."""
    tests = getattr(row, "tests", None)
    if not tests:
        return ScoreResult(
            False, predicted="", expected="<tests>", scored=False, detail="row has no tests"
        )
    code = extract_code(output)
    if not code:
        return ScoreResult(False, predicted="", expected="<code>", detail="no code in response")
    meta = getattr(row, "meta", None) or {}
    timeout_s = float(meta.get("timeout_s") or TIMEOUT_S)
    passed, tail = run_candidate(code, str(tests), timeout_s=timeout_s)
    return ScoreResult(passed, predicted=code[:500], expected="<tests pass>", detail=tail or None)
