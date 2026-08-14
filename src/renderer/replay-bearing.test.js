// A stopped sample keeps its entry heading; only pre-departure samples look
// ahead. Reverse orientation follows the samples that supplied the bearing.
// Browser-only functions are extracted from renderer.js with geodesicM injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import calc from '../shared/drive-calc.cjs';

const src = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');

function extractFn(name) {
  const i = src.indexOf(`function ${name}(`);
  assert.notEqual(i, -1, `function ${name} found in renderer.js`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  assert.fail(`unbalanced braces extracting ${name}`);
}

const code = [
  src.match(/^const (?:MIN|MAX)_BEARING_\w+\s*=.*$/gm).join('\n'),
  extractFn('calcBearing'),
  extractFn('smoothBearing'),
  extractFn('findBearingNear'),
].join('\n\n');
const { findBearingNear, smoothBearing } =
  new Function('geodesicM', `${code}; return { findBearingNear, smoothBearing };`)(calc.geodesicM);

// ── Synthetic 1 Hz tracks near lat 0 (1e-5 deg ≈ 1.113 m) ───────────────────
const STEP = 8.983e-5; // ≈ 10 m/sample (10 m/s)
const JIT = 2.2e-6;    // ≈ 0.25 m GPS multipath wiggle while stopped

// gearStates: 0=P, 1=D, 2=R. Point speed is signed as recorded by SEI.
function build(segments) {
  const pts = [], gears = [];
  let lat = 0, lng = 0, t = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.n; i++) {
      if (seg.move === 'east') lng += STEP;
      else if (seg.move === 'north') lat += STEP;
      else if (seg.move === 'south') lat -= STEP;
      const jl = seg.move ? 0 : (i % 2 ? JIT : 0);
      pts.push([lat, lng + jl, t++, seg.speed ?? (seg.move ? 10 : 0)]);
      gears.push(seg.gear);
    }
  }
  return { pts, gears };
}

const assertHeading = (got, want, msg) => {
  assert.notEqual(got, null, `${msg} (got null)`);
  const diff = Math.abs(((got - want + 540) % 360) - 180);
  assert.ok(diff <= 15, `${msg}: want ~${want}°, got ${got.toFixed(1)}° (off ${diff.toFixed(1)}°)`);
};

test('stopped at a light before a left turn — faces the entry heading', () => {
  const { pts, gears } = build([
    { n: 20, move: 'east', gear: 1 },
    { n: 20, move: null, gear: 1 },
    { n: 20, move: 'north', gear: 1 },
  ]);
  assertHeading(findBearingNear(pts, 35, 7, gears), 90, 'late-stop heading');
});

test('moving sample — faces its own travel bearing', () => {
  const { pts, gears } = build([
    { n: 20, move: 'east', gear: 1 },
    { n: 20, move: null, gear: 1 },
    { n: 20, move: 'north', gear: 1 },
  ]);
  assertHeading(findBearingNear(pts, 50, 7, gears), 0, 'northbound sample');
  assertHeading(findBearingNear(pts, 10, 7, gears), 90, 'eastbound sample');
});

test('parked after backing in — faces away from the reverse travel', () => {
  const { pts, gears } = build([
    { n: 15, move: 'east', gear: 1 },
    { n: 10, move: 'south', gear: 2, speed: -10 }, // backing south ⇒ nose points north
    { n: 30, move: null, gear: 0 },
  ]);
  assertHeading(findBearingNear(pts, 40, 7, gears), 0, 'parked-after-reverse heading');
});

test('deep inside a long stop — still the entry heading, never stale', () => {
  const { pts, gears } = build([
    { n: 20, move: 'east', gear: 1 },
    { n: 120, move: null, gear: 1 }, // 2 min — beyond any bounded search radius
    { n: 20, move: 'north', gear: 1 },
  ]);
  assertHeading(findBearingNear(pts, 80, 7, gears), 90, 'long-stop heading');
});

test('pre-departure idle — only the road ahead exists, look ahead', () => {
  const { pts, gears } = build([
    { n: 20, move: null, gear: 0 },
    { n: 20, move: 'north', gear: 1 },
  ]);
  assertHeading(findBearingNear(pts, 5, 7, gears), 0, 'pre-departure heading');
});

test('no confident heading anywhere — returns null so the caller holds', () => {
  const { pts, gears } = build([{ n: 40, move: null, gear: 0 }]);
  assert.equal(findBearingNear(pts, 20, 7, gears), null);
});

// ── SEI cadence (~10 points/s) ───────────────────────────────────────────────
// Speed evidence expands the short default window at this cadence.

// East, then a 90° left turn, then north at 2 m/s and 10 Hz.
function buildSlowTurn10Hz() {
  const pts = [], gears = [];
  let lat = 0, lng = 0, t = 0;
  const push = (headingDeg, speed) => {
    const rad = (headingDeg * Math.PI) / 180;
    const stepM = speed / 10;
    lat += (stepM * Math.cos(rad)) / 111320;
    lng += (stepM * Math.sin(rad)) / 111320;
    pts.push([lat, lng, (t += 100), speed]);
    gears.push(1);
  };
  for (let i = 0; i < 30; i++) push(90, 2);
  for (let i = 0; i < 60; i++) push(90 - (i + 0.5) * 1.5, 2);
  for (let i = 0; i < 30; i++) push(0, 2);
  return { pts, gears };
}

test('10 Hz at ~4.5 mph — playback bearing keeps updating (froze below 5 mph)', () => {
  const { pts, gears } = buildSlowTurn10Hz();
  const straight = smoothBearing(pts, 15, 7, gears);
  assertHeading(straight, 90, 'slow straight roll');
  const midTurn = smoothBearing(pts, 60, 7, gears);
  assertHeading(midTurn, 45, 'slow mid-turn');
});

test('10 Hz at ~4.5 mph — scrubbing matches the local heading too', () => {
  const { pts, gears } = buildSlowTurn10Hz();
  assertHeading(findBearingNear(pts, 60, 7, gears), 45, 'scrub mid-turn');
  assertHeading(findBearingNear(pts, 110, 7, gears), 0, 'scrub northbound exit');
});

test('reversing at 10 Hz — negative speed still proves motion (arrow froze in R)', () => {
  // Signed speed magnitude proves movement; reverse then flips the nose.
  const pts = [], gears = [];
  let lat = 0, t = 0;
  for (let i = 0; i < 100; i++) {
    lat -= 2 / 10 / 111320; // 2 m/s south, 10 Hz
    pts.push([lat, 0, (t += 100), -2]);
    gears.push(2);
  }
  assertHeading(smoothBearing(pts, 50, 7, gears), 180, 'reverse travel bearing (playback)');
  assertHeading(findBearingNear(pts, 50, 7, gears), 0, 'nose direction while backing (scrub)');
});

test('back-in maneuver at 10 Hz — bearing never mixes travel across the D→R shift', () => {
  // Bearing windows must not cross the D→R boundary.
  const pts = [], gears = [];
  let lat = 0, lng = 0, t = 0;
  for (let i = 0; i < 40; i++) {
    lng += 2 / 10 / 111320; // east in D
    pts.push([lat, lng, (t += 100), 2]);
    gears.push(1);
  }
  for (let i = 0; i < 60; i++) {
    lat += 2 / 10 / 111320; // backing north in R
    pts.push([lat, lng, (t += 100), -2]);
    gears.push(2);
  }
  assertHeading(smoothBearing(pts, 50, 7, gears), 0, 'reverse travel bearing (playback)');
  assertHeading(findBearingNear(pts, 50, 7, gears), 180, 'nose direction while backing (scrub)');
  assertHeading(smoothBearing(pts, 35, 7, gears), 90, 'forward travel near the shift');
});

test('10 Hz stationary (speed 0, GPS jitter) — widening does not loosen the hold', () => {
  const pts = [], gears = [];
  let t = 0;
  for (let i = 0; i < 100; i++) {
    pts.push([0, (i % 2 ? 2.2e-6 : 0), (t += 100), 0]);
    gears.push(1);
  }
  assert.equal(smoothBearing(pts, 50, 7, gears), null);
});
