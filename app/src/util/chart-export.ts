/**
 * Export a live uPlot chart as a PNG or an SVG file, with a title above and a credit line
 * below: who to attribute the picture to, the site, the data licence and the date. Data here
 * is CC-BY-4.0, so a chart that leaves the page should carry its attribution with it.
 *
 * PNG copies the chart's own canvas. SVG is drawn again from the plot's data and scales, so
 * the lines, points, bars, grid and tick labels are real vector shapes.
 */
import type uPlot from 'uplot';

export interface ExportOpts {
  title: string;
  subtitle?: string;
  credit: string;
  site: string;
  licence?: string;
  /** Colours resolved from the page theme. */
  colors: { bg: string; ink: string; muted: string; line: string };
}

const PAD = 20;
const TITLE_H = (o: ExportOpts) => (o.title ? 30 : 0) + (o.subtitle ? 18 : 0);
const FOOT_H = 28;
const FONT = 'system-ui, sans-serif';
const MONO = 'ui-monospace, SF Mono, Menlo, monospace';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function creditLine(o: ExportOpts): string {
  return [o.credit, o.site, o.licence ?? 'CC-BY-4.0', today()].filter(Boolean).join(' · ');
}

export function exportFilename(title: string, ext: 'png' | 'svg'): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'chart';
  return `${slug}-${today()}.${ext}`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ series helpers */

type SeriesInfo = {
  idx: number;
  label: string;
  stroke: string;
  fill: string | null;
  width: number;
  points: boolean;
  bars: boolean;
  scale: string;
};

function resolve(v: unknown, u: uPlot, i: number): string | null {
  if (typeof v === 'function') {
    const r = (v as (u: uPlot, i: number) => unknown)(u, i);
    return typeof r === 'string' ? r : null;
  }
  return typeof v === 'string' ? v : null;
}

function seriesInfo(u: uPlot): SeriesInfo[] {
  const out: SeriesInfo[] = [];
  for (let i = 1; i < u.series.length; i++) {
    const s = u.series[i]!;
    if (s.show === false) continue;
    const stroke = resolve(s.stroke, u, i) ?? '#1b4fd6';
    const fill = resolve(s.fill, u, i);
    // Bar series carry a custom path builder; lines use uPlot's default (undefined).
    const bars = typeof s.paths === 'function';
    out.push({
      idx: i,
      label: typeof s.label === 'string' ? s.label : `series ${i}`,
      stroke,
      fill: fill && fill !== 'transparent' ? fill : null,
      width: typeof s.width === 'number' ? s.width : 1.5,
      points: !!(s.points && s.points.show !== false && typeof s.points.show !== 'function'),
      bars,
      scale: s.scale ?? 'y',
    });
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------------ PNG */

export function exportPng(u: uPlot, o: ExportOpts): void {
  const src = u.ctx.canvas;
  const dpr = Math.max(1, src.width / Math.max(1, u.width));
  const th = TITLE_H(o);
  // Legend lines drawn by hand — uPlot's legend is DOM, not canvas.
  const series = seriesInfo(u);
  const legendH = series.length > 1 ? 22 : 0;
  const W = u.width + PAD * 2;
  const H = th + u.height + legendH + FOOT_H + PAD * 2;
  const c = document.createElement('canvas');
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = o.colors.bg;
  ctx.fillRect(0, 0, W, H);
  let y = PAD;
  if (o.title) {
    ctx.fillStyle = o.colors.ink;
    ctx.font = `600 16px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.fillText(o.title, PAD, y);
    y += 24;
  }
  if (o.subtitle) {
    ctx.fillStyle = o.colors.muted;
    ctx.font = `12px ${FONT}`;
    ctx.fillText(o.subtitle, PAD, y);
    y += 18;
  }
  y = PAD + th;
  ctx.drawImage(src, 0, 0, src.width, src.height, PAD, y, u.width, u.height);
  y += u.height;
  if (legendH) {
    let x = PAD;
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'middle';
    for (const s of series) {
      ctx.fillStyle = s.stroke;
      ctx.fillRect(x, y + 8, 10, 10);
      ctx.fillStyle = o.colors.ink;
      ctx.fillText(s.label, x + 14, y + 13);
      x += 14 + ctx.measureText(s.label).width + 16;
    }
    y += legendH;
  }
  ctx.strokeStyle = o.colors.line;
  ctx.beginPath();
  ctx.moveTo(PAD, y + 6);
  ctx.lineTo(W - PAD, y + 6);
  ctx.stroke();
  ctx.fillStyle = o.colors.muted;
  ctx.font = `11px ${MONO}`;
  ctx.textBaseline = 'top';
  ctx.fillText(creditLine(o), PAD, y + 12);
  c.toBlob((blob) => {
    if (blob) saveBlob(blob, exportFilename(o.title, 'png'));
  }, 'image/png');
}

/* ------------------------------------------------------------------ SVG */

/** uPlot keeps the computed tick positions and labels on each axis at run time. */
type AxisRuntime = uPlot.Axis & {
  _splits?: number[];
  _values?: Array<string | number | null>;
  _size?: number;
};

export function chartSvg(u: uPlot, o: ExportOpts): string {
  const dpr = Math.max(1, u.ctx.canvas.width / Math.max(1, u.width));
  const th = TITLE_H(o);
  const series = seriesInfo(u);
  const legendH = series.length > 1 ? 22 : 0;
  const W = u.width + PAD * 2;
  const H = th + u.height + legendH + FOOT_H + PAD * 2;
  const ox = PAD;
  const oy = PAD + th;
  const bb = {
    left: u.bbox.left / dpr,
    top: u.bbox.top / dpr,
    w: u.bbox.width / dpr,
    h: u.bbox.height / dpr,
  };
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${o.colors.bg}"/>`);
  if (o.title)
    parts.push(
      `<text x="${PAD}" y="${PAD + 16}" font-family="${FONT}" font-size="16" font-weight="600" fill="${o.colors.ink}">${esc(o.title)}</text>`,
    );
  if (o.subtitle)
    parts.push(
      `<text x="${PAD}" y="${PAD + (o.title ? 24 : 0) + 13}" font-family="${FONT}" font-size="12" fill="${o.colors.muted}">${esc(o.subtitle)}</text>`,
    );

  const px = (v: number, scale: string) => ox + bb.left + u.valToPos(v, scale);
  const py = (v: number, scale: string) => oy + bb.top + u.valToPos(v, scale);

  // Grid, ticks and tick labels from what uPlot last computed.
  for (let ai = 0; ai < u.axes.length; ai++) {
    const ax = u.axes[ai] as AxisRuntime;
    if (ax.show === false || !ax._splits) continue;
    const isX = ai === 0 || ax.side === 0 || ax.side === 2;
    const vals = ax._values ?? [];
    const scale = ax.scale ?? (isX ? 'x' : 'y');
    ax._splits.forEach((v, k) => {
      const label = vals[k];
      if (isX) {
        const x = px(v, scale);
        if (x < ox + bb.left - 1 || x > ox + bb.left + bb.w + 1) return;
        parts.push(
          `<line x1="${x.toFixed(1)}" y1="${(oy + bb.top).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(oy + bb.top + bb.h).toFixed(1)}" stroke="${o.colors.line}" stroke-width="1"/>`,
        );
        if (label != null && label !== '')
          parts.push(
            `<text x="${x.toFixed(1)}" y="${(oy + bb.top + bb.h + 16).toFixed(1)}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="${o.colors.muted}">${esc(String(label))}</text>`,
          );
      } else {
        const y = py(v, scale);
        if (y < oy + bb.top - 1 || y > oy + bb.top + bb.h + 1) return;
        parts.push(
          `<line x1="${(ox + bb.left).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(ox + bb.left + bb.w).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${o.colors.line}" stroke-width="1"/>`,
        );
        if (label != null && label !== '')
          parts.push(
            `<text x="${(ox + bb.left - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="${MONO}" font-size="11" fill="${o.colors.muted}">${esc(String(label))}</text>`,
          );
      }
    });
    if (ax.label) {
      if (isX)
        parts.push(
          `<text x="${(ox + bb.left + bb.w / 2).toFixed(1)}" y="${(oy + bb.top + bb.h + 34).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${o.colors.muted}">${esc(String(ax.label))}</text>`,
        );
      else
        parts.push(
          `<text transform="translate(${(ox + 12).toFixed(1)},${(oy + bb.top + bb.h / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${o.colors.muted}">${esc(String(ax.label))}</text>`,
        );
    }
  }

  // Series, clipped to the plot area.
  parts.push(
    `<clipPath id="plot"><rect x="${(ox + bb.left).toFixed(1)}" y="${(oy + bb.top).toFixed(1)}" width="${bb.w.toFixed(1)}" height="${bb.h.toFixed(1)}"/></clipPath>`,
  );
  parts.push(`<g clip-path="url(#plot)">`);
  const xs = u.data[0] ?? [];
  for (const s of series) {
    const ys = u.data[s.idx] ?? [];
    if (s.bars) {
      const n = xs.length;
      const step = n > 1 ? bb.w / n : bb.w;
      const bw = Math.max(1, step * 0.6);
      for (let k = 0; k < n; k++) {
        const yv = ys[k];
        if (yv == null) continue;
        const x = px(xs[k]!, 'x') - bw / 2;
        const y0 = py(0, s.scale);
        const y1 = py(yv as number, s.scale);
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(y0 - y1).toFixed(1)}" fill="${s.fill ?? s.stroke}" stroke="${s.stroke}" stroke-width="1"/>`,
        );
      }
      continue;
    }
    let d = '';
    let pen = false;
    const pts: Array<[number, number]> = [];
    for (let k = 0; k < xs.length; k++) {
      const yv = ys[k];
      if (yv == null || !Number.isFinite(yv as number)) {
        pen = false;
        continue;
      }
      const x = px(xs[k]!, 'x');
      const y = py(yv as number, s.scale);
      pts.push([x, y]);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      pen = true;
    }
    if (!d) continue;
    if (s.fill && pts.length > 1) {
      const base = py(u.scales[s.scale]?.min ?? 0, s.scale);
      const first = pts[0]!;
      const last = pts[pts.length - 1]!;
      parts.push(
        `<path d="${d}L${last[0].toFixed(1)} ${base.toFixed(1)}L${first[0].toFixed(1)} ${base.toFixed(1)}Z" fill="${s.stroke}" fill-opacity="0.12" stroke="none"/>`,
      );
    }
    parts.push(
      `<path d="${d}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    if (s.points || pts.length <= 40)
      for (const [x, y] of pts)
        parts.push(
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${o.colors.bg}" stroke="${s.stroke}" stroke-width="1.5"/>`,
        );
  }
  parts.push(`</g>`);

  let y = oy + u.height;
  if (legendH) {
    let x = PAD;
    for (const s of series) {
      parts.push(
        `<rect x="${x}" y="${y + 8}" width="10" height="10" rx="2" fill="${s.stroke}"/>`,
        `<text x="${x + 14}" y="${y + 17}" font-family="${FONT}" font-size="11" fill="${o.colors.ink}">${esc(s.label)}</text>`,
      );
      x += 14 + s.label.length * 6.2 + 16;
    }
    y += legendH;
  }
  parts.push(
    `<line x1="${PAD}" y1="${y + 6}" x2="${W - PAD}" y2="${y + 6}" stroke="${o.colors.line}"/>`,
    `<text x="${PAD}" y="${y + 22}" font-family="${MONO}" font-size="11" fill="${o.colors.muted}">${esc(creditLine(o))}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

export function exportSvg(u: uPlot, o: ExportOpts): void {
  saveBlob(
    new Blob([chartSvg(u, o)], { type: 'image/svg+xml;charset=utf-8' }),
    exportFilename(o.title, 'svg'),
  );
}
