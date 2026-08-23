/**
 * Launch-state smoke test: the site ships with ZERO runs (SPEC decisions log #21). Every view
 * must be genuinely presentable from the registries alone — no crashes, no `NaN`, no
 * `undefined` leaking into copy, and the contribute path always visible.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureRegistry } from '../data/fixture.js';
import { store } from '../store.js';

import './atlas-view.js';
import './results-view.js';
import './evals-view.js';
import './parallelism-view.js';
import './pareto-view.js';
import './timeline-view.js';
import './contributors-view.js';
import './gaps-view.js';
import './models-view.js';
import './explore-view.js';

beforeAll(() => {
  store.registry.value = fixtureRegistry();
  store.index.value = [];
  store.coverage.value = {};
  store.gaps.value = [];
  store.contributors.value = [];
  store.stats.value = {
    runs: 0,
    cells_covered: 0,
    cells_possible: store.possible.length,
    contributors: 0,
    engines: 2,
    models: 1,
    hardware: 2,
    workloads: 2,
    last_updated: null,
  };
  // avoid network fetches from connectedCallback in happy-dom
  store.loadGaps = () => Promise.resolve([]);
  store.loadContributors = () => Promise.resolve([]);
});

async function mount(tag: string, props: Record<string, unknown> = {}): Promise<HTMLElement> {
  const el = document.createElement(tag) as HTMLElement & { updateComplete: Promise<unknown> };
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

function clean(el: HTMLElement): string {
  const text = el.textContent ?? '';
  expect(text).not.toContain('NaN');
  expect(text).not.toContain('undefined');
  el.remove();
  return text;
}

describe('every view renders well with zero runs', () => {
  it('atlas: the all-grey map is the pitch', async () => {
    const el = await mount('atlas-atlas-view');
    const text = el.textContent ?? '';
    expect(text).toContain('The rest are yours');
    expect(text).toContain('0');
    expect(el.querySelector('.mini-map')).toBeTruthy(); // every possible cell, all grey
    expect(el.querySelector('atlas-heatmap')).toBeTruthy();
    expect(text).toContain('No results yet');
    expect(text).toContain('Pick a gap');
    clean(el);
  });

  it('results table', async () => {
    const text = clean(await mount('atlas-results-view'));
    expect(text).toContain('No results yet');
    expect(text).toContain('0 of 0 runs');
  });

  it('evals grid points at the registry-driven packets', async () => {
    const text = clean(await mount('atlas-evals-view'));
    expect(text).toContain('No eval runs yet');
    expect(text).toContain('Show every registered model/quant');
  });

  it('parallelism offers the first sweep', async () => {
    const text = clean(await mount('atlas-parallelism-view'));
    expect(text).toContain('No parallelism sweeps measured here yet');
  });

  it('pareto suggests adding a serving measurement', async () => {
    const text = clean(await mount('atlas-pareto-view'));
    expect(text).toContain('Add a serving measurement');
  });

  it('timeline offers the first point', async () => {
    const text = clean(await mount('atlas-timeline-view'));
    expect(text).toContain('Nobody has measured this cell');
  });

  it('contributors: nobody yet — be the first', async () => {
    const text = clean(await mount('atlas-contributors-view'));
    expect(text).toContain('be the first');
    expect(text).toContain('Pick a gap to fill');
  });

  it('gaps view still stands on the registries alone', async () => {
    const text = clean(await mount('atlas-gaps-view'));
    expect(text).toContain('gap');
  });

  it('models list and HF-id detail route', async () => {
    const list = clean(await mount('atlas-models-view'));
    expect(list).toContain('Qwen/Qwen3-8B');
    const detail = await mount('atlas-models-view', { itemId: 'Qwen/Qwen3-8B' });
    const text = detail.textContent ?? '';
    expect(text).toContain('Qwen3-8B');
    expect(text).toContain('Qwen/Qwen3-8B'); // the verbatim id is shown
    clean(detail);
  });

  it('explorer works from the registry with no runs at all', async () => {
    const text = clean(await mount('atlas-explore-view'));
    expect(text).toContain('Nobody has measured exactly this configuration yet');
  });
});
