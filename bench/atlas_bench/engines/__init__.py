"""Engine adapters.

``ADAPTERS`` maps a registry ``engine_id`` onto its adapter class. Engines that are not in
the map fall back to :class:`~atlas_bench.engines.base.AttachAdapter`, so measuring a new
engine only needs ``--base-url`` — the adapter is an optimization, not a requirement.
"""

from __future__ import annotations

from .base import AttachAdapter, EngineAdapter, ServeResult, build_flags, get_adapter
from .exllamav3 import ExllamaV3Adapter
from .llamacpp import LlamaCppAdapter
from .lmstudio import LmStudioAdapter
from .mlx_lm import MlxLmAdapter
from .ollama import OllamaAdapter
from .sglang import SglangAdapter
from .tensorrt_llm import TensorrtLlmAdapter
from .tgi import TgiAdapter
from .vllm import VllmAdapter

__all__ = [
    "ADAPTERS",
    "AttachAdapter",
    "EngineAdapter",
    "ServeResult",
    "build_flags",
    "get_adapter",
]

ADAPTERS: dict[str, type[EngineAdapter]] = {
    "vllm": VllmAdapter,
    "sglang": SglangAdapter,
    "llamacpp": LlamaCppAdapter,
    "llama-cpp": LlamaCppAdapter,
    "ollama": OllamaAdapter,
    "mlx-lm": MlxLmAdapter,
    "tensorrt-llm": TensorrtLlmAdapter,
    "tgi": TgiAdapter,
    "lmstudio": LmStudioAdapter,
    "exllamav3": ExllamaV3Adapter,
}
