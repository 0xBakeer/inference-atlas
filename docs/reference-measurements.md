# Reference measurements (historical, NOT in the atlas)

These numbers were measured by hand by `khaledbakeer` on his own machines before the harness
existed. They are **not** result files in the atlas (the atlas only holds harness-produced runs
submitted by PR); they are kept as context for plausibility thresholds, gotchas and as
reproduction targets. Model names below predate the "model_id = Hugging Face repo id" rule.

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

| prompt tokens | tok/s                                        |
| ------------- | -------------------------------------------- |
| 8             | 34.6                                         |
| 26,475        | 34.6                                         |
| 52,921        | 33.2                                         |
| 117,565       | 29.4                                         |
| 146,950       | 29.4                                         |
| 237,095       | 25.5 (needle at 90 % depth returned correct) |

- Cold prefill at 237K = 493 s (481 tok/s); shallower prefill 1,000–2,800 tok/s.
- ~90 GB resident.

### vLLM fork (`vllm-ling-v3`) · Ling-3.0-flash · int4 · 2026-08-10 · `--max-model-len 262144`

| prompt tokens | tok/s |
| ------------- | ----- |
| 8             | 18.6  |
| 26,475        | 6.4   |
| 52,921        | 3.7   |
| 117,565       | 1.8   |
| 146,950       | 1.5   |

- Gotcha: the depth penalty comes from _declaring_ 256K max-model-len; at a 16K config the same
  quant does 38.7 tok/s short. Extending cudagraph capture sizes changed nothing.
- Gotcha: Triton JIT needs Python.h — use a uv-managed CPython when there is no sudo.
- Gotcha: `VLLM_USE_PRECOMPILED=1` works on aarch64/GB10.

### llama.cpp b11071 · Tinfield 1 · `gguf-iq2-xxs-compact` · 2026-09-21

`badtheorylabs/Tinfield-1-Compact-GGUF` at revision 79689f3f (six IQ2XXS shards, 77.4 GB),
llama.cpp tag b11071 (6ad1af56) built with
`-DGGML_CUDA=ON -DGGML_CUDA_GRAPHS=ON -DCMAKE_CUDA_ARCHITECTURES=121`, run with `GGML_CUDA_NO_VMM=1`.
These are the measurements that sit next to the atlas rows for this model and are not atlas rows
themselves.

llama-bench, `-ngl 999 -fa on -lm none -b 2048 -ub 2048 -t 20`, f16 K and V, tok/s:

| depth (tokens) | pp512 | pp2048 | tg128 |
| -------------- | ----- | ------ | ----- |
| 0              | 980   | 1,097  | 32.0  |
| 8,192          | 855   | 966    | 29.7  |
| 32,768         | 660   | 723    | 25.6  |
| 65,536         | 507   | 571    | 21.1  |
| 131,072        | 300   | 404    | 14.8  |

- Rows 0 to 32K are 3 repetitions, 64K and 128K one each.
- q8_0 K and V at 32K depth: pp2048 763, tg128 23.9, so f16 is faster at decode.
- `--load-mode none` vs `auto`, 10 vs 20 threads: no difference (tg128 32.0 in all four). `-ub 2048`
  gives about 2.5 % more prefill than `-ub 1024`.
- Load to `/health`: 44 to 60 s from local NVMe with `--load-mode none`. With `-c 524288 -np 4` the server
  held about 94 GB and left 27 GB available. The release has no `--no-mmap`; `--load-mode none` replaces it.

Agentic and one-shot coding checks (server defaults `--temp 1.0 --top-p 0.95 --top-k 20`,
thinking on at the template default `reasoning_effort` xhigh):

- opencode 1.18.31, the aquarium prompt (build one self-contained `aquarium.html`, write it and
  do nothing else): one `write` call with valid arguments, 22 KB of HTML, 29,282 prompt and 28,090
  output tokens, 20.6 minutes at about 24 tok/s. The page runs from `file://` with no console errors.
  It has light shafts, bubbles from two vents, kelp, three fish species with depth dimming, a working
  pause button and a working fish-count slider. Caustics and fish shadows on the sand are faint. After
  writing, the model ignored "do nothing else" and made three more tool calls to open the page in a
  browser and screenshot it.
- One-shot "Angry Birds style game in one HTML file" through the chat API: 35,874 output tokens
  (about 79,000 characters of reasoning), 22.3 minutes at 26.9 tok/s, finish reason `stop`, 31 KB of
  HTML. It does not run. A stray identifier `hw_` in the block constructor throws a ReferenceError
  while the page builds the level, so only the HUD appears; with that token removed, a second TypeError
  follows. This is the same kind of token-level damage `eval-longgen-integrity-v1` counts.
