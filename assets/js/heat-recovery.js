// Compressor Heat Recovery Calculator.
//
// Aligned with the NYS Joint Utilities "Compressed Air Heat Recovery" C&I
// measure (Dec 12, 2025). Implements the TRM's two savings equations:
//
//   ΔkWh   = (hpcomp·LF·RE·hrs·0.746 / COPheating)·FElecHeat − (hpfan·0.746·hrs / Efffan)
//   ΔMMBtu = (hpcomp·LF·RE·hrs·0.746 / Effheating)·FFuelHeat · 3412/1e6
//
// where the recovered electrical-equivalent heat is the compressor motor input
// (brake power × load factor) times the recovery efficiency, the displaced
// heating is divided by the efficiency/COP of the system it offsets, and the
// distribution fan is always an electric penalty. Peak demand savings are N/A
// per the measure and are not calculated.
//
// Coincident heating hours diverge from the TRM's NY-only lookup table: they are
// computed as hours below a 63°F balance point within the operating schedule,
// from 2014–2023 hourly climate normals (Open-Meteo/ERA5), for representative
// cities across NY, NJ, and New England. The 63°F balance point is calibrated to
// reproduce the TRM's New York City continuous value (5,552 hrs). Values are
// overridable ("from application").
//
// Functions called from inline onclick=/onchange= attributes MUST remain global,
// so this file is not wrapped in an IIFE. Initialization runs via document$.

// Conversion constants
const HR_KW_PER_HP = 0.746;   // kW per horsepower
const HR_BTU_PER_KWH = 3412;  // Btu per kWh

// Fossil heating fuels. Electric heating is handled separately via COP.
const HR_FUEL_DEFAULTS = {
    'natural-gas': { hoc: 1000000, cost: 15.00, efficiency: 85, unit: 'MMBtu', costLabel: '$/MMBtu for natural gas',   hocLabel: '1,000,000 Btu/MMBtu (by definition)' },
    'propane':     { hoc: 1000000, cost: 27.00, efficiency: 85, unit: 'MMBtu', costLabel: '$/MMBtu for propane',       hocLabel: '1,000,000 Btu/MMBtu (by definition)' },
    'fuel-oil':    { hoc: 1000000, cost: 25.00, efficiency: 83, unit: 'MMBtu', costLabel: '$/MMBtu for No. 2 fuel oil', hocLabel: '1,000,000 Btu/MMBtu (by definition)' }
};

// Annual compressor hours coincident with heating demand, by location and
// operating schedule. Computed from 2014–2023 hourly temperatures (hours below a
// 63°F balance point within each schedule window). Schedule windows follow TRM
// footnote 510: Single 7am–3pm M–F, Two 7am–11pm M–F, Three 24h M–F, Continuous
// 24/7.
const HR_HEATING_HOURS = {
    "Albany": { state: "New York", single: 1378, two: 2656, three: 4308, cont: 6064 },
    "Binghamton": { state: "New York", single: 1390, two: 2691, three: 4384, cont: 6182 },
    "Buffalo": { state: "New York", single: 1395, two: 2725, three: 4379, cont: 6161 },
    "Massena": { state: "New York", single: 1458, two: 2841, three: 4574, cont: 6417 },
    "New York City": { state: "New York", single: 1271, two: 2479, three: 3961, cont: 5578 },
    "Poughkeepsie": { state: "New York", single: 1328, two: 2576, three: 4166, cont: 5875 },
    "Syracuse": { state: "New York", single: 1385, two: 2697, three: 4346, cont: 6114 },
    "Newark": { state: "New Jersey", single: 1250, two: 2444, three: 3925, cont: 5531 },
    "Atlantic City": { state: "New Jersey", single: 1171, two: 2320, three: 3708, cont: 5233 },
    "Trenton": { state: "New Jersey", single: 1217, two: 2352, three: 3810, cont: 5376 },
    "Hartford": { state: "Connecticut", single: 1319, two: 2583, three: 4185, cont: 5898 },
    "Bridgeport": { state: "Connecticut", single: 1319, two: 2589, three: 4095, cont: 5765 },
    "Providence": { state: "Rhode Island", single: 1319, two: 2628, three: 4227, cont: 5952 },
    "Boston": { state: "Massachusetts", single: 1346, two: 2674, three: 4276, cont: 6019 },
    "Worcester": { state: "Massachusetts", single: 1379, two: 2725, three: 4385, cont: 6175 },
    "Pittsfield": { state: "Massachusetts", single: 1427, two: 2805, three: 4523, cont: 6378 },
    "Burlington": { state: "Vermont", single: 1466, two: 2853, three: 4539, cont: 6368 },
    "Rutland": { state: "Vermont", single: 1448, two: 2835, three: 4589, cont: 6455 },
    "Concord": { state: "New Hampshire", single: 1406, two: 2761, three: 4471, cont: 6294 },
    "Manchester": { state: "New Hampshire", single: 1389, two: 2734, three: 4416, cont: 6213 },
    "Portland": { state: "Maine", single: 1455, two: 2918, three: 4613, cont: 6480 },
    "Bangor": { state: "Maine", single: 1477, two: 2956, three: 4749, cont: 6678 },
    "Caribou": { state: "Maine", single: 1610, two: 3165, three: 5066, cont: 7120 },
};

const HR_SCHEDULE_KEYS = { 'single': 'single', 'two': 'two', 'three': 'three', 'continuous': 'cont' };

function hrFormatNumber(num, decimals = 0) {
    if (!isFinite(num)) num = 0;
    return num.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

// Populate the location <select>, grouped by state.
function hrPopulateLocations() {
    const sel = document.getElementById('hrLocation');
    if (!sel || sel.dataset.hrPopulated) return;
    sel.dataset.hrPopulated = 'true';

    const byState = {};
    for (const [city, v] of Object.entries(HR_HEATING_HOURS)) {
        (byState[v.state] = byState[v.state] || []).push(city);
    }
    const stateOrder = ['New York', 'New Jersey', 'Connecticut', 'Rhode Island',
                        'Massachusetts', 'Vermont', 'New Hampshire', 'Maine'];
    for (const state of stateOrder) {
        const group = document.createElement('optgroup');
        group.label = state;
        for (const city of byState[state]) {
            const opt = document.createElement('option');
            opt.value = city;
            opt.textContent = city;
            group.appendChild(opt);
        }
        sel.appendChild(group);
    }
    sel.value = 'New York City';
}

// Recompute coincident heating hours from location + schedule and write them into
// the (editable) hours field. Skipped when the schedule is "custom" so a manual
// override survives.
function hrUpdateHeatingHours() {
    const schedule = document.getElementById('hrSchedule').value;
    const hoursInput = document.getElementById('coincidentHours');
    if (schedule === 'custom') {
        hoursInput.readOnly = false;
        hrCalculate();
        return;
    }
    const location = document.getElementById('hrLocation').value;
    const row = HR_HEATING_HOURS[location];
    if (row) {
        hoursInput.value = row[HR_SCHEDULE_KEYS[schedule]];
    }
    hoursInput.readOnly = true;
    hrCalculate();
}

function hrUpdateFuelDefaults() {
    const fuelType = document.getElementById('fuelType').value;
    const isElectric = fuelType === 'electric';

    document.getElementById('hrFossilParams').style.display = isElectric ? 'none' : '';
    document.getElementById('hrElectricParams').style.display = isElectric ? '' : 'none';

    if (!isElectric) {
        const defaults = HR_FUEL_DEFAULTS[fuelType];
        document.getElementById('fuelHoC').value = defaults.hoc;
        document.getElementById('fuelCost').value = defaults.cost;
        document.getElementById('heatingEfficiency').value = defaults.efficiency;
        document.getElementById('fuelCostLabel').textContent = defaults.costLabel;
        document.getElementById('fuelHoCLabel').textContent = defaults.hocLabel;
    }
    hrCalculate();
}

function hrUpdateHeatingCOP() {
    const type = document.getElementById('elecHeatType').value;
    if (type !== 'custom') {
        document.getElementById('heatingCOP').value = type === 'heat-pump' ? '3.2' : '1.0';
    }
    hrCalculate();
}

let hrCalculationResults = null;

function hrCalculate() {
    const motorPower = parseFloat(document.getElementById('motorPower').value);
    const powerUnit = document.getElementById('powerUnit').value;
    const loadFactor = parseFloat(document.getElementById('loadFactor').value);
    const RE = parseFloat(document.getElementById('recoveryEfficiency').value);
    const hrs = parseFloat(document.getElementById('coincidentHours').value);
    const fuelType = document.getElementById('fuelType').value;
    const elecRate = parseFloat(document.getElementById('hrElecRate').value) || 0;
    const fanHp = parseFloat(document.getElementById('fanHp').value) || 0;
    const fanEff = parseFloat(document.getElementById('fanEff').value);

    const isElectric = fuelType === 'electric';

    // Compressor motor input, as electrical-equivalent power (kW). Brake hp × 0.746.
    const motorKW = powerUnit === 'hp' ? motorPower * HR_KW_PER_HP : motorPower;

    // Recovered heat rate at average load (kW) and its Btu/hr equivalent.
    const recoveredKW = motorKW * loadFactor * RE;
    const recoveredHeatBtuHr = recoveredKW * HR_BTU_PER_KWH;

    // Annual recovered heat (electrical-equivalent kWh, Btu, MMBtu).
    const recoveredKWh = recoveredKW * hrs;
    const recoveredBtu = recoveredKWh * HR_BTU_PER_KWH;
    const recoveredMMBtu = recoveredBtu / 1e6;

    // Distribution fan electric penalty (always electric): hpfan·0.746·hrs / Efffan.
    const fanKWh = fanEff > 0 ? (fanHp * HR_KW_PER_HP * hrs) / fanEff : 0;
    const fanCost = fanKWh * elecRate;

    let fossilMMBtu = 0;
    let fuelDisplaced = 0;      // in the fuel's own units
    let fuelUnit = '';
    let fuelSavings = 0;
    let heatingKWh = 0;         // electric heating displaced (kWh)
    let deltaKWh = -fanKWh;     // net electric energy savings (ΔkWh)
    let heatingCOP = null;
    let totalCostSavings = 0;

    if (isElectric) {
        heatingCOP = parseFloat(document.getElementById('heatingCOP').value) || 1;
        heatingKWh = recoveredKWh / heatingCOP;
        deltaKWh = heatingKWh - fanKWh;
        fuelDisplaced = heatingKWh;
        fuelUnit = 'kWh';
        totalCostSavings = deltaKWh * elecRate;
    } else {
        const heatingEfficiency = parseFloat(document.getElementById('heatingEfficiency').value) / 100;
        const fuelCost = parseFloat(document.getElementById('fuelCost').value);
        const fuelHoC = parseFloat(document.getElementById('fuelHoC').value);
        fuelUnit = HR_FUEL_DEFAULTS[fuelType].unit;

        // Fuel input displaced = useful heat delivered / heating efficiency.
        const fuelInputBtu = recoveredBtu / heatingEfficiency;
        fossilMMBtu = fuelInputBtu / 1e6;
        fuelDisplaced = fuelInputBtu / fuelHoC;
        fuelSavings = fuelDisplaced * fuelCost;
        // Fan runs on electricity regardless of the displaced heating fuel.
        totalCostSavings = fuelSavings - fanCost;
    }

    hrCalculationResults = {
        motorKW, recoveredKW, recoveredHeatBtuHr, hrs, recoveredKWh, recoveredMMBtu,
        fanKWh, fanCost, isElectric, fossilMMBtu, fuelDisplaced, fuelUnit, fuelSavings,
        heatingKWh, heatingCOP, deltaKWh, totalCostSavings
    };

    hrRenderResults();
    hrGenerateLatex();
}

function hrRenderResults() {
    const r = hrCalculationResults;
    if (!r) return;

    document.getElementById('hrInputKwResult').textContent = `${hrFormatNumber(r.motorKW, 1)} kW`;
    document.getElementById('hrRecoverableResult').textContent = `${hrFormatNumber(r.recoveredHeatBtuHr)} Btu/hr`;
    document.getElementById('hrHeatingHoursResult').textContent = `${hrFormatNumber(r.hrs)} hrs`;

    document.getElementById('hrAnnualHeatResult').textContent = `${hrFormatNumber(r.recoveredMMBtu, 1)} MMBtu`;

    // Displaced-energy tile adapts to fuel type.
    document.getElementById('hrDisplacedLabel').textContent = r.isElectric
        ? 'Electric Heating Displaced' : 'Annual Fuel Displaced';
    document.getElementById('hrFuelDisplacedResult').textContent = r.isElectric
        ? `${hrFormatNumber(r.fuelDisplaced)} kWh`
        : `${hrFormatNumber(r.fuelDisplaced, 1)} ${r.fuelUnit}`;

    // Fan penalty tile.
    document.getElementById('hrFanKwhResult').textContent = `−${hrFormatNumber(r.fanKWh)} kWh`;
    document.getElementById('hrFanCostResult').textContent = `−$${hrFormatNumber(r.fanCost)}`;

    // TRM output tiles: ΔkWh and ΔMMBtu.
    const dk = document.getElementById('hrDeltaKwhResult');
    dk.textContent = `${r.deltaKWh < 0 ? '−' : ''}${hrFormatNumber(Math.abs(r.deltaKWh))} kWh`;
    dk.style.color = r.deltaKWh < 0 ? '#e5534b' : '#20bf55';
    document.getElementById('hrDeltaMMBtuResult').textContent = `${hrFormatNumber(r.fossilMMBtu, 1)} MMBtu`;

    // Net dollars.
    const net = document.getElementById('hrNetSavingsResult');
    net.textContent = `${r.totalCostSavings < 0 ? '−' : ''}$${hrFormatNumber(Math.abs(r.totalCostSavings))}`;
    net.style.color = r.totalCostSavings < 0 ? '#e5534b' : '#20bf55';
}

function hrGenerateLatex() {
    if (!hrCalculationResults) return;
    const r = hrCalculationResults;

    const motorPower = parseFloat(document.getElementById('motorPower').value);
    const powerUnit = document.getElementById('powerUnit').value;
    const loadFactor = parseFloat(document.getElementById('loadFactor').value);
    const RE = parseFloat(document.getElementById('recoveryEfficiency').value);
    const fanHp = parseFloat(document.getElementById('fanHp').value) || 0;
    const fanEff = parseFloat(document.getElementById('fanEff').value);
    const unitLabel = powerUnit === 'hp' ? 'HP' : 'kW';

    let rows = `Compressor Motor Power & ${hrFormatNumber(motorPower)} & ${unitLabel} \\\\
Load Factor (LF) & ${loadFactor.toFixed(2)} & \\\\
Recovery Efficiency (RE) & ${RE.toFixed(2)} & \\\\
Compressor Input Power & ${hrFormatNumber(r.motorKW, 1)} & kW \\\\
Recovered Heat (avg load) & ${hrFormatNumber(r.recoveredHeatBtuHr)} & Btu/hr \\\\
Coincident Heating Hours & ${hrFormatNumber(r.hrs)} & hrs/yr \\\\
Annual Heat Recovered & ${hrFormatNumber(r.recoveredMMBtu, 1)} & MMBtu/yr \\\\
Distribution Fan Motor & ${hrFormatNumber(fanHp)} & hp \\\\
Fan Motor Efficiency & ${fanEff.toFixed(3)} & \\\\
\\midrule`;

    if (r.isElectric) {
        const elecRate = parseFloat(document.getElementById('hrElecRate').value) || 0;
        rows += `
Heating COP & ${r.heatingCOP.toFixed(2)} & \\\\
Electric Heating Displaced & ${hrFormatNumber(r.heatingKWh)} & kWh/yr \\\\
Fan Energy Penalty & ${hrFormatNumber(r.fanKWh)} & kWh/yr \\\\
Net Electric Savings ($\\Delta$kWh) & ${hrFormatNumber(r.deltaKWh)} & kWh/yr \\\\
Electricity Rate & \\$${elecRate.toFixed(3)} & /kWh \\\\
\\midrule
Net Annual Savings & \\$${hrFormatNumber(r.totalCostSavings)} & /yr \\\\`;
    } else {
        const heatingEfficiency = parseFloat(document.getElementById('heatingEfficiency').value);
        const fuelCost = parseFloat(document.getElementById('fuelCost').value);
        const elecRate = parseFloat(document.getElementById('hrElecRate').value) || 0;
        rows += `
Heating System Efficiency & ${heatingEfficiency}\\% & \\\\
Fuel Displaced ($\\Delta$MMBtu) & ${hrFormatNumber(r.fuelDisplaced, 1)} & ${r.fuelUnit}/yr \\\\
Fuel Cost & \\$${fuelCost.toFixed(2)} & /${r.fuelUnit} \\\\
Fuel Cost Savings & \\$${hrFormatNumber(r.fuelSavings)} & /yr \\\\
Fan Energy Penalty & ${hrFormatNumber(r.fanKWh)} & kWh/yr \\\\
Fan Cost (@ \\$${elecRate.toFixed(3)}/kWh) & \\$${hrFormatNumber(r.fanCost)} & /yr \\\\
\\midrule
Net Annual Savings & \\$${hrFormatNumber(r.totalCostSavings)} & /yr \\\\`;
    }

    const latex = `\\begin{table}[htbp]
\\centering
\\caption{Compressor Heat Recovery Savings Analysis}
\\label{tab:heat-recovery}
\\begin{tabular}{@{}lrl@{}}
\\toprule
Parameter & Value & Unit \\\\
\\midrule
${rows}
\\bottomrule
\\end{tabular}
\\end{table}`;

    document.getElementById('hrLatexCode').textContent = latex;
}

function hrToggleLatex() {
    const content = document.getElementById('hrLatexContent');
    const button = document.getElementById('hrLatexToggle');
    const copyButton = document.getElementById('hrCopyButton');

    if (content.style.display === 'none') {
        content.style.display = 'block';
        button.textContent = 'Hide LaTeX Table';
        copyButton.style.display = 'inline-block';
    } else {
        content.style.display = 'none';
        button.textContent = 'Show LaTeX Table';
        copyButton.style.display = 'none';
    }
}

function hrCopyLatex() {
    hrCopyText(document.getElementById('hrLatexCode').textContent, document.getElementById('hrCopyButton'));
}

function hrToggleEquations() {
    const content = document.getElementById('hrEquationsContent');
    const button = document.getElementById('hrEquationsToggle');
    const copyButton = document.getElementById('hrCopyEquationsButton');

    if (content.style.display === 'none') {
        hrGenerateEquationsLatex();
        content.style.display = 'block';
        button.textContent = 'Hide LaTeX Equations';
        copyButton.style.display = 'inline-block';
    } else {
        content.style.display = 'none';
        button.textContent = 'Show LaTeX Equations';
        copyButton.style.display = 'none';
    }
}

function hrGenerateEquationsLatex() {
    if (!hrCalculationResults) {
        document.getElementById('hrEquationsCode').textContent = 'Please run calculations first.';
        return;
    }
    const r = hrCalculationResults;

    const motorPower = parseFloat(document.getElementById('motorPower').value);
    const powerUnit = document.getElementById('powerUnit').value;
    const loadFactor = parseFloat(document.getElementById('loadFactor').value);
    const RE = parseFloat(document.getElementById('recoveryEfficiency').value);
    const fanHp = parseFloat(document.getElementById('fanHp').value) || 0;
    const fanEff = parseFloat(document.getElementById('fanEff').value);
    const elecRate = parseFloat(document.getElementById('hrElecRate').value) || 0;
    const unitLabel = powerUnit === 'hp' ? 'HP' : 'kW';
    const powerToKW = powerUnit === 'hp'
        ? `${motorPower} \\times 0.746 = ${hrFormatNumber(r.motorKW, 1)}`
        : `${hrFormatNumber(r.motorKW, 1)}`;

    let latex = `\\section*{Compressor Heat Recovery Savings Calculation}

\\subsection*{System Parameters}

\\begin{itemize}
    \\item Compressor motor power: ${motorPower} ${unitLabel}
    \\item Load factor (LF): ${loadFactor}
    \\item Recovery efficiency (RE): ${RE}
    \\item Coincident heating hours: ${hrFormatNumber(r.hrs)} hrs/yr
    \\item Distribution fan: ${fanHp} hp at ${fanEff} efficiency
\\end{itemize}

\\subsection*{Recovered Heat}

The compressor input power and annual recovered heat (electrical equivalent) are:

\\begin{equation}
P_{\\text{comp}} = ${powerToKW} \\text{ kW}
\\end{equation}

\\begin{equation}
Q_{\\text{rec}} = P_{\\text{comp}} \\times LF \\times RE \\times hrs = ${hrFormatNumber(r.motorKW, 1)} \\times ${loadFactor} \\times ${RE} \\times ${hrFormatNumber(r.hrs)} = ${hrFormatNumber(r.recoveredKWh)} \\text{ kWh}
\\label{eq:recovered}
\\end{equation}

\\subsection*{Distribution Fan Penalty}

The distribution fan is an electric load in all cases:

\\begin{equation}
\\Delta kWh_{\\text{fan}} = \\frac{hp_{\\text{fan}} \\times 0.746 \\times hrs}{Eff_{\\text{fan}}} = \\frac{${fanHp} \\times 0.746 \\times ${hrFormatNumber(r.hrs)}}{${fanEff}} = ${hrFormatNumber(r.fanKWh)} \\text{ kWh}
\\label{eq:fan}
\\end{equation}`;

    if (r.isElectric) {
        latex += `

\\subsection*{Electric Heating Displaced}

Recovered heat offsets electric heating with coefficient of performance $COP = ${r.heatingCOP}$:

\\begin{equation}
kWh_{\\text{heat}} = \\frac{Q_{\\text{rec}}}{COP} = \\frac{${hrFormatNumber(r.recoveredKWh)}}{${r.heatingCOP}} = ${hrFormatNumber(r.heatingKWh)} \\text{ kWh}
\\label{eq:elec-heat}
\\end{equation}

\\subsection*{Net Electric Savings}

\\begin{equation}
\\Delta kWh = kWh_{\\text{heat}} - \\Delta kWh_{\\text{fan}} = ${hrFormatNumber(r.heatingKWh)} - ${hrFormatNumber(r.fanKWh)} = ${hrFormatNumber(r.deltaKWh)} \\text{ kWh}
\\label{eq:delta-kwh}
\\end{equation}

\\begin{equation}
\\text{Net Annual Savings} = \\Delta kWh \\times \\$${elecRate.toFixed(3)} = \\$${hrFormatNumber(r.totalCostSavings)}
\\label{eq:elec-savings}
\\end{equation}`;
    } else {
        const heatingEfficiency = parseFloat(document.getElementById('heatingEfficiency').value) / 100;
        const fuelCost = parseFloat(document.getElementById('fuelCost').value);
        latex += `

\\subsection*{Fossil Fuel Displaced}

Recovered heat offsets a fossil heating system of efficiency $Eff_{\\text{heat}} = ${heatingEfficiency.toFixed(2)}$:

\\begin{equation}
\\Delta MMBtu = \\frac{Q_{\\text{rec}} \\times 3{,}412}{Eff_{\\text{heat}} \\times 10^6} = \\frac{${hrFormatNumber(r.recoveredKWh)} \\times 3{,}412}{${heatingEfficiency.toFixed(2)} \\times 10^6} = ${hrFormatNumber(r.fossilMMBtu, 1)} \\text{ MMBtu}
\\label{eq:mmbtu}
\\end{equation}

\\subsection*{Net Annual Savings}

Fuel savings less the electric fan penalty:

\\begin{equation}
\\begin{split}
\\text{Net Savings} &= \\Delta MMBtu \\times \\$${fuelCost.toFixed(2)} - \\Delta kWh_{\\text{fan}} \\times \\$${elecRate.toFixed(3)} \\\\
&= \\$${hrFormatNumber(r.fuelSavings)} - \\$${hrFormatNumber(r.fanCost)} = \\$${hrFormatNumber(r.totalCostSavings)}
\\end{split}
\\label{eq:fossil-savings}
\\end{equation}`;
    }

    document.getElementById('hrEquationsCode').textContent = latex;
}

function hrCopyEquations() {
    hrCopyText(document.getElementById('hrEquationsCode').textContent, document.getElementById('hrCopyEquationsButton'));
}

function hrCopyText(text, btn) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => hrShowCopySuccess(btn)).catch(() => hrFallbackCopy(text, btn));
    } else {
        hrFallbackCopy(text, btn);
    }
}

function hrFallbackCopy(text, btn) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        document.execCommand('copy');
        hrShowCopySuccess(btn);
    } catch (err) {
        btn.textContent = 'Copy failed';
        setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 2000);
    }
    document.body.removeChild(textArea);
}

function hrShowCopySuccess(btn) {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 2000);
}

// Initialize on every page load (including instant-nav swaps). Bails out unless
// this calculator's root element is present, and guards against double-binding
// listeners when the user revisits the page without a hard reload.
function hrInitCalculator() {
    const root = document.getElementById('heat-recovery-calculator');
    if (!root) return;

    hrPopulateLocations();

    root.querySelectorAll('input, select').forEach(input => {
        if (input.dataset.hrBound) return;
        input.dataset.hrBound = 'true';
        input.addEventListener('change', hrCalculate);
        input.addEventListener('input', hrCalculate);
    });

    hrUpdateFuelDefaults();
    hrUpdateHeatingHours();
    hrCalculate();
}

if (typeof document$ !== 'undefined') {
    document$.subscribe(hrInitCalculator);
} else {
    document.addEventListener('DOMContentLoaded', hrInitCalculator);
}
