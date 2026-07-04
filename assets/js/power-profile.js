// Shared power-profile engine for the current-data calculators (leak-rate,
// weekly power-pattern analyzer, and any future CSV/CT tool).
//
// Loaded site-wide BEFORE the per-calculator scripts, like extra.js. Pure
// computation — no DOM, no Plotly — so it stays reusable and easy to reason
// about. Attaches a single global namespace, window.PowerProfile.
(function () {
  const SQRT3 = Math.sqrt(3);

  // --- CSV parsing --------------------------------------------------------

  // Split a single CSV line, honoring simple double-quoted fields that may
  // contain commas or escaped quotes ("" -> "). Good enough for the CT exports
  // these tools consume; not a full RFC-4180 parser (no embedded newlines).
  function splitCSVLine(line) {
    const out = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
          else { inQuotes = false; }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    out.push(field);
    return out.map(function (s) { return s.trim(); });
  }

  // Parse CSV text into { headers, rows }. Robust to a UTF-8 BOM, CRLF or LF
  // line endings, blank lines, and quoted fields. rows are plain objects keyed
  // by header name.
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
    const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (lines.length === 0) return { headers: [], rows: [] };

    const headers = splitCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const values = splitCSVLine(lines[i]);
      const row = {};
      headers.forEach(function (h, idx) {
        row[h] = values[idx] !== undefined ? values[idx] : '';
      });
      rows.push(row);
    }
    return { headers: headers, rows: rows };
  }

  // --- Date/time parsing --------------------------------------------------

  // Parse a timestamp into a Date. Accepts:
  //   MM/DD/YYYY            MM/DD/YYYY HH:MM[:SS]
  //   YYYY-MM-DD            YYYY-MM-DD[THH:MM[:SS]]  (ISO, space or T separator)
  // Returns null when the value cannot be parsed (callers skip/validate).
  function parseDateTime(str) {
    if (str == null) return null;
    str = String(str).trim();
    if (str === '') return null;

    // ISO-ish: YYYY-MM-DD with optional time
    let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      return makeDate(m[1], m[2], m[3], m[4], m[5], m[6]);
    }

    // US: MM/DD/YYYY with optional time
    m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      return makeDate(m[3], m[1], m[2], m[4], m[5], m[6]);
    }

    // Last resort: let the engine try (handles a few other formats).
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  function makeDate(y, mo, d, h, mi, s) {
    const date = new Date(
      parseInt(y, 10),
      parseInt(mo, 10) - 1,
      parseInt(d, 10),
      h ? parseInt(h, 10) : 0,
      mi ? parseInt(mi, 10) : 0,
      s ? parseInt(s, 10) : 0
    );
    return isNaN(date.getTime()) ? null : date;
  }

  // --- Power --------------------------------------------------------------

  // Real electrical power (kW) for a 3-phase load:
  //   P = sqrt(3) * V * I * PF / 1000
  // Power factor defaults to 1.0 (apparent power) only when omitted; callers
  // should pass a real PF (~0.90 for loaded compressor motors).
  function computePower(opts) {
    const v = opts.voltage;
    const i = opts.current;
    const pf = opts.powerFactor == null ? 1 : opts.powerFactor;
    return (SQRT3 * v * i * pf) / 1000;
  }

  // --- Series construction ------------------------------------------------

  // Turn parsed rows into a chronological power series:
  //   [{ t: Date, kW: Number }]
  // Rows with an unparseable timestamp or non-numeric current are skipped.
  // Result is sorted ascending by time so downstream aggregation and timestep
  // detection are robust to out-of-order exports.
  function buildSeries(rows, opts) {
    const dtCol = opts.dtCol;
    const currentCol = opts.currentCol;
    const series = [];
    for (let i = 0; i < rows.length; i++) {
      const t = parseDateTime(rows[i][dtCol]);
      const current = parseFloat(rows[i][currentCol]);
      if (t === null || isNaN(current)) continue;
      series.push({
        t: t,
        kW: computePower({ voltage: opts.voltage, current: current, powerFactor: opts.powerFactor })
      });
    }
    series.sort(function (a, b) { return a.t - b.t; });
    return series;
  }

  // Median spacing between consecutive samples, in minutes. Median (not first
  // delta) so logging gaps or duplicate stamps don't skew the estimate.
  function detectTimestepMinutes(series) {
    if (series.length < 2) return null;
    const deltas = [];
    for (let i = 1; i < series.length; i++) {
      const dt = (series[i].t - series[i - 1].t) / 60000;
      if (dt > 0) deltas.push(dt);
    }
    if (deltas.length === 0) return null;
    deltas.sort(function (a, b) { return a - b; });
    const mid = Math.floor(deltas.length / 2);
    return deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
  }

  // --- Aggregations -------------------------------------------------------

  // Histogram of kW values: { binCenters, counts }.
  function histogram(series, nbins) {
    nbins = nbins || 50;
    const powers = series.map(function (s) { return s.kW; });
    if (powers.length === 0) return { binCenters: [], counts: [] };
    let min = Math.min.apply(null, powers);
    let max = Math.max.apply(null, powers);
    if (min === max) { max = min + 1; } // avoid zero-width range
    const width = (max - min) / nbins;
    const counts = new Array(nbins).fill(0);
    for (let i = 0; i < powers.length; i++) {
      let idx = Math.floor((powers[i] - min) / width);
      if (idx >= nbins) idx = nbins - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    }
    const binCenters = [];
    for (let b = 0; b < nbins; b++) binCenters.push(min + width * (b + 0.5));
    return { binCenters: binCenters, counts: counts };
  }

  // Average power for each (day-of-week, hour) cell across the whole series.
  // Returns { meanKw: 7x24, count: 7x24 } with day 0 = Sunday (JS getDay()).
  function weeklyProfile(series) {
    const sum = [];
    const count = [];
    for (let d = 0; d < 7; d++) {
      sum.push(new Array(24).fill(0));
      count.push(new Array(24).fill(0));
    }
    for (let i = 0; i < series.length; i++) {
      const d = series[i].t.getDay();
      const h = series[i].t.getHours();
      sum[d][h] += series[i].kW;
      count[d][h]++;
    }
    const meanKw = [];
    for (let d = 0; d < 7; d++) {
      meanKw.push(sum[d].map(function (s, h) {
        return count[d][h] > 0 ? s / count[d][h] : null;
      }));
    }
    return { meanKw: meanKw, count: count };
  }

  // Equivalent Full-Load Hours via the representative-week method.
  //   opts: { nameplateKw, operatingDays:[bool x7 Sun..Sat], weeksPerYear=52 }
  // Builds the 168-hour average-power week (weeklyProfile), keeps only the
  // selected operating days, sums to weekly kWh, extrapolates by weeksPerYear,
  // and divides by nameplate. Hours with no data contribute 0 kWh.
  // Returns { avgPowerKw, weeklyKwh, annualKwh, eflh, operatingHoursPerWeek }.
  function eflh(series, opts) {
    const nameplate = opts.nameplateKw;
    const operatingDays = opts.operatingDays || [true, true, true, true, true, true, true];
    const weeksPerYear = opts.weeksPerYear == null ? 52 : opts.weeksPerYear;

    const prof = weeklyProfile(series);
    let weeklyKwh = 0;
    let powerSum = 0;
    let operatingHours = 0; // hour-cells with data on operating days
    for (let d = 0; d < 7; d++) {
      if (!operatingDays[d]) continue;
      for (let h = 0; h < 24; h++) {
        const kw = prof.meanKw[d][h];
        if (kw == null) continue;      // no data this hour -> no energy
        weeklyKwh += kw;               // kW * 1 hr
        powerSum += kw;
        operatingHours++;
      }
    }
    const annualKwh = weeklyKwh * weeksPerYear;
    const avgPowerKw = operatingHours > 0 ? powerSum / operatingHours : 0;
    const eflhVal = nameplate > 0 ? annualKwh / nameplate : 0;
    return {
      avgPowerKw: avgPowerKw,
      weeklyKwh: weeklyKwh,
      annualKwh: annualKwh,
      eflh: eflhVal,
      operatingHoursPerWeek: operatingHours
    };
  }

  // --- UI helper ----------------------------------------------------------

  // Inline validation message markup (replaces alert()). Themed via CSS vars.
  function errorHTML(msg) {
    return '<div class="pp-error" role="alert" style="margin: 10px 0; padding: 10px 12px; ' +
      'border-radius: 6px; background: rgba(219,41,85,0.10); color: var(--color-crimson, #db2955); ' +
      'font-size: 0.9em;">' + msg + '</div>';
  }

  window.PowerProfile = {
    splitCSVLine: splitCSVLine,
    parseCSV: parseCSV,
    parseDateTime: parseDateTime,
    computePower: computePower,
    buildSeries: buildSeries,
    detectTimestepMinutes: detectTimestepMinutes,
    histogram: histogram,
    weeklyProfile: weeklyProfile,
    eflh: eflh,
    errorHTML: errorHTML
  };
})();
