/**
 * Hash router. `#/results?engine=vllm&sort=-output_tok_s` → { segments: ['results'], query }.
 * Every view keeps its state in the query so that every page is deep-linkable.
 */
import { signal } from './signal.js';

export interface Route {
  /** `/results`, `/run/abc`, `/` */
  path: string;
  /** path split on `/`, decoded, no empties: [] for `/` */
  segments: string[];
  query: URLSearchParams;
  raw: string;
}

export function parseHash(hash: string): Route {
  let h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h.startsWith('/')) h = '/' + h;
  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const qs = qi >= 0 ? h.slice(qi + 1) : '';
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { path: path || '/', segments, query: new URLSearchParams(qs), raw: h };
}

export function buildHash(
  path: string,
  query?: Record<string, string | number | null | undefined> | URLSearchParams,
): string {
  const p = path.startsWith('/') ? path : '/' + path;
  let qs = '';
  if (query instanceof URLSearchParams) {
    qs = query.toString();
  } else if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === null || v === undefined || v === '') continue;
      sp.set(k, String(v));
    }
    qs = sp.toString();
  }
  return `#${p}${qs ? '?' + qs : ''}`;
}

/** Shorthand for templates: href('/run', id) → '#/run/<id>' */
export function href(...parts: Array<string | number>): string {
  return '#/' + parts.map((p) => encodeURIComponent(String(p))).join('/');
}

/**
 * `#/models/<owner>/<name>` — `model_id` is the Hugging Face repo id verbatim (SPEC §2,
 * decision #20). The slash is a real path segment: each segment is encoded on its own, the
 * id itself is never lowercased, kebab-cased or flattened.
 */
export function modelHref(id: string): string {
  return (
    '#/models/' +
    id
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/')
  );
}

/**
 * Model routes consume every segment after `models`, rejoined on '/'. Handles both
 * `#/models/google/gemma-4-E2B-it` (two segments) and a `%2F`-encoded single segment,
 * which `parseHash` decodes back into a slash.
 */
export function modelIdFromSegments(segments: string[]): string | null {
  return segments.length > 1 ? segments.slice(1).join('/') : null;
}

export const route = signal<Route>(parseHash(typeof location !== 'undefined' ? location.hash : ''));

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.value = parseHash(location.hash);
  });
}

export function navigate(hash: string): void {
  if (location.hash === hash) return;
  location.hash = hash;
}

/**
 * Patch the current query without adding a history entry. Used by filters, sorts, axis
 * pickers: the URL always reflects the view, but Back still leaves the page.
 */
export function setQuery(
  patch: Record<string, string | number | boolean | null | undefined>,
  opts: { push?: boolean; path?: string } = {},
): void {
  const cur = route.value;
  const q = new URLSearchParams(cur.query);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '' || v === false) q.delete(k);
    else q.set(k, v === true ? '1' : String(v));
  }
  const hash = buildHash(opts.path ?? cur.path, q);
  if (hash === location.hash) return;
  if (opts.push) {
    location.hash = hash;
  } else {
    history.replaceState(null, '', location.pathname + location.search + hash);
    route.value = parseHash(hash);
  }
}

export function qget(q: URLSearchParams, key: string): string | null {
  const v = q.get(key);
  return v === null || v === '' ? null : v;
}
export function qlist(q: URLSearchParams, key: string): string[] {
  const v = q.get(key);
  return v ? v.split(',').filter(Boolean) : [];
}
export function qnum(q: URLSearchParams, key: string): number | null {
  const v = q.get(key);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
