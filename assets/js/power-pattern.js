// Weekly Power Pattern Analyzer.
//
// Uploads logged CT current data, computes a { t, kW } power series via the
// shared PowerProfile engine, renders a weekly power heatmap + average hourly
// profile (Plotly, lazy-loaded), and computes average power and equivalent
// full-load hours (EFLH) for a MEASUR setup.
//
// Listeners are bound in init (no inline onclick), so this is a clean IIFE
// guarded by the page's root element, like vsd-efficiency.js.
(function () {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let csvData = [];
  let headers = [];

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

  function getOperatingDays() {
    return DAY_NAMES.map(function (_, d) {
      const el = document.getElementById('opday-' + d);
      return el ? el.checked : true;
    });
  }

  function showError(msg) {
    document.getElementById('errorBox').innerHTML = window.PowerProfile.errorHTML(msg);
  }

  function clearError() {
    document.getElementById('errorBox').innerHTML = '';
  }

  function buildSeries() {
    return window.PowerProfile.buildSeries(csvData, {
      dtCol: getDtCol(),
      currentCol: getCurrentCol(),
      voltage: getVoltage(),
      powerFactor: getPowerFactor()
    });
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
    const parsed = window.PowerProfile.parseCSV(text);
    headers = parsed.headers;
    csvData = parsed.rows;

    if (csvData.length === 0) {
      showError('No data rows found in the CSV file.');
      return;
    }

    populateColumnSelects();

    if (cache) {
      try {
        sessionStorage.setItem('itac-csv', JSON.stringify({ name: fileName || 'uploaded.csv', text: text }));
      } catch (e) { /* non-fatal */ }
    }

    refresh();
  }

  function loadCSV() {
    const file = document.getElementById('csvFileInput').files[0];
    if (!file) { showError('Please select a CSV file.'); return; }
    const reader = new FileReader();
    reader.onload = function (e) { ingest(e.target.result, file.name, true); };
    reader.readAsText(file);
  }

  // Recompute summary + charts after upload or a parameter/column change.
  function refresh() {
    if (csvData.length === 0) return;
    const series = buildSeries();
    const timestep = window.PowerProfile.detectTimestepMinutes(series);
    const span = series.length > 0
      ? ((series[series.length - 1].t - series[0].t) / 86400000).toFixed(1)
      : '0';

    document.getElementById('fileInfo').innerHTML =
      '<strong>✓ File loaded:</strong> ' + csvData.length + ' data points | ' +
      'Timestep: ' + (timestep == null ? 'unknown' : Math.round(timestep)) + ' minutes | ' +
      'Span: ' + span + ' days';

    renderCharts(series);
  }

  // --- Charts --------------------------------------------------------------

  function renderCharts(series) {
    const prof = window.PowerProfile.weeklyProfile(series);
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(h);

    const heatmap = {
      z: prof.meanKw,          // 7 rows (Sun..Sat) x 24 cols
      x: hours,
      y: DAY_NAMES,
      type: 'heatmap',
      colorscale: [[0, '#0a1a4d'], [0.5, '#00a6fb'], [1, '#20bf55']],
      colorbar: { title: 'kW' },
      hovertemplate: '%{y} %{x}:00<br>%{z:.1f} kW<extra></extra>'
    };

    const heatLayout = {
      title: 'Average Power by Day & Hour (kW)',
      xaxis: { title: 'Hour of day', dtick: 2 },
      yaxis: { title: '', autorange: 'reversed' },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: getComputedStyle(document.body).getPropertyValue('--md-default-fg-color') },
      margin: { t: 50, b: 50, l: 50, r: 20 }
    };

    // Average power by hour, across all days that have data.
    const hourSum = new Array(24).fill(0);
    const hourCnt = new Array(24).fill(0);
    series.forEach(function (s) {
      const h = s.t.getHours();
      hourSum[h] += s.kW;
      hourCnt[h]++;
    });
    const hourAvg = hourSum.map(function (v, h) { return hourCnt[h] > 0 ? v / hourCnt[h] : null; });

    const profileTrace = {
      x: hours,
      y: hourAvg,
      type: 'scatter',
      mode: 'lines+markers',
      line: { color: '#013ecd', width: 2 },
      marker: { color: '#013ecd', size: 5 },
      name: 'Avg power'
    };

    const profLayout = {
      title: 'Average Hourly Power Profile (kW)',
      xaxis: { title: 'Hour of day', dtick: 2 },
      yaxis: { title: 'Power (kW)', rangemode: 'tozero' },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: getComputedStyle(document.body).getPropertyValue('--md-default-fg-color') },
      margin: { t: 50, b: 50, l: 60, r: 20 }
    };

    const config = { responsive: true, displayModeBar: true };

    document.getElementById('weeklyHeatmap').style.display = 'block';
    document.getElementById('hourlyProfile').style.display = 'block';
    window.loadScriptOnce(window.PLOTLY_SRC).then(function () {
      if (document.getElementById('weeklyHeatmap')) {
        Plotly.newPlot('weeklyHeatmap', [heatmap], heatLayout, config);
      }
      if (document.getElementById('hourlyProfile')) {
        Plotly.newPlot('hourlyProfile', [profileTrace], profLayout, config);
      }
    });
  }

  // --- EFLH ----------------------------------------------------------------

  function compute() {
    clearError();
    if (csvData.length === 0) { showError('Please load a CSV file first.'); return; }

    const voltage = getVoltage();
    if (isNaN(voltage) || voltage <= 0) { showError('Please enter a valid system voltage.'); return; }

    const nameplate = parseFloat(document.getElementById('nameplateKw').value);
    if (isNaN(nameplate) || nameplate <= 0) { showError('Please enter the compressor nameplate power (kW).'); return; }

    const weeksPerYear = parseFloat(document.getElementById('weeksPerYear').value) || 52;
    const operatingDays = getOperatingDays();
    if (!operatingDays.some(Boolean)) { showError('Select at least one operating day.'); return; }

    const series = buildSeries();
    const r = window.PowerProfile.eflh(series, {
      nameplateKw: nameplate,
      operatingDays: operatingDays,
      weeksPerYear: weeksPerYear
    });

    const loadPct = (r.avgPowerKw / nameplate) * 100;
    const selectedNames = DAY_NAMES.filter(function (_, d) { return operatingDays[d]; }).join(', ');

    document.getElementById('resultsContent').innerHTML =
      '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; text-align: center; margin-bottom: 16px;">' +
        tile('Equivalent Full-Load Hours', r.eflh.toFixed(0) + ' hr/yr', '#20bf55') +
        tile('Average Power', r.avgPowerKw.toFixed(1) + ' kW', null) +
        tile('Annual Energy', Math.round(r.annualKwh).toLocaleString() + ' kWh', null) +
      '</div>' +
      '<p style="margin: 6px 0; font-size: 0.9em; color: var(--md-default-fg-color--light);">' +
        '<strong>Average load:</strong> ' + loadPct.toFixed(0) + '% of nameplate · ' +
        '<strong>Operating days:</strong> ' + selectedNames + ' · ' +
        '<strong>Operating hours/week (with data):</strong> ' + r.operatingHoursPerWeek + ' · ' +
        '<strong>Weeks/year:</strong> ' + weeksPerYear +
      '</p>' +
      '<p style="margin: 8px 0 0 0; font-size: 0.85em; color: var(--md-default-fg-color--light);">' +
        'EFLH uses the representative-week method: the average power for each hour ' +
        'across the selected operating days is summed to a weekly kWh, scaled by ' +
        'weeks/year, and divided by nameplate power.</p>';

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

  function buildDayCheckboxes() {
    const wrap = document.getElementById('operatingDays');
    if (!wrap || wrap.dataset.built) return;
    wrap.dataset.built = 'true';
    wrap.innerHTML = DAY_NAMES.map(function (name, d) {
      return '<label style="display: inline-flex; align-items: center; gap: 6px; font-weight: 500;">' +
        '<input type="checkbox" id="opday-' + d + '" checked> ' + name + '</label>';
    }).join('');
  }

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

  function init() {
    if (!document.getElementById('power-pattern-calc')) return;

    buildDayCheckboxes();
    offerReuse();

    bind('loadDataBtn', 'click', loadCSV);
    bind('calcBtn', 'click', compute);
    bind('dtColSelect', 'change', function () { if (csvData.length) refresh(); });
    bind('currentColSelect', 'change', function () { if (csvData.length) refresh(); });
    bind('systemVoltage', 'input', function () { if (csvData.length) refresh(); });
    bind('powerFactor', 'input', function () { if (csvData.length) refresh(); });
  }

  function bind(id, evt, fn) {
    const el = document.getElementById(id);
    if (el && !el.dataset.ppBound) {
      el.dataset.ppBound = 'true';
      el.addEventListener(evt, fn);
    }
  }

  if (typeof document$ !== 'undefined') {
    document$.subscribe(init);
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
