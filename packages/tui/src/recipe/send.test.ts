/**
 * The escape hatches out of the terminal. WSL is the case worth pinning down: it looks
 * like linux to node, has no `xdg-open`, and its browser and clipboard are Windows-side.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { clipboardTools, osc52, urlOpeners } from './send.js';

const names = (rows: Array<[string, string[]]>): string[] => rows.map(([cmd]) => cmd);

const savedBrowser = process.env['BROWSER'];
afterEach(() => {
  if (savedBrowser === undefined) delete process.env['BROWSER'];
  else process.env['BROWSER'] = savedBrowser;
});

describe('urlOpeners', () => {
  const url = 'https://github.com/o/r/issues/new?template=new-hardware.yml&id=nvidia-rtx-4000';

  it('uses the one opener that exists on macOS', () => {
    expect(urlOpeners(url, 'darwin', false)).toEqual([['open', [url]]]);
  });

  it('reaches for the Windows side first on WSL, and still falls back to the linux tools', () => {
    delete process.env['BROWSER'];
    const tried = names(urlOpeners(url, 'linux', true));
    expect(tried.slice(0, 2)).toEqual(['wslview', 'powershell.exe']);
    expect(tried).toContain('xdg-open');
    expect(tried.indexOf('wslview')).toBeLessThan(tried.indexOf('xdg-open'));
  });

  it('passes the URL to PowerShell as one quoted argument, so `&` survives', () => {
    const ps = urlOpeners(url, 'linux', true).find(([cmd]) => cmd === 'powershell.exe')!;
    const command = ps[1].at(-1)!;
    expect(command).toBe(`Start-Process '${url}'`);
    expect(command).toContain('&id=');
  });

  it('does not offer the Windows tools on a plain linux box', () => {
    delete process.env['BROWSER'];
    const tried = names(urlOpeners(url, 'linux', false));
    expect(tried).not.toContain('wslview');
    expect(tried).not.toContain('powershell.exe');
    expect(tried[0]).toBe('xdg-open');
  });

  it('honours $BROWSER ahead of the generic openers', () => {
    process.env['BROWSER'] = 'firefox';
    const tried = names(urlOpeners(url, 'linux', false));
    expect(tried[0]).toBe('firefox');
  });
});

describe('clipboardTools', () => {
  it('uses clip.exe on WSL before the X/Wayland tools that are not installed there', () => {
    const tried = names(clipboardTools('linux', true));
    expect(tried[0]).toBe('clip.exe');
    expect(tried.indexOf('clip.exe')).toBeLessThan(tried.indexOf('xclip'));
  });

  it('stays with the display-server tools on a plain linux box', () => {
    expect(names(clipboardTools('linux', false))).toEqual(['wl-copy', 'xclip', 'xsel']);
  });

  it('uses pbcopy on macOS', () => {
    expect(names(clipboardTools('darwin', false))).toEqual(['pbcopy']);
  });
});

describe('osc52', () => {
  it('wraps base64 in the terminal clipboard sequence', () => {
    expect(osc52('hi')).toBe('\u001b]52;c;aGk=\u0007');
  });
});
