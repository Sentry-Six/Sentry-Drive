// Locked tests for the single-source drive-calc module.
//
// These pin the constants and formulas that MUST stay identical to the
// canonical Rust implementation at Sentry-USB-Rusty/crates/drives. They run on
// `npm test` and on `prebuild`/`publish`, so any accidental change to a
// constant or to the haversine formula fails the build before it can ship.
//
// The haversine vectors are mirrored verbatim from the Rust crate's own tests:
//   - grouper.rs   test_haversine_m             (NYC→LA ≈ 3,944 km, ±50 km)
//   - grouper.rs   test_haversine_m_same_point  (identical point → 0)
//   - aggregate.rs haversine_known_distance_sf_to_nyc (SF→NYC 4,000–4,200 km)

import test from 'node:test';
import assert from 'node:assert/strict';
import calc from './drive-calc.cjs';

test('constants match the canonical Rust crate', () => {
  // Geodesy + unit conversions
  assert.equal(calc.R_EARTH_M, 6371000.0);
  assert.equal(calc.M_PER_MILE, 1609.344);
  assert.equal(calc.M_PER_KM, 1000);
  assert.equal(calc.MI_TO_KM, 1.609344);
  assert.equal(calc.MPS_TO_MPH, 2.23694);
  assert.equal(calc.MPS_TO_KMH, 3.6);
  assert.equal(calc.MPH_TO_MPS, 0.44704);

  // GPS outlier filtering
  assert.equal(calc.MAX_FROM_MEDIAN_M, 1000000);
  assert.equal(calc.MAX_JUMP_M, 5000);
  assert.equal(calc.NULL_ISLAND_DEG, 1);

  // Trip grouping
  assert.equal(calc.DRIVE_GAP_MS, 300000);
  assert.equal(calc.PARK_GAP_SECONDS, 2.0);
  assert.equal(calc.CLIP_DURATION_MS, 60000);

  // Speed sanity caps
  assert.equal(calc.SEI_SPEED_MAX_MPS, 100);
  assert.equal(calc.DERIVED_SPEED_MAX_MPS, 70);

  // Gear enum
  assert.equal(calc.GEAR_PARK, 0);
  assert.equal(calc.GEAR_DRIVE, 1);
  assert.equal(calc.GEAR_REVERSE, 2);
  assert.equal(calc.GEAR_NEUTRAL, 3);

  // Autopilot enum
  assert.equal(calc.AUTOPILOT_OFF, 0);
  assert.equal(calc.AUTOPILOT_FSD, 1);
  assert.equal(calc.AUTOPILOT_AUTOSTEER, 2);
  assert.equal(calc.AUTOPILOT_TACC, 3);
});

test('module is frozen — cannot be mutated at runtime', () => {
  assert.ok(Object.isFrozen(calc));
  assert.throws(() => {
    calc.M_PER_MILE = 1;
  }, TypeError);
});

// ─── Haversine golden vectors (mirrored from the Rust crate's tests) ──────────

test('haversineM: NYC → LA ≈ 3,944 km (grouper.rs:test_haversine_m)', () => {
  const d = calc.haversineM(40.7128, -74.006, 34.0522, -118.2437);
  assert.ok(Math.abs(d - 3_944_000) < 50_000, `expected ~3,944,000 m, got ${d}`);
});

test('haversineM: SF → NYC within 4,000–4,200 km (aggregate.rs)', () => {
  const d = calc.haversineM(37.7749, -122.4194, 40.7128, -74.006);
  assert.ok(d > 4_000_000 && d < 4_200_000, `expected 4.0–4.2M m, got ${d}`);
});

test('haversineM: identical point → 0 (grouper.rs:test_haversine_m_same_point)', () => {
  assert.equal(calc.haversineM(37.7749, -122.4194, 37.7749, -122.4194), 0);
});

test('haversineM is symmetric', () => {
  const a = calc.haversineM(40.7128, -74.006, 34.0522, -118.2437);
  const b = calc.haversineM(34.0522, -118.2437, 40.7128, -74.006);
  assert.equal(a, b);
});

// ─── round2 ───────────────────────────────────────────────────────────────────

test('round2 rounds half up to two decimals', () => {
  assert.equal(calc.round2(1.234), 1.23);
  assert.equal(calc.round2(1.236), 1.24);
  assert.equal(calc.round2(0), 0);
});

// ─── Aggregation method (guards Part A: sum pre-rounded, NOT metres) ──────────
//
// The headline lifetime total must be the sum of each drive's already-rounded
// distanceMi, matching Rust db.rs:1059 (Σ d.distance_mi). The Go server instead
// accumulates metres and converts once. For the fixture below the two methods
// disagree at 2 dp, so this test documents and guards the chosen method.

test('lifetime total sums pre-rounded per-drive miles, not metres (Rust db.rs:1059)', () => {
  // Each drive truly travelled 1.006 mi; the pipeline stores that per drive as
  // a 2-dp distanceMi of 1.01.
  const trueMeters = 1.006 * calc.M_PER_MILE;
  const drives = [0, 1, 2].map(() => ({ distanceMi: calc.round2(trueMeters / calc.M_PER_MILE) }));
  assert.equal(drives[0].distanceMi, 1.01);

  // Rust / Sentry-Drive method: sum the rounded per-drive miles.
  const sumOfRounded = calc.round2(drives.reduce((s, d) => s + d.distanceMi, 0));
  assert.equal(sumOfRounded, 3.03);

  // Go method: accumulate metres, convert once. Differs at 2 dp here.
  const metresMethod = calc.round2((trueMeters * 3) / calc.M_PER_MILE);
  assert.equal(metresMethod, 3.02);

  assert.notEqual(sumOfRounded, metresMethod);
});
