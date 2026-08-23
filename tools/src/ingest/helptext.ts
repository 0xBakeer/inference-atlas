/**
 * `--help` text → params, for the engines that have no argparse to introspect.
 *
 * llama.cpp writes its own option parser in C++ and Ollama's is Cobra, so the only
 * machine-readable description either of them offers is the help output. Parsing help text
 * is a worse source than argparse — the defaults are whatever the author wrote in the
 * string — so `extraction_method` records `help` and the reader can weigh it accordingly.
 *
 * The grammar both parsers assume:
 *
 *     -ngl, --n-gpu-layers N          number of layers to offload (default: 0)
 *           --ctx-size N              size of the prompt context (default: 4096)
 *     -fa,  --flash-attn              enable Flash Attention (default: disabled)
 *
 * That is: an options column of comma-separated switches with an optional metavar, two or
 * more spaces, then a description whose trailing `(default: …)` carries the default.
 * Continuation lines are indented past the options column and belong to the description
 * above them.
 */
import type { ArgValue, EngineParam, EngineParamType } from '@atlas/core';

export interface HelpParseOptions {
  /** Names to skip entirely — help, version, and anything the caller knows is noise. */
  skip?: string[];
}

const DEFAULT_SKIP = ['help', 'usage', 'version', 'h', 'v'];

interface RawOption {
  name: string;
  aliases: string[];
  metavar: string | null;
  description: string;
}

/** `N`, `HOST`, `FNAME`, `{on,off,auto}`, `<n>` — a placeholder for the flag's value. */
const METAVAR = /^([A-Z][A-Z0-9_]*|\{[^}]+\}|<[^>]+>)$/;

/**
 * Split one help line into its option column and its description.
 *
 * The option column cannot be found by "the first run of two spaces": llama.cpp aligns the
 * long form of a flag into its own column, so `-t,    --threads N   number of threads` has
 * a wide gap *inside* the options. So the line is walked token by token instead — switches
 * and their metavar first, description from the first token that is neither.
 */
function parseFlagLine(line: string): RawOption | null {
  if (!/^\s*-/.test(line)) return null;

  const tokens: Array<{ text: string; end: number }> = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    tokens.push({ text: match[0], end: pattern.lastIndex });
  }

  const switches: string[] = [];
  let metavar: string | null = null;
  let index = 0;
  let descriptionFrom = line.length;

  while (index < tokens.length) {
    const token = tokens[index]!;
    const bare = token.text.replace(/,$/, '');
    if (!bare.startsWith('-')) break;
    switches.push(bare);
    index += 1;
    // A metavar belongs to the switch it follows, but only when the column ends after it:
    // `--host HOST   ip address` has one, `--mlock   IP something` does not.
    const next = tokens[index];
    const endsColumn = next !== undefined && /^\s{2,}/.test(line.slice(next.end));
    if (next && metavar === null && endsColumn && METAVAR.test(next.text)) {
      metavar = next.text;
      index += 1;
    }
    if (!token.text.endsWith(',')) {
      const after = tokens[index - 1]!;
      if (/^\s{2,}/.test(line.slice(after.end)) || index >= tokens.length) {
        descriptionFrom = after.end;
        break;
      }
    }
  }
  if (switches.length === 0) return null;

  const long = switches.filter((s) => s.startsWith('--'));
  const canonical = (long.length > 0 ? long : switches).reduce((a, b) =>
    b.length > a.length ? b : a,
  );
  return {
    name: canonical.replace(/^-+/, '').toLowerCase().replace(/_/g, '-'),
    aliases: switches.filter((s) => s !== canonical),
    metavar,
    description: line.slice(descriptionFrom).trim(),
  };
}

/** `(default: 0)`, `(default: disabled)`, `(env: LLAMA_ARG_THREADS)` — the tail matter. */
function extractDefault(description: string): {
  text: string;
  raw: string | null;
  env: string | null;
} {
  let env: string | null = null;
  let raw: string | null = null;
  let text = description;

  const envMatch = /\(env:\s*([A-Z0-9_]+)\)/.exec(text);
  if (envMatch) {
    env = envMatch[1]!;
    text = text.replace(envMatch[0], '').trim();
  }
  const defaultMatch = /\(default:?\s*([^)]*)\)\s*$/i.exec(text);
  if (defaultMatch) {
    raw = (defaultMatch[1] ?? '').trim();
    text = text.slice(0, defaultMatch.index).trim();
  }
  return { text: text.replace(/\s+/g, ' ').trim(), raw, env };
}

const DISABLED = new Set(['disabled', 'off', 'false', 'no', 'unset', 'none', '']);
const ENABLED = new Set(['enabled', 'on', 'true', 'yes']);

function coerceDefault(
  raw: string | null,
  metavar: string | null,
): { value: ArgValue; type: EngineParamType } {
  if (raw === null) {
    // No stated default. A switch with no metavar is a boolean that is off unless passed;
    // anything else has a default we do not know, and an unknown default must be null so
    // that canonicalization never drops a value it should have kept (SPEC decision 5).
    return metavar === null ? { value: false, type: 'bool' } : { value: null, type: 'str' };
  }
  // `(default: 4096, 0 = loaded from model)` states the default and then explains a special
  // value; the default is the part before the comma.
  const head = raw.includes(',') ? raw.slice(0, raw.indexOf(',')).trim() : raw;
  for (const candidate of [raw, head]) {
    const lower = candidate.toLowerCase();
    if (DISABLED.has(lower)) return { value: false, type: 'bool' };
    if (ENABLED.has(lower)) return { value: true, type: 'bool' };
    if (/^-?\d+$/.test(candidate)) return { value: Number.parseInt(candidate, 10), type: 'int' };
    if (/^-?\d*\.\d+$/.test(candidate)) {
      return { value: Number.parseFloat(candidate), type: 'float' };
    }
  }
  const cleaned = raw.replace(/^['"`]|['"`]$/g, '');
  if (cleaned === 'null' || cleaned === 'none') return { value: null, type: 'str' };
  return { value: cleaned, type: 'str' };
}

/** `{f16,q8_0,q4_0}` in the metavar is a closed set of choices. */
function choicesFrom(metavar: string | null): string[] | null {
  if (!metavar) return null;
  const match = /^\{(.+)\}$/.exec(metavar);
  if (!match) return null;
  return match[1]!
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

export function paramsFromHelpText(help: string, options: HelpParseOptions = {}): EngineParam[] {
  const skip = new Set([...(options.skip ?? []), ...DEFAULT_SKIP]);
  const raws: RawOption[] = [];
  let current: RawOption | null = null;

  for (const line of help.replace(/\r\n/g, '\n').split('\n')) {
    const option = parseFlagLine(line);
    if (option) {
      raws.push(option);
      current = option;
      continue;
    }
    // Continuation: indented text under an option we are already collecting.
    if (current && /^\s{4,}\S/.test(line) && !/^\s*-/.test(line)) {
      current.description = `${current.description} ${line.trim()}`.trim();
      continue;
    }
    if (line.trim() === '') current = null;
  }

  const params: EngineParam[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (skip.has(raw.name) || seen.has(raw.name)) continue;
    seen.add(raw.name);
    const { text, raw: defaultText, env } = extractDefault(raw.description);
    const { value, type } = coerceDefault(defaultText, raw.metavar);
    const choices = choicesFrom(raw.metavar);
    params.push({
      name: raw.name,
      type: choices ? 'enum' : type,
      default: value,
      ...(choices ? { choices } : {}),
      help: text || null,
      ...(raw.aliases.length > 0 ? { aliases: raw.aliases } : {}),
      ...(env ? { env } : {}),
    });
  }
  params.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return params;
}

/* ------------------------------------------------------------------------ ollama */

/**
 * Ollama's knobs are environment variables, not flags: `ollama serve` takes almost no
 * options and everything that changes a number (`OLLAMA_NUM_PARALLEL`,
 * `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`) is read from the environment. Newer
 * builds list them under `Environment Variables:` in the help output; older ones do not,
 * which is what `OLLAMA_ENV_VARS` is for.
 *
 * The naming follows the registry: the canonical name is the variable lowercased with
 * dashes (`ollama-num-parallel`), with the bare suffix kept as an alias so that a result
 * whose `args` says `num_parallel` still fingerprints identically.
 */
export const OLLAMA_ENV_VARS: Array<{
  env: string;
  type: EngineParamType;
  default: ArgValue;
  help: string;
  choices?: string[];
}> = [
  {
    env: 'OLLAMA_NUM_PARALLEL',
    type: 'int',
    default: 0,
    help: 'Maximum number of parallel requests per model (0 = auto).',
  },
  {
    env: 'OLLAMA_MAX_LOADED_MODELS',
    type: 'int',
    default: 0,
    help: 'How many models may be resident at once (0 = auto).',
  },
  {
    env: 'OLLAMA_MAX_QUEUE',
    type: 'int',
    default: 512,
    help: 'Maximum number of queued requests before rejecting.',
  },
  {
    env: 'OLLAMA_FLASH_ATTENTION',
    type: 'bool',
    default: false,
    help: 'Enable the flash-attention kernels.',
  },
  {
    env: 'OLLAMA_KV_CACHE_TYPE',
    type: 'enum',
    default: 'f16',
    help: 'Quantization of the K/V cache.',
    choices: ['f16', 'q8_0', 'q4_0'],
  },
  {
    env: 'OLLAMA_CONTEXT_LENGTH',
    type: 'int',
    default: 4096,
    help: 'Default context window when the request does not set one.',
  },
  {
    env: 'OLLAMA_KEEP_ALIVE',
    type: 'str',
    default: '5m',
    help: 'How long a model stays resident after its last request.',
  },
  { env: 'OLLAMA_NOHISTORY', type: 'bool', default: false, help: 'Do not keep readline history.' },
  {
    env: 'OLLAMA_NOPRUNE',
    type: 'bool',
    default: false,
    help: 'Do not prune model blobs on start-up.',
  },
  {
    env: 'OLLAMA_SCHED_SPREAD',
    type: 'bool',
    default: false,
    help: 'Spread a model across all GPUs instead of filling one.',
  },
  {
    env: 'OLLAMA_GPU_OVERHEAD',
    type: 'int',
    default: 0,
    help: 'Bytes of VRAM to reserve per GPU.',
  },
  {
    env: 'OLLAMA_LOAD_TIMEOUT',
    type: 'str',
    default: '5m',
    help: 'How long to wait for a model to load before giving up.',
  },
];

function envParam(
  entry: (typeof OLLAMA_ENV_VARS)[number],
  help?: string,
  def?: ArgValue,
): EngineParam {
  const name = entry.env.toLowerCase().replace(/_/g, '-');
  const suffix = name.replace(/^ollama-/, '');
  return {
    name,
    type: entry.type,
    default: def === undefined ? entry.default : def,
    ...(entry.choices ? { choices: entry.choices } : {}),
    help: help ?? entry.help,
    aliases: [suffix.replace(/-/g, '_'), suffix],
    env: entry.env,
  };
}

/** `ollama serve --help` — the flags it does have, plus the environment variables. */
export function paramsFromOllamaHelp(help: string): EngineParam[] {
  const described = new Map<string, { help: string; default: ArgValue }>();

  const envSection = /Environment Variables:\n([\s\S]*?)(?:\n\s*\n|$)/.exec(help);
  if (envSection) {
    for (const line of envSection[1]!.split('\n')) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s{2,}(.*)$/.exec(line);
      if (!match) continue;
      const { text, raw } = extractDefault(match[2]!.trim());
      const known = OLLAMA_ENV_VARS.find((e) => e.env === match[1]);
      const coerced = coerceDefault(raw, known?.type === 'bool' ? null : 'X');
      described.set(match[1]!, {
        help: text,
        default: raw === null ? (known?.default ?? null) : coerced.value,
      });
    }
  }

  const params = OLLAMA_ENV_VARS.map((entry) => {
    const seen = described.get(entry.env);
    return envParam(entry, seen?.help || entry.help, seen ? seen.default : undefined);
  });

  // Anything the build lists that we do not know about: keep it, typed from its default.
  for (const [env, seen] of described) {
    if (OLLAMA_ENV_VARS.some((e) => e.env === env)) continue;
    const type: EngineParamType =
      typeof seen.default === 'boolean'
        ? 'bool'
        : typeof seen.default === 'number'
          ? Number.isInteger(seen.default)
            ? 'int'
            : 'float'
          : 'str';
    params.push(
      envParam({ env, type, default: seen.default, help: seen.help }, seen.help, seen.default),
    );
  }

  params.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return params;
}
