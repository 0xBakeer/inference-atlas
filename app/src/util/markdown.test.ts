import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('renders headings, code, lists, tables and escapes html', () => {
    const md = [
      '# Title',
      '',
      'Some **bold** and `code` <script>x</script>',
      '',
      '```bash',
      'echo "<hi>"',
      '```',
      '',
      '- one',
      '- two',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '> note',
    ].join('\n');
    const out = renderMarkdown(md);
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code>code</code>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<pre data-lang="bash"><code>echo &quot;&lt;hi&gt;&quot;</code></pre>');
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('<th>a</th>');
    expect(out).toContain('<td>2</td>');
    expect(out).toContain('<blockquote>');
  });
  it('omits empty table headers and links safely', () => {
    const out = renderMarkdown(
      '| | |\n|---|---|\n| k | v |\n\n[repo](https://example.com) [bad](javascript:alert(1))',
    );
    expect(out).not.toContain('<thead>');
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener">repo</a>');
    expect(out).not.toContain('href="javascript');
  });
});
