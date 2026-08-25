#!/usr/bin/env python3
"""Fetch and verify the AA-LCR document corpus.

The questions are vendored; the documents are not. They are third-party material —
company filings, EU consultations, court judgments — that Artificial Analysis extracted
and republished, and this repository does not redistribute other people's corpora
(see DATA_LICENSE). So the corpus is fetched on demand and checksum-verified against the
digest recorded in ``dataset.json`` at the time the questions were converted.

    python3 datasets/aa-lcr-v1/prepare.py

Idempotent: an already-extracted corpus is left alone unless ``--force`` is passed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _entry_name(entry: zipfile.ZipInfo) -> str:
    """The entry's real filename, undoing zipfile's CP437 fallback.

    A zip stores filenames as bytes and only promises UTF-8 when general-purpose bit 11 is
    set. This archive stores UTF-8 without setting it, so zipfile decodes as CP437 and a
    curly apostrophe arrives as "\u0393\u00c7\u00d6". Four documents then did not exist under the
    names the questions reference, and four items went unscorable for a reason that had
    nothing to do with the data.
    """
    if entry.flag_bits & 0x800:
        return entry.filename
    try:
        return entry.filename.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return entry.filename


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-download and re-extract")
    args = parser.parse_args(argv)

    meta = json.loads((HERE / "dataset.json").read_text(encoding="utf-8"))
    corpus = meta["corpus"]
    target = HERE / corpus["extract_to"]

    if target.exists() and not args.force:
        files = sum(1 for _ in target.rglob("*") if _.is_file())
        print(f"already prepared: {target} ({files} files) — pass --force to redo")
        return 0
    if target.exists():
        shutil.rmtree(target)

    archive = HERE / "_corpus.zip"
    print(f"fetching {corpus['url']}")
    urllib.request.urlretrieve(corpus["url"], archive)  # noqa: S310 - pinned https URL

    actual = _sha256(archive)
    if actual != corpus["sha256"]:
        archive.unlink(missing_ok=True)
        # Refusing is the point. A corpus that changed under us silently changes every
        # score measured against it, and a benchmark that cannot say which bytes it read
        # is not a measurement.
        print(
            f"checksum mismatch\n  expected {corpus['sha256']}\n  actual   {actual}\n"
            "The upstream archive changed. Re-convert the questions against the new "
            "release and update dataset.json rather than scoring against a corpus this "
            "dataset was not built from.",
            file=sys.stderr,
        )
        return 1

    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            name = _entry_name(entry)
            # Zip entries are attacker-controlled paths in the general case; keep the
            # extraction inside the dataset directory whatever the archive claims.
            destination = (target / name).resolve()
            if not str(destination).startswith(str(target.resolve())):
                print(f"refusing entry outside the target: {name}", file=sys.stderr)
                return 1
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as source, destination.open("wb") as out:
                shutil.copyfileobj(source, out)
    archive.unlink(missing_ok=True)

    files = sum(1 for _ in target.rglob("*") if _.is_file())
    print(f"prepared {target} ({files} files, sha256 verified)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
