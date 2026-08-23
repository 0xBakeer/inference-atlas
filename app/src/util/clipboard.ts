import { signal } from '../signal.js';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'error';
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 2200): void {
  const t: Toast = { id: nextId++, text, kind };
  toasts.value = [...toasts.value, t];
  setTimeout(() => {
    toasts.value = toasts.value.filter((x) => x.id !== t.id);
  }, ms);
}

export async function copyText(text: string, label = 'Copied'): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(label, 'ok');
    return true;
  } catch {
    toast('Could not copy — select the text and copy it manually', 'error', 3500);
    return false;
  }
}

export function download(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
