/**
 * The plain-language "recipe" of a run: the handful of facts a reader needs before any number
 * means anything — how many requests ran at once, how long the prompts and answers were, how
 * big the context window was, how much KV cache the engine had, whether speculative decoding
 * was on. Each engine spells these as different flags; this module is the one place that
 * knows the spellings, so every page shows them the same way.
 */
import { fmtInt, isNum } from '@atlas/core';
import type { MetricBlock, ResultRecord, SweepPoint, Workload, WorkloadKind } from '@atlas/core';

type Args = Record<string, unknown>;
type Params = Record<string, unknown>;

/** Compact token count: 128 → "128", 1024 → "1k", 262144 → "256k", 1500 → "1.5k". */
export function fmtTokens(v: number | null | undefined): string {
  if (!isNum(v)) return '–';
  if (v >= 1024 && v % 1024 === 0) return `${v / 1024}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return String(v);
}

function num(v: unknown): number | null {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function numList(v: unknown): number[] {
  return Array.isArray(v) ? v.map(num).filter((x): x is number => x !== null) : [];
}

/** The first flag present in `args` among several engine spellings. */
function pick(args: Args, names: string[]): { name: string; value: unknown } | null {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return { name, value: args[name] };
  }
  return null;
}

/* ------------------------------------------------------------------ workload shape */

export interface WorkloadShape {
  kind: WorkloadKind | null;
  /** Concurrent requests; for a concurrency sweep, the levels swept. */
  concurrency: number[];
  /** Prompt tokens per request; for a depth sweep, the depths swept. */
  input: number[];
  output: number | null;
  requests: number | null;
}

/** How a workload loads the server, from the registry entry (or the run's resolved params). */
export function workloadShape(
  w: Pick<Workload, 'kind' | 'params' | 'sweep'> | null | undefined,
  resolved?: Params | null,
): WorkloadShape {
  const p: Params = { ...(w?.params ?? {}), ...(resolved ?? {}) };
  const sweepC = numList(w?.sweep?.concurrency);
  const sweepI = numList(w?.sweep?.input_tokens);
  const c = num(p.concurrency);
  const i = num(p.input_tokens);
  return {
    kind: w?.kind ?? null,
    concurrency: sweepC.length ? sweepC : c !== null ? [c] : [],
    input: sweepI.length ? sweepI : i !== null ? [i] : [],
    output: num(p.output_tokens),
    requests: num(p.num_requests),
  };
}

function range(vals: number[], fmt: (v: number) => string): string {
  if (vals.length === 0) return '–';
  if (vals.length === 1) return fmt(vals[0]!);
  return `${fmt(Math.min(...vals))}→${fmt(Math.max(...vals))}`;
}

/** "16 concurrent · 128 in / 128 out", "1→64 concurrent · 1k in / 256 out". */
export function shapeLabel(s: WorkloadShape): string {
  const parts: string[] = [];
  if (s.concurrency.length) parts.push(`${range(s.concurrency, String)} concurrent`);
  const io: string[] = [];
  if (s.input.length) io.push(`${range(s.input, fmtTokens)} in`);
  if (s.output !== null) io.push(`${fmtTokens(s.output)} out`);
  if (io.length) parts.push(io.join(' / '));
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ recipe facts */

export interface RecipeFact {
  key: string;
  label: string;
  value: string;
  /** The flag or field the value came from — shown as a tooltip for the engineers. */
  source?: string;
  /** A short gloss for non-specialists. */
  hint?: string;
  /** True when the value is "not recorded" rather than a measurement or setting. */
  missing?: boolean;
}

const CONTEXT_FLAGS = ['max-model-len', 'context-length', 'ctx-size', 'max-seq-len', 'c'];
const SEQS_FLAGS = ['max-num-seqs', 'max-running-requests', 'parallel', 'max-batch-size', 'np'];
const MEM_FLAGS = ['gpu-memory-utilization', 'mem-fraction-static'];
const KV_DTYPE_FLAGS = ['kv-cache-dtype', 'cache-type-k'];
const TP_FLAGS = ['tensor-parallel-size', 'tp-size', 'tp'];

/** The speculative-decoding setting in words, or null when the run did not use it. */
export function speculative(args: Args): string | null {
  const alg = pick(args, ['speculative-algorithm']);
  if (alg) {
    const steps = num(args['speculative-num-steps']);
    const draft = num(args['speculative-num-draft-tokens']);
    const bits = [
      steps !== null ? `${steps} steps` : null,
      draft !== null ? `${draft} draft tokens` : null,
    ].filter(Boolean);
    return `${String(alg.value)}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }
  const cfg = args['speculative-config'];
  if (cfg) {
    let o: Record<string, unknown> | null = null;
    if (typeof cfg === 'object') o = cfg as Record<string, unknown>;
    else if (typeof cfg === 'string') {
      try {
        o = JSON.parse(cfg) as Record<string, unknown>;
      } catch {
        return cfg;
      }
    }
    if (o) {
      const method = o.method ?? o.model ?? 'on';
      const k = num(o.num_speculative_tokens);
      return `${String(method)}${k !== null ? ` (${k} tokens)` : ''}`;
    }
  }
  const other = pick(args, ['spec-type', 'draft-mode', 'speculative']);
  if (other && other.value !== false && other.value !== 'none') {
    return other.value === true ? 'on' : String(other.value);
  }
  if (args['draft-model'] || args['model-draft']) return 'draft model';
  return null;
}

function memValue(v: unknown): string {
  const n = num(v);
  if (n === null) return String(v);
  return n <= 1 ? `${Math.round(n * 100)}% of memory` : `${n}`;
}

/**
 * The run's setup in reader order. Values are always what was recorded; a fact the run did not
 * record is returned as `missing` rather than dropped, so a reader can tell "not set" from "not
 * shown" — the KV pool especially, which most harness versions do not capture yet.
 */
export function recipeFacts(
  rec: Pick<ResultRecord, 'args' | 'metrics' | 'hardware' | 'kind'> & {
    workload?: { resolved_params?: Params | null } | null;
  },
  workload?: Pick<Workload, 'kind' | 'params' | 'sweep'> | null,
): RecipeFact[] {
  const args = (rec.args ?? {}) as Args;
  const m: MetricBlock = rec.metrics ?? {};
  const shape = workloadShape(
    workload ?? { kind: rec.kind, params: {} },
    rec.workload?.resolved_params,
  );
  const facts: RecipeFact[] = [];

  if (shape.concurrency.length) {
    facts.push({
      key: 'concurrency',
      label: shape.concurrency.length > 1 ? 'Concurrency swept' : 'Concurrent requests',
      value:
        shape.concurrency.length > 1 ? shape.concurrency.join(', ') : String(shape.concurrency[0]),
      source: 'workload concurrency',
      hint: 'requests in flight at the same time — think "simultaneous users"',
    });
  }
  if (shape.input.length || shape.output !== null) {
    const inp =
      shape.input.length > 1 ? shape.input.map(fmtTokens).join(', ') : fmtTokens(shape.input[0]);
    facts.push({
      key: 'io',
      label: 'Prompt / answer length',
      value: `${shape.input.length ? inp : '–'} / ${fmtTokens(shape.output)} tokens`,
      source: 'workload input_tokens / output_tokens',
      hint: 'tokens per request in, and tokens generated out',
    });
  }
  const requests = num(m.requests_total) ?? shape.requests;
  if (requests !== null) {
    facts.push({ key: 'requests', label: 'Requests measured', value: fmtInt(requests) });
  }

  const ctx = pick(args, CONTEXT_FLAGS);
  const ctxN = ctx ? num(ctx.value) : null;
  facts.push(
    ctx
      ? {
          key: 'context',
          label: 'Context window',
          value: ctxN !== null ? `${fmtInt(ctxN)} tokens` : String(ctx.value),
          source: `--${ctx.name}`,
          hint: 'the longest prompt + answer one request may use',
        }
      : {
          key: 'context',
          label: 'Context window',
          value: 'engine default',
          source: 'no context flag passed',
          missing: true,
        },
  );

  const kv = num(m.kv_cache_tokens);
  const kvDtype = pick(args, KV_DTYPE_FLAGS);
  facts.push({
    key: 'kv',
    label: 'KV cache pool',
    value:
      kv !== null
        ? `${fmtInt(kv)} tokens${kvDtype ? ` · ${String(kvDtype.value)}` : ''}`
        : kvDtype
          ? `size not recorded · ${String(kvDtype.value)}`
          : 'not recorded',
    source: kv !== null ? 'metrics.kv_cache_tokens' : kvDtype ? `--${kvDtype.name}` : undefined,
    hint: 'total tokens of context all concurrent requests share',
    missing: kv === null,
  });

  const seqs = pick(args, SEQS_FLAGS);
  if (seqs) {
    facts.push({
      key: 'seqs',
      label: 'Max parallel sequences',
      value: String(seqs.value),
      source: `--${seqs.name}`,
    });
  }
  const mem = pick(args, MEM_FLAGS);
  if (mem) {
    facts.push({
      key: 'mem',
      label: 'Memory reserved',
      value: memValue(mem.value),
      source: `--${mem.name}`,
      hint: 'share of device memory the engine claims for weights + KV cache',
    });
  }
  const spec = speculative(args);
  facts.push({
    key: 'spec',
    label: 'Speculative decoding',
    value: spec ?? 'off',
    hint: spec ? 'decode speed includes the speculative speed-up' : undefined,
  });
  const tp = pick(args, TP_FLAGS);
  const devices = rec.hardware?.count ?? 1;
  if (devices > 1 || tp) {
    facts.push({
      key: 'devices',
      label: 'Devices',
      value: `${devices}${tp ? ` · tensor parallel ${String(tp.value)}` : ''}`,
      source: tp ? `--${tp.name}` : undefined,
    });
  }
  const peak = num(m.vram_peak_gb) ?? num(m.ram_peak_gb);
  if (peak !== null) {
    facts.push({
      key: 'peak',
      label: m.vram_peak_gb != null ? 'Peak VRAM' : 'Peak memory',
      value: `${peak.toFixed(peak >= 100 ? 0 : 1)} GB`,
    });
  }
  return facts;
}

/* ------------------------------------------------------------------ key numbers */

export interface KeyNumber {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** What the number means, in one short line. */
  hint: string;
  fmt: (v: number) => string;
}

const d50 = (d: { p50?: number | null; mean?: number | null } | null | undefined): number | null =>
  num(d?.p50) ?? num(d?.mean);

/**
 * The two to four numbers a reader came for, named in plain words. Aggregate throughput and
 * per-user speed are always separated and always labelled, because "221 tok/s" means
 * something very different at 1 and at 16 concurrent requests.
 */
export function keyNumbers(
  rec: Pick<ResultRecord, 'kind' | 'metrics'> & {
    scores?: { accuracy?: number | null } | null;
    sweep?: SweepPoint[] | null;
  },
  shape?: WorkloadShape,
): KeyNumber[] {
  const m: MetricBlock = rec.metrics ?? {};
  if (rec.sweep?.length && num(m.output_tok_s) === null) return sweepNumbers(rec.sweep);
  const out: KeyNumber[] = [];
  const c = shape?.concurrency.length === 1 ? shape.concurrency[0]! : null;
  const tok = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const ms = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)}` : fmtInt(v));
  const push = (k: KeyNumber | null) => {
    if (k) out.push(k);
  };
  const ttft = d50(m.ttft_ms);
  const ttftK = (): KeyNumber | null =>
    ttft === null
      ? null
      : {
          key: 'ttft',
          label: 'Time to first token',
          value: ttft,
          unit: ttft >= 10000 ? 's' : 'ms',
          hint: 'median wait before the answer starts',
          fmt: ms,
        };
  const perUser = d50(m.decode_tok_s_per_request);
  const perUserK = (): KeyNumber | null =>
    perUser === null
      ? null
      : {
          key: 'per_user',
          label: 'Speed per user',
          value: perUser,
          unit: 'tok/s',
          hint: 'generation speed one request sees',
          fmt: tok,
        };
  const outTok = num(m.output_tok_s);
  const totalK = (): KeyNumber | null =>
    outTok === null
      ? null
      : {
          key: 'output',
          label: 'Total throughput',
          value: outTok,
          unit: 'tok/s',
          hint: c !== null ? `all ${c} concurrent requests combined` : 'all requests combined',
          fmt: tok,
        };
  const success = num(m.success_rate);
  const successK = (): KeyNumber | null =>
    success === null
      ? null
      : {
          key: 'success',
          label: 'Success rate',
          value: success,
          unit: '%',
          hint: 'requests that completed',
          fmt: (v) => (v * 100).toFixed(v === 1 ? 0 : 1),
        };

  switch (rec.kind) {
    case 'eval': {
      const acc = num(rec.scores?.accuracy) ?? num((m as { accuracy?: unknown }).accuracy);
      if (acc !== null)
        out.push({
          key: 'accuracy',
          label: 'Accuracy',
          value: acc,
          unit: '%',
          hint: 'share of items answered correctly',
          fmt: (v) => (v * 100).toFixed(1),
        });
      push(perUserK());
      push(ttftK());
      break;
    }
    case 'prefill': {
      const pf = num(m.prefill_tok_s);
      if (pf !== null)
        out.push({
          key: 'prefill',
          label: 'Prompt processing',
          value: pf,
          unit: 'tok/s',
          hint: 'how fast the prompt is read in',
          fmt: (v) => fmtInt(v),
        });
      push(ttftK());
      push(perUserK());
      break;
    }
    case 'longctx':
      push(ttftK());
      push(perUserK());
      push(successK());
      break;
    case 'image': {
      const spi = d50(m.s_per_image);
      if (spi !== null)
        out.push({
          key: 's_per_image',
          label: 'Time per image',
          value: spi,
          unit: 's',
          hint: 'median seconds to generate one image',
          fmt: (v) => v.toFixed(2),
        });
      push(successK());
      break;
    }
    default:
      push(totalK());
      push(perUserK());
      push(ttftK());
      push(successK());
  }
  return out.slice(0, 4);
}

/** A sweep's headline: its peak throughput and where it peaked, plus single-request speed. */
function sweepNumbers(pts: SweepPoint[]): KeyNumber[] {
  const out: KeyNumber[] = [];
  const tok = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  let best: SweepPoint | null = null;
  for (const p of pts) {
    const v = num(p.metrics.output_tok_s);
    if (v !== null && (best === null || v > (num(best.metrics.output_tok_s) ?? -1))) best = p;
  }
  if (best) {
    const where = [
      best.concurrency != null ? `${best.concurrency} concurrent` : null,
      best.input_tokens != null ? `${fmtTokens(best.input_tokens)} prompt` : null,
    ].filter(Boolean);
    out.push({
      key: 'peak_output',
      label: 'Peak throughput',
      value: num(best.metrics.output_tok_s)!,
      unit: 'tok/s',
      hint: where.length ? `reached at ${where.join(', ')}` : 'best point of the sweep',
      fmt: tok,
    });
  }
  const first = [...pts].sort(
    (a, b) => (a.concurrency ?? a.input_tokens ?? 0) - (b.concurrency ?? b.input_tokens ?? 0),
  )[0];
  const single = first ? d50(first.metrics.decode_tok_s_per_request) : null;
  if (first && single !== null) {
    out.push({
      key: 'per_user',
      label: 'Speed per user',
      value: single,
      unit: 'tok/s',
      hint:
        first.concurrency != null
          ? `at ${first.concurrency} concurrent`
          : first.input_tokens != null
            ? `at ${fmtTokens(first.input_tokens)} prompt`
            : 'first point',
      fmt: tok,
    });
  }
  const ttft = first ? d50(first.metrics.ttft_ms) : null;
  if (first && ttft !== null) {
    out.push({
      key: 'ttft',
      label: 'Time to first token',
      value: ttft,
      unit: 'ms',
      hint: 'median, at the lightest point',
      fmt: (v) => fmtInt(v),
    });
  }
  return out;
}
