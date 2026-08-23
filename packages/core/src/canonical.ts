import { sha256Hex } from './hash.js';
import type { ArgValue, Args } from './types.js';

/**
 * Config fingerprinting — SPEC §3.
 *
 * Two people who ran the same setup must produce the same `config_id`, even if they wrote
 * the flags in a different order, used an alias, wrote `0.90` instead of `0.9` or passed a
 * boolean as the string `"True"`. This module is the reference implementation;
 * `bench/atlas_bench/canonical.py` re-implements it and both are tested against
 * `schemas/fixtures/fingerprint-vectors.json`.
 *
 * The function is pure: the caller passes the engine version's params and the engine's
 * drop_params, so nothing here touches the filesystem or the network.
 */

/** The subset of an EngineParam that canonicalization needs. */
export interface CanonicalParam {
  name: string;
  /** Value the engine uses when the flag is absent; anything equal to it is dropped. */
  default?: ArgValue;
  aliases?: string[];
  /** Optional; when absent the type is inferred from `default`. */
  type?: string;
}

/**
 * Input shape is intentionally snake_case: these objects are exactly the `input` blocks of
 * the golden vectors, so the fixtures can be fed to TypeScript and Python unchanged.
 */
export interface CanonicalizeInput {
  engine_id: string;
  /** null / unknown version → no defaults are dropped (the validator warns separately). */
  engine_version?: string | null;
  args: Args;
  quant_id: string;
  dtype?: string | null;
  /** The engine version's params. `null`/absent means "unknown engine version". */
  params?: CanonicalParam[] | null;
  /** engine meta `drop_params`: paths, ports, credentials — things that cannot change a number. */
  drop_params?: string[] | null;
  /** engine meta `param_aliases`, merged under the per-param aliases. */
  param_aliases?: Record<string, string> | null;
}

export interface CanonicalizeResult {
  /** `k=v;k=v`, sorted, including the `@quant` / `@dtype` pseudo-params. */
  canonical: string;
  /** `sha256(canonical)[:16]` */
  configId: string;
  /**
   * Exactly the pairs that make up `canonical`, pseudo-params included, so that
   * `canonical` is reconstructible from `resolved` and the UI can show what survived.
   */
  resolved: Record<string, string>;
}

/** lowercase, trim, strip leading dashes, `_` → `-`. Applied to every flag name and alias. */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/^-+/, '').replace(/_/g, '-');
}

/**
 * Shortest round-trip decimal with at most 6 decimal places.
 * `0.90 → "0.9"`, `8192 → "8192"`, `0.8800000000000001 → "0.88"`.
 */
export function normalizeNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const rounded = Math.round(n * 1e6) / 1e6;
  return String(rounded);
}

const TRUEISH = new Set(['true', 'yes', 'on', '1']);
const FALSEISH = new Set(['false', 'no', 'off', '0']);

/** JSON with object keys sorted recursively and arrays of scalars sorted. */
function stableJson(value: ArgValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const parts = value.map((v) => stableJson(v));
    parts.sort(byteCompare);
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(byteCompare);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k] as ArgValue)}`).join(',')}}`;
  }
  if (typeof value === 'number') return normalizeNumber(value);
  return JSON.stringify(value);
}

/** Byte order, i.e. plain UTF-16 code-unit order. `Array#sort` default is locale-free already, but be explicit. */
export function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inferType(def: ArgValue | undefined): string | undefined {
  if (def === undefined || def === null) return undefined;
  if (typeof def === 'boolean') return 'bool';
  if (typeof def === 'number') return Number.isInteger(def) ? 'int' : 'float';
  if (Array.isArray(def)) return 'list';
  if (typeof def === 'object') return 'json';
  return 'str';
}

/**
 * Normalize one value to its canonical string.
 *
 * `type` is the declared param type when the engine version is known; without it the
 * value's own JavaScript type decides, which is why `--enable-prefix-caching 1` only
 * folds to `true` for engines whose version file says the flag is a bool.
 */
export function normalizeValue(value: ArgValue, type?: string): string {
  if (value === null || value === undefined) return '';

  if (type === 'bool') {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return value !== 0 ? 'true' : 'false';
    const s = String(value).trim().toLowerCase();
    if (TRUEISH.has(s)) return 'true';
    if (FALSEISH.has(s)) return 'false';
    return s;
  }

  if (type === 'int' || type === 'float') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isNaN(n)) return normalizeNumber(n);
    return String(value).trim();
  }

  if (type === 'json' || type === 'list') {
    if (typeof value === 'string') {
      const parsed = tryParseJson(value.trim());
      if (parsed !== undefined) return stableJson(parsed);
      return value.trim();
    }
    return stableJson(value);
  }

  // Unknown / string-typed param: fall back to the value's own shape.
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return normalizeNumber(value);
  if (typeof value === 'object') return stableJson(value);

  const s = value.trim();
  // A string that is JSON is JSON, whatever the version file thinks: this is how a
  // `--speculative-config '{...}'` from a shell command line reaches us.
  const parsed = tryParseJson(s);
  if (parsed !== undefined) return stableJson(parsed);
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false') return lower;
  return s;
}

function tryParseJson(s: string): ArgValue | undefined {
  if (!(s.startsWith('{') || s.startsWith('['))) return undefined;
  try {
    return JSON.parse(s) as ArgValue;
  } catch {
    return undefined;
  }
}

/**
 * SPEC §3 steps 1–6.
 *
 * 1. resolve aliases, 2. drop values equal to the version default, 3. normalize values and
 * remove `drop_params`, 4. prepend `@quant` / `@dtype`, 5. sort, 6. hash.
 *
 * Steps 2 and 3 are fused: the default is normalized with the same rules as the value and
 * the two canonical *strings* are compared, so `"0.90"` matches a default of `0.9` and
 * `"True"` matches a default of `true`.
 */
export function canonicalizeArgs(input: CanonicalizeInput): CanonicalizeResult {
  const params = input.params ?? null;
  const byName = new Map<string, CanonicalParam>();
  const aliasMap = new Map<string, string>();

  for (const [alias, target] of Object.entries(input.param_aliases ?? {})) {
    aliasMap.set(normalizeKey(alias), normalizeKey(target));
  }
  for (const p of params ?? []) {
    const name = normalizeKey(p.name);
    byName.set(name, p);
    for (const alias of p.aliases ?? []) aliasMap.set(normalizeKey(alias), name);
  }

  const dropped = new Set((input.drop_params ?? []).map(normalizeKey));

  const resolved: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input.args ?? {})) {
    const key = aliasMap.get(normalizeKey(rawKey)) ?? normalizeKey(rawKey);
    if (!key) continue;
    if (dropped.has(key)) continue;
    // A null value means "flag not passed"; it must not change the fingerprint.
    if (rawValue === null || rawValue === undefined) continue;

    const param = byName.get(key);
    const type = param?.type ?? inferType(param?.default);
    const value = normalizeValue(rawValue, type);

    // Unknown engine version → params is null → nothing is a known default → drop nothing.
    if (param && param.default !== undefined) {
      const defaultValue = normalizeValue(param.default as ArgValue, type);
      if (param.default !== null && value === defaultValue) continue;
    }

    resolved[key] = value;
  }

  resolved['@quant'] = input.quant_id.trim().toLowerCase();
  resolved['@dtype'] = (input.dtype ?? 'auto').trim().toLowerCase() || 'auto';

  const canonical = Object.keys(resolved)
    .sort(byteCompare)
    .map((k) => `${k}=${resolved[k]}`)
    .join(';');

  return { canonical, configId: sha256Hex(canonical).slice(0, 16), resolved };
}
