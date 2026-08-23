### Engine

vllm

### Engine version

0.27.1

### Model

Qwen/Qwen3-8B

### Quantization

fp8

### Hardware

nvidia-rtx-4090

### Device count

1

### Engine args (JSON)

```json
{ "max-model-len": 32768, "gpu-memory-utilization": 0.9 }
```

### Workload

serve-single-i256-o256-v1

### Results (JSON)

```json
{
  "metrics": {
    "requests_total": 50,
    "requests_ok": 50,
    "requests_failed": 0,
    "success_rate": 1,
    "duration_s": 61.2,
    "output_tok_s": 118.4,
    "decode_tok_s_per_request": { "mean": 118.4 },
    "ttft_ms": { "mean": 41.2, "p50": 39.0, "p95": 62.5 },
    "vram_peak_gb": 17.9
  }
}
```

### Started at (UTC)

2026-08-12T14:15:22Z

### Conditions and notes

Ambient 21C, box otherwise idle, nothing else resident.

### Serve command

_No response_
