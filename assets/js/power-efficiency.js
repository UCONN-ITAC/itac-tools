// Power & Efficiency Analyzer.
//
// Merges the former Power Pattern analyzer and VSD Isentropic Efficiency
// estimator into one tool driven by a single CSV of logged CT current data:
//   - builds a { t, kW } power series (shared PowerProfile engine),
//   - auto-groups the seven weekdays into day-type buckets by power profile
//     (user can rename / reassign / add buckets),
//   - draws a weekly heatmap and a per-day-type hourly profile,
//   - computes EFLH and annual energy across ALL days,
//   - computes average operating power above an auto-set threshold, and
//   - looks up flow (VFD curve or load/unload state, ported from the leak-rate
//     calculator) to report a time-weighted isentropic efficiency.
//
// Listeners are bound in init (no inline onclick), so this is a clean IIFE
// guarded by the page's root element, like the calculators it replaces.
(function () {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const BUCKET_COLORS = ['#013ecd', '#20bf55', '#f4a259', '#db2955', '#8a4fff', '#00a6fb', '#5c6b73'];

  let csvData = [];
  let headers = [];
  let buckets = [];       // [{ name }]
  let assignment = [];    // [7] day-of-week -> bucket index

  const PP = function () { return window.PowerProfile; };

  // --- input getters -------------------------------------------------------

  function getVoltage() { return parseFloat(document.getElementById('systemVoltage').value); }

  function getPowerFactor() {
    const pf = parseFloat(document.getElementById('powerFactor').value);
    return isNaN(pf) || pf <= 0 ? 0.90 : pf;
  }

  function getDtCol() {
    const sel = document.getElementById('dtColSelect');
    return sel && sel.value !== '' ? sel.value : headers[1];
  }

  function getCurrentCol() {
    const sel = document.getElementById('currentColSelect');
    return sel && sel.value !== '' ? sel.value : headers[2];
  }

  function num(id) { return parseFloat(document.getElementById(id).value); }

  function showError(msg) {
    document.getElementById('errorBox').innerHTML = PP().errorHTML(msg);
  }
  function clearError() { document.getElementById('errorBox').innerHTML = ''; }

  function buildSeries() {
    return PP().buildSeries(csvData, {
      dtCol: getDtCol(),
      currentCol: getCurrentCol(),
      voltage: getVoltage(),
      powerFactor: getPowerFactor()
    });
  }

  // --- control-type config (ported from leak-rate) -------------------------

  function updateControlTypeUI() {
    const type = document.querySelector('input[name="controlType"]:checked').value;
    document.getElementById('vfdConfig').style.display = type === 'vfd' ? 'block' : 'none';
    document.getElementById('nonvfdConfig').style.display = type === 'nonvfd' ? 'block' : 'none';
    updateAutoThreshold();
  }

  function addVFDPoint() {
    const container = document.getElementById('vfdPointsContainer');
    const row = document.createElement('div');
    row.className = 'vfd-point';
    row.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr 50px; gap: 10px; margin-bottom: 8px;';
    row.innerHTML =
      '<input type="number" class="vfd-power" placeholder="kW" step="0.1" style="padding: 8px; border: 1px solid #ccc; border-radius: 4px;">' +
      '<input type="number" class="vfd-flow" placeholder="CFM" step="0.1" style="padding: 8px; border: 1px solid #ccc; border-radius: 4px;">' +
      '<button type="button" class="vfd-remove" style="padding: 6px; background: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">✕</button>';
    container.appendChild(row);
  }

  function removeVFDPoint(button) {
    if (document.querySelectorAll('.vfd-point').length > 4) {
      button.parentElement.remove();
      updateAutoThreshold();
    } else {
      showError('Minimum 4 data points required for VFD interpolation.');
    }
  }

  // Build the flow-lookup config from the control-type inputs.
  function getConfig() {
    const type = document.querySelector('input[name="controlType"]:checked').value;
    if (type === 'vfd') {
      const pts = [];
      document.querySelectorAll('.vfd-point').forEach(function (p) {
        const power = parseFloat(p.querySelector('.vfd-power').value);
        const flow = parseFloat(p.querySelector('.vfd-flow').value);
        if (!isNaN(power) && !isNaN(flow)) pts.push({ power: power, flow: flow });
      });
      pts.sort(function (a, b) { return a.power - b.power; });
      return {
        type: 'vfd',
        power: pts.map(function (p) { return p.power; }),
        flow: pts.map(function (p) { return p.flow; }),
        points: pts
      };
    }
    const loadedPower = num('loadedPower');
    const loadedFlow = num('loadedFlow');
    const loadedMargin = (num('loadedMargin') || 10) / 100;
    const unloadedPower = num('unloadedPower');
    const unloadedFlow = num('unloadedFlow');
    const unloadedMargin = (num('unloadedMargin') || 10) / 100;
    return {
      type: 'nonvfd',
      loadedPower: loadedPower, loadedFlow: loadedFlow,
      unloadedPower: unloadedPower, unloadedFlow: unloadedFlow,
      loadedThreshold: loadedPower * (1 - loadedMargin),
      unloadedThreshold: unloadedPower * (1 - unloadedMargin)
    };
  }

  // Auto-populate the average-power threshold unless the user has edited it.
  function updateAutoThreshold() {
    const el = document.getElementById('avgThreshold');
    if (!el || el.dataset.userSet === 'true') return;
    const t = PP().suggestThreshold(getConfig());
    el.value = isNaN(t) ? '' : t.toFixed(1);
  }

  function getThreshold() {
    const el = document.getElementById('avgThreshold');
    const t = parseFloat(el.value);
    return isNaN(t) ? 0 : t;
  }

  // --- CSV loading ---------------------------------------------------------

  function populateColumnSelects() {
    const dtSel = document.getElementById('dtColSelect');
    const curSel = document.getElementById('currentColSelect');
    const optionsHtml = headers.map(function (h, i) {
      return '<option value="' + h.replace(/"/g, '&quot;') + '">' + (i + 1) + ': ' + h + '</option>';
    }).join('');
    dtSel.innerHTML = optionsHtml;
    curSel.innerHTML = optionsHtml;
    dtSel.selectedIndex = Math.min(1, headers.length - 1);
    curSel.selectedIndex = Math.min(2, headers.length - 1);
    document.getElementById('columnMapping').style.display = 'block';
  }

  function ingest(text, fileName, cache) {
    clearError();
    const parsed = PP().parseCSV(text);
    headers = parsed.headers;
    csvData = parsed.rows;
    if (csvData.length === 0) { showError('No data rows found in the CSV file.'); return; }

    populateColumnSelects();
    if (cache) {
      try {
        sessionStorage.setItem('itac-csv', JSON.stringify({ name: fileName || 'uploaded.csv', text: text }));
      } catch (e) { /* non-fatal */ }
    }
    applyAutoGroup();
    refresh();
  }

  function loadCSV() {
    const file = document.getElementById('csvFileInput').files[0];
    if (!file) { showError('Please select a CSV file.'); return; }
    const reader = new FileReader();
    reader.onload = function (e) { ingest(e.target.result, file.name, true); };
    reader.readAsText(file);
  }

  // Recompute file summary + charts after upload or a parameter/column change.
  function refresh() {
    if (csvData.length === 0) return;
    const series = buildSeries();
    const timestep = PP().detectTimestepMinutes(series);
    const span = series.length > 0
      ? ((series[series.length - 1].t - series[0].t) / 86400000).toFixed(1)
      : '0';

    document.getElementById('fileInfo').innerHTML =
      '<strong>✓ File loaded:</strong> ' + csvData.length + ' data points | ' +
      'Timestep: ' + (timestep == null ? 'unknown' : Math.round(timestep)) + ' minutes | ' +
      'Span: ' + span + ' days';

    updateAutoThreshold();
    renderCharts(series);
  }

  // --- Day types -----------------------------------------------------------

  function applyAutoGroup() {
    if (csvData.length === 0) return;
    const g = PP().autoGroupDays(buildSeries(), 10);
    buckets = g.buckets.map(function (b) { return { name: b.name }; });
    assignment = g.assignment.slice();
    renderDayTypeUI();
  }

  function addBucket() {
    buckets.push({ name: 'Type ' + (buckets.length + 1) });
    renderDayTypeUI();
  }

  function renderDayTypeUI() {
    const host = document.getElementById('dayTypeUI');
    if (!host) return;

    let html = '<div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; align-items: center;">';
    buckets.forEach(function (b, i) {
      const count = assignment.filter(function (a) { return a === i; }).length;
      html += '<span style="display: inline-flex; align-items: center; gap: 6px;">' +
        '<span style="width: 12px; height: 12px; border-radius: 3px; background: ' + color(i) + ';"></span>' +
        '<input class="bucket-name" data-b="' + i + '" value="' + b.name.replace(/"/g, '&quot;') + '" ' +
          'style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 130px;">' +
        '<span style="font-size: 0.85em; color: var(--md-default-fg-color--light);">' + count + 'd</span></span>';
    });
    html += '<button type="button" id="addBucketBtn" style="padding: 6px 12px; background: #4caf50; color: white; border: none; border-radius: 4px; cursor: pointer;">+ Add bucket</button>';
    html += '<button type="button" id="autoGroupBtn" style="padding: 6px 12px; background: var(--md-primary-fg-color, #4051b5); color: white; border: none; border-radius: 4px; cursor: pointer;">Re-run auto-group</button>';
    html += '</div>';

    html += '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px;">';
    DAY_NAMES.forEach(function (name, d) {
      html += '<div style="display: flex; align-items: center; gap: 6px;">' +
        '<span style="width: 34px; font-weight: 500;">' + name + '</span>' +
        '<select class="day-bucket" data-day="' + d + '" style="flex: 1; padding: 6px;">' +
        buckets.map(function (b, i) {
          return '<option value="' + i + '"' + (assignment[d] === i ? ' selected' : '') + '>' + b.name + '</option>';
        }).join('') +
        '</select></div>';
    });
    html += '</div>';
    host.innerHTML = html;
  }

  function color(i) { return BUCKET_COLORS[i % BUCKET_COLORS.length]; }

  // Delegated handler for the day-type UI (rebuilt on every render).
  function onDayTypeChange(e) {
    const t = e.target;
    if (t.classList.contains('day-bucket')) {
      assignment[parseInt(t.dataset.day, 10)] = parseInt(t.value, 10);
      renderDayTypeUI();
      if (csvData.length) renderCharts(buildSeries());
    } else if (t.classList.contains('bucket-name')) {
      buckets[parseInt(t.dataset.b, 10)].name = t.value;
      renderDayTypeUI();
    }
  }

  function onDayTypeClick(e) {
    if (e.target.id === 'addBucketBtn') addBucket();
    else if (e.target.id === 'autoGroupBtn') { applyAutoGroup(); if (csvData.length) renderCharts(buildSeries()); }
  }

  // --- Charts --------------------------------------------------------------

  function renderCharts(series) {
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(h);

    const prof = PP().weeklyProfile(series);
    const heatmap = {
      z: prof.meanKw, x: hours, y: DAY_NAMES, type: 'heatmap',
      colorscale: [[0, '#0a1a4d'], [0.5, '#00a6fb'], [1, '#20bf55']],
      colorbar: { title: 'kW' },
      hovertemplate: '%{y} %{x}:00<br>%{z:.1f} kW<extra></extra>'
    };
    const heatLayout = baseLayout('Average Power by Day & Hour (kW)', 'Hour of day', '');
    heatLayout.xaxis.dtick = 2;
    heatLayout.yaxis.autorange = 'reversed';

    const profiles = PP().bucketHourlyProfiles(series, assignment, buckets.length);
    const traces = profiles.map(function (row, i) {
      return {
        x: hours, y: row, type: 'scatter', mode: 'lines+markers',
        line: { color: color(i), width: 2 }, marker: { color: color(i), size: 4 },
        name: buckets[i].name, connectgaps: false
      };
    }).filter(function (_, i) {
      return assignment.some(function (a) { return a === i; });
    });

    const profLayout = baseLayout('Hourly Power Profile by Day Type (kW)', 'Hour of day', 'Power (kW)');
    profLayout.xaxis.dtick = 2;
    profLayout.yaxis.rangemode = 'tozero';
    profLayout.showlegend = true;

    const config = { responsive: true, displayModeBar: true };
    document.getElementById('weeklyHeatmap').style.display = 'block';
    document.getElementById('bucketProfiles').style.display = 'block';
    window.loadScriptOnce(window.PLOTLY_SRC).then(function () {
      if (document.getElementById('weeklyHeatmap')) Plotly.newPlot('weeklyHeatmap', [heatmap], heatLayout, config);
      if (document.getElementById('bucketProfiles')) Plotly.newPlot('bucketProfiles', traces, profLayout, config);
    });
  }

  function baseLayout(title, xTitle, yTitle) {
    return {
      title: title,
      xaxis: { title: xTitle },
      yaxis: { title: yTitle },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: getComputedStyle(document.body).getPropertyValue('--md-default-fg-color') },
      margin: { t: 50, b: 50, l: 60, r: 20 }
    };
  }

  // --- Results -------------------------------------------------------------

  const ALL_DAYS = [true, true, true, true, true, true, true];

  function compute() {
    clearError();
    if (csvData.length === 0) { showError('Please load a CSV file first.'); return; }

    const voltage = getVoltage();
    if (isNaN(voltage) || voltage <= 0) { showError('Please enter a valid system voltage.'); return; }

    const nameplate = num('nameplateKw');
    if (isNaN(nameplate) || nameplate <= 0) { showError('Please enter the compressor nameplate power (kW).'); return; }

    const weeksPerYear = num('weeksPerYear') || 52;
    const series = buildSeries();

    // EFLH & energy use ALL days (runtime on non-production days is still runtime).
    const r = PP().eflh(series, { nameplateKw: nameplate, operatingDays: ALL_DAYS, weeksPerYear: weeksPerYear });

    // Average operating power uses only samples above the threshold.
    const threshold = getThreshold();
    const avg = PP().averageOperatingPower(series, threshold);
    const loadPct = nameplate > 0 ? (avg.avgKw / nameplate) * 100 : 0;

    // Time-weighted isentropic efficiency from the flow lookup.
    const config = getConfig();
    const psi = num('dischargePsi');
    const inletC = isNaN(num('inletTempC')) ? 20 : num('inletTempC');
    const eff = PP().timeWeightedEfficiency(series, config, threshold, { psi: psi, inletC: inletC });

    let effTile;
    if (!(psi > 0)) {
      effTile = tile('Time-Weighted Efficiency', 'enter PSI', null);
    } else if (config.type === 'vfd' && config.power.length < 2) {
      effTile = tile('Time-Weighted Efficiency', 'need VFD points', null);
    } else if (!eff) {
      effTile = tile('Time-Weighted Efficiency', 'no data', null);
    } else {
      const c = eff.effPct > 100 ? '#f44336' : (eff.effPct < 50 ? '#ff9800' : '#4caf50');
      effTile = tile('Time-Weighted Efficiency', eff.effPct.toFixed(1) + '%', c);
    }

    // Per-bucket EFLH share + average power.
    let bucketRows = '';
    buckets.forEach(function (b, i) {
      const mask = assignment.map(function (a) { return a === i; });
      if (!mask.some(Boolean)) return;
      const br = PP().eflh(series, { nameplateKw: nameplate, operatingDays: mask, weeksPerYear: weeksPerYear });
      const share = r.weeklyKwh > 0 ? (br.weeklyKwh / r.weeklyKwh) * 100 : 0;
      const days = DAY_NAMES.filter(function (_, d) { return mask[d]; }).join(' ');
      bucketRows +=
        '<tr style="border-bottom: 1px solid var(--md-default-fg-color--lightest);">' +
        '<td style="padding: 8px;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + color(i) + ';margin-right:6px;"></span>' + b.name + '</td>' +
        '<td style="padding: 8px;">' + (days || '—') + '</td>' +
        '<td style="padding: 8px; text-align: right;">' + br.eflh.toFixed(0) + '</td>' +
        '<td style="padding: 8px; text-align: right;">' + share.toFixed(0) + '%</td>' +
        '<td style="padding: 8px; text-align: right;">' + br.avgPowerKw.toFixed(1) + '</td>' +
        '</tr>';
    });

    document.getElementById('resultsContent').innerHTML =
      '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; text-align: center; margin-bottom: 16px;">' +
        tile('Equivalent Full-Load Hours', r.eflh.toFixed(0) + ' hr/yr', '#20bf55') +
        tile('Avg Operating Power', avg.avgKw.toFixed(1) + ' kW', null) +
        tile('Annual Energy', Math.round(r.annualKwh).toLocaleString() + ' kWh', null) +
        effTile +
        (eff && psi > 0 ? tile('Avg Flow', eff.avgCfm.toFixed(0) + ' CFM', null) : '') +
      '</div>' +
      '<p style="margin: 6px 0; font-size: 0.9em; color: var(--md-default-fg-color--light);">' +
        '<strong>Average load:</strong> ' + loadPct.toFixed(0) + '% of nameplate · ' +
        '<strong>Threshold:</strong> ≥ ' + threshold.toFixed(1) + ' kW (' + avg.nSamples + ' samples) · ' +
        '<strong>Weeks/year:</strong> ' + weeksPerYear +
      '</p>' +
      '<table style="width: 100%; border-collapse: collapse; margin: 14px 0;">' +
        '<tr style="background: var(--md-code-bg-color); border-bottom: 2px solid var(--md-default-fg-color--lightest);">' +
          '<th style="padding: 8px; text-align: left;">Day type</th>' +
          '<th style="padding: 8px; text-align: left;">Days</th>' +
          '<th style="padding: 8px; text-align: right;">EFLH (hr/yr)</th>' +
          '<th style="padding: 8px; text-align: right;">Energy share</th>' +
          '<th style="padding: 8px; text-align: right;">Avg power (kW)</th>' +
        '</tr>' + bucketRows +
      '</table>' +
      '<p style="margin: 8px 0 0 0; font-size: 0.85em; color: var(--md-default-fg-color--light);">' +
        'EFLH and annual energy use <strong>all</strong> days (runtime on non-production days still counts). ' +
        'Average operating power, average flow, and the time-weighted efficiency use only samples at or above ' +
        'the threshold, so idle/off periods don\'t drag them down.</p>';

    document.getElementById('results').style.display = 'block';
  }

  function tile(label, value, color) {
    return '<div>' +
      '<p style="margin: 4px 0; color: var(--md-default-fg-color--light); font-size: 0.85em;">' + label + '</p>' +
      '<p style="margin: 4px 0; font-family: monospace; font-size: 1.4em; font-weight: 600;' +
        (color ? ' color: ' + color + ';' : '') + '">' + value + '</p>' +
      '</div>';
  }

  // --- init ----------------------------------------------------------------

  function offerReuse() {
    const notice = document.getElementById('reuseNotice');
    if (!notice) return;
    let cached;
    try { cached = JSON.parse(sessionStorage.getItem('itac-csv') || 'null'); } catch (e) { cached = null; }
    if (!cached || !cached.text) return;
    notice.style.display = 'block';
    notice.innerHTML = 'A previously uploaded file is available: <strong>' + cached.name + '</strong>. ' +
      '<button id="reuseBtn" style="margin-left: 8px; padding: 4px 10px; background: var(--md-primary-fg-color); color: white; border: none; border-radius: 4px; cursor: pointer;">Reuse it</button>';
    document.getElementById('reuseBtn').addEventListener('click', function () {
      ingest(cached.text, cached.name, false);
      notice.style.display = 'none';
    });
  }

  function bind(id, evt, fn) {
    const el = document.getElementById(id);
    if (el && !el.dataset.peBound) {
      el.dataset.peBound = 'true';
      el.addEventListener(evt, fn);
    }
  }

  function init() {
    const root = document.getElementById('power-efficiency-calc');
    if (!root) return;

    offerReuse();

    bind('loadDataBtn', 'click', loadCSV);
    bind('calcBtn', 'click', compute);
    bind('dtColSelect', 'change', function () { if (csvData.length) { applyAutoGroup(); refresh(); } });
    bind('currentColSelect', 'change', function () { if (csvData.length) { applyAutoGroup(); refresh(); } });
    bind('systemVoltage', 'input', function () { if (csvData.length) refresh(); });
    bind('powerFactor', 'input', function () { if (csvData.length) refresh(); });

    // Control-type + performance-data plumbing (ported from leak-rate).
    document.querySelectorAll('input[name="controlType"]').forEach(function (r) {
      if (!r.dataset.peBound) { r.dataset.peBound = 'true'; r.addEventListener('change', updateControlTypeUI); }
    });
    bind('addVfdPointBtn', 'click', addVFDPoint);
    const vfdContainer = document.getElementById('vfdPointsContainer');
    if (vfdContainer && !vfdContainer.dataset.peBound) {
      vfdContainer.dataset.peBound = 'true';
      vfdContainer.addEventListener('click', function (e) {
        if (e.target.classList.contains('vfd-remove')) removeVFDPoint(e.target);
      });
      vfdContainer.addEventListener('input', updateAutoThreshold);
    }
    ['loadedPower', 'unloadedPower', 'loadedMargin', 'unloadedMargin'].forEach(function (id) {
      bind(id, 'input', updateAutoThreshold);
    });
    const thr = document.getElementById('avgThreshold');
    if (thr && !thr.dataset.peBound) {
      thr.dataset.peBound = 'true';
      thr.addEventListener('input', function () { thr.dataset.userSet = 'true'; });
    }

    // Day-type UI (delegated; the container survives re-renders).
    const dt = document.getElementById('dayTypeUI');
    if (dt && !dt.dataset.peBound) {
      dt.dataset.peBound = 'true';
      dt.addEventListener('change', onDayTypeChange);
      dt.addEventListener('click', onDayTypeClick);
    }

    updateControlTypeUI();
  }

  if (typeof document$ !== 'undefined') {
    document$.subscribe(init);
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
