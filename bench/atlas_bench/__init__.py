"""atlas-bench — the Inference Atlas benchmark harness.

The harness measures an OpenAI-compatible inference server and writes one JSON
result file per run into ``results/<engine>/<model>/<hardware>/<run_id>.json``.
Identifier computation (:mod:`atlas_bench.canonical`, :mod:`atlas_bench.ids`) is a
byte-for-byte port of the TypeScript reference implementation in ``packages/core``.
"""

__all__ = ["HARNESS_NAME", "__version__"]

__version__ = "0.1.0"
HARNESS_NAME = "atlas-bench"
