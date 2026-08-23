/**
 * Parsing a GitHub issue-form body.
 *
 * GitHub renders an issue form as Markdown: each field becomes `### <label>` followed by a
 * blank line and the value, and an empty optional field becomes the literal string
 * `_No response_`. There is no structured payload in the webhook, so this is the contract —
 * which means the labels in `.github/ISSUE_TEMPLATE/submit-result.yml` are load-bearing.
 *
 * Lookup is forgiving on purpose: labels are matched after lowercasing and stripping
 * everything that is not a letter or a digit, and each field accepts a few aliases. Somebody
 * fixing a typo in a form label should not break the pipeline that reads it.
 */

const NO_RESPONSE = /^_?no response_?$/i;

export type IssueFormFields = Map<string, string>;

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** `### Label` sections → normalized label → trimmed value (empty fields dropped). */
export function parseIssueForm(body: string): IssueFormFields {
  const fields: IssueFormFields = new Map();
  const text = body.replace(/\r\n/g, '\n');
  const pattern = /^###[ \t]+(.+?)[ \t]*$/gm;

  const headings: Array<{ label: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    headings.push({ label: match[1]!, start: match.index, end: pattern.lastIndex });
  }

  for (const [i, heading] of headings.entries()) {
    const next = headings[i + 1];
    const value = text.slice(heading.end, next ? next.start : text.length).trim();
    if (value === '' || NO_RESPONSE.test(value)) continue;
    fields.set(normalizeLabel(heading.label), value);
  }
  return fields;
}

/** First alias that is present. Aliases are written as they appear in the form. */
export function field(fields: IssueFormFields, ...aliases: string[]): string | null {
  for (const alias of aliases) {
    const value = fields.get(normalizeLabel(alias));
    if (value !== undefined) return value;
  }
  return null;
}

/**
 * A JSON value out of a form field.
 *
 * Contributors paste JSON out of a terminal, so it arrives wrapped in a fenced code block
 * about half the time. Strip the fence before parsing rather than telling them off for it.
 */
export function jsonField(fields: IssueFormFields, ...aliases: string[]): unknown {
  const raw = field(fields, ...aliases);
  if (raw === null) return undefined;
  const stripped = raw
    .replace(/^```[a-zA-Z]*\n/, '')
    .replace(/\n```$/, '')
    .trim();
  if (stripped === '') return undefined;
  return JSON.parse(stripped) as unknown;
}
