import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, withTargetSection } from './config.js';

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

describe('target', () => {
  it('reads the selected hardware and count', () => {
    const c = parseConfig('[target]\nhardware = "nvidia-rtx-6000-ada"\ncount = 3');
    expect(c.target).toEqual({ hardware: 'nvidia-rtx-6000-ada', count: 3 });
  });

  it('defaults to detection with a count of one', () => {
    expect(parseConfig('').target).toEqual({ hardware: null, count: 1 });
  });

  it('floors a nonsense count at one', () => {
    expect(parseConfig('[target]\nhardware = "x"\ncount = 0').target.count).toBe(1);
  });
});

describe('withTargetSection', () => {
  it('appends the section to a config that has none', () => {
    const out = withTargetSection('[ui]\ncolor = "auto"\n', 'nvidia-rtx-4090', 2);
    expect(out).toContain('[ui]');
    expect(out).toContain('[target]\nhardware = "nvidia-rtx-4090"\ncount = 2');
  });

  it('replaces an existing section and keeps every comment around it', () => {
    const before = [
      '# my notes',
      '[ui]',
      'color = "mono"',
      '',
      '# the box',
      '[target]',
      'hardware = "old-gpu"',
      'count = 1',
      '',
      '[recipes]',
      'dir = "~/x"',
      '',
    ].join('\n');
    const out = withTargetSection(before, 'nvidia-h100-80gb', 8);
    expect(out).toContain('# my notes');
    expect(out).toContain('# the box');
    expect(out).toContain('[recipes]');
    expect(out).toContain('hardware = "nvidia-h100-80gb"');
    expect(out).toContain('count = 8');
    expect(out).not.toContain('old-gpu');
    // and it is still valid TOML that round-trips
    expect(parseConfig(out).target).toEqual({ hardware: 'nvidia-h100-80gb', count: 8 });
    expect(parseConfig(out).recipes.dir).toBe('~/x');
  });

  it('handles an empty file', () => {
    expect(parseConfig(withTargetSection('', 'x', 1)).target).toEqual({ hardware: 'x', count: 1 });
  });
});
