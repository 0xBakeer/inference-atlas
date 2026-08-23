"""Physical sanity bounds for a result (SPEC §5 item 5).

A port of ``packages/core/src/plausibility.ts`` — the checks CI runs. Keeping them
byte-compatible matters more than it looks: a contributor who passes
``atlas-bench validate`` locally and then fails ``pnpm validate`` in CI has been sent on a
round trip for nothing.

The bounds are cheap physics rather than statistics: you cannot decode faster than memory
bandwidth allows, you cannot use more VRAM than the device has, percentiles cannot go
backwards, and requests cannot fail negatively.

Pure functions: every input is passed in, so nothing here touches the filesystem.
"""

from __future__ import annotations

import itertools
import json
import math
from dataclasses import dataclass
from typing import Any

from .canonical import normalize_key

__all__ = [
    "DEFAULTS",
    "Finding",
    "active_weight_gb",
    "bandwidth_ceiling",
    "check_plausibility",
    "tokens_per_forward_pass",
]

#: Overridable through ``site/config.json``'s ``plausibility`` block.
DEFAULTS = {
    "bandwidth_tolerance": 1.5,
    "vram_tolerance": 1.02,
    "warn_bandwidth_fraction": 0.15,
    "min_weight_gb": 0.05,
}

_NON_NEGATIVE = (
    "duration_s",
    "output_tok_s",
    "total_tok_s",
    "req_s",
    "prefill_tok_s",
    "vram_peak_gb",
    "ram_peak_gb",
    "kv_cache_tokens",
    "power_avg_w",
    "power_peak_w",
    "energy_wh",
    "requests_total",
    "requests_ok",
    "requests_failed",
)
_DISTRIBUTIONS = ("ttft_ms", "tpot_ms", "itl_ms", "e2e_ms", "decode_tok_s_per_request")
_ORDERED_QUANTILES = ("min", "p50", "p90", "p95", "p99", "max")
_DRAFT_COUNT_KEYS = (
    "num-speculative-tokens",
    "speculative-num-steps",
    "speculative-num-draft-tokens",
    "draft-max",
    "draft",
)
_DRAFT_OBJECT_KEYS = ("num_speculative_tokens", "num-speculative-tokens", "num_steps", "draft_max")


@dataclass
class Finding:
    """One plausibility finding."""

    level: str  # error | warn
    code: str
    message: str
    path: str | None = None


def _number(value: Any) -> float | None:
    """A finite number, or ``None`` (booleans are not numbers here)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _bits_to_gb(params_b: float, bits: float) -> float:
    """Weight size from parameter count and bit width, when the quant has no ``size_gb``."""
    return params_b * 1e9 * (bits / 8) / 1e9


def active_weight_gb(model: dict[str, Any] | None, quant: dict[str, Any] | None) -> float | None:
    """Weight bytes read per decoded token, in GB.

    Dense models read everything; an MoE model reads roughly the active fraction, which is
    why a 30B-A3B decodes an order of magnitude faster than its total size suggests.
    """
    if not model:
        return None
    total = _number((quant or {}).get("size_gb"))
    if total is None and quant:
        params_b = _number(model.get("params_b"))
        bits = _number(quant.get("bits"))
        total = _bits_to_gb(params_b, bits) if params_b and bits else None
    if total is None or total <= 0:
        return None
    params_b = _number(model.get("params_b"))
    if not params_b:
        return total
    active = _number(model.get("active_params_b"))
    active = params_b if active is None else active
    fraction = min(1.0, max(0.0, active / params_b))
    return total * (fraction or 1.0)


def _draft_tokens_from(key: str, value: Any) -> float | None:
    """Draft length declared by one speculative-decoding argument."""
    if key in _DRAFT_COUNT_KEYS:
        count = _number(value) if not isinstance(value, str) else _number(_to_number(value))
        return count if count and count > 0 else None
    obj: Any = value
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            obj = json.loads(value)
        except json.JSONDecodeError:
            return None
    if isinstance(obj, dict):
        for name in _DRAFT_OBJECT_KEYS:
            count = _number(obj.get(name)) or _number(_to_number(obj.get(name)))
            if count and count > 0:
                return count
    return None


def _to_number(value: Any) -> float | None:
    """Loose numeric coercion for values that arrive as strings."""
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def tokens_per_forward_pass(
    args: dict[str, Any] | None, metrics: dict[str, Any] | None = None
) -> float:
    """How many tokens come out of one pass over the weights.

    Speculative decoding is the one legitimate way to beat the naive bandwidth bound: the
    draft tokens are verified in a single pass, so tok/s scales with the accepted draft
    length. Measured ``accepted_tokens_per_step`` wins; then the configured draft length + 1;
    then a generous 4 when a speculative method is configured without a visible draft length.
    Every fallback only loosens an error bound, which is the safe direction.
    """
    measured = _number((metrics or {}).get("accepted_tokens_per_step"))
    if measured and measured > 0:
        return measured
    configured = False
    drafts: float | None = None
    for raw_key, raw_value in (args or {}).items():
        key = normalize_key(str(raw_key))
        if "speculative" not in key and not key.startswith("draft") and key != "model-draft":
            continue
        configured = True
        count = _draft_tokens_from(key, raw_value)
        if count is not None:
            drafts = max(drafts or 0.0, count)
    if drafts is not None:
        return drafts + 1
    return 4.0 if configured else 1.0


def bandwidth_ceiling(
    hardware: dict[str, Any] | None,
    model: dict[str, Any] | None,
    quant: dict[str, Any] | None,
    tolerance: float = 1.5,
    hw_count: int = 1,
    tokens_per_pass: float = 1.0,
    min_weight_gb: float = 0.05,
) -> float | None:
    """Upper bound on single-stream decode tok/s: bandwidth ÷ active weights × tolerance."""
    bandwidth = _number((hardware or {}).get("memory_bandwidth_gbs"))
    weight = active_weight_gb(model, quant)
    if not bandwidth or not weight or weight < min_weight_gb:
        return None
    return (bandwidth * hw_count) / weight * tolerance * max(1.0, tokens_per_pass)


def _per_request_decode(metrics: dict[str, Any], concurrency: int | None) -> float | None:
    """Per-request decode rate, measured directly or derived from the aggregate."""
    distribution = metrics.get("decode_tok_s_per_request")
    if isinstance(distribution, dict):
        mean = _number(distribution.get("mean"))
        if mean is not None:
            return mean
    aggregate = _number(metrics.get("output_tok_s"))
    if aggregate is None:
        return None
    return aggregate / (concurrency if concurrency and concurrency > 0 else 1)


def _check_metric_block(metrics: dict[str, Any], path: str, ctx: dict[str, Any]) -> list[Finding]:
    """Every check that applies to one metric block (top level or one sweep point)."""
    findings: list[Finding] = []

    for key in _NON_NEGATIVE:
        value = _number(metrics.get(key))
        if value is not None and value < 0:
            findings.append(
                Finding(
                    "error",
                    "negative-metric",
                    f"{key} is {value}; it cannot be negative.",
                    f"{path}.{key}",
                )
            )

    for key in _DISTRIBUTIONS:
        block = metrics.get(key)
        if not isinstance(block, dict):
            continue
        present = [(n, _number(block.get(n))) for n in _ORDERED_QUANTILES]
        present = [(n, v) for n, v in present if v is not None]
        signed = [
            *present,
            ("mean", _number(block.get("mean"))),
            ("stddev", _number(block.get("stddev"))),
        ]
        for name, value in signed:
            if value is not None and value < 0:
                findings.append(
                    Finding(
                        "error",
                        "negative-metric",
                        f"{key}.{name} is {value}; latencies cannot be negative.",
                        f"{path}.{key}.{name}",
                    )
                )
        for (prev_name, prev_value), (name, value) in itertools.pairwise(present):
            if value < prev_value:
                findings.append(
                    Finding(
                        "error",
                        "distribution-out-of-order",
                        f"{key}.{name} ({value}) is below {key}.{prev_name} ({prev_value}).",
                        f"{path}.{key}.{name}",
                    )
                )

    total = _number(metrics.get("requests_total"))
    ok = _number(metrics.get("requests_ok"))
    failed = _number(metrics.get("requests_failed"))
    if None not in (total, ok, failed) and ok + failed != total:
        findings.append(
            Finding(
                "error",
                "request-counts-mismatch",
                f"requests_ok ({ok:g}) + requests_failed ({failed:g}) is {ok + failed:g}, "
                f"not requests_total ({total:g}).",
                f"{path}.requests_total",
            )
        )

    rate = _number(metrics.get("success_rate"))
    if rate is not None:
        if rate < 0 or rate > 1:
            findings.append(
                Finding(
                    "error",
                    "success-rate-out-of-range",
                    f"success_rate is {rate}; it is a fraction in [0, 1].",
                    f"{path}.success_rate",
                )
            )
        elif total and total > 0 and ok is not None and abs(ok / total - rate) > 0.01:
            findings.append(
                Finding(
                    "warn",
                    "success-rate-inconsistent",
                    f"success_rate is {rate} but requests_ok/requests_total is {ok / total:.4f}.",
                    f"{path}.success_rate",
                )
            )

    vram = _number(metrics.get("vram_peak_gb"))
    memory = _number((ctx["hardware"] or {}).get("memory_gb"))
    if vram is not None and memory and memory > 0:
        limit = memory * ctx["hw_count"] * ctx["vram_tolerance"]
        if vram > limit:
            suffix = f" x{ctx['hw_count']}" if ctx["hw_count"] > 1 else ""
            findings.append(
                Finding(
                    "error",
                    "vram-exceeds-device-memory",
                    f"vram_peak_gb is {vram} but {(ctx['hardware'] or {}).get('id')} has "
                    f"{memory:g} GB{suffix}.",
                    f"{path}.vram_peak_gb",
                )
            )

    if ctx["ceiling"] is not None:
        per_request = _per_request_decode(metrics, ctx["concurrency"])
        if per_request is not None and per_request > ctx["ceiling"]:
            findings.append(
                Finding(
                    "error",
                    "bandwidth-ceiling-exceeded",
                    f"per-request decode is {per_request:.1f} tok/s but memory bandwidth "
                    f"allows at most {ctx['ceiling']:.1f} tok/s for these weights. Either "
                    "the weights, the hardware or the number is wrong (speculative decoding "
                    "does not lift this bound — it lowers the bytes read per accepted token, "
                    "so record the draft configuration in args).",
                    f"{path}.output_tok_s",
                )
            )
        elif (
            per_request is not None
            and ctx["plain_ceiling"] is not None
            and per_request < ctx["plain_ceiling"] * ctx["warn_fraction"]
        ):
            findings.append(
                Finding(
                    "warn",
                    "bandwidth-efficiency-low",
                    f"per-request decode is {per_request:.1f} tok/s, under "
                    f"{ctx['warn_fraction'] * 100:.0f}% of the {ctx['plain_ceiling']:.1f} "
                    "tok/s bandwidth ceiling — worth a note about why.",
                    f"{path}.output_tok_s",
                )
            )

    tdp = _number((ctx["hardware"] or {}).get("tdp_w"))
    power = _number(metrics.get("power_avg_w"))
    if power is not None and tdp and tdp > 0 and power > tdp * ctx["hw_count"] * 1.25:
        findings.append(
            Finding(
                "warn",
                "power-above-tdp",
                f"power_avg_w is {power} against a {tdp:g} W TDP; check what the sampler "
                "measured (whole wall socket vs device).",
                f"{path}.power_avg_w",
            )
        )

    if metrics.get("thermal_throttle_detected") is True:
        findings.append(
            Finding(
                "warn",
                "thermal-throttle",
                "thermal throttling was detected during the run; the numbers describe a "
                "throttled machine.",
                f"{path}.thermal_throttle_detected",
            )
        )
    return findings


def check_plausibility(
    result: dict[str, Any],
    *,
    hardware: dict[str, Any] | None = None,
    model: dict[str, Any] | None = None,
    quant: dict[str, Any] | None = None,
    site: dict[str, Any] | None = None,
) -> list[Finding]:
    """Run every plausibility check against one result. Empty list = nothing suspicious."""
    config = {**DEFAULTS, **((site or {}).get("plausibility") or {})}
    hw_count = int((result.get("hardware") or {}).get("count") or 1)
    resolved = (result.get("workload") or {}).get("resolved_params") or {}
    concurrency = resolved.get("concurrency")
    concurrency = int(concurrency) if isinstance(concurrency, (int, float)) else None

    tokens_per_pass = tokens_per_forward_pass(result.get("args") or {}, result.get("metrics"))
    ceiling = bandwidth_ceiling(
        hardware,
        model,
        quant,
        config["bandwidth_tolerance"],
        hw_count,
        tokens_per_pass,
        config["min_weight_gb"],
    )
    plain_ceiling = bandwidth_ceiling(
        hardware,
        model,
        quant,
        config["bandwidth_tolerance"],
        hw_count,
        1.0,
        config["min_weight_gb"],
    )
    ctx = {
        "hardware": hardware,
        "ceiling": ceiling,
        "plain_ceiling": plain_ceiling,
        "vram_tolerance": config["vram_tolerance"],
        "warn_fraction": config["warn_bandwidth_fraction"],
        "concurrency": concurrency,
        "hw_count": hw_count,
    }

    findings: list[Finding] = []
    if isinstance(result.get("metrics"), dict):
        findings += _check_metric_block(result["metrics"], "metrics", ctx)
    for index, point in enumerate(result.get("sweep") or []):
        if not isinstance(point, dict) or not isinstance(point.get("metrics"), dict):
            continue
        point_ctx = {**ctx, "concurrency": point.get("concurrency") or concurrency}
        findings += _check_metric_block(point["metrics"], f"sweep[{index}].metrics", point_ctx)

    if not result.get("metrics") and not result.get("sweep") and not result.get("scores"):
        findings.append(
            Finding(
                "warn",
                "no-metrics",
                "the result carries no metrics, no sweep and no scores — there is nothing "
                "to record.",
            )
        )

    scores = result.get("scores")
    if isinstance(scores, dict):
        correct = _number(scores.get("correct"))
        score_total = _number(scores.get("total"))
        accuracy = _number(scores.get("accuracy"))
        if correct is not None and score_total is not None and correct > score_total:
            findings.append(
                Finding(
                    "error",
                    "score-counts-mismatch",
                    f"scores.correct ({correct:g}) is greater than scores.total ({score_total:g}).",
                    "scores.correct",
                )
            )
        elif (
            score_total
            and score_total > 0
            and correct is not None
            and accuracy is not None
            and abs(correct / score_total - accuracy) > 0.005
        ):
            findings.append(
                Finding(
                    "error",
                    "accuracy-mismatch",
                    f"scores.accuracy is {accuracy} but correct/total is "
                    f"{correct / score_total:.4f}.",
                    "scores.accuracy",
                )
            )

    failed = _number((result.get("metrics") or {}).get("requests_failed"))
    if failed and failed > 0 and not (result.get("failures") or []):
        findings.append(
            Finding(
                "warn",
                "failures-not-described",
                f"{failed:g} requests failed but failures[] is empty. Failures are data — "
                "say what broke.",
                "failures",
            )
        )

    if hardware and quant and model:
        weight = active_weight_gb(model, quant)
        memory = _number(hardware.get("memory_gb"))
        if weight and memory and memory > 0:
            total = _number(quant.get("size_gb"))
            if total is None:
                params_b = _number(model.get("params_b"))
                bits = _number(quant.get("bits"))
                total = _bits_to_gb(params_b, bits) if params_b and bits else None
            if total is not None and total > memory * hw_count:
                suffix = f" x{hw_count}" if hw_count > 1 else ""
                findings.append(
                    Finding(
                        "warn",
                        "weights-exceed-memory",
                        f"{quant.get('model_id')}/{quant.get('id')} is ~{total:.1f} GB but "
                        f"{hardware.get('id')} has {memory:g} GB{suffix} — this only works "
                        "with offloading, which belongs in args and notes.",
                    )
                )
    return findings
