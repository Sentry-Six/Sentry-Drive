// Locks the shared calculation contract against accidental drift. geodesicM is
// the WGS-84 production distance in both Drive and Sentry-USB-Rusty;
// haversineM remains only as a spherical comparison reference.

import test from 'node:test';
import assert from 'node:assert/strict';
import calc from './drive-calc.cjs';

test('constants match the canonical Rust crate', () => {
  // Geodesy + unit conversions
  assert.equal(calc.R_EARTH_M, 6371000.0);
  assert.equal(calc.WGS84_A, 6378137.0);
  assert.equal(calc.WGS84_F, 1 / 298.257223563);
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

  // Event-clip gap-fill
  assert.equal(calc.GAP_FILL_MIN_MS, 90000);
  assert.equal(calc.GAP_FILL_MAX_MS, 1800000);
  assert.equal(calc.GAP_FILL_ADJ_MS, 180000);
  assert.equal(calc.GAP_FILL_DUP_MS, 30000);
  assert.equal(calc.GAP_FILL_MIN_SPEED_MPS, 0.5);

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

// ─── geodesicM golden vectors (canonical distance — WGS-84 Andoyer–Lambert) ───
// Cross-validated against an independent Vincenty inverse; tolerances allow
// sub-metre libm variation across platforms.

test('geodesicM: NYC → LA golden value (Vincenty: 3,944,422.232 m)', () => {
  const d = calc.geodesicM(40.7128, -74.006, 34.0522, -118.2437);
  assert.ok(Math.abs(d - 3_944_422.179) < 1, `expected 3,944,422.179 ±1 m, got ${d}`);
});

test('geodesicM: SF → NYC golden value (Vincenty: 4,139,145.472 m)', () => {
  const d = calc.geodesicM(37.7749, -122.4194, 40.7128, -74.006);
  assert.ok(Math.abs(d - 4_139_145.867) < 1, `expected 4,139,145.867 ±1 m, got ${d}`);
});

test('geodesicM: ~30 m one-second GPS segment golden value', () => {
  const d = calc.geodesicM(37.7749, -122.4194, 37.77517, -122.4194);
  assert.ok(Math.abs(d - 29.968) < 0.01, `expected 29.968 ±0.01 m, got ${d}`);
});

test('geodesicM: identical point → exactly 0', () => {
  assert.equal(calc.geodesicM(37.7749, -122.4194, 37.7749, -122.4194), 0);
});

test('geodesicM is symmetric', () => {
  const a = calc.geodesicM(40.7128, -74.006, 34.0522, -118.2437);
  const b = calc.geodesicM(34.0522, -118.2437, 40.7128, -74.006);
  assert.equal(a, b);
});

test('geodesicM stays within 0.5% of haversineM (sanity tie between the two)', () => {
  const pairs = [
    [40.7128, -74.006, 34.0522, -118.2437],
    [37.7749, -122.4194, 40.7128, -74.006],
    [37.7749, -122.4194, 37.7839, -122.4194],
    [0.0, 10.0, 0.0, 11.0],
    [60.0, 25.0, 61.0, 25.0],
  ];
  for (const [a1, o1, a2, o2] of pairs) {
    const g = calc.geodesicM(a1, o1, a2, o2);
    const h = calc.haversineM(a1, o1, a2, o2);
    assert.ok(Math.abs(g - h) / h < 0.005, `geodesic ${g} vs haversine ${h}`);
  }
});

// ─── Haversine reference vectors (non-production) ────────────────────────────

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

// ─── Aggregation method ──────────────────────────────────────────────────────
// Lifetime totals sum stored, two-decimal per-drive mileage. Converting the
// aggregate metres once produces a different result and breaks Rust parity.

test('lifetime total sums pre-rounded per-drive miles, not metres (Rust db.rs:1059)', () => {
  // Each 1.006 mi drive is stored as 1.01 mi.
  const trueMeters = 1.006 * calc.M_PER_MILE;
  const drives = [0, 1, 2].map(() => ({ distanceMi: calc.round2(trueMeters / calc.M_PER_MILE) }));
  assert.equal(drives[0].distanceMi, 1.01);

  const sumOfRounded = calc.round2(drives.reduce((s, d) => s + d.distanceMi, 0));
  assert.equal(sumOfRounded, 3.03);

  const metresMethod = calc.round2((trueMeters * 3) / calc.M_PER_MILE);
  assert.equal(metresMethod, 3.02);

  assert.notEqual(sumOfRounded, metresMethod);
});

// ─── Summon detection ────────────────────────────────────────────────────────
// Fixtures cover representative Summon and human parking-lot repositioning.

test('summon flag constants and thresholds are locked', () => {
  assert.equal(calc.FLAG_BLINKER_LEFT, 1);
  assert.equal(calc.FLAG_BLINKER_RIGHT, 2);
  assert.equal(calc.FLAG_BRAKE, 4);
  assert.equal(calc.FLAG_ACCEL, 8);
  assert.equal(calc.SUMMON_MAX_SPEED_MPS, 4.5);
  assert.equal(calc.SUMMON_BOOKEND_SECONDS, 10);
  assert.equal(calc.SUMMON_MAX_DURATION_MS, 600000);
});

test('flagRunsOverlap: requireAll needs both bits in the SAME run', () => {
  const HAZARD = calc.FLAG_BLINKER_LEFT | calc.FLAG_BLINKER_RIGHT;
  assert.equal(calc.flagRunsOverlap([{ flags: 3, frames: 10 }], 0, 10, HAZARD, true), true);
  const alternating = [{ flags: 1, frames: 10 }, { flags: 2, frames: 10 }];
  assert.equal(calc.flagRunsOverlap(alternating, 0, 20, HAZARD, true), false);
  assert.equal(calc.flagRunsOverlap(alternating, 0, 20, HAZARD, false), true);
});

test('flagRunsOverlap honors [from, to) frame bounds', () => {
  const runs = [
    { flags: 3, frames: 60 },   // frames 0-59
    { flags: 0, frames: 540 },  // frames 60-599
    { flags: 3, frames: 60 },   // frames 600-659
    { flags: 0, frames: 1140 }, // frames 660-1799
  ];
  assert.equal(calc.flagRunsOverlap(runs, 0, 60, 3, true), true);
  assert.equal(calc.flagRunsOverlap(runs, 60, 600, 3, true), false);
  assert.equal(calc.flagRunsOverlap(runs, 660, 1800, 3, true), false);
  assert.equal(calc.flagRunsOverlap(runs, 360, 600, 3, true), false);
  assert.equal(calc.flagRunsOverlap(runs, 360, 601, 3, true), true);
});

// Start clip: hazards through P→D and no pedal input.
const ASS_START_CLIP = {
  flagRuns: [
    { flags: 0, frames: 27 },
    { flags: 3, frames: 123 },
    { flags: 0, frames: 17 },
    { flags: 1, frames: 873 },
    { flags: 0, frames: 746 },
  ],
  startFrame: 0,
  endFrame: 1786,
  totalFrames: 1786,
};
// End clip: hazards through the stop and D→P shift.
const ASS_END_CLIP = {
  flagRuns: [
    { flags: 0, frames: 471 },
    { flags: 3, frames: 82 },
  ],
  startFrame: 0,
  endFrame: 553,
  totalFrames: 553,
};
const ASS_STATS = { maxSpeedMps: 2.7, durationMs: 78000, hasSeiSpeeds: true };

test('detectSummon: real ASS two-clip shape is summon', () => {
  assert.equal(calc.detectSummon([ASS_START_CLIP, ASS_END_CLIP], ASS_STATS), true);
});

test('detectSummon: single-clip dumb-summon shape is summon', () => {
  const clip = {
    flagRuns: [
      { flags: 3, frames: 90 },
      { flags: 0, frames: 300 },
      { flags: 3, frames: 60 },
    ],
    startFrame: 0,
    endFrame: 450,
    totalFrames: 450,
  };
  assert.equal(
    calc.detectSummon([clip], { maxSpeedMps: 1.0, durationMs: 15000, hasSeiSpeeds: true }),
    true,
  );
});

test('detectSummon: pedal input anywhere disqualifies (human reposition)', () => {
  const humanClip = {
    flagRuns: [
      { flags: 0, frames: 1200 },
      { flags: 4, frames: 12 },
      { flags: 8, frames: 230 },
      { flags: 4, frames: 40 },
      { flags: 0, frames: 674 },
    ],
    startFrame: 0,
    endFrame: 2156,
    totalFrames: 2156,
  };
  assert.equal(
    calc.detectSummon([humanClip], { maxSpeedMps: 1.3, durationMs: 10000, hasSeiSpeeds: true }),
    false,
  );
  // Hazard bookends do not override pedal evidence.
  const hazardsButPedal = {
    flagRuns: [
      { flags: 3, frames: 90 },
      { flags: 0, frames: 100 },
      { flags: 8, frames: 1 },
      { flags: 0, frames: 199 },
      { flags: 3, frames: 60 },
    ],
    startFrame: 0,
    endFrame: 450,
    totalFrames: 450,
  };
  assert.equal(
    calc.detectSummon([hazardsButPedal], { maxSpeedMps: 1.0, durationMs: 15000, hasSeiSpeeds: true }),
    false,
  );
});

test('detectSummon: hazards must bookend BOTH ends', () => {
  const startOnly = {
    ...ASS_START_CLIP,
  };
  const noHazardEnd = {
    flagRuns: [{ flags: 0, frames: 553 }],
    startFrame: 0,
    endFrame: 553,
    totalFrames: 553,
  };
  assert.equal(calc.detectSummon([startOnly, noHazardEnd], ASS_STATS), false);
});

test('detectSummon: individual turn signals never read as hazards', () => {
  const clip = {
    flagRuns: [
      { flags: 1, frames: 90 },  // left only at start
      { flags: 0, frames: 300 },
      { flags: 2, frames: 60 },  // right only at end
    ],
    startFrame: 0,
    endFrame: 450,
    totalFrames: 450,
  };
  assert.equal(
    calc.detectSummon([clip], { maxSpeedMps: 1.0, durationMs: 15000, hasSeiSpeeds: true }),
    false,
  );
});

test('detectSummon: speed, duration, and SEI-speed gates', () => {
  const clips = [ASS_START_CLIP, ASS_END_CLIP];
  assert.equal(calc.detectSummon(clips, { ...ASS_STATS, maxSpeedMps: 5.0 }), false);
  assert.equal(calc.detectSummon(clips, { ...ASS_STATS, maxSpeedMps: 0 }), false);
  assert.equal(calc.detectSummon(clips, { ...ASS_STATS, durationMs: 601000 }), false);
  assert.equal(calc.detectSummon(clips, { ...ASS_STATS, hasSeiSpeeds: false }), false);
});

test('detectSummon: any clip without flagRuns makes the drive unverifiable', () => {
  const legacyClip = { flagRuns: undefined, startFrame: 0, endFrame: 553, totalFrames: 553 };
  assert.equal(calc.detectSummon([ASS_START_CLIP, legacyClip], ASS_STATS), false);
  assert.equal(calc.detectSummon([], ASS_STATS), false);
});

test('detectSummon: park-split segment bounds gate the bookend windows', () => {
  // The split at frame 660 must isolate both hazard windows in the first segment.
  const flagRuns = [
    { flags: 3, frames: 60 },
    { flags: 0, frames: 540 },
    { flags: 3, frames: 60 },
    { flags: 0, frames: 1140 },
  ];
  const stats = { maxSpeedMps: 1.5, durationMs: 22000, hasSeiSpeeds: true };
  const firstSegment = { flagRuns, startFrame: 0, endFrame: 660, totalFrames: 1800 };
  const secondSegment = { flagRuns, startFrame: 660, endFrame: 1800, totalFrames: 1800 };
  assert.equal(calc.detectSummon([firstSegment], stats), true);
  assert.equal(calc.detectSummon([secondSegment], stats), false);
});

test('computeFlagRuns RLEs raw frames and round-trips totals', () => {
  assert.deepEqual(calc.computeFlagRuns([]), []);
  assert.deepEqual(calc.computeFlagRuns([0, 0, 3, 3, 3, 1, 0]), [
    { flags: 0, frames: 2 },
    { flags: 3, frames: 3 },
    { flags: 1, frames: 1 },
    { flags: 0, frames: 1 },
  ]);
  // Raw-frame segment bounds require exact run totals.
  const flags = [0, 8, 8, 4, 0, 0, 3, 3, 2, 1];
  const total = calc.computeFlagRuns(flags).reduce((s, r) => s + r.frames, 0);
  assert.equal(total, flags.length);
});

test('computeGearRuns matches the worker RLE shape', () => {
  assert.deepEqual(calc.computeGearRuns([]), []);
  assert.deepEqual(calc.computeGearRuns([0, 0, 1, 1, 1, 0]), [
    { gear: 0, frames: 2 },
    { gear: 1, frames: 3 },
    { gear: 0, frames: 1 },
  ]);
});

test('computeFlagRuns carries per-run max |SEI speed| when speeds are given', () => {
  const flags  = [0, 0, 3, 3, 8, 8, 8];
  const speeds = [0, -1.5, 0.4, 0.26, 2.0, 4.73, 3.1];
  assert.deepEqual(calc.computeFlagRuns(flags, speeds), [
    { flags: 0, frames: 2, maxMps: 1.5 },
    { flags: 3, frames: 2, maxMps: 0.4 },
    { flags: 8, frames: 3, maxMps: 4.7 },
  ]);
  assert.deepEqual(calc.computeFlagRuns([0, 3], undefined), [
    { flags: 0, frames: 1 },
    { flags: 3, frames: 1 },
  ]);
});

test('segmentMaxSpeed: frame-space max over the segment, null on legacy runs', () => {
  const runs = [
    { flags: 3, frames: 100, maxMps: 0.5 },
    { flags: 0, frames: 400, maxMps: 2.7 },
    { flags: 8, frames: 500, maxMps: 4.7 },
  ];
  assert.equal(calc.segmentMaxSpeed({ flagRuns: runs, startFrame: 0, endFrame: 500 }), 2.7);
  assert.equal(calc.segmentMaxSpeed({ flagRuns: runs, startFrame: 0, endFrame: 1000 }), 4.7);
  assert.equal(calc.segmentMaxSpeed({ flagRuns: runs, startFrame: 450, endFrame: 550 }), 4.7);
  const legacy = [{ flags: 3, frames: 100 }, { flags: 0, frames: 100, maxMps: 1 }];
  assert.equal(calc.segmentMaxSpeed({ flagRuns: legacy, startFrame: 0, endFrame: 200 }), null);
  assert.equal(calc.segmentMaxSpeed({ flagRuns: legacy, startFrame: 100, endFrame: 200 }), 1);
});

test('detectSummon: frame-space speed evidence overrides polluted drive stats', () => {
  // Per-run maxMps prevents deduped point-slice spillover from an adjacent,
  // faster drive.
  const clipA = {
    flagRuns: [
      { flags: 0, frames: 7, maxMps: 0 },
      { flags: 3, frames: 144, maxMps: 0.1 },
      { flags: 0, frames: 766, maxMps: 2.7 },
    ],
    startFrame: 0, endFrame: 917, totalFrames: 917,
  };
  const clipB = {
    flagRuns: [
      { flags: 0, frames: 143, maxMps: 2.7 },
      { flags: 3, frames: 219, maxMps: 2.6 },
      { flags: 0, frames: 105, maxMps: 2.0 },
      { flags: 3, frames: 191, maxMps: 1.8 },
      { flags: 4, frames: 50, maxMps: 0 },
      { flags: 0, frames: 10, maxMps: 0 },
      { flags: 8, frames: 521, maxMps: 4.7 },
      { flags: 0, frames: 16, maxMps: 4.0 },
      { flags: 8, frames: 545, maxMps: 4.7 },
      { flags: 0, frames: 55, maxMps: 1.0 },
    ],
    startFrame: 0, endFrame: 579, totalFrames: 1855,
  };
  const polluted = { maxSpeedMps: 4.05, durationMs: 42000, hasSeiSpeeds: true };
  assert.equal(calc.detectSummon([clipA, clipB], polluted), true);
  // Fast frames inside the segment still reject despite slow aggregate stats.
  const fastNoPedals = {
    flagRuns: [
      { flags: 3, frames: 100, maxMps: 0.5 },
      { flags: 0, frames: 700, maxMps: 4.7 },
      { flags: 3, frames: 100, maxMps: 0.3 },
    ],
    startFrame: 0, endFrame: 900, totalFrames: 900,
  };
  assert.equal(
    calc.detectSummon([fastNoPedals], { maxSpeedMps: 2.0, durationMs: 42000, hasSeiSpeeds: true }),
    false,
  );
});
