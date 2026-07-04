# ITAC Tools

Interactive energy-assessment calculators for the **Southern New England
Industrial Training and Assessment Center (ITAC)**, hosted at
**[tools.industrialassessment.com](https://tools.industrialassessment.com)**.

These were factored out of the main documentation site
([itac-docs](https://github.com/UCONN-ITAC/itac-docs) →
[industrialassessment.com](https://industrialassessment.com)) into a standalone,
framework-free static site.

## Calculators

| Page | Purpose |
|---|---|
| `leak-rate.html` | Determine compressed-air leak rates from logged compressor power data (CSV upload). |
| `cold-intake.html` | Estimate energy/cost savings from a cold outdoor-air intake system. |
| `heat-recovery.html` | Estimate fuel savings from recovering compressor waste heat. |
| `vsd-efficiency.html` | Back-calculate isentropic efficiency from measured specific-power data. |

## How it works

Plain static HTML — no build step. Each calculator is a self-contained page:

- **`assets/theme.css`** — defines the six Material (`--md-*`) CSS variables the
  ported widgets reference, for both light and dark palettes, plus base layout.
- **`assets/js/extra.js`** — shared helpers (`loadScriptOnce`, `PLOTLY_SRC`) that
  lazy-load Plotly from CDN on demand.
- **`assets/js/site.js`** — light/dark theme toggle.
- **`assets/js/<calculator>.js`** — one script per calculator (ported verbatim
  from the docs site; each already falls back to `DOMContentLoaded` when the
  Material `document$` observable is absent).

The only external dependency is Plotly, loaded from `cdn.plot.ly` at runtime by
the charts that need it.

## Local development

No toolchain required — just serve the directory:

```bash
python3 -m http.server 8899
# then open http://localhost:8899/
```

## Deployment

Deployed via **Cloudflare Pages** (Git-connected) to
`tools.industrialassessment.com`. There is no build command — the output
directory is the repository root.

## Keeping in sync with the docs site

The calculator JavaScript originates in
`itac-docs/docs/assets/javascript/`. When a calculator's logic changes there,
copy the updated `.js` into `assets/js/` here (the files are byte-for-byte
copies).
