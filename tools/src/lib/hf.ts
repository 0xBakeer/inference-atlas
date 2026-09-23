/**
 * Registry records that point at Hugging Face must point at something that is there
 * (SPEC decision 29).
 *
 * A model id is the Hugging Face repo id verbatim (SPEC §2), and a quant record names the
 * repo and the files a run downloads. Neither can be checked offline, so this is the one
 * check that talks to the network, and it only runs with `--check-hf` (CI passes it for the
 * registry files a pull request adds or changes).
 *
 * What the Hub answers, without a token:
 *
 * - 200 with `siblings`: the repo exists; gated repos answer this way too.
 * - 307 to another id: the repo was renamed, or the case is wrong. The id must be the
 *   current one, spelled as the Hub spells it.
 * - 401 or 404: no such public repo. The Hub does not distinguish missing from private.
 *
 * Anything else (5xx, timeouts, no network) is a warning: an outage on the Hub is not a
 * reason to fail somebody's pull request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Issue } from './report.js';

const HUB = 'https://huggingface.co/api/models/';
const MODEL_FILE = /^models\/[^/]+\/[^/]+\/model\.json$/;
const QUANT_FILE = /^models\/[^/]+\/[^/]+\/quants\/[^/]+\.json$/;

export type Fetch = (
  url: string,
  init: { redirect: 'manual'; headers: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

type Lookup =
  | { kind: 'found'; id: string; files: Set<string> }
  | { kind: 'moved'; to: string }
  | { kind: 'missing' }
  | { kind: 'unreachable'; detail: string };

async function lookup(id: string, fetchFn: Fetch, token: string | null): Promise<Lookup> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchFn(`${HUB}${id}`, { redirect: 'manual', headers });
  } catch (error) {
    return { kind: 'unreachable', detail: String((error as Error)?.message ?? error) };
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '';
    const to = decodeURIComponent(
      location.replace(/^.*\/api\/models\//, '').replace(/[?#].*$/, ''),
    );
    return to ? { kind: 'moved', to } : { kind: 'unreachable', detail: `HTTP ${response.status}` };
  }
  if (response.status === 401 || response.status === 404) return { kind: 'missing' };
  if (response.status !== 200) return { kind: 'unreachable', detail: `HTTP ${response.status}` };
  try {
    const body = (await response.json()) as {
      id?: string;
      siblings?: Array<{ rfilename?: string }>;
    };
    return {
      kind: 'found',
      id: body.id ?? id,
      files: new Set((body.siblings ?? []).map((s) => s.rfilename ?? '').filter(Boolean)),
    };
  } catch (error) {
    return { kind: 'unreachable', detail: String((error as Error)?.message ?? error) };
  }
}

function readJson(root: string, path: string): Record<string, unknown> | null {
  const full = join(root, path);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface HfCheckOptions {
  root: string;
  /** Repository-relative registry files to check; anything that is not a model or quant file is ignored. */
  files: string[];
  fetchFn?: Fetch;
  token?: string | null;
}

export async function checkHuggingFace(options: HfCheckOptions): Promise<Issue[]> {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as Fetch);
  const token = options.token ?? null;
  const issues: Issue[] = [];
  const cache = new Map<string, Promise<Lookup>>();
  const get = (id: string) => {
    let hit = cache.get(id);
    if (!hit) {
      hit = lookup(id, fetchFn, token);
      cache.set(id, hit);
    }
    return hit;
  };

  for (const file of options.files) {
    const isModel = MODEL_FILE.test(file);
    const isQuant = QUANT_FILE.test(file);
    if (!isModel && !isQuant) continue;
    const record = readJson(options.root, file);
    if (!record) continue;
    const hfId = typeof record.hf_id === 'string' ? record.hf_id : null;
    if (!hfId) continue;
    const path = { path: 'hf_id' };

    const found = await get(hfId);
    if (found.kind === 'unreachable') {
      issues.push({
        level: 'warn',
        code: 'hf-unreachable',
        file,
        message: `could not check ${hfId} on Hugging Face (${found.detail})`,
        ...path,
      });
      continue;
    }
    if (found.kind === 'missing') {
      issues.push({
        level: 'error',
        code: 'hf-repo-missing',
        file,
        message: `${hfId} is not a public repository on Hugging Face; use the exact repo the weights were downloaded from`,
        ...path,
      });
      continue;
    }
    if (found.kind === 'moved' || found.id !== hfId) {
      const current = found.kind === 'moved' ? found.to : found.id;
      issues.push({
        level: 'error',
        code: 'hf-repo-renamed',
        file,
        message: `Hugging Face serves ${hfId} as ${current}; ids are the current repo id, spelled as the Hub spells it`,
        ...path,
      });
      continue;
    }
    if (isQuant && Array.isArray(record.files)) {
      const missing = (record.files as unknown[])
        .filter((f): f is string => typeof f === 'string')
        .filter((f) => !found.files.has(f));
      if (missing.length > 0) {
        issues.push({
          level: 'error',
          code: 'hf-file-missing',
          file,
          message: `${hfId} has no file ${missing.map((f) => `"${f}"`).join(', ')}; name the files as they are in the repo`,
          path: 'files',
        });
      }
    }
  }
  return issues;
}
