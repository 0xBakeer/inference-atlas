/** Tabbed rendering of a Packet (agent prompt / JSON / shell / issue). Shared by the Add dialog and the packet builder. */
import { html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { Packet } from '@atlas/core';
import { copyText, download } from '../util/clipboard.js';
import { renderMarkdown } from '../util/markdown.js';
import { AtlasElement } from './base.js';
import { icon } from './icons.js';

export type PacketTab = 'prompt' | 'json' | 'shell' | 'issue';

@customElement('atlas-packet-preview')
export class AtlasPacketPreview extends AtlasElement {
  @property({ attribute: false }) packet: Packet | null = null;
  @property() fileBase = 'atlas-packet';
  @state() tab: PacketTab = 'prompt';

  override render() {
    const packet = this.packet;
    if (!packet) return nothing;
    const tabs: Array<{ id: PacketTab; label: string; ic: string }> = [
      { id: 'prompt', label: 'Agent prompt', ic: 'sparkle' },
      { id: 'json', label: 'Packet (JSON)', ic: 'code' },
      { id: 'shell', label: 'Shell', ic: 'terminal' },
      { id: 'issue', label: 'Issue', ic: 'github' },
    ];
    const jsonText = JSON.stringify(packet.json, null, 2);
    const issueBody = (() => {
      try {
        return decodeURIComponent(packet.issueUrl.split('body=')[1]?.split('&labels')[0] ?? '');
      } catch {
        return '';
      }
    })();
    return html`<div class="tabs" role="tablist">
        ${tabs.map((t) => html`<button role="tab" class="tab" aria-selected=${this.tab === t.id} @click=${() => (this.tab = t.id)}>${icon(t.ic)} ${t.label}</button>`)}
      </div>
      <div class="packet-body mt-3">
        ${
          this.tab === 'prompt'
            ? html`<div class="add-prompt-bar">
                  <p class="small muted">
                    Paste this into Claude Code, Codex, opencode or any coding agent on the machine
                    that has the hardware. It is self-contained: clone, capture hardware truthfully,
                    install, serve, measure, validate, open the PR.
                  </p>
                  <button
                    class="btn btn-primary"
                    type="button"
                    @click=${() => copyText(packet.markdown, 'Agent prompt copied')}
                  >
                    ${icon('copy')} Copy agent prompt
                  </button>
                </div>
                <article class="md add-md">${unsafeHTML(renderMarkdown(packet.markdown))}</article>`
            : nothing
        }
        ${
          this.tab === 'json'
            ? html`<div class="add-prompt-bar">
                  <p class="small muted">
                    Save as <code>task.json</code> — this is what
                    <code>atlas-bench run --spec</code> consumes.
                  </p>
                  <div class="row">
                    <button
                      class="btn"
                      type="button"
                      @click=${() => download(`${this.fileBase}.json`, jsonText, 'application/json')}
                    >
                      ${icon('download')} Download
                    </button>
                    <button
                      class="btn btn-primary"
                      type="button"
                      @click=${() => copyText(jsonText, 'Packet JSON copied')}
                    >
                      ${icon('copy')} Copy JSON
                    </button>
                  </div>
                </div>
                <div class="codeblock">
                  <pre style="max-height:none"><code>${jsonText}</code></pre>
                </div>`
            : nothing
        }
        ${
          this.tab === 'shell'
            ? html`<div class="add-prompt-bar">
                  <p class="small muted">
                    For a human at a terminal. Leave the serve command running in a second shell.
                  </p>
                  <div class="row">
                    <button
                      class="btn"
                      type="button"
                      @click=${() => download(`${this.fileBase}.sh`, packet.shell, 'text/x-shellscript')}
                    >
                      ${icon('download')} Download
                    </button>
                    <button
                      class="btn btn-primary"
                      type="button"
                      @click=${() => copyText(packet.shell, 'Shell script copied')}
                    >
                      ${icon('copy')} Copy script
                    </button>
                  </div>
                </div>
                <div class="codeblock">
                  <pre style="max-height:none"><code>${packet.shell}</code></pre>
                </div>`
            : nothing
        }
        ${
          this.tab === 'issue'
            ? html`<div class="add-prompt-bar">
                  <p class="small muted">
                    Have the hardware but not the time? Open a pre-filled issue so somebody else can
                    pick it up — or so the request counts on the wanted queue.
                  </p>
                  <a class="btn btn-primary" href=${packet.issueUrl} target="_blank" rel="noopener"
                    >${icon('github')} Open issue on GitHub</a
                  >
                </div>
                <div class="codeblock">
                  <pre style="max-height:360px"><code>${issueBody}</code></pre>
                </div>
                <p class="xs muted mt-2">
                  The issue body carries the JSON packet; very long packets may exceed GitHub's URL
                  limit — paste the JSON tab by hand if the page opens empty.
                </p>`
            : nothing
        }
      </div>`;
  }
}
