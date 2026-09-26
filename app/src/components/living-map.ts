/**
 * The whole map as a field of dots that breathes. Every possible cell is one dot; measured
 * cells glow in their evidence colour and pulse slowly, and every so often one of the
 * unmeasured dots flickers — the next square waiting for somebody. The pointer bends the
 * field a little, like light on water. Purely decorative: it never draws a number, and it
 * stands still when the visitor asked for reduced motion.
 */
import { html, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { CoverageLevel } from '@atlas/core';
import { theme as themeSignal } from '../theme.js';
import { watch } from '../signal.js';
import { cssVar } from '../util/colors.js';
import { AtlasElement } from './base.js';

interface Dot {
  x: number;
  y: number;
  level: CoverageLevel;
  phase: number;
  /** 0..1, fades in and out for the "waiting" flicker on an empty dot. */
  flash: number;
}

@customElement('atlas-living-map')
export class AtlasLivingMap extends AtlasElement {
  /** One coverage level per possible cell; order does not matter. */
  @property({ attribute: false }) levels: CoverageLevel[] = [];
  @property({ type: Number }) height = 320;

  private canvas: HTMLCanvasElement | null = null;
  private dots: Dot[] = [];
  private raf = 0;
  private ro: ResizeObserver | null = null;
  private pointer: { x: number; y: number } | null = null;
  private reduced =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private lastFlash = 0;
  private colors = {
    none: '#ccc',
    single: '#7dd3fc',
    reproduced: '#22c55e',
    disputed: '#f97316',
    stale: '#a78bfa',
    accent: '#d1295e',
  };

  constructor() {
    super();
    watch(this, themeSignal);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(this);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
  }

  protected override updated(_c: PropertyValues): void {
    this.readColors();
    this.layout();
  }

  private readColors(): void {
    this.colors = {
      none: cssVar('--ev-none'),
      single: cssVar('--ev-single'),
      reproduced: cssVar('--ev-reproduced'),
      disputed: cssVar('--ev-disputed'),
      stale: cssVar('--ev-stale'),
      accent: cssVar('--accent'),
    };
  }

  /** Lay the dots on a grid that fills the box, measured ones scattered through it. */
  private layout(): void {
    this.canvas = this.querySelector('canvas');
    const c = this.canvas;
    if (!c) return;
    const w = this.clientWidth;
    const h = this.height;
    if (w === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const n = Math.max(1, this.levels.length);
    const cols = Math.max(8, Math.ceil(Math.sqrt((n * w) / h)));
    const rows = Math.ceil(n / cols);
    const cell = Math.min(w / cols, h / rows);
    const ox = (w - cols * cell) / 2 + cell / 2;
    const oy = (h - rows * cell) / 2 + cell / 2;
    // Deterministic shuffle so the glow is spread across the field, and stable between
    // resizes (a seed from the length keeps the picture the same for the same data).
    const order = this.levels.map((_, i) => i);
    let seed = 1103515245 + n;
    for (let i = order.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    this.dots = order.map((li, k) => ({
      x: ox + (k % cols) * cell,
      y: oy + Math.floor(k / cols) * cell,
      level: this.levels[li]!,
      phase: ((li * 7919) % 1000) / 1000,
      flash: 0,
    }));
    this.cellSize = cell;
    this.dpr = dpr;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private cellSize = 8;
  private dpr = 1;

  private frame(t: number): void {
    const c = this.canvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width / dpr, c.height / dpr);
    const s = this.cellSize;
    const r0 = Math.max(1.2, s * 0.22);
    const time = t / 1000;
    // one empty dot flickers every ~700ms
    if (!this.reduced && t - this.lastFlash > 700) {
      this.lastFlash = t;
      const empties = this.dots.filter((d) => d.level === 'none');
      const pick = empties[Math.floor(Math.random() * empties.length)];
      if (pick) pick.flash = 1;
    }
    const p = this.pointer;
    for (const d of this.dots) {
      let r = r0;
      let alpha = 1;
      let color = this.colors[d.level] ?? this.colors.none;
      if (d.level !== 'none') {
        const pulse = this.reduced ? 1 : 0.75 + 0.25 * Math.sin(time * 1.6 + d.phase * Math.PI * 2);
        r = r0 * (1.6 + 0.5 * pulse);
        alpha = 0.65 + 0.35 * pulse;
      } else {
        alpha = 0.7;
        if (d.flash > 0) {
          color = this.colors.accent;
          r = r0 * (1 + 1.8 * d.flash);
          alpha = 0.35 + 0.65 * d.flash;
          d.flash = Math.max(0, d.flash - 0.02);
        }
      }
      if (p) {
        const dx = d.x - p.x;
        const dy = d.y - p.y;
        const dist = Math.hypot(dx, dy);
        const reach = s * 6;
        if (dist < reach) {
          const k = 1 - dist / reach;
          r *= 1 + 1.4 * k * k;
          alpha = Math.min(1, alpha + 0.5 * k);
        }
      }
      if (d.level !== 'none' || d.flash > 0) {
        // a soft halo so a lit square reads from across the page
        ctx.globalAlpha = alpha * 0.25;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r * 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!this.reduced || p) this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }

  private onMove = (e: PointerEvent) => {
    const rect = this.getBoundingClientRect();
    this.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (this.reduced) {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  };
  private onLeave = () => {
    this.pointer = null;
    if (this.reduced) {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  };

  override render() {
    return html`<canvas
      aria-hidden="true"
      @pointermove=${this.onMove}
      @pointerleave=${this.onLeave}
    ></canvas>`;
  }
}
