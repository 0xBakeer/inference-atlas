import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { icon } from '../components/icons.js';
import { store } from '../store.js';
import { fmtInt } from '@atlas/core';
import { ViewElement } from './view-base.js';

@customElement('atlas-about-view')
export class AtlasAboutView extends ViewElement {
  override render() {
    const site = store.site;
    const repo = `${site.repo.host ?? 'https://github.com'}/${site.repo.owner}/${site.repo.name}`;
    const stats = store.stats.value;
    return html`<div class="page about">
      <div class="page-head">
        <div class="eyebrow">About</div>
        <h1>${site.site.title}</h1>
        <p class="lede">${site.site.tagline}</p>
      </div>
      <div class="md">
        <h2>What this is</h2>
        <p>
          A static web app that renders the configuration space of LLM serving engines — vLLM,
          SGLang, llama.cpp, TensorRT-LLM, MLX, Ollama and friends — as a browsable map. Every
          square is a model, a quantization, a device and an engine version. Squares somebody has
          measured show real numbers, attributed to the GitHub user who ran them and the commit that
          added them. Squares nobody has measured are gaps, and every gap comes with everything
          needed to fill it: the exact flags, a machine-readable packet for a coding agent, the
          output schema, the validation command, the pull-request steps.
        </p>
        <h2>Why</h2>
        <p>
          Benchmark numbers for local inference are scattered across blog posts, threads and
          screenshots, and they are almost never reproducible — because the thing that determines
          the result is the <em>combination</em>: the exact engine version, the quantization and
          whether the device has a native kernel for it, flags like memory utilisation and
          speculative decoding, and the workload itself. Change one and the number changes. Almost
          nobody records all of them, so the same benchmark is re-run thousands of times and the
          knowledge evaporates.
        </p>
        <p>
          This project inverts the usual leaderboard. Colour on the map means
          <strong>evidence</strong>, not speed. Grey pulls contributors towards what nobody has
          tried rather than towards whatever is trending.
        </p>
        <h2>How it works</h2>
        <ul>
          <li>
            <strong>The repository is the database.</strong> Every measurement is one JSON file on
            <code>main</code>; the site is a static build of those files. No backend, no server
            cost, fork-able by anyone.
          </li>
          <li>
            <strong>One file, one owner.</strong> CI only lets you add or change result files whose
            <code>github_login</code> is yours. Merge conflicts are structurally impossible.
          </li>
          <li>
            <strong>Fingerprints.</strong> Flags are canonicalised (aliases resolved, version
            defaults dropped, values normalised) and hashed. Two people who ran the same setup
            produce the same <code>config_id</code> — which also defines "untested" precisely and
            makes disagreements visible.
          </li>
          <li>
            <strong>Provenance you can check.</strong> Logins are resolved to numeric GitHub ids in
            CI; the build stamps the adding commit and PR from git history.
          </li>
          <li>
            <strong>Plausibility.</strong> Decode speed cannot beat memory bandwidth divided by
            weight bytes; VRAM cannot exceed the device; percentiles must be ordered. The validator
            says so.
          </li>
        </ul>
        ${stats ? html`<p class="small muted">Right now: ${fmtInt(stats.runs)} runs in ${fmtInt(stats.cells_covered)} of ${fmtInt(stats.cells_possible)} possible cells, from ${fmtInt(stats.contributors)} contributor${stats.contributors === 1 ? '' : 's'}, across ${fmtInt(stats.engines)} engines, ${fmtInt(stats.models)} models and ${fmtInt(stats.hardware)} devices.</p>` : ''}
        <h2>Licences</h2>
        <p>
          Code is MIT. Data — every registry file and every measurement — is CC-BY-4.0: use it,
          redistribute it, credit the contributors. Test datasets are authored in the repository and
          MIT-licensed; no model weights and no datasets with unclear licences are mirrored.
        </p>
        <h2>Links</h2>
        <p class="row-wrap">
          <a class="btn" href=${repo} target="_blank" rel="noopener"
            >${icon('github')} Repository</a
          >
          <a
            class="btn"
            href=${site.links?.spec ?? `${repo}/blob/main/docs/SPEC.md`}
            target="_blank"
            rel="noopener"
            >${icon('file')} Specification</a
          >
          <a
            class="btn"
            href=${site.links?.agents ?? `${repo}/blob/main/AGENTS.md`}
            target="_blank"
            rel="noopener"
            >${icon('sparkle')} AGENTS.md</a
          >
          <a
            class="btn"
            href=${site.links?.data_licence ?? `${repo}/blob/main/DATA_LICENSE`}
            target="_blank"
            rel="noopener"
            >${icon('file')} Data licence</a
          >
          <a class="btn btn-primary" href="#/contribute">${icon('flag')} Contribute</a>
        </p>
      </div>
    </div>`;
  }
}
