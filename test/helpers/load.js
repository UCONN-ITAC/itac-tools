// Test-only loader for the shipped calculator engine.
//
// assets/js/power-profile.js is a browser IIFE that assigns
// `window.PowerProfile` — it has no CommonJS/ESM exports, so it can't be
// require()'d directly. Rather than add a module shim to production code, we
// wrap the file in a Function that receives a bare `window`, run it, and hand
// back the namespace it attaches. The shipped file stays untouched.
//
// We deliberately run it in THIS realm (via `new Function`, not `node:vm`):
// the engine returns plain arrays/objects, and running it in a separate vm
// context would give those a foreign Array/Object prototype, breaking
// `assert.deepStrictEqual` ("same structure but not reference-equal"). The
// engine only reads the `window` free variable — Date/Math/parseFloat/etc.
// resolve to the host globals.

const fs = require('node:fs');
const path = require('node:path');

function loadPowerProfile() {
  const file = path.join(__dirname, '../../assets/js/power-profile.js');
  const code = fs.readFileSync(file, 'utf8');
  const factory = new Function('window', code + '\nreturn window.PowerProfile;');
  return factory({});
}

// Build a [{ t: Date, kW }] series fixture for the aggregation tests.
//
// Accepts an array of [isoString, kW] pairs, e.g.
//   makeSeries([['2024-01-01T00:00', 10], ['2024-01-01T00:15', 20]])
// The Date is constructed from the string via `new Date(...)`, matching how
// the engine reads local-time timestamps (getDay()/getHours()).
function makeSeries(pairs) {
  return pairs.map(function (p) {
    return { t: new Date(p[0]), kW: p[1] };
  });
}

module.exports = {
  PowerProfile: loadPowerProfile(),
  loadPowerProfile: loadPowerProfile,
  makeSeries: makeSeries
};
