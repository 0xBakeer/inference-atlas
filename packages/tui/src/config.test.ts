import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig } from './config.js';

describe('parseConfig', () => {
  it('returns defaults for an empty file', () => {
    expect(parseConfig('')).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults for broken TOML instead of throwing', () => {
    expect(parseConfig('[data\nurl=')).toEqual(DEFAULT_CONFIG);
  });

  it('reads overrides and keeps defaults for the rest', () => {
    const c = parseConfig(
      ['[data]', 'repo = "~/atlas"', 'refresh_minutes = 0', '[ui]', 'color = "mono"'].join('\n'),
    );
    expect(c.data.repo).toBe('~/atlas');
    expect(c.data.refreshMinutes).toBe(0);
    expect(c.data.url).toBe(DEFAULT_CONFIG.data.url);
    expect(c.ui.color).toBe('mono');
  });

  it('merges custom agent targets with defaults', () => {
    const c = parseConfig(
      ['[agents.pi]', 'command = \'ssh pi "claude $(cat {recipe})"\'', 'mode = "run"'].join('\n'),
    );
    expect(c.agents['pi']).toEqual({ command: 'ssh pi "claude $(cat {recipe})"', mode: 'run' });
    expect(c.agents['claude']).toBeDefined();
  });

  it('rejects an invalid color value back to auto', () => {
    expect(parseConfig('[ui]\ncolor = "neon"').ui.color).toBe('auto');
  });
});

describe('boxes', () => {
  it('reads ssh boxes and hardware-pinned boxes', () => {
    const c = parseConfig(
      ['[boxes.dgx]', 'ssh = "spark"', '[boxes.rented]', 'hardware = "nvidia-rtx-4090"'].join('\n'),
    );
    expect(c.boxes['dgx']).toEqual({ ssh: 'spark', hardware: null });
    expect(c.boxes['rented']).toEqual({ ssh: null, hardware: 'nvidia-rtx-4090' });
  });

  it('skips a box that declares neither ssh nor hardware', () => {
    expect(parseConfig('[boxes.empty]\nnote = "nothing"').boxes['empty']).toBeUndefined();
  });

  it('defaults to no boxes', () => {
    expect(parseConfig('').boxes).toEqual({});
  });
});
