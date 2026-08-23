# Seed notes — real measurements available for seeding (2026-08-23)

Everything below was actually measured by `khaledbakeer` on his own machines. Seed result files
MAY use these numbers (metrics that are not listed stay `null`). Never invent additional numbers.
All seed results: `provenance.method = "manual"`, `verification.level = "self-reported"`,
`provenance.github_login = "khaledbakeer"`, `github_user_id = null` (CI would resolve it).

## Machines

### NVIDIA DGX Spark / ASUS Ascent GX10 — `nvidia-gb10-dgx-spark`
- GB10 Grace Blackwell superchip, 128 GB LPDDR5x unified (≈121 GiB visible to the OS), ~273 GB/s
  memory bandwidth, sm_121 (runs sm_120 cubins), CUDA 13 host, Ubuntu 24.04 aarch64, 20-core
  Grace CPU (10× X925 + 10× A725). Docker with CDI GPU access.
- Images used: `vllm/vllm-openai:v0.27.1-aarch64` (official, runs on GB10); community
  `timothystewart6/vllm-gb10:gb10.6` = vLLM `0.26.1.dev0+g568afb3a1`.
- Bandwidth model: dense decode tok/s ≈ 273 ÷ weight_GB. BF16 27B = 55.6 GB ⇒ ~4.9 tok/s ceiling
  (4.5 measured = 92 %).

### Mac Studio (2023) — `apple-m2-max-32gb`
- Apple M2 Max, 32 GB unified, 400 GB/s, macOS 26, LM Studio on :1234 (MLX + llama.cpp backends).
  No Atlas-grade measurements recorded yet → seed it as a registered hardware with gaps only.

## Measurements (DGX Spark)

### vLLM 0.27.1 · Qwen3.8-27B · FP8 (`Qwen/Qwen3.8-27B-FP8`) · 2026-08-16
Args: `--max-model-len 262144 --gpu-memory-utilization 0.44 --enable-prefix-caching
--speculative-config '{"method":"mtp","num_speculative_tokens":3}' --reasoning-parser qwen3
--tool-call-parser qwen3_xml` (plus served-model-name etc. which are dropped).
- single-stream decode: **18.9 tok/s on code, 14.1 tok/s on prose** (with MTP-3);
  **7.88 tok/s without MTP** (both code and prose).
- MTP acceptance per draft position 82 % / 66 % / 48 %, mean 2.96 tokens per forward pass.
- KV cache: 271,315 tokens with prefix caching, 348,497 without (at 0.44 gmu, 256K ctx).
- FP8 weights resident 28.5 GiB; full engine footprint ~50.3 GiB at 256K ctx.
- Prefix caching prefill wins: 19K-token shared prefix 12.64 s → 0.89 s; 53K prefix 26.62 s → 1.21 s.
- Gotcha: prefix caching defaults OFF for hybrid-attention models (is_hybrid=True) — must pass
  `--enable-prefix-caching` explicitly. Gotcha: `--reasoning-parser qwen3` resolves but
  `qwen3_xml` does not; `--tool-call-parser qwen3_xml` resolves but `qwen3` does not.
  Gotcha: thinking on by default at `reasoning_effort: xhigh` → 63-minute response once.
- Note: embed engine (Qwen3-Embedding-8B, ~10 GiB) resident alongside during measurement.

### vLLM 0.27.1 · Qwen3.8-27B · BF16 (`Qwen/Qwen3.8-27B`) · 2026-08-14
- BF16 weights 51.9 GiB; 76.3 GiB footprint at 256K. Decode ≈ 4.5 tok/s (bandwidth bound).

### vLLM 0.27.1 · Nemotron-3.5-Lightning-30B-A3B · NVFP4 · 2026-08-14/16
Args: `--max-model-len 1048576 --gpu-memory-utilization 0.22` + MTP (DSpark) spec decode.
- decode **115 tok/s** single stream (with spec decode). KV pool 1,481,935 tokens at 1M ctx.
- 318,924 KV tokens per GiB (whole 1M window = 3.3 GiB).

### vLLM 0.27.1 and 0.26.1 · Nemotron-3.5-Lightning-30B-A3B · BF16 · 2026-08-11
- `--max-model-len 262144`, no spec decode: **~29 tok/s** short-context decode on both versions
  (first request after boot ~9 tok/s = warmup). KV pool 1.19–1.22 M tokens. Mamba SSM cache fp32.

### llama.cpp (build 2026-08-07+) · Ling-3.0-flash · GGUF Q5_K_M · 2026-08-10
`~/ling/serve-ling-256k.sh`, context 262144 (GGUF metadata patched from 131072).
Decode tok/s (256-token generations) vs real prompt tokens:
| prompt tokens | tok/s |
|---|---|
| 8 | 34.6 |
| 26,475 | 34.6 |
| 52,921 | 33.2 |
| 117,565 | 29.4 |
| 146,950 | 29.4 |
| 237,095 | 25.5 (needle at 90 % depth returned correct) |
- Cold prefill at 237K = 493 s (481 tok/s); shallower prefill 1,000–2,800 tok/s.
- ~90 GB resident.

### vLLM fork (`vllm-ling-v3`) · Ling-3.0-flash · int4 · 2026-08-10 · `--max-model-len 262144`
| prompt tokens | tok/s |
|---|---|
| 8 | 18.6 |
| 26,475 | 6.4 |
| 52,921 | 3.7 |
| 117,565 | 1.8 |
| 146,950 | 1.5 |
- Gotcha: the depth penalty comes from *declaring* 256K max-model-len; at a 16K config the same
  quant does 38.7 tok/s short. Extending cudagraph capture sizes changed nothing.
- Gotcha: Triton JIT needs Python.h — use a uv-managed CPython when there is no sudo.
- Gotcha: `VLLM_USE_PRECOMPILED=1` works on aarch64/GB10.

## Which of the above become seed files

Seed at least these cells (kind `serving`, single-stream workload `serve-single-i256-o256-v1`
or the appropriate long-context workload), one file each:
1. vllm 0.27.1 / qwen3.8-27b / fp8 / dgx-spark — with MTP (18.9 code / 14.1 prose → record
   `decode_tok_s_per_request.mean = 16.5`, put both in notes, gotchas listed).
2. vllm 0.27.1 / qwen3.8-27b / fp8 / dgx-spark — without MTP (7.88).
3. vllm 0.27.1 / qwen3.8-27b / bf16 / dgx-spark (4.5).
4. vllm 0.27.1 / nemotron-3.5-lightning-30b-a3b / nvfp4 / dgx-spark (115, MTP).
5. vllm 0.27.1 / nemotron-3.5-lightning-30b-a3b / bf16 / dgx-spark (29).
6. vllm 0.26.1 / nemotron-3.5-lightning-30b-a3b / bf16 / dgx-spark (29).
7. llamacpp / ling-3.0-flash / gguf-q5-k-m / dgx-spark — longctx workload with the 6-point depth table in `sweep` (sweep axis `input_tokens`).
8. vllm (fork `vllm-ling-v3`, record as engine `vllm` version `0.26.1` with `engine.commit = "fork:vllm-ling-v3"`) / ling-3.0-flash / int4 — depth table.
