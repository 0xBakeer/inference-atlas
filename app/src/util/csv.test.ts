import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.js';

describe('toCsv', () => {
  it('quotes commas and quotes, leaves nulls empty', () => {
    const csv = toCsv(
      [{ a: 'x,y', b: 'say "hi"', c: null }],
      [
        { key: 'a', label: 'A', value: (r) => r.a },
        { key: 'b', label: 'B', value: (r) => r.b },
        { key: 'c', label: 'C', value: (r) => r.c },
      ],
    );
    expect(csv).toBe('A,B,C\n"x,y","say ""hi""",\n');
  });
});
