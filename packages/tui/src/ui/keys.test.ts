import { describe, expect, it } from 'vitest';
import { isConfirm, isEnter, printableInput } from './keys.js';

describe('isEnter', () => {
  it('accepts the key Ink names `return`', () => {
    expect(isEnter('\r', { return: true })).toBe(true);
  });

  it('accepts a bare carriage return', () => {
    expect(isEnter('\r', {})).toBe(true);
  });

  it('accepts a line feed — the WSL/ConPTY spelling Ink never flags as return', () => {
    expect(isEnter('\n', { return: false })).toBe(true);
  });

  it('is not fooled by ordinary text', () => {
    expect(isEnter('j', {})).toBe(false);
    expect(isEnter('', {})).toBe(false);
  });
});

describe('isConfirm', () => {
  it('takes enter in either spelling, and an explicit yes', () => {
    expect(isConfirm('\n', {})).toBe(true);
    expect(isConfirm('\r', { return: true })).toBe(true);
    expect(isConfirm('y', {})).toBe(true);
    expect(isConfirm('Y', {})).toBe(true);
  });

  it('does not confirm on anything else', () => {
    expect(isConfirm('n', {})).toBe(false);
    expect(isConfirm('c', {})).toBe(false);
  });
});

describe('printableInput', () => {
  it('keeps text and rejects control characters', () => {
    expect(printableInput('q')).toBe(true);
    expect(printableInput('Qwen3')).toBe(true);
    expect(printableInput('\n')).toBe(false);
    expect(printableInput('\r')).toBe(false);
    expect(printableInput('')).toBe(false);
  });
});
