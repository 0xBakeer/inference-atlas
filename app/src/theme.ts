import { signal } from './signal.js';

export type Theme = 'light' | 'dark';

function current(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const theme = signal<Theme>(typeof document !== 'undefined' ? current() : 'light');

export function setTheme(t: Theme, persist = true): void {
  document.documentElement.dataset.theme = t;
  if (persist) {
    try {
      localStorage.setItem('atlas.theme', t);
    } catch {
      /* private mode */
    }
  }
  theme.value = t;
}

export function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

/** Follow the OS when the user has not chosen explicitly. */
if (typeof matchMedia !== 'undefined') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('atlas.theme');
    } catch {
      /* ignore */
    }
    if (stored !== 'light' && stored !== 'dark') setTheme(e.matches ? 'dark' : 'light', false);
  });
}
