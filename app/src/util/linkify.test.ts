import { describe, expect, it } from 'vitest';
import { linkifyPieces } from './linkify.js';

describe('linkify', () => {
  it('links URLs and strips trailing punctuation', () => {
    expect(linkifyPieces('see https://example.com/a/b. Then more')).toEqual([
      'see ',
      { href: 'https://example.com/a/b', text: 'https://example.com/a/b' },
      '. Then more',
    ]);
  });

  it('links GitHub issue references', () => {
    expect(linkifyPieces('parser (sgl-project/sglang#25600).')).toEqual([
      'parser (',
      {
        href: 'https://github.com/sgl-project/sglang/issues/25600',
        text: 'sgl-project/sglang#25600',
      },
      ').',
    ]);
  });

  it('links Hugging Face ids only when the registry knows them', () => {
    const known = new Set(['openbmb/MiniCPM5-2B', 'openbmb/MiniCPM5-2B-DSpark']);
    expect(
      linkifyPieces(
        'Weights: openbmb/MiniCPM5-2B at 12a380, drafter openbmb/MiniCPM5-2B-DSpark; docs/deployment/sglang.md',
        known,
      ),
    ).toEqual([
      'Weights: ',
      { href: 'https://huggingface.co/openbmb/MiniCPM5-2B', text: 'openbmb/MiniCPM5-2B' },
      ' at 12a380, drafter ',
      {
        href: 'https://huggingface.co/openbmb/MiniCPM5-2B-DSpark',
        text: 'openbmb/MiniCPM5-2B-DSpark',
      },
      '; docs/deployment/sglang.md',
    ]);
  });

  it('does not double-link an id inside a URL', () => {
    const known = new Set(['Qwen/Qwen3.8-27B']);
    expect(linkifyPieces('https://huggingface.co/Qwen/Qwen3.8-27B', known)).toEqual([
      {
        href: 'https://huggingface.co/Qwen/Qwen3.8-27B',
        text: 'https://huggingface.co/Qwen/Qwen3.8-27B',
      },
    ]);
  });
});
