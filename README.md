# ITAC Tools

Interactive energy-assessment calculators for the **Southern New England
Industrial Training and Assessment Center (ITAC)**, hosted at
**[tools.industrialassessment.com](https://tools.industrialassessment.com)**.

## Calculators

| Page | Purpose |
|---|---|
| `leak-rate.html` | Determine compressed-air leak rates from logged compressor power data (CSV upload). |
| `power-pattern.html` | Power &amp; efficiency analyzer: weekly power-pattern heatmap, day-type grouping, EFLH, average operating power, and time-weighted isentropic efficiency from logged CT current data (CSV upload). |
| `cold-intake.html` | Estimate energy/cost savings from a cold outdoor-air intake system. |
| `heat-recovery.html` | Estimate fuel savings from recovering compressor waste heat. |

The standalone VSD isentropic efficiency estimator was absorbed into `power-pattern.html`.

## How it works

Plain static HTML — no build step. Each calculator is a self-contained page:

- **`assets/theme.css`** — defines the six Material (`--md-*`) CSS variables the
  ported widgets reference, for both light and dark palettes, plus base layout.
- **`assets/js/extra.js`** — shared helpers (`loadScriptOnce`, `PLOTLY_SRC`) that
  lazy-load Plotly from CDN on demand.
- **`assets/js/power-profile.js`** — shared `window.PowerProfile` engine (robust
  CSV parse, datetime parse, `√3·V·I·PF` power, weekly profile, EFLH, day-type
  grouping, power→flow lookup, and isentropic efficiency) used by the CSV-driven
  tools (`leak-rate`, `power-pattern`).
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