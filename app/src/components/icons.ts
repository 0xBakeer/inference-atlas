import { html, svg, type TemplateResult } from 'lit';

/** Tiny inline icon set — 24-box, 1.75 stroke, round caps. Styled by `svg.icon`. */
const P: Record<string, TemplateResult> = {
  search: svg`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  x: svg`<path d="M18 6 6 18M6 6l12 12"/>`,
  copy: svg`<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>`,
  check: svg`<path d="m5 12 5 5L20 7"/>`,
  external: svg`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`,
  chevronDown: svg`<path d="m6 9 6 6 6-6"/>`,
  chevronUp: svg`<path d="m18 15-6-6-6 6"/>`,
  chevronRight: svg`<path d="m9 6 6 6-6 6"/>`,
  chevronLeft: svg`<path d="m15 6-6 6 6 6"/>`,
  arrowUp: svg`<path d="M12 19V5M5 12l7-7 7 7"/>`,
  arrowDown: svg`<path d="M12 5v14M19 12l-7 7-7-7"/>`,
  arrowRight: svg`<path d="M5 12h14M13 5l7 7-7 7"/>`,
  sun: svg`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  moon: svg`<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>`,
  menu: svg`<path d="M4 7h16M4 12h16M4 17h16"/>`,
  flag: svg`<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>`,
  github: svg`<path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.7.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/>`,
  download: svg`<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>`,
  filter: svg`<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>`,
  plus: svg`<path d="M12 5v14M5 12h14"/>`,
  minus: svg`<path d="M5 12h14"/>`,
  info: svg`<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>`,
  warn: svg`<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>`,
  alert: svg`<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16h.01"/>`,
  grid: svg`<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>`,
  compare: svg`<path d="M9 3v18M15 3v18M3 9h6M15 9h6M3 15h6M15 15h6"/>`,
  link: svg`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  sort: svg`<path d="M8 4v16M5 17l3 3 3-3M16 20V4M13 7l3-3 3 3"/>`,
  play: svg`<path d="M7 4v16l13-8L7 4Z"/>`,
  refresh: svg`<path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4"/><path d="M20 4v7h-7M4 20v-7h7"/>`,
  eye: svg`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>`,
  terminal: svg`<path d="m5 7 5 5-5 5M12 17h7"/>`,
  file: svg`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>`,
  cpu: svg`<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>`,
  box: svg`<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="M3 7l9 5 9-5M12 12v10"/>`,
  users: svg`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14a5 5 0 0 1 5.5 5"/>`,
  sparkle: svg`<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>`,
  dot: svg`<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>`,
  zap: svg`<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>`,
  clock: svg`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  layers: svg`<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>`,
  gauge: svg`<path d="M5 19a9 9 0 1 1 14 0"/><path d="m12 14 4-5"/>`,
  command: svg`<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z"/>`,
  code: svg`<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/>`,
  table: svg`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>`,
  scatter: svg`<path d="M3 3v18h18"/><circle cx="9" cy="14" r="1.5"/><circle cx="13" cy="9" r="1.5"/><circle cx="17" cy="12" r="1.5"/><circle cx="11" cy="17" r="1.5"/>`,
  bulb: svg`<path d="M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 1-1.5 2-1.5 3h-5c0-1-.5-2-1.5-3Z"/>`,
};

export function icon(name: keyof typeof P | string, cls = ''): TemplateResult {
  const body = P[name] ?? P.dot!;
  return html`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(P);
