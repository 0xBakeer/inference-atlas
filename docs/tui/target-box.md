# The target box

Everything the app tells you — the ranking, every fit verdict, every recipe — is judged
against a **target box**. This page explains how it is chosen, why device counts change the
answer, and how each verdict is reached.

## The target is not necessarily this machine

The normal shape of local inference work is a laptop driving a GPU machine. So the target is
a **hardware registry entry plus a count**, and you own it:

| Source     | Means                                                                               |
| ---------- | ----------------------------------------------------------------------------------- |
| `detected` | probed on this machine and matched against the registry                             |
| `chosen`   | you picked it in the picker or on the command line                                  |
| `unknown`  | nothing matched, and you have not picked yet — the app asks before showing verdicts |

## Detection

At startup the app probes the machine it is running on:

| Platform | What it reads                                                |
| -------- | ------------------------------------------------------------ |
| macOS    | `sysctl -n machdep.cpu.brand_string`, `sysctl -n hw.memsize` |
| Linux    | `lscpu` (model name), total system memory                    |
| any      | `nvidia-smi --query-gpu=name,memory.total`                   |

It then matches that against the `detect` block every hardware file in the registry carries
— the same signals `atlas-bench hwinfo` uses:

```jsonc
"detect": {
  "nvidia_smi_name": ["NVIDIA GB10"],
  "cpu_model": ["Cortex-X925", "NVIDIA Grace"]
}
```

A GPU or Apple-chip name match scores highest, a CPU match lower, and installed memory
disambiguates size variants — which is what separates `apple-m2-max-32gb` from
`apple-m2-max-96gb`. **A box that matches nothing stays unidentified**; the app asks rather
than guessing.

Detection also reads the **count**: a host with three cards prints three `nvidia-smi` lines,
so it starts at `3 ×`.

If a tool is missing or fails, that probe is simply skipped — no error, just less
information.

## Choosing a box

Press **`b`**. The list is every hardware entry in the registry, the detected one first and
marked. `+` / `-` set how many devices. `enter` selects — and drops you back on the target
view, with everything re-ranked against the box you just chose.

Your choice is written to `~/.config/inference-atlas/config.toml`:

```toml
[target]
hardware = "nvidia-rtx-6000-ada"
count = 3
```

Only that section is rewritten — comments and every other setting survive untouched. You can
also edit it by hand, or set it from the command line:

```bash
inference-atlas --hardware nvidia-h100-80gb --count 8
```

which persists it the same way. `--hardware local` is not a thing; to go back to detection,
delete the `[target]` section or pick the detected row in the picker.

## Why the count matters

A count is not a label. It changes the memory a model can reach and the bandwidth it can
pull — but only where that is physically true, and the app distinguishes the two cases.

### GPUs in one host **pool**

Several discrete GPUs in one machine can serve one model together, sharded across them by
tensor parallelism. Memory adds up and so does bandwidth:

```
1 × H100 80GB  →  80 GB   · ceiling ≈ 141 tok/s
2 × H100 80GB  →  pools 160 GB (80 × 2)  · ceiling ≈ 282 tok/s across 2 devices
4 × H100 80GB  →  pools 320 GB (80 × 4)  · ceiling ≈ 564 tok/s across 4 devices
```

When a model needs more than one device, the verdict says how many and which flag sets it:

> needs sharding across 14 of your 16 devices — the engine must support tensor parallelism
> (e.g. vLLM `--tensor-parallel-size 14`)

### Whole machines do **not** pool

Two DGX Sparks are two computers. A model still has to fit one of them, so memory and the
bandwidth ceiling stay per-device:

```
2 × DGX Spark  →  has 128 GB (not 256)  ·  "separate machines — a model must fit one"
```

The rule is the registry's own `kind` field: `gpu` pools, `soc` and `cpu` do not.

### A run measured on more devices than you have

A four-card measurement is not evidence that a configuration fits on one card, so the
verdict is downgraded and says why:

> measured on 4 devices, you have 1 — the flags below assume 4

## The fit verdicts

| Verdict            | Means                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `✓ recommended`    | It fits, and the memory judgement rests on a **measurement** — usually because the run was made on this exact hardware in this exact quantity |
| `~ should fit`     | It fits, but the memory judgement is an **estimate** from the quantization's file size                                                        |
| `! tight`          | Over 90 % of the target's memory, or measured on more devices than you have                                                                   |
| `✗ won't fit`      | The footprint exceeds what the target can reach                                                                                               |
| `✗ wrong platform` | The engine does not run on this box's platform at all (a Metal engine on a CUDA box, or the reverse)                                          |
| `? unknown`        | No hardware selected yet, or nothing to judge from                                                                                            |

### How the memory judgement is made

In order of preference:

1. **Measured peak** — `ram_peak_gb` or `vram_peak_gb` from the run itself. Best evidence
   there is, and the verdict says `measured peak 120.2 GB on nvidia-gb10-dgx-spark`.
2. **Estimate** — the quantization's `size_gb` plus **25 %** headroom for KV cache and
   runtime, and the verdict says `estimate: … (no measured peak)`.
3. **Neither** — it says `no measured footprint and no quant size — memory fit unknown`
   rather than inventing a number.

A verdict that rests on an estimate never claims to be measured. That distinction is the
whole point of the line.

> **A note on the current data.** Every box measured in the atlas so far is unified-memory
> (Apple Silicon, DGX Spark), so `vram_peak_gb` is null everywhere and `ram_peak_gb` carries
> the footprint. For a discrete-GPU box there is not yet a measured VRAM figure to compare
> against, so verdicts there fall back to the estimate — and say so.

### The decode ceiling

Every verdict ends with a bandwidth-bound ceiling:

> bandwidth-bound decode ceiling there ≈ 33 tok/s

That is memory bandwidth divided by the bytes that must be read per token — an upper bound
no engine can beat, computed by `@atlas/core`'s `bandwidthCeiling`, the same function the
atlas uses to catch implausible measurements. Expect less than it, never more. On a pooled
multi-GPU target it scales with the device count.

### The platform check

Each engine's registry entry lists the platforms it supports (`linux-cuda`, `macos-metal`,
`linux-rocm`, …). The app compares that against the target's platform:

- for a **detected** target, from the actual probe — it knows
- for a **chosen** target, inferred from the registry entry's vendor, and the verdict says
  `(inferred from the registry entry, nothing probed)`

## Your box is not in the registry

The picker's last row — **first**, if nothing was detected — is `＋ not listed?`. It turns
the dead end into a contribution.

Selecting it raises a confirmation showing exactly what would be sent: a proposed id, name
and kind, and the probe output verbatim. Confirming opens the repository's `new-hardware`
issue form in your browser with all six of its fields pre-filled. `c` copies the link
instead. Nothing is submitted until you press the button on GitHub yourself.

What it proposes follows the registry's conventions:

| Your box                  | Proposed id                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `NVIDIA GeForce RTX 5090` | `nvidia-rtx-5090` — vendor first, marketing words dropped                                                |
| `Apple M4 Max`, 128 GB    | `apple-m4-max-128gb` — Apple ids carry the memory size, because unified memory is the binding constraint |
| a CPU-only box            | slugged from the CPU model                                                                               |

**What it refuses to propose matters more.** Memory bandwidth, compute throughput and TDP
are left blank, with a line saying they were deliberately not filled in. Those are exactly
the figures the plausibility checks use to catch a fabricated measurement — a guess there
would silently invalidate every future run on that device. The issue body says outright that
the values are probe output rather than a spec sheet, and offers the full
`uv run atlas-bench hwinfo --json` capture as follow-up.

The request carries the hardware probe and nothing else: no username, no hostname, no file
paths.
