"""Import shim so the AA-LCR prepare script is testable.

`datasets/aa-lcr-v1/prepare.py` is a standalone script, not part of the package, and its
filename is not importable as a module. Loading it by path keeps the zip-name decoding
covered by the suite instead of only by the one run that noticed it was wrong.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_PATH = Path(__file__).resolve().parents[2] / "datasets" / "aa-lcr-v1" / "prepare.py"
_spec = importlib.util.spec_from_file_location("aa_lcr_prepare", _PATH)
assert _spec and _spec.loader
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)

_entry_name = _module._entry_name
