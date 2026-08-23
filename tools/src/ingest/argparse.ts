/**
 * argparse introspection → `engines/<id>/versions/<version>.json` params (DESIGN §3.4).
 *
 * vLLM and SGLang both build their server flags with `argparse`, so the truthful list of
 * what a *particular build* accepts — including the defaults, which canonicalization drops
 * and therefore must get right — is inside the installed package, not in the documentation.
 * `snippets.ts` runs a few lines of Python inside the container or the pip environment that
 * walk `parser._actions` and dump them as JSON; this module turns that dump into params.
 *
 * Reading `_actions` is reaching into a private attribute, and that is deliberate: the
 * public argparse API can format help but cannot enumerate defaults, and a default parsed
 * out of help text is a guess. The dump is versioned with the engine build that produced
 * it, so a change in argparse internals breaks loudly on one engine rather than silently
 * mis-fingerprinting every configuration.
 */
import type { ArgValue, EngineParam, EngineParamType } from '@atlas/core';

/** One `argparse.Action`, as `snippets.ts` serializes it. */
export interface ArgparseAction {
  option_strings: string[];
  dest: string;
  /** `int`, `float`, `str`, `json.loads`, … — the `__name__` of `action.type`. */
  type?: string | null;
  default?: unknown;
  choices?: Array<string | number | boolean> | null;
  help?: string | null;
  nargs?: string | number | null;
  /** Python class name of the action: `_StoreTrueAction`, `BooleanOptionalAction`, … */
  class?: string | null;
  metavar?: string | null;
  deprecated?: boolean;
}

export interface ArgparseDump {
  engine_id?: string;
  version?: string;
  source?: string;
  actions: ArgparseAction[];
}

/** argparse's sentinel for "leave the attribute unset" reaches us as this string. */
const SUPPRESS = '==SUPPRESS==';

const BOOL_ACTIONS = new Set([
  '_StoreTrueAction',
  '_StoreFalseAction',
  'BooleanOptionalAction',
  'StoreBoolean',
]);

export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/^-+/, '').replace(/_/g, '-');
}

/** Longest `--long-form` wins as the canonical name; everything else becomes an alias. */
function nameAndAliases(action: ArgparseAction): { name: string; aliases: string[] } | null {
  const options = action.option_strings.filter((o) => o !== '-h' && o !== '--help');
  if (options.length === 0) {
    // A positional (vLLM's `model_tag`): the destination is the only name it has.
    return action.dest ? { name: normalizeName(action.dest), aliases: [] } : null;
  }
  const long = options.filter((o) => o.startsWith('--'));
  const canonical = (long.length > 0 ? long : options).reduce((a, b) =>
    b.length > a.length ? b : a,
  );
  const aliases = options
    .filter((o) => o !== canonical)
    .map((o) => o.trim())
    .filter((o) => o !== '');
  return { name: normalizeName(canonical), aliases };
}

export function inferType(
  action: ArgparseAction,
  defaultValue: ArgValue,
  name: string,
): EngineParamType {
  if (BOOL_ACTIONS.has(action.class ?? '')) return 'bool';
  if (action.choices && action.choices.length > 0) return 'enum';

  const type = (action.type ?? '').toLowerCase();
  if (type.includes('bool')) return 'bool';
  if (type === 'int') return 'int';
  if (type === 'float') return 'float';
  if (type.includes('json') || type.includes('dict') || type.includes('loads')) return 'json';

  const nargs = action.nargs;
  if (nargs === '+' || nargs === '*' || typeof nargs === 'number') return 'list';

  if (typeof defaultValue === 'boolean') return 'bool';
  if (typeof defaultValue === 'number') return Number.isInteger(defaultValue) ? 'int' : 'float';
  if (Array.isArray(defaultValue)) return 'list';
  if (defaultValue !== null && typeof defaultValue === 'object') return 'json';

  if (/(^|-)(path|dir|directory|file)$/.test(name)) return 'path';
  return 'str';
}

function toArgValue(value: unknown): ArgValue {
  if (value === undefined || value === null) return null;
  if (value === SUPPRESS) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value as ArgValue;
  if (Array.isArray(value)) return value.map(toArgValue);
  if (t === 'object') {
    const out: Record<string, ArgValue> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toArgValue(inner);
    }
    return out;
  }
  // A Python object with no JSON representation (a class, a callable): unknowable default.
  return null;
}

/** Collapse whitespace: argparse help arrives wrapped at whatever the terminal was. */
function cleanHelp(help: string | null | undefined): string | null {
  if (!help) return null;
  const text = help.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

export function paramsFromArgparse(dump: ArgparseDump): EngineParam[] {
  const params: EngineParam[] = [];
  const seen = new Set<string>();

  for (const action of dump.actions ?? []) {
    if (action.class === '_HelpAction' || action.class === '_VersionAction') continue;
    const names = nameAndAliases(action);
    if (!names || names.name === '') continue;
    if (seen.has(names.name)) continue;
    seen.add(names.name);

    const defaultValue = toArgValue(action.default);
    const type = inferType(action, defaultValue, names.name);

    // `--no-foo` style negations declare `default: true` on the store_false action; keep
    // the value argparse would actually produce rather than inverting it here.
    const param: EngineParam = {
      name: names.name,
      type,
      default: defaultValue,
      ...(action.choices && action.choices.length > 0 ? { choices: action.choices } : {}),
      help: cleanHelp(action.help),
      ...(names.aliases.length > 0 ? { aliases: names.aliases } : {}),
      ...(action.deprecated === true ? { deprecated: true } : {}),
    };
    params.push(param);
  }

  params.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return params;
}
