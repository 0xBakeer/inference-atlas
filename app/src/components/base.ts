import { LitElement } from 'lit';

/**
 * All Atlas components render into light DOM so one hand-written stylesheet, with its
 * custom properties, styles everything (tables, uPlot, markdown) without per-component
 * duplication. Components are namespaced by class names instead of shadow roots.
 */
export class AtlasElement extends LitElement {
  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Custom elements are inline by default; every Atlas element is a block-level container.
    if (!this.style.display) this.style.display = 'block';
  }
}
