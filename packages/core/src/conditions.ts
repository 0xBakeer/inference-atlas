/**
 * Run conditions — were two honestly-recorded results measured under comparable conditions?
 *
 * A result can carry conditions in two places:
 *
 * 1. `conditions` (structured, authoritative when present): `dedicated` + `detail` are what
 *    the contributor ASSERTS about the box, `isolation_check` is what was MEASURED about
 *    isolation. The two are deliberately distinct and stay distinct here.
 * 2. The canonical prose vocabulary in `provenance.notes`: notes that open with
 *    `Box WAS dedicated: ...` or `Box was NOT dedicated: ...` and carry a labelled
 *    `Isolation check: ...` sentence. Results written before the structured field existed
 *    use only this form.
 *
 * Everything older than the canonical vocabulary resolves to `dedicated: null` — "not
 * recorded" is a true statement about those files, and the full prose stays one click away
 * on the run page. This module never guesses from free prose: a wrong derived flag would be
 * worse than an honest unknown.
 */
import type { Provenance, RunConditions } from './types.js';

export type ConditionsSource = 'structured' | 'notes' | 'none';

export interface ResolvedConditions {
  /** `null` means the run did not record conditions in any machine-readable form. */
  dedicated: boolean | null;
  /** The asserted conditions beyond the flag itself (what else was resident/reachable). */
  detail: string | null;
  /** What was MEASURED about isolation, as opposed to asserted. `null` = nothing measured. */
  isolationCheck: string | null;
  source: ConditionsSource;
}

/**
 * How comparable a set of runs is on the conditions axis.
 *
 * - `uniform`: every run recorded conditions and they agree.
 * - `mixed`: at least one dedicated box and one shared box — a known difference.
 * - `partial`: some runs recorded conditions, some did not.
 * - `unrecorded`: no run recorded conditions.
 */
export type Comparability = 'uniform' | 'mixed' | 'partial' | 'unrecorded';

const OPENER = /^box\s+was\s+(not\s+)?dedicated:\s*/i;
const ISOLATION_LABEL = /isolation\s+check:\s*/i;

/**
 * End of the sentence starting at `from`: the first `.` followed by whitespace and an
 * upper-case/paren/digit start, or the end of the text. Good enough for the canonical
 * vocabulary; a mid-sentence abbreviation may truncate the captured detail, never extend it.
 */
function sentenceEnd(text: string, from: number): number {
  const rest = text.slice(from);
  const m = /\.(?=\s+[A-Z0-9("'])/.exec(rest);
  return m ? from + m.index + 1 : text.length;
}

function parseNotes(notes: string): Omit<ResolvedConditions, 'source'> | null {
  const trimmed = notes.trim();
  const opener = OPENER.exec(trimmed);
  const iso = ISOLATION_LABEL.exec(trimmed);
  if (!opener && !iso) return null;

  let dedicated: boolean | null = null;
  let detail: string | null = null;
  if (opener) {
    dedicated = !opener[1];
    const start = opener[0].length;
    let end = sentenceEnd(trimmed, start);
    if (iso && iso.index > start && iso.index < end) end = iso.index;
    const text = trimmed.slice(start, end).trim().replace(/\.$/, '');
    detail = text || null;
  }

  let isolationCheck: string | null = null;
  if (iso) {
    const start = iso.index + iso[0].length;
    const end = sentenceEnd(trimmed, start);
    const text = trimmed.slice(start, end).trim().replace(/\.$/, '');
    isolationCheck = text || null;
  }

  return { dedicated, detail, isolationCheck };
}

/**
 * Resolve a run's conditions: the structured `conditions` field when present, else the
 * canonical prose vocabulary in `provenance.notes`, else unknown.
 */
export function resolveConditions(rec: {
  conditions?: RunConditions | null;
  provenance: Pick<Provenance, 'notes'>;
}): ResolvedConditions {
  if (rec.conditions) {
    return {
      dedicated: rec.conditions.dedicated,
      detail: rec.conditions.detail ?? null,
      isolationCheck: rec.conditions.isolation_check ?? null,
      source: 'structured',
    };
  }
  const notes = rec.provenance.notes;
  if (typeof notes === 'string' && notes) {
    const parsed = parseNotes(notes);
    if (parsed) return { ...parsed, source: 'notes' };
  }
  return { dedicated: null, detail: null, isolationCheck: null, source: 'none' };
}

/**
 * Classify a set of resolved conditions for a side-by-side comparison. Says how much the
 * conditions axis is known — never which run is better.
 */
export function conditionsComparability(list: ResolvedConditions[]): Comparability {
  const known = list.filter((c) => c.dedicated !== null);
  if (known.length === 0) return 'unrecorded';
  if (known.length < list.length) return 'partial';
  const dedicated = known.some((c) => c.dedicated === true);
  const shared = known.some((c) => c.dedicated === false);
  return dedicated && shared ? 'mixed' : 'uniform';
}
