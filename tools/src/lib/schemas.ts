/**
 * ajv (JSON Schema draft 2020-12) wired to the repository layout.
 *
 * Which schema a file is checked against is decided by *where it lives*, not by anything
 * inside it: a result cannot escape the result schema by claiming to be a workload. Files
 * under a registry directory that match no rule are an error of their own
 * (`unmapped-file`) — a stray JSON file in `results/` is always a mistake.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

export type SchemaName =
  | 'hardware'
  | 'engine'
  | 'engine-overlay'
  | 'engine-version'
  | 'model'
  | 'quant'
  | 'workload'
  | 'dataset'
  | 'result'
  | 'site'
  | 'identities';

const SCHEMA_BASE = 'https://inference-atlas.dev/schemas';

/** Files that live under a registry directory but are data of their own kind. */
const EXEMPT = new Set(['site/wanted-requests.json']);

const RULES: Array<{ pattern: RegExp; name: SchemaName }> = [
  { pattern: /^hardware\/[^/]+\.json$/, name: 'hardware' },
  { pattern: /^engines\/[^/]+\/meta\.json$/, name: 'engine' },
  { pattern: /^engines\/[^/]+\/overlay\.json$/, name: 'engine-overlay' },
  { pattern: /^engines\/[^/]+\/versions\/[^/]+\.json$/, name: 'engine-version' },
  // A model id is a Hugging Face repo id, so its directory is two levels deep (SPEC §2)
  // and every path that carries one — model, quant, result — has that extra segment.
  { pattern: /^models\/[^/]+\/[^/]+\/model\.json$/, name: 'model' },
  { pattern: /^models\/[^/]+\/[^/]+\/quants\/[^/]+\.json$/, name: 'quant' },
  { pattern: /^workloads\/[^/]+\.json$/, name: 'workload' },
  { pattern: /^datasets\/[^/]+\/dataset\.json$/, name: 'dataset' },
  { pattern: /^results\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+\.json$/, name: 'result' },
  { pattern: /^site\/config\.json$/, name: 'site' },
  { pattern: /^site\/identities\.json$/, name: 'identities' },
];

/** Directories whose unmapped `.json` files are an error rather than none of our business. */
const OWNED_DIRS = ['hardware/', 'engines/', 'models/', 'workloads/', 'results/', 'site/'];

export type SchemaVerdict =
  { kind: 'schema'; name: SchemaName } | { kind: 'unmapped' } | { kind: 'ignored' };

export function schemaFor(relPath: string): SchemaVerdict {
  const path = relPath.split('\\').join('/');
  for (const rule of RULES) {
    if (rule.pattern.test(path)) return { kind: 'schema', name: rule.name };
  }
  if (EXEMPT.has(path)) return { kind: 'ignored' };
  // `datasets/<id>/*.json` other than dataset.json is dataset payload (prefixes, items).
  if (path.startsWith('datasets/')) return { kind: 'ignored' };
  if (OWNED_DIRS.some((dir) => path.startsWith(dir))) return { kind: 'unmapped' };
  return { kind: 'ignored' };
}

export class Schemas {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<SchemaName, ValidateFunction>();

  constructor(schemaDir: string) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    // ajv-formats ships CommonJS; the callable lands on `.default` under ESM resolution.
    const applyFormats =
      (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
    applyFormats(this.ajv);
    for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
      this.ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, file), 'utf8')) as object);
    }
  }

  private validator(name: SchemaName): ValidateFunction {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const fn = this.ajv.getSchema(`${SCHEMA_BASE}/${name}.schema.json`);
    if (!fn) throw new Error(`no schema registered for "${name}"`);
    this.cache.set(name, fn);
    return fn;
  }

  /** Returns the ajv errors, formatted one per message; empty means valid. */
  check(name: SchemaName, data: unknown): string[] {
    const fn = this.validator(name);
    if (fn(data)) return [];
    return (fn.errors ?? []).map(formatError);
  }
}

function formatError(error: ErrorObject): string {
  const where = error.instancePath || '/';
  const params = Object.entries(error.params ?? {})
    .filter(([key]) => key !== 'type')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  return `${where} ${error.message}${params ? ` (${params})` : ''}`;
}
