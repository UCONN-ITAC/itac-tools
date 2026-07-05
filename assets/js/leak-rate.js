// Leak Rate Calculator (calculators/leak-rate.md).
//
// Functions called from inline onclick=/onchange= attributes (loadCSV,
// addVFDPoint, removeVFDPoint, calculateLeakRate, updateControlTypeUI) MUST
// remain global, so this file is not wrapped in an IIFE. CSV parsing, datetime
// parsing and the power calculation are delegated to the shared PowerProfile
// engine (assets/js/power-profile.js), which loads before this file. Plotly is
// lazy-loaded on demand via loadScriptOnce (defined in extra.js).

let csvData = [];
let headers = [];

// --- input getters ---------------------------------------------------------

function getVoltage() {
    return parseFloat(document.getElementById('systemVoltage').value);
}

// Power factor for the √3·V·I·PF real-power calculation. Defaults to 0.90
// (typical loaded compressor motor) when the field is blank or absent.
function getPowerFactor() {
    const el = document.getElementById('powerFactor');
    const pf = el ? parseFloat(el.value) : NaN;
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

function rowPower(row) {
    return window.PowerProfile.computePower({
        voltage: getVoltage(),
        current: parseFloat(row[getCurrentCol()]),
        powerFactor: getPowerFactor()
    });
}

// Inline validation message (replaces alert()), shown in the results panel.
function showLeakError(msg) {
    document.getElementById('resultsContent').innerHTML = window.PowerProfile.errorHTML(msg);
    document.getElementById('results').style.display = 'block';
}

// --- UI plumbing -----------------------------------------------------------

function updateControlTypeUI() {
    const controlType = document.querySelector('input[name="controlType"]:checked').value;
    document.getElementById('vfdConfig').style.display = controlType === 'vfd' ? 'block' : 'none';
    document.getElementById('nonvfdConfig').style.display = controlType === 'nonvfd' ? 'block' : 'none';
}

function addVFDPoint() {
    const container = document.getElementById('vfdPointsContainer');
    const newPoint = document.createElement('div');
    newPoint.className = 'vfd-point';
    newPoint.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr 50px; gap: 10px; margin-bottom: 8px;';
    newPoint.innerHTML = `
        <input type="number" class="vfd-power" placeholder="kW" step="0.1" style="padding: 8px; border: 1px solid var(--md-default-fg-color--lightest); border-radius: 4px;">
        <input type="number" class="vfd-flow" placeholder="CFM" step="0.1" style="padding: 8px; border: 1px solid var(--md-default-fg-color--lightest); border-radius: 4px;">
        <button onclick="removeVFDPoint(this)" style="padding: 6px; background: #db2955; color: white; border: none; border-radius: 4px; cursor: pointer;">✕</button>
    `;
    container.appendChild(newPoint);
}

function removeVFDPoint(button) {
    const points = document.querySelectorAll('.vfd-point');
    if (points.length > 4) {
        button.parentElement.remove();
    } else {
        showLeakError('Minimum 4 data points required for VFD interpolation.');
    }
}

function loadCSV() {
    const fileInput = document.getElementById('csvFileInput');
    const file = fileInput.files[0];

    if (!file) {
        showLeakError('Please select a CSV file.');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        parseAndLoad(e.target.result, file.name);
    };
    reader.readAsText(file);
}

// Populate the datetime / current column dropdowns from the parsed headers,
// defaulting to columns 1 and 2 (the historical fixed layout).
function populateColumnSelects() {
    const dtSel = document.getElementById('dtColSelect');
    const curSel = document.getElementById('currentColSelect');
    if (!dtSel || !curSel) return;

    const optionsHtml = headers.map(function (h, i) {
        return '<option value="' + h.replace(/"/g, '&quot;') + '">' + (i + 1) + ': ' + h + '</option>';
    }).join('');
    dtSel.innerHTML = optionsHtml;
    curSel.innerHTML = optionsHtml;

    dtSel.selectedIndex = Math.min(1, headers.length - 1);
    curSel.selectedIndex = Math.min(2, headers.length - 1);

    const wrap = document.getElementById('columnMapping');
    if (wrap) wrap.style.display = 'block';
}

function parseAndLoad(text, fileName) {
    const parsed = window.PowerProfile.parseCSV(text);
    headers = parsed.headers;
    csvData = parsed.rows;

    if (csvData.length === 0) {
        showLeakError('No data rows found in the CSV file.');
        return;
    }

    populateColumnSelects();

    // Cache for cross-page reuse (weekly pattern analyzer, etc.).
    try {
        sessionStorage.setItem('itac-csv', JSON.stringify({ name: fileName || 'uploaded.csv', text: text }));
    } catch (e) { /* storage may be unavailable/full — non-fatal */ }

    onDataOrColumnsChanged();
}

// Recompute the file summary, default period and histogram. Called after a
// fresh upload and whenever the column selection changes.
function onDataOrColumnsChanged() {
    if (csvData.length === 0) return;
    const dtCol = getDtCol();
    const series = buildSeries();
    const timestep = window.PowerProfile.detectTimestepMinutes(series);

    document.getElementById('fileInfo').innerHTML = `
        <strong>✓ File loaded:</strong> ${csvData.length} data points |
        Timestep: ${timestep == null ? 'unknown' : Math.round(timestep)} minutes<br>
        <strong>DateTime Column:</strong> ${dtCol} | <strong>Current Column:</strong> ${getCurrentCol()}
    `;

    if (series.length > 0) {
        document.getElementById('startTime').value = formatDateTimeLocal(series[0].t);
        document.getElementById('endTime').value = formatDateTimeLocal(series[series.length - 1].t);
    }

    updatePeriodInfo();
    updatePowerHistogram();
}

// Build a { t, kW } series from the loaded rows using the current selections.
function buildSeries() {
    return window.PowerProfile.buildSeries(csvData, {
        dtCol: getDtCol(),
        currentCol: getCurrentCol(),
        voltage: getVoltage(),
        powerFactor: getPowerFactor()
    });
}

function updatePowerHistogram() {
    const voltage = getVoltage();

    if (csvData.length === 0 || isNaN(voltage) || voltage <= 0) {
        document.getElementById('powerHistogram').style.display = 'none';
        return;
    }

    const powers = buildSeries().map(function (s) { return s.kW; });
    if (powers.length === 0) return;

    const trace = {
        x: powers,
        type: 'histogram',
        nbinsx: 50,
        marker: {
            color: '#013ecd',
            line: {
                color: '#ffffff',
                width: 1
            }
        },
        name: 'Power Distribution'
    };

    const layout = {
        title: 'Power Distribution (All Data)',
        xaxis: {
            title: 'Power (kW)',
            zeroline: false
        },
        yaxis: {
            title: 'Frequency (count)',
            zeroline: false
        },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: {color: getComputedStyle(document.body).getPropertyValue('--md-default-fg-color')},
        margin: {t: 40, b: 50, l: 60, r: 20},
        showlegend: false
    };

    const config = {responsive: true, displayModeBar: true};

    document.getElementById('powerHistogram').style.display = 'block';
    window.loadScriptOnce(window.PLOTLY_SRC).then(function () {
        if (document.getElementById('powerHistogram')) {
            Plotly.newPlot('powerHistogram', [trace], layout, config);
        }
    });
}

function formatDateTimeLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function updatePeriodInfo() {
    const startTime = document.getElementById('startTime').value;
    const endTime = document.getElementById('endTime').value;

    if (startTime && endTime) {
        const start = new Date(startTime);
        const end = new Date(endTime);
        const durationHours = (end - start) / (1000 * 60 * 60);

        document.getElementById('periodInfo').innerHTML = `
            Period duration: ${durationHours.toFixed(1)} hours
        `;
    }
}

// Linear interpolation lives in the shared PowerProfile engine so the leak-rate
// and power-efficiency tools share one implementation.
function linearInterpolate(x, xArray, yArray) {
    return window.PowerProfile.linearInterpolate(x, xArray, yArray);
}

function calculateLeakRate() {
    // Validate inputs
    if (csvData.length === 0) {
        showLeakError('Please load a CSV file first.');
        return;
    }

    const voltage = getVoltage();
    if (isNaN(voltage) || voltage <= 0) {
        showLeakError('Please enter a valid system voltage.');
        return;
    }

    const startTime = new Date(document.getElementById('startTime').value);
    const endTime = new Date(document.getElementById('endTime').value);

    const dtCol = getDtCol();

    // Filter data for non-production period and calculate power.
    const periodData = csvData.filter(function (row) {
        const rowDate = window.PowerProfile.parseDateTime(row[dtCol]);
        return rowDate && rowDate >= startTime && rowDate <= endTime;
    }).map(function (row) {
        return Object.assign({}, row, { calculatedPower: rowPower(row) });
    });

    if (periodData.length === 0) {
        showLeakError('No data points found in selected period.');
        return;
    }

    const controlType = document.querySelector('input[name="controlType"]:checked').value;

    let results;
    if (controlType === 'vfd') {
        results = calculateVFDLeakRate(periodData, voltage);
    } else {
        results = calculateNonVFDLeakRate(periodData, voltage);
    }

    displayResults(results, periodData, dtCol, voltage);
}

function calculateVFDLeakRate(periodData, voltage) {
    // Get VFD performance points
    const vfdPoints = document.querySelectorAll('.vfd-point');
    const powerArray = [];
    const flowArray = [];

    vfdPoints.forEach(point => {
        const power = parseFloat(point.querySelector('.vfd-power').value);
        const flow = parseFloat(point.querySelector('.vfd-flow').value);
        if (!isNaN(power) && !isNaN(flow)) {
            powerArray.push(power);
            flowArray.push(flow);
        }
    });

    if (powerArray.length < 4) {
        showLeakError('Please enter at least 4 VFD performance points.');
        return null;
    }

    // Sort arrays by power
    const combined = powerArray.map((p, i) => ({power: p, flow: flowArray[i]}));
    combined.sort((a, b) => a.power - b.power);
    const sortedPower = combined.map(c => c.power);
    const sortedFlow = combined.map(c => c.flow);

    // Interpolate flow for each timestep (using calculated 3-phase power)
    const flows = [];
    const powers = [];

    periodData.forEach(row => {
        const power = row.calculatedPower;
        if (!isNaN(power)) {
            const flow = linearInterpolate(power, sortedPower, sortedFlow);
            flows.push(flow);
            powers.push(power);
        }
    });

    const avgLeakRate = flows.reduce((a, b) => a + b, 0) / flows.length;
    const avgPower = powers.reduce((a, b) => a + b, 0) / powers.length;

    return {
        type: 'VFD',
        leakRate: avgLeakRate,
        avgPower: avgPower,
        dataPoints: periodData.length,
        performancePoints: combined,
        voltage: voltage,
        detailedData: periodData.map((row, i) => ({
            power: powers[i],
            flow: flows[i]
        }))
    };
}

function calculateNonVFDLeakRate(periodData, voltage) {
    // Get non-VFD configuration
    const loadedPower = parseFloat(document.getElementById('loadedPower').value);
    const loadedFlow = parseFloat(document.getElementById('loadedFlow').value);
    const loadedMargin = parseFloat(document.getElementById('loadedMargin').value) / 100;

    const unloadedPower = parseFloat(document.getElementById('unloadedPower').value);
    const unloadedFlow = parseFloat(document.getElementById('unloadedFlow').value);
    const unloadedMargin = parseFloat(document.getElementById('unloadedMargin').value) / 100;

    if (isNaN(loadedPower) || isNaN(loadedFlow) || isNaN(unloadedPower)) {
        showLeakError('Please enter all non-VFD configuration values.');
        return null;
    }

    // Calculate thresholds
    const loadedThreshold = loadedPower * (1 - loadedMargin);
    const unloadedThreshold = unloadedPower * (1 - unloadedMargin);

    // Assign states (using calculated 3-phase power)
    let loadedCount = 0, unloadedCount = 0, offCount = 0;
    let totalCFMMinutes = 0;
    const stateData = [];

    periodData.forEach(row => {
        const power = row.calculatedPower;
        if (isNaN(power)) return;

        let state, flow;
        if (power > loadedThreshold) {
            state = 'Loaded';
            flow = loadedFlow;
            loadedCount++;
        } else if (power >= unloadedThreshold) {
            state = 'Unloaded';
            flow = unloadedFlow;
            unloadedCount++;
        } else {
            state = 'Off';
            flow = 0;
            offCount++;
        }

        totalCFMMinutes += flow;
        stateData.push({power, state, flow});
    });

    const totalCount = loadedCount + unloadedCount + offCount;
    const avgLeakRate = totalCFMMinutes / totalCount;

    return {
        type: 'Non-VFD',
        leakRate: avgLeakRate,
        dataPoints: totalCount,
        voltage: voltage,
        states: {
            loaded: {
                count: loadedCount,
                percent: (loadedCount / totalCount * 100).toFixed(1),
                power: loadedPower,
                flow: loadedFlow,
                threshold: loadedThreshold
            },
            unloaded: {
                count: unloadedCount,
                percent: (unloadedCount / totalCount * 100).toFixed(1),
                power: unloadedPower,
                flow: unloadedFlow,
                threshold: unloadedThreshold
            },
            off: {
                count: offCount,
                percent: (offCount / totalCount * 100).toFixed(1)
            }
        },
        detailedData: stateData
    };
}

function displayResults(results, periodData, dateTimeCol, voltage) {
    if (!results) return;

    const timestep = window.PowerProfile.detectTimestepMinutes(buildSeries());
    let html = `
        <div style="margin-bottom: 20px;">
            <h4 style="color: #20bf55; margin-bottom: 10px;">Leak Rate: ${results.leakRate.toFixed(1)} CFM</h4>
            <p style="margin: 5px 0;"><strong>Control Type:</strong> ${results.type}</p>
            <p style="margin: 5px 0;"><strong>System Voltage:</strong> ${voltage} V (3-phase) | <strong>Power Factor:</strong> ${getPowerFactor().toFixed(2)}</p>
            <p style="margin: 5px 0;"><strong>Data Points Analyzed:</strong> ${results.dataPoints}</p>
            <p style="margin: 5px 0;"><strong>Timestep:</strong> ${timestep == null ? 'unknown' : Math.round(timestep)} minutes</p>
        </div>
    `;

    if (results.type === 'VFD') {
        html += `
            <div style="margin: 20px 0;">
                <h4>VFD Performance Points Used:</h4>
                <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
                    <tr style="background: var(--md-code-bg-color); border-bottom: 2px solid var(--md-default-fg-color--lightest);">
                        <th style="padding: 8px; text-align: left;">Power (kW)</th>
                        <th style="padding: 8px; text-align: left;">Flow (CFM)</th>
                    </tr>
                    ${results.performancePoints.map(p => `
                        <tr style="border-bottom: 1px solid var(--md-default-fg-color--lightest);">
                            <td style="padding: 8px;">${p.power.toFixed(1)}</td>
                            <td style="padding: 8px;">${p.flow.toFixed(1)}</td>
                        </tr>
                    `).join('')}
                </table>
                <p style="margin: 10px 0;"><strong>Average Power During Period:</strong> ${results.avgPower.toFixed(2)} kW</p>
            </div>
        `;
    } else {
        html += `
            <div style="margin: 20px 0;">
                <h4>State Distribution:</h4>
                <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
                    <tr style="background: var(--md-code-bg-color); border-bottom: 2px solid var(--md-default-fg-color--lightest);">
                        <th style="padding: 8px; text-align: left;">State</th>
                        <th style="padding: 8px; text-align: right;">Count</th>
                        <th style="padding: 8px; text-align: right;">% of Period</th>
                        <th style="padding: 8px; text-align: right;">Power (kW)</th>
                        <th style="padding: 8px; text-align: right;">Flow (CFM)</th>
                    </tr>
                    <tr style="border-bottom: 1px solid var(--md-default-fg-color--lightest);">
                        <td style="padding: 8px;">Loaded</td>
                        <td style="padding: 8px; text-align: right;">${results.states.loaded.count}</td>
                        <td style="padding: 8px; text-align: right;">${results.states.loaded.percent}%</td>
                        <td style="padding: 8px; text-align: right;">${results.states.loaded.power.toFixed(1)}</td>
                        <td style="padding: 8px; text-align: right;">${results.states.loaded.flow.toFixed(1)}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid var(--md-default-fg-color--lightest);">
                        <td style="padding: 8px;">Unloaded</td>
                        <td style="padding: 8px; text-align: right;">${results.states.unloaded.count}</td>
                        <td style="padding: 8px; text-align: right;">${results.states.unloaded.percent}%</td>
                        <td style="padding: 8px; text-align: right;">${results.states.unloaded.power.toFixed(1)}</td>
                        <td style="padding: 8px; text-align: right;">${results.states.unloaded.flow.toFixed(1)}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid var(--md-default-fg-color--lightest);">
                        <td style="padding: 8px;">Off</td>
                        <td style="padding: 8px; text-align: right;">${results.states.off.count}</td>
                        <td style="padding: 8px; text-align: right;">${results.states.off.percent}%</td>
                        <td style="padding: 8px; text-align: right;">~0</td>
                        <td style="padding: 8px; text-align: right;">0</td>
                    </tr>
                </table>
                <p style="margin: 10px 0; font-size: 0.9em; color: var(--md-default-fg-color--light);">
                    <strong>Thresholds:</strong> Loaded >${results.states.loaded.threshold.toFixed(1)} kW |
                    Unloaded ≥${results.states.unloaded.threshold.toFixed(1)} kW
                </p>
            </div>
        `;
    }

    document.getElementById('resultsContent').innerHTML = html;
    document.getElementById('results').style.display = 'block';

    // Create power vs time chart
    plotPowerChart(periodData, dateTimeCol, results);
}

function plotPowerChart(periodData, dateTimeCol, results) {
    const timestamps = periodData.map(row => window.PowerProfile.parseDateTime(row[dateTimeCol]));
    const powers = periodData.map(row => row.calculatedPower);

    let traces = [{
        x: timestamps,
        y: powers,
        type: 'scatter',
        mode: 'lines',
        name: 'Compressor Power',
        line: {color: '#013ecd', width: 2}
    }];

    if (results.type === 'VFD') {
        const flows = results.detailedData.map(d => d.flow);
        traces.push({
            x: timestamps,
            y: flows,
            type: 'scatter',
            mode: 'lines',
            name: 'Interpolated Flow',
            line: {color: '#20bf55', width: 2},
            yaxis: 'y2'
        });
    }

    const layout = {
        title: 'Compressor Power During Non-Production Period',
        xaxis: {title: 'Time'},
        yaxis: {title: 'Power (kW)'},
        hovermode: 'x unified',
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: {color: getComputedStyle(document.body).getPropertyValue('--md-default-fg-color')},
        margin: {t: 50, b: 50, l: 60, r: results.type === 'VFD' ? 60 : 10}
    };

    // Only define the secondary flow axis for VFD; passing yaxis2: undefined
    // makes Plotly throw ("Cannot read properties of undefined (reading 'anchor')").
    if (results.type === 'VFD') {
        layout.yaxis2 = { title: 'Flow (CFM)', overlaying: 'y', side: 'right' };
    }

    const config = {responsive: true, displayModeBar: true};

    document.getElementById('powerChart').style.display = 'block';
    window.loadScriptOnce(window.PLOTLY_SRC).then(function () {
        if (document.getElementById('powerChart')) {
            Plotly.newPlot('powerChart', traces, layout, config);
        }
    });
}

// Initialize on every page load (including instant-nav swaps). Bails out unless
// this calculator's root element is present, and guards against double-binding
// listeners when the user revisits the page without a hard reload.
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
        parseAndLoad(cached.text, cached.name);
        notice.style.display = 'none';
    });
}

function initLeakRateCalculator() {
    if (!document.getElementById('leak-calculator')) return;

    offerReuse();

    const startEl = document.getElementById('startTime');
    if (startEl && !startEl.dataset.lrBound) {
        startEl.dataset.lrBound = 'true';
        startEl.addEventListener('change', updatePeriodInfo);
    }

    const endEl = document.getElementById('endTime');
    if (endEl && !endEl.dataset.lrBound) {
        endEl.dataset.lrBound = 'true';
        endEl.addEventListener('change', updatePeriodInfo);
    }

    const voltageEl = document.getElementById('systemVoltage');
    if (voltageEl && !voltageEl.dataset.lrBound) {
        voltageEl.dataset.lrBound = 'true';
        voltageEl.addEventListener('input', function () {
            if (csvData.length > 0) {
                updatePowerHistogram();
            }
        });
    }

    const pfEl = document.getElementById('powerFactor');
    if (pfEl && !pfEl.dataset.lrBound) {
        pfEl.dataset.lrBound = 'true';
        pfEl.addEventListener('input', function () {
            if (csvData.length > 0) {
                updatePowerHistogram();
            }
        });
    }

    ['dtColSelect', 'currentColSelect'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el && !el.dataset.lrBound) {
            el.dataset.lrBound = 'true';
            el.addEventListener('change', function () {
                if (csvData.length > 0) {
                    onDataOrColumnsChanged();
                }
            });
        }
    });

    updateControlTypeUI();
}

if (typeof document$ !== 'undefined') {
    document$.subscribe(initLeakRateCalculator);
} else {
    document.addEventListener('DOMContentLoaded', initLeakRateCalculator);
}
