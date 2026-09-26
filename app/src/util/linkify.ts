/**
 * Turn the plain text of contributor notes and gotchas into text with links: URLs, GitHub
 * `owner/repo#123` references, and Hugging Face repo ids the registry knows about (a model's
 * or a quantization's `hf_id`). Anything else stays text — an arbitrary `a/b` is not a link.
 */
import { html, type TemplateResult } from 'lit';

export type LinkifyPiece = string | { href: string; text: string };

const URL_RE = /https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?)]/g;
const GH_REF_RE = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
const HF_ID_RE = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?=[\s,;:)]|\.$|$|@)/g;

/**
 * Split `text` into plain strings and `{ href, text }` links. `known` is the set of Hugging
 * Face repo ids that may be linked; pass the registry's ids so only real repos become links.
 */
export function linkifyPieces(
  text: string,
  known: ReadonlySet<string> = new Set(),
): LinkifyPiece[] {
  const out: LinkifyPiece[] = [];
  type Hit = { start: number; end: number; href: string; text: string };
  const hits: Hit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    hits.push({ start: m.index!, end: m.index! + m[0].length, href: m[0], text: m[0] });
  }
  const covered = (s: number, e: number) => hits.some((h) => s < h.end && e > h.start);
  for (const m of text.matchAll(GH_REF_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    if (covered(s, e)) continue;
    hits.push({
      start: s,
      end: e,
      href: `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}`,
      text: m[0],
    });
  }
  if (known.size) {
    for (const m of text.matchAll(HF_ID_RE)) {
      const id = m[1]!;
      const s = m.index!;
      const e = s + id.length;
      if (!known.has(id) || covered(s, e)) continue;
      hits.push({ start: s, end: e, href: `https://huggingface.co/${id}`, text: id });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  let pos = 0;
  for (const h of hits) {
    if (h.start < pos) continue;
    if (h.start > pos) out.push(text.slice(pos, h.start));
    out.push({ href: h.href, text: h.text });
    pos = h.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/** Render the pieces as a lit template; links open in a new tab. */
export function linkify(text: string, known?: ReadonlySet<string>): TemplateResult {
  return html`${linkifyPieces(text, known).map((p) =>
    typeof p === 'string'
      ? p
      : html`<a href=${p.href} target="_blank" rel="noopener">${p.text}</a>`,
  )}`;
}
