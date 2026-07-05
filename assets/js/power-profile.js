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

  // --- Interpolation ------------------------------------------------------

  // 1-D linear interpolation of y at x given monotonic-ascending xArray and its
  // paired yArray. Clamps to the endpoints outside the range. Shared by the flow
  // lookup here and the leak-rate calculator.
  function linearInterpolate(x, xArray, yArray) {
    if (xArray.length === 0) return null;
    if (x <= xArray[0]) return yArray[0];
    if (x >= xArray[xArray.length - 1]) return yArray[yArray.length - 1];
    let lo = 0;
    let hi = xArray.length - 1;
    for (let i = 0; i < xArray.length - 1; i++) {
      if (x >= xArray[i] && x <= xArray[i + 1]) { lo = i; hi = i + 1; break; }
    }
    const x0 = xArray[lo], x1 = xArray[hi], y0 = yArray[lo], y1 = yArray[hi];
    return y0 + (x - x0) * (y1 - y0) / (x1 - x0);
  }

  // --- Day-type grouping --------------------------------------------------

  // Average power for each weekday (0 = Sun .. 6 = Sat), across the whole
  // series. Returns [7] with null where a weekday has no data.
  function dailyMeanPower(series) {
    const sum = new Array(7).fill(0);
    const cnt = new Array(7).fill(0);
    for (let i = 0; i < series.length; i++) {
      const d = series[i].t.getDay();
      sum[d] += series[i].kW;
      cnt[d]++;
    }
    return sum.map(function (s, d) { return cnt[d] > 0 ? s / cnt[d] : null; });
  }

  // Auto-group the seven weekdays into "day type" buckets by daily average
  // power. Days are visited high-to-low; a day joins the current cluster when
  // its mean is within tolerancePct (%) of the running cluster mean, else it
  // starts a new cluster. Clusters come out in descending-power order and are
  // named Production (highest) .. Non-Production (lowest), with Type 3, Type 4…
  // in between. A second (empty) bucket is always guaranteed so the user has
  // somewhere to move days, and weekdays with no data land in Non-Production.
  // Returns { assignment:[7 bucket index], buckets:[{ name, days:[], meanKw }] }.
  function autoGroupDays(series, tolerancePct) {
    const tol = (tolerancePct == null ? 10 : tolerancePct) / 100;
    const means = dailyMeanPower(series);

    const withData = [];
    for (let d = 0; d < 7; d++) if (means[d] != null) withData.push(d);
    withData.sort(function (a, b) { return means[b] - means[a]; });

    const clusters = [];
    withData.forEach(function (d) {
      const cur = clusters[clusters.length - 1];
      const cmean = cur ? cur.sum / cur.n : null;
      if (cur && Math.abs(means[d] - cmean) <= tol * cmean) {
        cur.days.push(d); cur.sum += means[d]; cur.n++;
      } else {
        clusters.push({ days: [d], sum: means[d], n: 1 });
      }
    });

    const buckets = clusters.map(function (c) {
      return { name: '', days: c.days.slice(), meanKw: c.sum / c.n };
    });
    while (buckets.length < 2) buckets.push({ name: '', days: [], meanKw: null });

    const n = buckets.length;
    buckets.forEach(function (b, i) {
      b.name = i === 0 ? 'Production' : (i === n - 1 ? 'Non-Production' : 'Type ' + (i + 1));
    });

    // Weekdays without data -> Non-Production (last) bucket.
    for (let d = 0; d < 7; d++) if (means[d] == null) buckets[n - 1].days.push(d);
    buckets.forEach(function (b) { b.days.sort(function (a, c) { return a - c; }); });

    const assignment = new Array(7).fill(n - 1);
    buckets.forEach(function (b, i) {
      b.days.forEach(function (d) { assignment[d] = i; });
    });

    return { assignment: assignment, buckets: buckets };
  }

  // Average hourly power [24] for each bucket, given a day->bucket assignment.
  // Returns nBuckets rows of 24 values (null where a bucket has no data in that
  // hour). Used for the per-day-type profile chart.
  function bucketHourlyProfiles(series, assignment, nBuckets) {
    const sum = [];
    const cnt = [];
    for (let b = 0; b < nBuckets; b++) {
      sum.push(new Array(24).fill(0));
      cnt.push(new Array(24).fill(0));
    }
    for (let i = 0; i < series.length; i++) {
      const b = assignment[series[i].t.getDay()];
      if (b == null || b < 0 || b >= nBuckets) continue;
      const h = series[i].t.getHours();
      sum[b][h] += series[i].kW;
      cnt[b][h]++;
    }
    return sum.map(function (row, b) {
      return row.map(function (v, h) { return cnt[b][h] > 0 ? v / cnt[b][h] : null; });
    });
  }

  // --- Flow, threshold & isentropic efficiency ----------------------------

  // Flow (CFM) for a given electrical power (kW). config is either
  //   { type:'vfd', power:[asc], flow:[] }              -> interpolated, or
  //   { type:'nonvfd', loadedThreshold, loadedFlow,
  //                    unloadedThreshold, unloadedFlow } -> discrete state.
  // power/flow for VFD must be sorted ascending by power. Returns null when the
  // config is unusable.
  function flowForPower(kw, config) {
    if (!config) return null;
    if (config.type === 'vfd') {
      if (!config.power || config.power.length < 2) return null;
      return linearInterpolate(kw, config.power, config.flow);
    }
    if (kw > config.loadedThreshold) return config.loadedFlow;
    if (kw >= config.unloadedThreshold) return config.unloadedFlow;
    return 0;
  }

  // Suggested average-power threshold: 50% of the lowest VFD performance point,
  // or 50% of unloaded power for a load/unload machine. Below this a sample is
  // treated as idle/off and excluded from average operating power and the
  // efficiency lookup (but NOT from EFLH). Returns NaN when it can't be derived.
  function suggestThreshold(config) {
    if (!config) return NaN;
    if (config.type === 'vfd') {
      return config.power && config.power.length ? 0.5 * config.power[0] : NaN;
    }
    return config.unloadedPower > 0 ? 0.5 * config.unloadedPower : NaN;
  }

  // Mean power of samples at or above threshold -> { avgKw, nSamples }.
  function averageOperatingPower(series, threshold) {
    let sum = 0, n = 0;
    for (let i = 0; i < series.length; i++) {
      if (series[i].kW >= threshold) { sum += series[i].kW; n++; }
    }
    return { avgKw: n > 0 ? sum / n : 0, nSamples: n };
  }

  // Time-weighted average flow and specific power (kW per 100 CFM) across the
  // above-threshold samples, using the flow lookup only — no discharge pressure
  // needed, so this is available whenever a usable control-type config exists.
  // flowP10/flowP90 bound the band the machine "tends to operate" in. Returns
  // { avgCfm, avgKw, specPower, flowP10, flowP90, nSamples } or null.
  function averageOperatingFlow(series, config, threshold) {
    let cfmSum = 0, kwSum = 0, specSum = 0, n = 0;
    const flows = [];
    for (let i = 0; i < series.length; i++) {
      const kw = series[i].kW;
      if (kw < threshold) continue;
      const flow = flowForPower(kw, config);
      if (!(flow > 0)) continue;
      flows.push(flow);
      cfmSum += flow; kwSum += kw; specSum += kw / (flow / 100); n++;
    }
    if (n === 0) return null;
    flows.sort(function (a, b) { return a - b; });
    function pct(p) {
      const idx = Math.min(flows.length - 1, Math.max(0, Math.round((p / 100) * (flows.length - 1))));
      return flows[idx];
    }
    return {
      avgCfm: cfmSum / n, avgKw: kwSum / n, specPower: specSum / n,
      flowP10: pct(10), flowP90: pct(90), nSamples: n
    };
  }

  // Specific-power curve (kW per 100 CFM vs. flow) implied by the control-type
  // config, for plotting. VFD configs are swept across their power range and
  // mapped to flow; load/unload configs yield their two discrete operating
  // states. Returns { cfm:[], specPower:[] } (empty when the config is unusable).
  function specificPowerCurve(config, nPoints) {
    nPoints = nPoints || 48;
    const cfm = [], specPower = [];
    if (!config) return { cfm: cfm, specPower: specPower };
    if (config.type === 'vfd') {
      if (!config.power || config.power.length < 2) return { cfm: cfm, specPower: specPower };
      const pMin = config.power[0];
      const pMax = config.power[config.power.length - 1];
      for (let i = 0; i < nPoints; i++) {
        const kw = pMin + (pMax - pMin) * (i / (nPoints - 1));
        const flow = linearInterpolate(kw, config.power, config.flow);
        if (!(flow > 0)) continue;
        cfm.push(flow);
        specPower.push(kw / (flow / 100));
      }
    } else {
      [[config.unloadedPower, config.unloadedFlow],
       [config.loadedPower, config.loadedFlow]].forEach(function (s) {
        if (s[0] > 0 && s[1] > 0) { cfm.push(s[1]); specPower.push(s[0] / (s[1] / 100)); }
      });
    }
    return { cfm: cfm, specPower: specPower };
  }

  const EFF_GAMMA = 1.40287268;
  const EFF_R_AIR = 0.28703905;
  const EFF_P_ATM = 101.325;                 // kPa
  const EFF_CFM_TO_KGS = 0.000472 * 1.225;

  // Isentropic (adiabatic) compression efficiency from a single operating point.
  //   opts: { cfm, kw, psi (gauge discharge), inletC (default 20) }
  // Returns { efficiency (%), idealPower (kW), specificPower (kW/100cfm) } or
  // null when inputs are non-positive.
  function isentropicEfficiency(opts) {
    const cfm = opts.cfm, kw = opts.kw, psi = opts.psi;
    const inletC = opts.inletC == null ? 20 : opts.inletC;
    if (!(cfm > 0) || !(kw > 0) || !(psi > 0)) return null;
    const massFlow = cfm * EFF_CFM_TO_KGS;
    const T1 = inletC + 273.15;
    const P2 = psi * 6.894757 + EFF_P_ATM;   // gauge -> absolute
    const exponent = (EFF_GAMMA - 1) / EFF_GAMMA;
    const idealPower = (EFF_GAMMA * EFF_R_AIR * T1 / (EFF_GAMMA - 1)) *
                       (Math.pow(P2 / EFF_P_ATM, exponent) - 1) * massFlow;
    return {
      efficiency: (idealPower / kw) * 100,
      idealPower: idealPower,
      specificPower: kw / (cfm / 100)
    };
  }

  // Time-weighted average isentropic efficiency across all above-threshold
  // samples: each qualifying sample's flow is looked up from config and its
  // efficiency evaluated, then averaged. Samples are (near-)uniformly spaced so
  // an equal-weight mean is the time-weighted mean. cond = { psi, inletC }.
  // Returns { effPct, avgCfm, avgKw, nSamples } or null when nothing qualifies.
  function timeWeightedEfficiency(series, config, threshold, cond) {
    let effSum = 0, cfmSum = 0, kwSum = 0, n = 0;
    for (let i = 0; i < series.length; i++) {
      const kw = series[i].kW;
      if (kw < threshold) continue;
      const flow = flowForPower(kw, config);
      if (!(flow > 0)) continue;
      const eff = isentropicEfficiency({ cfm: flow, kw: kw, psi: cond.psi, inletC: cond.inletC });
      if (!eff) continue;
      effSum += eff.efficiency; cfmSum += flow; kwSum += kw; n++;
    }
    if (n === 0) return null;
    return { effPct: effSum / n, avgCfm: cfmSum / n, avgKw: kwSum / n, nSamples: n };
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
    linearInterpolate: linearInterpolate,
    dailyMeanPower: dailyMeanPower,
    autoGroupDays: autoGroupDays,
    bucketHourlyProfiles: bucketHourlyProfiles,
    flowForPower: flowForPower,
    suggestThreshold: suggestThreshold,
    averageOperatingPower: averageOperatingPower,
    averageOperatingFlow: averageOperatingFlow,
    specificPowerCurve: specificPowerCurve,
    isentropicEfficiency: isentropicEfficiency,
    timeWeightedEfficiency: timeWeightedEfficiency,
    errorHTML: errorHTML
  };
})();
