// Unit tests for the shared power-profile engine (assets/js/power-profile.js).
//
// This is the pure, DOM-free math behind the Power & Efficiency analyzer
// (power-pattern.html): CSV parsing, timestamp handling, 3-phase power, weekly
// aggregation / EFLH, day-type grouping, flow lookup and isentropic efficiency.
// power-efficiency.js is DOM/Plotly glue over these functions and is exercised
// manually in the browser; everything worth pinning lives here.
//
// Run with: npm test   (or: node --test)

const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerProfile: PP, makeSeries } = require('./helpers/load.js');

// Relative-tolerance float compare for the thermodynamics; exact assertions are
// used wherever the math is exact (power, interpolation, EFLH arithmetic).
function approx(actual, expected, epsilon) {
  epsilon = epsilon == null ? 1e-9 : epsilon;
  assert.ok(
    Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)),
    'expected ' + actual + ' ≈ ' + expected + ' (±' + epsilon + ' rel)'
  );
}

test('the engine loaded from the shipped file', () => {
  assert.equal(typeof PP, 'object');
  assert.equal(typeof PP.computePower, 'function');
});

// --- computePower --------------------------------------------------------

test.describe('computePower', () => {
  test.it('P = sqrt(3)*V*I*PF/1000', () => {
    // 460 V, 100 A, PF 0.9 -> 1.7320508 * 460 * 100 * 0.9 / 1000
    approx(PP.computePower({ voltage: 460, current: 100, powerFactor: 0.9 }),
      (Math.sqrt(3) * 460 * 100 * 0.9) / 1000);
  });

  test.it('defaults power factor to 1 (apparent power) when omitted', () => {
    approx(PP.computePower({ voltage: 460, current: 100 }),
      (Math.sqrt(3) * 460 * 100) / 1000);
  });

  test.it('is zero at zero current', () => {
    assert.equal(PP.computePower({ voltage: 460, current: 0, powerFactor: 0.9 }), 0);
  });
});

// --- isentropicEfficiency ------------------------------------------------

test.describe('isentropicEfficiency', () => {
  const pt = { cfm: 500, kw: 75, psi: 125, inletC: 20 };

  test.it('matches the hand-computed adiabatic value for a known point', () => {
    const r = PP.isentropicEfficiency(pt);
    assert.ok(r);
    // Reference values computed from the module's own constants.
    approx(r.idealPower, 75.56247831427287, 1e-6);
    approx(r.efficiency, 100.74997108569717, 1e-6);
    // specificPower is exact: kW / (CFM/100) = 75 / 5.
    assert.equal(r.specificPower, 15);
  });

  test.it('returns null for non-positive cfm, kw, or psi', () => {
    assert.equal(PP.isentropicEfficiency({ cfm: 0, kw: 75, psi: 125 }), null);
    assert.equal(PP.isentropicEfficiency({ cfm: 500, kw: 0, psi: 125 }), null);
    assert.equal(PP.isentropicEfficiency({ cfm: 500, kw: 75, psi: 0 }), null);
  });

  test.it('nets out zero-flow power, raising the reported efficiency', () => {
    const wireToAir = PP.isentropicEfficiency(pt);
    const net = PP.isentropicEfficiency(Object.assign({ zeroFlowKw: 10 }, pt));
    assert.ok(net.efficiency > wireToAir.efficiency);
    // Same ideal work, smaller denominator (kw - zeroFlow).
    approx(net.efficiency, wireToAir.idealPower / (75 - 10) * 100, 1e-9);
  });

  test.it('returns null when power is at or below the zero-flow draw', () => {
    assert.equal(PP.isentropicEfficiency({ cfm: 500, kw: 10, psi: 125, zeroFlowKw: 10 }), null);
    assert.equal(PP.isentropicEfficiency({ cfm: 500, kw: 8, psi: 125, zeroFlowKw: 10 }), null);
  });
});

// --- CSV parsing ---------------------------------------------------------

test.describe('splitCSVLine', () => {
  test.it('splits a plain line and trims fields', () => {
    assert.deepEqual(PP.splitCSVLine('a, b ,c'), ['a', 'b', 'c']);
  });

  test.it('honors quoted fields containing commas', () => {
    assert.deepEqual(PP.splitCSVLine('"x,y",z'), ['x,y', 'z']);
  });

  test.it('unescapes doubled quotes inside a quoted field', () => {
    assert.deepEqual(PP.splitCSVLine('"say ""hi""",b'), ['say "hi"', 'b']);
  });
});

test.describe('parseCSV', () => {
  test.it('returns headers and row objects keyed by header', () => {
    const r = PP.parseCSV('time,amps\n2024-01-01 00:00,100\n2024-01-01 00:15,120');
    assert.deepEqual(r.headers, ['time', 'amps']);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0], { time: '2024-01-01 00:00', amps: '100' });
  });

  test.it('strips a UTF-8 BOM and handles CRLF, skipping blank lines', () => {
    const r = PP.parseCSV('﻿time,amps\r\n2024-01-01,5\r\n\r\n2024-01-02,6\r\n');
    assert.deepEqual(r.headers, ['time', 'amps']);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[1].amps, '6');
  });

  test.it('returns empty structure for empty input', () => {
    assert.deepEqual(PP.parseCSV(''), { headers: [], rows: [] });
  });
});

// --- parseDateTime -------------------------------------------------------

test.describe('parseDateTime', () => {
  test.it('parses ISO date with space or T separator', () => {
    const a = PP.parseDateTime('2024-01-02 13:45');
    const b = PP.parseDateTime('2024-01-02T13:45:30');
    assert.equal(a.getFullYear(), 2024);
    assert.equal(a.getMonth(), 0);
    assert.equal(a.getDate(), 2);
    assert.equal(a.getHours(), 13);
    assert.equal(a.getMinutes(), 45);
    assert.equal(b.getSeconds(), 30);
  });

  test.it('parses a date-only ISO value at midnight', () => {
    const d = PP.parseDateTime('2024-03-04');
    assert.equal(d.getHours(), 0);
    assert.equal(d.getDate(), 4);
  });

  test.it('parses US MM/DD/YYYY with time', () => {
    const d = PP.parseDateTime('03/04/2024 08:15');
    assert.equal(d.getMonth(), 2); // March
    assert.equal(d.getDate(), 4);
    assert.equal(d.getHours(), 8);
  });

  test.it('returns null for empty or unparseable input', () => {
    assert.equal(PP.parseDateTime(''), null);
    assert.equal(PP.parseDateTime(null), null);
    assert.equal(PP.parseDateTime('not a date'), null);
  });
});

// --- buildSeries ---------------------------------------------------------

test.describe('buildSeries', () => {
  const rows = [
    { time: '2024-01-01 01:00', amps: '100' },
    { time: 'garbage', amps: '100' },        // bad timestamp -> skipped
    { time: '2024-01-01 00:00', amps: 'xyz' }, // bad current -> skipped
    { time: '2024-01-01 00:30', amps: '50' }
  ];
  const opts = { dtCol: 'time', currentCol: 'amps', voltage: 460, powerFactor: 0.9 };

  test.it('skips unparseable rows and sorts ascending by time', () => {
    const s = PP.buildSeries(rows, opts);
    assert.equal(s.length, 2);
    assert.ok(s[0].t < s[1].t);            // 00:30 before 01:00
    assert.equal(s[0].t.getMinutes(), 30);
  });

  test.it('applies computePower to each retained row', () => {
    const s = PP.buildSeries(rows, opts);
    approx(s[1].kW, PP.computePower({ voltage: 460, current: 100, powerFactor: 0.9 }));
  });
});

// --- detectTimestepMinutes ----------------------------------------------

test.describe('detectTimestepMinutes', () => {
  test.it('returns the median spacing in minutes', () => {
    const s = makeSeries([
      ['2024-01-01T00:00', 1], ['2024-01-01T00:15', 1],
      ['2024-01-01T00:30', 1], ['2024-01-01T00:45', 1]
    ]);
    assert.equal(PP.detectTimestepMinutes(s), 15);
  });

  test.it('is robust to a single large gap (median, not mean)', () => {
    const s = makeSeries([
      ['2024-01-01T00:00', 1], ['2024-01-01T00:15', 1],
      ['2024-01-01T00:30', 1], ['2024-01-01T06:30', 1] // 360-min gap
    ]);
    assert.equal(PP.detectTimestepMinutes(s), 15);
  });

  test.it('returns null for fewer than two samples', () => {
    assert.equal(PP.detectTimestepMinutes([]), null);
    assert.equal(PP.detectTimestepMinutes(makeSeries([['2024-01-01T00:00', 1]])), null);
  });
});

// --- linearInterpolate ---------------------------------------------------

test.describe('linearInterpolate', () => {
  test.it('interpolates within a segment', () => {
    assert.equal(PP.linearInterpolate(50, [0, 100], [0, 10]), 5);
    assert.equal(PP.linearInterpolate(25, [0, 40, 100], [0, 8, 20]), 5);
  });

  test.it('clamps to the endpoints outside the range', () => {
    assert.equal(PP.linearInterpolate(-5, [0, 100], [0, 10]), 0);
    assert.equal(PP.linearInterpolate(999, [0, 100], [0, 10]), 10);
  });

  test.it('returns null for an empty table', () => {
    assert.equal(PP.linearInterpolate(1, [], []), null);
  });
});

// --- weeklyProfile & dailyMeanPower --------------------------------------

test.describe('weeklyProfile / dailyMeanPower', () => {
  // 2024-01-01 is a Monday (getDay() === 1).
  const s = makeSeries([
    ['2024-01-01T09:00', 10], ['2024-01-01T09:30', 20], // Mon hour 9 -> mean 15
    ['2024-01-01T10:00', 30]                             // Mon hour 10 -> 30
  ]);

  test.it('averages power into (day, hour) cells with Sunday = 0', () => {
    const p = PP.weeklyProfile(s);
    assert.equal(p.meanKw[1][9], 15);
    assert.equal(p.meanKw[1][10], 30);
    assert.equal(p.count[1][9], 2);
    assert.equal(p.meanKw[0][9], null); // Sunday, no data
    assert.equal(p.meanKw[1][0], null); // Monday midnight, no data
  });

  test.it('dailyMeanPower averages per weekday, null where empty', () => {
    const m = PP.dailyMeanPower(s);
    approx(m[1], (10 + 20 + 30) / 3);
    assert.equal(m[0], null);
    assert.equal(m.length, 7);
  });
});

// --- eflh ----------------------------------------------------------------

test.describe('eflh', () => {
  // One Monday hour with two samples averaging 15 kW; nothing else.
  const s = makeSeries([
    ['2024-01-01T09:00', 10], ['2024-01-01T09:30', 20]
  ]);

  test.it('builds a representative week and scales to the year', () => {
    const r = PP.eflh(s, { nameplateKw: 30, weeksPerYear: 52 });
    assert.equal(r.weeklyKwh, 15);           // one hour-cell at mean 15 kW
    assert.equal(r.operatingHoursPerWeek, 1);
    assert.equal(r.avgPowerKw, 15);
    assert.equal(r.annualKwh, 15 * 52);      // weeklyKwh * weeksPerYear
    assert.equal(r.eflh, (15 * 52) / 30);    // annualKwh / nameplate
  });

  test.it('excludes non-operating days from the weekly total', () => {
    // Monday only; if we mark Monday non-operating, nothing counts.
    const off = [true, false, true, true, true, true, true]; // Mon = index 1 off
    const r = PP.eflh(s, { nameplateKw: 30, operatingDays: off });
    assert.equal(r.weeklyKwh, 0);
    assert.equal(r.eflh, 0);
  });

  test.it('returns eflh 0 when nameplate is non-positive', () => {
    const r = PP.eflh(s, { nameplateKw: 0 });
    assert.equal(r.eflh, 0);
    assert.equal(r.annualKwh, 15 * 52); // energy still computed
  });
});

// --- coverage ------------------------------------------------------------

test.describe('coverage', () => {
  test.it('reports span, per-weekday presence, and count', () => {
    const s = makeSeries([
      ['2024-01-01T00:00', 5], // Mon
      ['2024-01-03T00:00', 5]  // Wed, 2 days later
    ]);
    const c = PP.coverage(s);
    approx(c.spanDays, 2);
    assert.equal(c.nDaysWithData, 2);
    assert.equal(c.daysWithData[1], true);  // Mon
    assert.equal(c.daysWithData[3], true);  // Wed
    assert.equal(c.daysWithData[2], false); // Tue
  });
});

// --- autoGroupDays -------------------------------------------------------

test.describe('autoGroupDays', () => {
  test.it('splits a clear high/low week into Production and Non-Production', () => {
    // Mon-Fri ~100 kW (2024-01-01..05), Sat/Sun ~5 kW (2024-01-06..07).
    const pairs = [];
    [1, 2, 3, 4, 5].forEach((d) => pairs.push(['2024-01-0' + d + 'T09:00', 100]));
    pairs.push(['2024-01-06T09:00', 5]); // Sat
    pairs.push(['2024-01-07T09:00', 5]); // Sun
    const g = PP.autoGroupDays(makeSeries(pairs), 10);

    assert.equal(g.assignment.length, 7);
    assert.ok(g.buckets.length >= 2);
    assert.equal(g.buckets[0].name, 'Production');
    assert.equal(g.buckets[g.buckets.length - 1].name, 'Non-Production');
    // The five weekdays share the high bucket; Sat/Sun the low one.
    assert.equal(g.assignment[1], g.assignment[5]); // Mon == Fri
    assert.notEqual(g.assignment[1], g.assignment[6]); // Mon != Sat
  });

  test.it('always yields at least two buckets and files no-data weekdays last', () => {
    // Only Monday has data.
    const g = PP.autoGroupDays(makeSeries([['2024-01-01T09:00', 50]]), 10);
    assert.ok(g.buckets.length >= 2);
    const last = g.buckets.length - 1;
    assert.equal(g.assignment[0], last); // Sunday (no data) -> last bucket
    assert.equal(g.assignment[2], last); // Tuesday (no data) -> last bucket
  });
});

// --- bucketHourlyProfiles ------------------------------------------------

test.describe('bucketHourlyProfiles', () => {
  test.it('averages hourly power per bucket via the day assignment', () => {
    const s = makeSeries([
      ['2024-01-01T09:00', 100], // Mon
      ['2024-01-06T09:00', 20]   // Sat
    ]);
    // Mon (1) -> bucket 0, Sat (6) -> bucket 1, everything else bucket 1.
    const assignment = [1, 0, 1, 1, 1, 1, 1];
    const rows = PP.bucketHourlyProfiles(s, assignment, 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0][9], 100); // bucket 0, hour 9 (Monday)
    assert.equal(rows[1][9], 20);  // bucket 1, hour 9 (Saturday)
    assert.equal(rows[0][0], null); // no midnight data
  });
});

// --- flowForPower --------------------------------------------------------

test.describe('flowForPower', () => {
  const vfd = { type: 'vfd', power: [10, 40, 75], flow: [50, 250, 475] };

  test.it('interpolates the VFD power-flow curve', () => {
    assert.equal(PP.flowForPower(10, vfd), 50);
    assert.equal(PP.flowForPower(75, vfd), 475);
    approx(PP.flowForPower(25, vfd), 150); // midway between (10,50) and (40,250)
  });

  test.it('returns null for a VFD config with fewer than two points', () => {
    assert.equal(PP.flowForPower(30, { type: 'vfd', power: [10], flow: [50] }), null);
  });

  test.it('resolves non-VFD load/unload/off states by threshold', () => {
    const cfg = {
      type: 'nonvfd',
      loadedThreshold: 90, loadedFlow: 500,
      unloadedThreshold: 20, unloadedFlow: 0
    };
    assert.equal(PP.flowForPower(100, cfg), 500); // above loaded -> loaded flow
    assert.equal(PP.flowForPower(50, cfg), 0);    // between -> unloaded flow (0)
    assert.equal(PP.flowForPower(5, cfg), 0);     // below unloaded -> off (0)
  });

  test.it('returns null when config is missing', () => {
    assert.equal(PP.flowForPower(30, null), null);
  });
});

// --- suggestThreshold ----------------------------------------------------

test.describe('suggestThreshold', () => {
  test.it('is half the lowest VFD point', () => {
    assert.equal(PP.suggestThreshold({ type: 'vfd', power: [10, 40, 75] }), 5);
  });

  test.it('is half the unloaded power for a load/unload machine', () => {
    assert.equal(PP.suggestThreshold({ type: 'nonvfd', unloadedPower: 30 }), 15);
  });

  test.it('is NaN when it cannot be derived', () => {
    assert.ok(Number.isNaN(PP.suggestThreshold({ type: 'vfd', power: [] })));
    assert.ok(Number.isNaN(PP.suggestThreshold({ type: 'nonvfd', unloadedPower: 0 })));
    assert.ok(Number.isNaN(PP.suggestThreshold(null)));
  });
});

// --- averageOperatingPower -----------------------------------------------

test.describe('averageOperatingPower', () => {
  const s = makeSeries([
    ['2024-01-01T00:00', 5],   // below threshold
    ['2024-01-01T00:15', 40],
    ['2024-01-01T00:30', 60]
  ]);

  test.it('averages only samples at or above the threshold', () => {
    const r = PP.averageOperatingPower(s, 10);
    assert.equal(r.nSamples, 2);
    assert.equal(r.avgKw, 50);
  });

  test.it('returns zero average and count when nothing qualifies', () => {
    const r = PP.averageOperatingPower(s, 1000);
    assert.deepEqual(r, { avgKw: 0, nSamples: 0 });
  });
});

// --- averageOperatingFlow ------------------------------------------------

test.describe('averageOperatingFlow', () => {
  const vfd = { type: 'vfd', power: [10, 40, 75], flow: [50, 250, 475] };
  const s = makeSeries([
    ['2024-01-01T00:00', 2],   // below threshold, ignored
    ['2024-01-01T00:15', 40],  // flow 250
    ['2024-01-01T00:30', 75]   // flow 475
  ]);

  test.it('reconciles specific power with the mean kW and CFM', () => {
    const r = PP.averageOperatingFlow(s, vfd, 10);
    assert.equal(r.nSamples, 2);
    approx(r.avgKw, (40 + 75) / 2);
    approx(r.avgCfm, (250 + 475) / 2);
    // The reported specPower must equal avgKw / (avgCfm/100).
    approx(r.specPower, r.avgKw / (r.avgCfm / 100));
  });

  test.it('returns null when no sample yields positive flow', () => {
    assert.equal(PP.averageOperatingFlow(s, vfd, 1000), null);
  });
});

// --- timeWeightedEfficiency ----------------------------------------------

test.describe('timeWeightedEfficiency', () => {
  const vfd = { type: 'vfd', power: [10, 75], flow: [50, 500] };
  const s = makeSeries([
    ['2024-01-01T00:00', 2],   // below threshold
    ['2024-01-01T00:15', 40],
    ['2024-01-01T00:30', 60]
  ]);

  test.it('averages per-sample efficiency over qualifying samples', () => {
    const cond = { psi: 125, inletC: 20 };
    const r = PP.timeWeightedEfficiency(s, vfd, 10, cond);
    assert.ok(r);
    assert.equal(r.nSamples, 2);
    // Recompute the expected mean from the two qualifying samples.
    const e1 = PP.isentropicEfficiency({ cfm: PP.flowForPower(40, vfd), kw: 40, psi: 125, inletC: 20 });
    const e2 = PP.isentropicEfficiency({ cfm: PP.flowForPower(60, vfd), kw: 60, psi: 125, inletC: 20 });
    approx(r.effPct, (e1.efficiency + e2.efficiency) / 2, 1e-9);
  });

  test.it('returns null when nothing qualifies', () => {
    assert.equal(PP.timeWeightedEfficiency(s, vfd, 1000, { psi: 125 }), null);
  });
});

// --- specificPowerCurve --------------------------------------------------

test.describe('specificPowerCurve', () => {
  test.it('sweeps a VFD config into flow/specific-power points', () => {
    const c = PP.specificPowerCurve({ type: 'vfd', power: [10, 75], flow: [50, 500] }, 10);
    assert.equal(c.cfm.length, 10);
    assert.equal(c.specPower.length, 10);
    c.specPower.forEach((v) => assert.ok(v > 0));
  });

  test.it('yields the two discrete states for a load/unload config', () => {
    const c = PP.specificPowerCurve({
      type: 'nonvfd',
      unloadedPower: 25, unloadedFlow: 100,
      loadedPower: 100, loadedFlow: 500
    });
    assert.deepEqual(c.cfm, [100, 500]);
    assert.equal(c.specPower[0], 25 / (100 / 100)); // 25
    assert.equal(c.specPower[1], 100 / (500 / 100)); // 20
  });

  test.it('is empty for an unusable config', () => {
    assert.deepEqual(PP.specificPowerCurve(null), { cfm: [], specPower: [] });
    assert.deepEqual(PP.specificPowerCurve({ type: 'vfd', power: [10], flow: [50] }),
      { cfm: [], specPower: [] });
  });
});

// --- histogram -----------------------------------------------------------

test.describe('histogram', () => {
  test.it('bins values so counts sum to the sample count', () => {
    const s = makeSeries([
      ['2024-01-01T00:00', 0], ['2024-01-01T00:15', 5],
      ['2024-01-01T00:30', 10], ['2024-01-01T00:45', 10]
    ]);
    const h = PP.histogram(s, 5);
    assert.equal(h.counts.length, 5);
    assert.equal(h.counts.reduce((a, b) => a + b, 0), 4);
  });

  test.it('handles a single repeated value without dividing by zero', () => {
    const s = makeSeries([['2024-01-01T00:00', 7], ['2024-01-01T00:15', 7]]);
    const h = PP.histogram(s, 4);
    assert.equal(h.counts.reduce((a, b) => a + b, 0), 2);
    assert.ok(h.binCenters.every((c) => Number.isFinite(c)));
  });

  test.it('returns empty arrays for an empty series', () => {
    assert.deepEqual(PP.histogram([], 5), { binCenters: [], counts: [] });
  });
});
