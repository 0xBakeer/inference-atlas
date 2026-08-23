/**
 * The argv parser the tool CLIs share.
 *
 * Small on purpose: these commands take flags, not sub-commands, and a dependency that
 * ships its own help renderer would be more code than the thing it parses. Supports
 * `--flag`, `--key value`, `--key=value`, repeated keys, and *variadic* keys that swallow
 * every following token until the next `--flag` (which is how `--changed a.json b.json`
 * reaches us from a shell `$(git diff --name-only ...)` expansion).
 */

export interface ArgvSpec {
  /** Flags that consume every following non-flag token: `--changed a b c`. */
  variadic?: string[];
  /** Flags that never take a value, so `--json path` leaves `path` positional. */
  boolean?: string[];
}

export class Argv {
  readonly values: Map<string, Array<string | boolean>>;
  readonly positional: string[];

  constructor(values: Map<string, Array<string | boolean>>, positional: string[]) {
    this.values = values;
    this.positional = positional;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  /** Last occurrence wins, so a wrapper script can append an override. */
  str(name: string, fallback: string): string;
  str(name: string, fallback?: string | null): string | null;
  str(name: string, fallback: string | null = null): string | null {
    const list = this.values.get(name);
    if (!list || list.length === 0) return fallback;
    const last = list[list.length - 1]!;
    return typeof last === 'string' ? last : fallback;
  }

  num(name: string, fallback: number): number {
    const raw = this.str(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  bool(name: string, fallback = false): boolean {
    const list = this.values.get(name);
    if (!list || list.length === 0) return fallback;
    const last = list[list.length - 1]!;
    if (typeof last === 'boolean') return last;
    const s = last.trim().toLowerCase();
    if (s === 'false' || s === 'no' || s === '0') return false;
    return true;
  }

  /** Every value of a repeated or variadic flag, comma-separated values split out. */
  list(name: string): string[] {
    const list = this.values.get(name) ?? [];
    const out: string[] = [];
    for (const value of list) {
      if (typeof value !== 'string') continue;
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (trimmed) out.push(trimmed);
      }
    }
    return out;
  }

  /** `--args k=v --args other=1` → `{ k: 'v', other: 1 }`, values JSON-parsed when they parse. */
  pairs(name: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const entry of this.values.get(name) ?? []) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq === -1) {
        out[entry] = true;
        continue;
      }
      const key = entry.slice(0, eq).trim();
      const raw = entry.slice(eq + 1);
      out[key] = coerce(raw);
    }
    return out;
  }
}

function coerce(raw: string): unknown {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return s;
    }
  }
  return s;
}

export function parseArgv(input: string[], spec: ArgvSpec = {}): Argv {
  // `pnpm packet -- --engine vllm` forwards the separator itself; a leading `--` is pnpm's,
  // not the user's, and dropping it is the difference between parsing flags and collecting
  // them all as positionals.
  let argv = input;
  while (argv[0] === '--') argv = argv.slice(1);

  const variadic = new Set(spec.variadic ?? []);
  const booleans = new Set(spec.boolean ?? []);
  const values = new Map<string, Array<string | boolean>>();
  const positional: string[] = [];

  const push = (name: string, value: string | boolean) => {
    const list = values.get(name);
    if (list) list.push(value);
    else values.set(name, [value]);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      push(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const name = body;
    if (booleans.has(name)) {
      push(name, true);
      continue;
    }
    if (variadic.has(name)) {
      let consumed = 0;
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        push(name, argv[i + 1]!);
        i += 1;
        consumed += 1;
      }
      if (consumed === 0) push(name, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      push(name, true);
      continue;
    }
    push(name, next);
    i += 1;
  }

  return new Argv(values, positional);
}
