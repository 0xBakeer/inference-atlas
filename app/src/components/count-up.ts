/** A number that counts up to its value the first time it appears. Static under reduced motion. */
import { html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { AtlasElement } from './base.js';

@customElement('atlas-count-up')
export class AtlasCountUp extends AtlasElement {
  @property({ type: Number }) value = 0;
  @property({ type: Number }) decimals = 0;
  @property({ type: Number }) duration = 1100;
  @state() private shown = 0;
  private raf = 0;
  private from = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = 'inline';
  }

  protected override updated(changed: PropertyValues): void {
    if (!changed.has('value')) return;
    cancelAnimationFrame(this.raf);
    const reduced =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !Number.isFinite(this.value)) {
      this.shown = this.value;
      return;
    }
    const start = performance.now();
    const from = this.from;
    const to = this.value;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / this.duration);
      const eased = 1 - Math.pow(1 - k, 3);
      this.shown = from + (to - from) * eased;
      if (k < 1) this.raf = requestAnimationFrame(tick);
      else this.from = to;
    };
    this.raf = requestAnimationFrame(tick);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
  }

  override render() {
    const v = this.shown;
    return html`${
      this.decimals ? v.toFixed(this.decimals) : Math.round(v).toLocaleString('en-US')
    }`;
  }
}
