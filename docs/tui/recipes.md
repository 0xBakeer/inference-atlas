# Recipes

A recipe is a Markdown file that turns one measured run into instructions somebody — or some
agent — can follow to reproduce it, and then to contribute their own measurement back.

Press **`g`** on an open run.

## What you get

The file is written to `~/inference-atlas/recipes/` (configurable) with a name built from
the configuration:

```
qwen-qwen3.8-27b--nvfp4--sglang-0.5.4--serve-chat-c8-i1k-o256-v1.md
```

Regenerating the same run overwrites the same file.

## Anatomy

Every recipe carries these sections, in this order.

### Title and provenance

Which model, quantization and engine version; the run id with a link to it on the website;
the workload; the hardware it was measured on, by whom, and the verification level.

### The box this is for

The target box you had selected, whether it was detected or chosen by hand, its memory and
bandwidth, and its atlas hardware id. When the model does not fit a single device, this
section states across how many it must be sharded and which flag sets it.

### Fit

The verdict and every reason behind it — the same reasoning the detail view shows. When the
memory judgement is an estimate rather than a measurement, it says so here rather than
letting the reader assume.

### Model & weights

- the model, with its parameter count
- the quantization: format, bits, size on disk
- **the weights repository with its revision pinned** — this is the part that makes a recipe
  reproducible rather than approximately reproducible
- the quantization recipe link, when the quant came from a published one
- the registry's notes about that quantization

### Engine

Repo, docs, supported platforms, and **install commands for that exact version**, rendered
from the registry's install methods:

```
- **docker**: `docker pull vllm/vllm-openai:v0.27.1`
  - aarch64 images carry an -aarch64 suffix for some releases; check the tag list first.
- **pip**: `uv pip install 'vllm==0.27.1'`
```

### Serve command

The command line, rebuilt from the flags the run recorded, through that engine's own flag
style:

```bash
vllm serve neuralmagic/Qwen3-8B-FP8 --max-model-len 131072 --max-num-seqs 32 \
  --gpu-memory-utilization 0.6 --enable-auto-tool-choice --tool-call-parser gemma4 \
  --no-enable-prefix-caching --host 0.0.0.0 --port 8000
```

Most results in the atlas were measured by attaching to a server the contributor started
themselves, so this command is _reconstructed_ from the recorded configuration rather than
copied from a log. When the run did record its own `serve_command`, both are shown.

Followed by the health endpoint to poll until the server is up.

### Parameters

Every flag the run set, in a table with its **registered default**, its **impact**, and the
**help text** from that engine version's parameter registry:

| flag            | value    | default | impact | what it does           |
| --------------- | -------- | ------- | ------ | ---------------------- |
| `max-model-len` | `131072` | `null`  | high   | Context window served. |

This is the difference between a config dump and something you can reason about: you can see
which flags deviate from the defaults and why they matter. Flags the registry does not know
are marked as such rather than silently omitted.

### Gotchas

The `gotchas[]` from the run, verbatim. These are the notes the original contributor left
about what they had to know to make it work — 245 of the 255 runs in the atlas carry at
least one, and they are usually the most valuable part of the file.

### Expected numbers

The metrics the run actually produced, so you can tell whether your reproduction matches:
throughput, per-request decode rate, prefill rate, TTFT and TPOT percentiles, success rate,
accuracy, peak memory, power. Plus the bandwidth-bound decode ceiling on your box — expect
less than it, never more.

### Verify & contribute back

The `atlas-bench` sequence to reproduce the measurement on your own machine and open a pull
request with the result. The cell is filled in with your target's hardware id:

```bash
git clone https://github.com/0xBakeer/inference-atlas.git && cd inference-atlas/bench
uv sync && uv run atlas-bench hwinfo   # identify this box — never type specs
uv run atlas-bench packet --cell 'vllm@0.27.1/Qwen/Qwen3-8B/fp8/nvidia-h100-80gb' \
  --workload serve-chat-c8-i1k-o256-v1 \
  --arg max-model-len=131072 \
  --out task.json
uv run atlas-bench run --spec task.json --base-url http://127.0.0.1:8000/v1 --out ../results
```

### Rules for the agent doing this

The eight rules from [`AGENTS.md`](../../AGENTS.md), restated in the file: only add files you
own, never edit a number by hand, never silently lower the configuration, report failures as
failures, run on an idle box, capture hardware rather than typing it, leave the fields CI
owns alone, record the gotchas.

They are in every recipe because a recipe is most often read by an agent, and those rules
are what keep the data trustworthy.

## Getting it out of the terminal

From the recipe view:

| Key       | Does                                       |
| --------- | ------------------------------------------ |
| `c`       | copy the whole Markdown to the clipboard   |
| `1`–`9`   | hand it to the _n_-th agent in your config |
| `j` / `k` | scroll                                     |
| `esc`     | back to the run                            |

Copying goes through **OSC 52** first, which works over ssh and inside tmux if your terminal
allows it, then falls back to `pbcopy` (macOS), `wl-copy` or `xclip` (Linux).

## Agent targets

Configure any number of them. `{recipe}` is replaced with the path of the generated file:

```toml
[agents.claude]
command = 'claude "$(cat {recipe})"'
mode = "copy"

[agents.opencode]
command = 'opencode run "$(cat {recipe})"'
mode = "copy"

[agents.remote]
command = 'ssh gpu-box "claude -p \"$(cat {recipe})\""'
mode = "run"
```

| `mode` | Behaviour                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------- |
| `copy` | Puts the **command** on your clipboard, for you to paste into a shell. The default, and the safe one |
| `run`  | Executes it from the app and shows the tail of its output                                            |

`copy` is the default because handing a recipe to an agent starts real work — downloading
tens of gigabytes of weights, pulling containers, binding ports. That should be a deliberate
paste, not a keystroke.

## Where recipes go

```toml
[recipes]
dir = "~/inference-atlas/recipes"
```

Nothing else reads that directory — the files are yours. They are plain Markdown: commit
them, paste them into an issue, hand them to a colleague.

One caution: a recipe records the target box you had selected, so if you generate one for a
private machine name, that name is in the file. The content is otherwise entirely public
atlas data.
