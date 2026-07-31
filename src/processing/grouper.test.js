// Behavioral tests for drive identification — ported from the canonical Rust
// grouper suite (Sentry-USB-Rusty/crates/drives/src/grouper.rs `#[cfg(test)]`).
//
// These run against Drive's real public entry point, groupIntoDrives, which
// MATERIALIZES the drive list (one drive per group). Drive now matches Rust's
// summary path exactly — including dropping a fully-parked group (no driving →
// no drive; Rust split_summary_by_gear_state, grouper.rs:1893). There is no
// remaining known fast-path-vs-materialized divergence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoDrives, isEventFolderPath } from './grouper.js';
import { GEAR_PARK, GEAR_DRIVE } from '../shared/drive-calc.cjs';

// ─── Fixtures (mirror Rust's test_route / park_route / clip_with_gear_runs) ───

function linePoints(n, baseLat = 37.0, baseLng = -122.0) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([baseLat + i * 1e-4, baseLng]);
  return pts;
}

// A normal driving clip with a single GPS point (Rust test_route).
function testRoute(file, points) {
  return {
    file,
    points,
    gearStates: [],
    autopilotStates: [],
    speeds: [],
    accelPositions: [],
    rawParkCount: 0,
    rawFrameCount: 10,
    gearRuns: [{ gear: GEAR_DRIVE, frames: 10 }],
    source: undefined,
    externalSignature: undefined,
  };
}

// A clip parked the entire minute (Rust park_route): 60 Park frames.
function parkRoute(file, lat) {
  return {
    file,
    points: [[lat, -76.795]],
    gearStates: [],
    autopilotStates: [],
    speeds: [],
    accelPositions: [],
    rawParkCount: 60,
    rawFrameCount: 60,
    gearRuns: [{ gear: GEAR_PARK, frames: 60 }],
    source: undefined,
    externalSignature: undefined,
  };
}

// A clip with arbitrary internal gear runs (Rust clip_with_gear_runs). `runs`
// is [gear, frames] pairs; one GPS point per frame so the frame-fraction
// slicing in splitClipAtParkGaps maps cleanly to point indices.
function clipWithGearRuns(file, runs, baseLat = 37.0, baseLng = -122.0) {
  const totalFrames = runs.reduce((s, [, f]) => s + f, 0);
  return {
    file,
    points: linePoints(Math.max(totalFrames, 1), baseLat, baseLng),
    gearStates: [],
    autopilotStates: [],
    speeds: [],
    accelPositions: [],
    rawParkCount: runs.filter(([g]) => g === GEAR_PARK).reduce((s, [, f]) => s + f, 0),
    rawFrameCount: totalFrames,
    gearRuns: runs.map(([gear, frames]) => ({ gear, frames })),
    source: undefined,
    externalSignature: undefined,
  };
}

const drivesOf = (routes) => groupIntoDrives(routes).drives;

// ─── isEventFolderPath (Rust test_is_event_folder_path, grouper.rs:3271) ──────

test('isEventFolderPath: top-level SavedClips/SentryClips only', () => {
  assert.equal(isEventFolderPath('SavedClips/2026-05-17_18-47-59/2026-05-17_18-47-34-front.mp4'), true);
  assert.equal(isEventFolderPath('SentryClips/2026-05-17_18-46-39/2026-05-17_18-35-39-front.mp4'), true);
  // Windows-style separators from a Sentry-Drive drive-data.json import.
  assert.equal(isEventFolderPath('SavedClips\\2026-05-17_18-47-59\\2026-05-17_18-47-34-front.mp4'), true);
  assert.equal(isEventFolderPath('SentryClips\\foo\\bar-front.mp4'), true);
  // Real drive content stays in.
  assert.equal(isEventFolderPath('RecentClips/2026-05-17/2026-05-17_18-47-34-front.mp4'), false);
  assert.equal(isEventFolderPath('2026-05-17/2026-05-17_18-47-34-front.mp4'), false);
  assert.equal(isEventFolderPath('2026-05-17\\2026-05-17_18-47-34-front.mp4'), false);
  assert.equal(isEventFolderPath(''), false);
  // Substring matches don't count — must be a top-level segment.
  assert.equal(isEventFolderPath('foo/SavedClips/x.mp4'), false);
  assert.equal(isEventFolderPath('MySavedClips/x.mp4'), false);
});

// ─── Grouping (Rust test_group_clips_*) ───────────────────────────────────────

test('empty input → no drives', () => {
  assert.equal(drivesOf([]).length, 0);
});

test('single clip → one drive', () => {
  const drives = drivesOf([testRoute('/cam/2025-01-15_12-30-45-front.mp4', [[37.0, -122.0]])]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].routeFiles.length, 1);
});

test('>5 min gap splits into separate drives', () => {
  const drives = drivesOf([
    testRoute('/cam/2025-01-15_12-00-00-front.mp4', [[37.0, -122.0]]),
    testRoute('/cam/2025-01-15_13-00-00-front.mp4', [[37.1, -122.1]]),
  ]);
  assert.equal(drives.length, 2);
});

test('clips <5 min apart stay in one drive', () => {
  const drives = drivesOf([
    testRoute('/cam/2025-01-15_12-00-00-front.mp4', [[37.0, -122.0]]),
    testRoute('/cam/2025-01-15_12-01-00-front.mp4', [[37.0001, -122.0]]),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].routeFiles.length, 2);
});

// ─── Gear-state park splitting (Rust test_split_summary_*) ────────────────────

test('two internal park gaps split one clip into three drives', () => {
  // 60 frames: drive 20, park 5, drive 15, park 5, drive 15. Park runs are
  // 5s ≥ PARK_GAP_SECONDS (2s).
  const drives = drivesOf([
    clipWithGearRuns('/cam/2025-01-15_12-00-00-front.mp4', [
      [GEAR_DRIVE, 20], [GEAR_PARK, 5], [GEAR_DRIVE, 15], [GEAR_PARK, 5], [GEAR_DRIVE, 15],
    ]),
  ]);
  assert.equal(drives.length, 3);
});

test('no internal park gap keeps one drive', () => {
  const drives = drivesOf([
    clipWithGearRuns('/cam/2025-01-15_12-00-00-front.mp4', [[GEAR_DRIVE, 60]]),
  ]);
  assert.equal(drives.length, 1);
});

test('all-parked clip → no drive (Rust split_summary_by_gear_state)', () => {
  // An isolated, fully-parked clip is a stationary recording, not a trip:
  // splitByGearState returns [] for an all-Park group, so groupIntoDrives
  // emits nothing — matching Rust's summary path (grouper.rs:1893, "return
  // nothing so drives_count stays 0").
  const drives = drivesOf([
    clipWithGearRuns('/cam/2025-01-15_12-00-00-front.mp4', [[GEAR_PARK, 60]]),
  ]);
  assert.equal(drives.length, 0);
});

test('a fully-parked clip between two drives yields two drives', () => {
  const drives = drivesOf([
    clipWithGearRuns('/cam/2025-01-15_12-00-00-front.mp4', [[GEAR_DRIVE, 60]]),
    clipWithGearRuns('/cam/2025-01-15_12-01-00-front.mp4', [[GEAR_PARK, 60]]),
    clipWithGearRuns('/cam/2025-01-15_12-02-00-front.mp4', [[GEAR_DRIVE, 60]]),
  ]);
  assert.equal(drives.length, 2);
  assert.equal(drives[0].routeFiles.length, 1);
  assert.equal(drives[1].routeFiles.length, 1);
});

// ─── Dedup + event-folder filtering ──────────────────────────────────────────

test('duplicate file paths (mixed separators) are deduped', () => {
  const drives = drivesOf([
    testRoute('cam/2025-01-15_12-00-00-front.mp4', [[37.0, -122.0]]),
    testRoute('cam\\2025-01-15_12-00-00-front.mp4', [[37.0, -122.0]]),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].routeFiles.length, 1);
});

test('event-folder routes are filtered out of grouping (grouper.rs:3314)', () => {
  // Three routes in the same minute; only the RecentClips one survives.
  const drives = drivesOf([
    testRoute('RecentClips/2025-01-15/2025-01-15_12-30-00-front.mp4', [[37.0, -122.0]]),
    testRoute('SavedClips/2025-01-15_12-30-30/2025-01-15_12-30-00-front.mp4', [[37.0, -122.0]]),
    testRoute('SentryClips/2025-01-15_12-29-30/2025-01-15_12-30-00-front.mp4', [[37.0, -122.0]]),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].routeFiles.length, 1);
  assert.equal(drives[0].routeFiles[0].startsWith('RecentClips/'), true);
});

test('May 17 regression: event clips do not create a phantom parked drive', () => {
  // 11 SentryClips parked recordings + 1 SavedClips duplicate + 5 RecentClips
  // driving clips. After event-folder filtering this must be ONE drive of
  // exactly the 5 RecentClips routes (not a fake parked drive + the trip).
  const routes = [];
  for (let minute = 35; minute <= 45; minute++) {
    const ss = String(39 + (minute - 35)).padStart(2, '0');
    routes.push(parkRoute(
      `SentryClips/2026-05-17_18-46-39/2026-05-17_18-${minute}-${ss}-front.mp4`,
      39.1988 + minute * 1e-6,
    ));
  }
  routes.push(testRoute(
    'SavedClips/2026-05-17_18-47-59/2026-05-17_18-47-34-front.mp4',
    [[39.198835, -76.795246]],
  ));
  const driveStarts = [
    'RecentClips/2026-05-17/2026-05-17_18-47-34-front.mp4',
    'RecentClips/2026-05-17/2026-05-17_18-48-34-front.mp4',
    'RecentClips/2026-05-17/2026-05-17_18-49-34-front.mp4',
    'RecentClips/2026-05-17/2026-05-17_18-50-34-front.mp4',
    'RecentClips/2026-05-17/2026-05-17_18-51-34-front.mp4',
  ];
  driveStarts.forEach((f, i) => {
    routes.push(testRoute(f, [[39.198835 + i * 1e-4, -76.795246]]));
  });

  const drives = drivesOf(routes);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].routeFiles.length, driveStarts.length);
  for (const f of drives[0].routeFiles) {
    assert.equal(f.startsWith('RecentClips/'), true);
  }
});

// ─── BLE location-name rollup (Rust roll_up_telemetry, grouper.rs:2785) ───────
// First non-null locationNameStart / last non-null locationNameEnd across the
// drive's clips, verbatim. Clips without telemetry contribute nothing; drives
// with no telemetry at all omit the fields entirely.

test('locationName rollup: first non-null start, last non-null end (Rust roll_up_telemetry)', () => {
  const routes = [
    // First clip: BLE sample landed only late in the window → no start name.
    { ...testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', [[37.0, -122.0]]),
      locationNameEnd: '100 First St' },
    // Middle clip: both names present → provides the drive's start name.
    { ...testRoute('RecentClips/2026-05-17_10-01-00-front.mp4', [[37.001, -122.0]]),
      locationNameStart: '100 First St', locationNameEnd: '250 Mid Ave' },
    // Last clip: no telemetry window at all → end name stays from prior clip.
    testRoute('RecentClips/2026-05-17_10-02-00-front.mp4', [[37.002, -122.0]]),
  ];
  const drives = drivesOf(routes);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].locationNameStart, '100 First St');
  assert.equal(drives[0].locationNameEnd, '250 Mid Ave');
});

test('locationName rollup: omitted entirely when no clip has telemetry', () => {
  const drives = drivesOf([
    testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', [[37.0, -122.0]]),
    testRoute('RecentClips/2026-05-17_10-01-00-front.mp4', [[37.001, -122.0]]),
  ]);
  assert.equal(drives.length, 1);
  assert.equal('locationNameStart' in drives[0], false);
  assert.equal('locationNameEnd' in drives[0], false);
});

// ─── BLE battery rollup ────────────────────────────────────────────────────────
// Shares the locationName convention: first non-null batteryPctStart, last
// non-null batteryPctEnd across the drive's clips; omitted entirely when no
// clip carries battery telemetry (pre-BLE history, imports).

test('battery rollup: first non-null start, last non-null end', () => {
  const routes = [
    // First clip: no battery sample yet (BLE connected late).
    testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', [[37.0, -122.0]]),
    // Middle clip: provides the drive's starting charge.
    { ...testRoute('RecentClips/2026-05-17_10-01-00-front.mp4', [[37.001, -122.0]]),
      batteryPctStart: 78, batteryPctEnd: 71 },
    // Last clip: its end-of-clip sample is the drive's ending charge.
    { ...testRoute('RecentClips/2026-05-17_10-02-00-front.mp4', [[37.002, -122.0]]),
      batteryPctStart: 71, batteryPctEnd: 64 },
  ];
  const drives = drivesOf(routes);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].batteryPctStart, 78);
  assert.equal(drives[0].batteryPctEnd, 64);
});

test('battery rollup: omitted entirely when no clip has battery telemetry', () => {
  const drives = drivesOf([
    testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', [[37.0, -122.0]]),
    testRoute('RecentClips/2026-05-17_10-01-00-front.mp4', [[37.001, -122.0]]),
  ]);
  assert.equal(drives.length, 1);
  assert.equal('batteryPctStart' in drives[0], false);
  assert.equal('batteryPctEnd' in drives[0], false);
});

// ─── Geocode endpoint snapping (Drive-leading; geocoding only, not stats) ─────
// Median of the stationary cluster at each end; raw terminal fix when the car
// was already rolling (cluster < 3 points).

test('geocode endpoints: stationary-median start, raw terminal fix when rolling', () => {
  const pts = [
    // Parked cluster: 5 jittered fixes within ~5 m (median lat = 37.000009).
    [37.000000, -122.0],
    [37.000018, -122.0],
    [36.999991, -122.0],
    [37.000009, -122.0],
    [37.000036, -122.0],
    // Rolling away — each step ~33 m breaks the 15 m cluster radius.
    [37.000300, -122.0],
    [37.000600, -122.0],
    [37.000900, -122.0],
  ];
  const drives = drivesOf([testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', pts)]);
  assert.equal(drives.length, 1);
  const d = drives[0];
  // Start: median of the 5-point parked cluster — not the raw first fix.
  assert.equal(d.geocodeStartPoint[0], 37.000009);
  assert.equal(d.geocodeStartPoint[1], -122.0);
  // End: still rolling at the last fix → cluster of 1 → anchor wins.
  assert.equal(d.geocodeEndPoint[0], 37.000900);
  assert.equal(d.geocodeEndPoint[1], -122.0);
});

// ─── Drive end-time convention (Rust build_summary_from_aggregates:1992) ──────
// A drive whose last clip is park-split ends where the driving segment's
// frames end — NOT a full minute after the clip's start. Unsplit final clips
// keep the +60 s convention. This was a real divergence: Drive's flat +60 s
// inflated lifetime duration vs Sentry USB Rusty.

test('drive ends at the last driving frame, not +60s, when the final clip is park-split', () => {
  // 30 frames driving, 30 frames parked → drive covers the first 30s only.
  const drives = drivesOf([
    clipWithGearRuns('RecentClips/2026-05-17_10-00-00-front.mp4', [[GEAR_DRIVE, 30], [GEAR_PARK, 30]]),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].durationMs, 30000);
});

test('drive with an unsplit final clip keeps the +60s convention', () => {
  const drives = drivesOf([
    testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', linePoints(10)),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].durationMs, 60000);
});

// ─── Event-clip gap-fill (Rust grouper.rs vectors: parse_clip_timestamp,
// fillable_holes, select_gap_fill*, telemetry_has_driving) ────────────────────
import {
  parseClipTimestamp, fillableHoles, tsInHoles,
  selectGapFill, selectGapFillEvents, telemetryHasDriving,
} from './grouper.js';

const ms = (s) => new Date(s.replace(' ', 'T')).getTime();

test('parseClipTimestamp uses the filename component, not the event folder', () => {
  assert.equal(
    parseClipTimestamp('SentryClips/2026-05-17_18-46-39/2026-05-17_18-35-39-front.mp4').getTime(),
    ms('2026-05-17 18:35:39'));
  assert.equal(
    parseClipTimestamp('SavedClips\\2026-05-17_18-47-59\\2026-05-17_18-47-34-front.mp4').getTime(),
    ms('2026-05-17 18:47:34'));
  assert.equal(
    parseClipTimestamp('RecentClips/2026-05-17/2026-05-17_18-47-34-front.mp4').getTime(),
    ms('2026-05-17 18:47:34'));
  assert.equal(parseClipTimestamp('SentryClips/2026-05-17_18-46-39/event.json'), null);
});

test('fillableHoles bounds: >90s and <=30min; strict interior membership', () => {
  const seq = [
    ms('2026-06-01 10:00:00'), ms('2026-06-01 10:01:00'),
    ms('2026-06-01 10:04:00'), ms('2026-06-01 10:05:00'),
    ms('2026-06-01 10:11:00'), ms('2026-06-01 10:46:00'),
  ];
  const holes = fillableHoles(seq);
  assert.deepEqual(holes, [
    [ms('2026-06-01 10:01:00'), ms('2026-06-01 10:04:00')],
    [ms('2026-06-01 10:05:00'), ms('2026-06-01 10:11:00')],
  ]);
  assert.equal(tsInHoles(holes, ms('2026-06-01 10:02:00')), true);
  assert.equal(tsInHoles(holes, ms('2026-06-01 10:07:00')), true);
  assert.equal(tsInHoles(holes, ms('2026-06-01 10:01:00')), false);
  assert.equal(tsInHoles(holes, ms('2026-06-01 10:04:00')), false);
  assert.equal(tsInHoles(holes, ms('2026-06-01 10:11:00')), false);
  assert.equal(tsInHoles(holes, ms('2026-06-01 10:30:00')), false);
});

test('selectGapFillEvents: twin dedup lowest-path-wins; outside-hole rejected', () => {
  const recent = [ms('2026-06-01 10:00:00'), ms('2026-06-01 10:03:00')];
  const cands = [
    { ts: ms('2026-06-01 10:01:00'), file: 'SentryClips/2026-06-01_10-02-30/2026-06-01_10-01-00-front.mp4' },
    { ts: ms('2026-06-01 10:01:00'), file: 'SavedClips/2026-06-01_10-02-30/2026-06-01_10-01-00-front.mp4' },
    { ts: ms('2026-06-01 10:02:00'), file: 'SentryClips/2026-06-01_10-02-30/2026-06-01_10-02-00-front.mp4' },
    { ts: ms('2026-06-01 09:30:00'), file: 'SentryClips/2026-06-01_09-31-00/2026-06-01_09-30-00-front.mp4' },
  ];
  const picked = selectGapFillEvents(recent, cands).map((i) => cands[i].file).sort();
  assert.deepEqual(picked, [
    'SavedClips/2026-06-01_10-02-30/2026-06-01_10-01-00-front.mp4',
    'SentryClips/2026-06-01_10-02-30/2026-06-01_10-02-00-front.mp4',
  ]);
});

test('selectGapFill: chain hop window (3min) and 30min cap from nearest recent', () => {
  const recent = [ms('2026-06-01 10:00:00')];
  const chain = [
    { ts: ms('2026-06-01 10:01:01'), file: 'SentryClips/e/a-front.mp4', driving: true },
    { ts: ms('2026-06-01 10:02:02'), file: 'SentryClips/e/b-front.mp4', driving: true },
    { ts: ms('2026-06-01 10:04:34'), file: 'SentryClips/e/c-front.mp4', driving: true },
    { ts: ms('2026-06-01 10:07:00'), file: 'SentryClips/e/d-front.mp4', driving: true },
    { ts: ms('2026-06-01 10:12:00'), file: 'SentryClips/e/e-front.mp4', driving: true },
  ];
  assert.deepEqual(selectGapFill(recent, chain), [0, 1, 2, 3]);

  // A 35-clip chain of driving clips must be cut at 30min from the anchor.
  const long = Array.from({ length: 35 }, (_, k) => ({
    ts: ms('2026-06-01 10:00:00') + (k + 1) * 61000,
    file: 'SentryClips/e/clip' + String(k).padStart(2, '0') + '-front.mp4',
    driving: true,
  }));
  const picked = selectGapFill(recent, long);
  assert.ok(picked.length > 0 && picked.length < long.length);
  for (const i of picked) {
    assert.ok(long[i].ts - recent[0] <= 30 * 60 * 1000, long[i].file + ' exceeds the cap');
  }
});

test('selectGapFill: occupied-slot twin and overlap dup rejected; parked never admitted', () => {
  const recent = [ms('2026-07-04 20:43:50'), ms('2026-07-04 20:44:50')];
  const cands = [
    { ts: ms('2026-07-04 20:44:51'), file: 'SentryClips/e/2026-07-04_20-44-51-front.mp4', driving: true },
    { ts: ms('2026-07-04 20:45:51'), file: 'SentryClips/e/2026-07-04_20-45-51-front.mp4', driving: true },
    { ts: ms('2026-07-04 20:46:11'), file: 'SavedClips/e2/2026-07-04_20-46-11-front.mp4', driving: true },
  ];
  assert.deepEqual(selectGapFill(recent, cands), [1]);

  const parked = [
    { ts: ms('2026-07-04 20:45:51'), file: 'SentryClips/e/2026-07-04_20-45-51-front.mp4', driving: false },
  ];
  assert.deepEqual(selectGapFill(recent, parked), []);
});

test('telemetryHasDriving: gear/speed evidence; absent telemetry is not driving', () => {
  const run = (gear) => ({ gear, frames: 30 });
  assert.equal(telemetryHasDriving({ gearRuns: [run(0), run(1)] }), true);
  assert.equal(telemetryHasDriving({ gearRuns: [run(0)], gearStates: new Uint8Array(60), speeds: Array(60).fill(0), rawParkCount: 60, rawFrameCount: 60 }), false);
  assert.equal(telemetryHasDriving({ gearRuns: [run(0)], speeds: [-2.0] }), true);
  assert.equal(telemetryHasDriving({ speeds: [0.2] }), false);
  assert.equal(telemetryHasDriving({ rawParkCount: 40, rawFrameCount: 60 }), true);
  assert.equal(telemetryHasDriving({}), false);
  // Deviation (documented in grouper.js): rawParkCount ABSENT means the
  // raw-count arm must not fire on frames alone.
  assert.equal(telemetryHasDriving({ rawFrameCount: 60 }), false);
});

test('groupIntoDrives: trailing pre-roll chain extends the drive; parked tail excluded', () => {
  const pt = (lat) => [lat, -122.0];
  const drivingRoute = (file, lat) => ({
    file,
    points: [pt(lat), pt(lat + 0.001)],
    speeds: [5.0, 5.0],
    gearStates: new Uint8Array([1, 1]),
    gearRuns: [{ gear: 1, frames: 2 }],
  });
  const parkedRoute = (file, lat) => ({
    file,
    points: [pt(lat), pt(lat)],
    speeds: [0, 0],
    gearStates: new Uint8Array([0, 0]),
    gearRuns: [{ gear: 0, frames: 2 }],
  });
  const { drives } = groupIntoDrives([
    drivingRoute('RecentClips/2026-07-04/2026-07-04_20-42-50-front.mp4', 37.0),
    drivingRoute('RecentClips/2026-07-04/2026-07-04_20-43-50-front.mp4', 37.001),
    drivingRoute('SentryClips/2026-07-04_20-55-50/2026-07-04_20-44-51-front.mp4', 37.002),
    drivingRoute('SentryClips/2026-07-04_20-55-50/2026-07-04_20-45-51-front.mp4', 37.003),
    parkedRoute('SentryClips/2026-07-04_20-55-50/2026-07-04_20-46-52-front.mp4', 37.003),
    parkedRoute('SentryClips/2026-07-04_20-55-50/2026-07-04_20-47-52-front.mp4', 37.003),
  ]);
  assert.equal(drives.length, 1, 'expected a single extended drive');
  const files = drives[0].routeFiles.map((f) => f.replace(/\\/g, '/'));
  assert.deepEqual(files, [
    'RecentClips/2026-07-04/2026-07-04_20-42-50-front.mp4',
    'RecentClips/2026-07-04/2026-07-04_20-43-50-front.mp4',
    'SentryClips/2026-07-04_20-55-50/2026-07-04_20-44-51-front.mp4',
    'SentryClips/2026-07-04_20-55-50/2026-07-04_20-45-51-front.mp4',
  ]);
});

// ─── Summon detection (Drive-leading; Rust port pending) ─────────────────────
// End-to-end through groupIntoDrives with the real ASS shape from
// 2026-07-15: leading/trailing Park trimmed by the splitter, hazard runs in
// raw frame space, SEI speeds at crawl. flagRuns totals match gearRuns totals
// exactly as the worker emits them (same raw SEI frame sequence).

function summonClip(file, gearRunPairs, flagRuns, { speed = 2.0, n = 100, baseLat = 37.0 } = {}) {
  const clip = clipWithGearRuns(file, gearRunPairs, baseLat);
  clip.points = clip.points.slice(0, n);
  while (clip.points.length < n) clip.points.push([baseLat + clip.points.length * 1e-6, -122.0]);
  clip.speeds = new Array(n).fill(speed);
  clip.flagRuns = flagRuns;
  return clip;
}

const ASS_START_RUNS = [
  { flags: 0, frames: 27 },
  { flags: 3, frames: 123 },  // hazards through the P→D shift
  { flags: 0, frames: 17 },
  { flags: 1, frames: 873 },  // left signal while maneuvering out
  { flags: 0, frames: 746 },
];
const ASS_END_RUNS = [
  { flags: 0, frames: 471 },
  { flags: 3, frames: 82 },   // hazards through the stop and D→P shift
];

test('summon: hazard-bookended pedal-free crawl across two clips is flagged', () => {
  const clipA = summonClip(
    '2026-07-15/2026-07-15_20-49-54-front.mp4',
    [[GEAR_PARK, 60], [GEAR_DRIVE, 1726]],
    ASS_START_RUNS,
  );
  const clipB = summonClip(
    '2026-07-15/2026-07-15_20-50-43-front.mp4',
    [[GEAR_DRIVE, 500], [GEAR_PARK, 53]],
    ASS_END_RUNS,
  );
  const drives = drivesOf([clipA, clipB]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].summon, true);
});

test('summon: missing flagRuns or pedal input never flags', () => {
  // Same drive shape without flag evidence (pre-flags extraction) — the
  // summary must omit the flag entirely rather than guess.
  const bareA = summonClip(
    '2026-07-15/2026-07-15_20-49-54-front.mp4',
    [[GEAR_PARK, 60], [GEAR_DRIVE, 1726]],
    undefined,
  );
  const bareB = summonClip(
    '2026-07-15/2026-07-15_20-50-43-front.mp4',
    [[GEAR_DRIVE, 500], [GEAR_PARK, 53]],
    undefined,
  );
  const bareDrives = drivesOf([bareA, bareB]);
  assert.equal(bareDrives.length, 1);
  assert.equal(bareDrives[0].summon, undefined);

  // Hazard bookends but a human touched the accelerator mid-drive.
  const pedalRuns = [
    { flags: 3, frames: 150 },
    { flags: 0, frames: 800 },
    { flags: 8, frames: 36 },
    { flags: 0, frames: 718 },
    { flags: 3, frames: 82 },
  ];
  const pedalClip = summonClip(
    '2026-07-16/2026-07-16_09-00-00-front.mp4',
    [[GEAR_PARK, 60], [GEAR_DRIVE, 1726]],
    pedalRuns,
  );
  const pedalDrives = drivesOf([pedalClip]);
  assert.equal(pedalDrives.length, 1);
  assert.equal(pedalDrives[0].summon, undefined);
});

test('summon: reverse-only summon (negative SEI speeds) is flagged', () => {
  // Backing out of a garage: P -> R -> P with hazard bookends. Reverse gear
  // reports NEGATIVE SEI speeds, which the locked display stats ignore — the
  // detector must still see the movement via absolute SEI speed.
  const clip = summonClip(
    '2026-07-20/2026-07-20_09-00-00-front.mp4',
    [[GEAR_PARK, 90], [2 /* GEAR_REVERSE */, 300], [GEAR_PARK, 60]],
    [
      { flags: 3, frames: 120 },
      { flags: 0, frames: 240 },
      { flags: 3, frames: 90 },
    ],
    { speed: -1.5 },
  );
  const drives = drivesOf([clip]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].summon, true);
  // Speed stats use the SEI magnitude (Drive-leading divergence from Rusty,
  // which drops negative samples): a 1.5 m/s reverse crawl reads 3.36 mph,
  // not 0 — and reverse-only data still counts as having SEI speeds.
  assert.equal(drives[0].maxSpeedMph, 3.36);
  assert.equal(drives[0].avgSpeedMph, 3.36);
});

test('summon: reverse summon ending seconds before the human drives off splits and flags', () => {
  // Real 2026-07-27 20:04 shape. Clip 1: hazards in P, P->R under hazards
  // (leading P too short to split), backs out, shifts D, creeps toward the
  // user. Clip 2: creep finishes, hazards through the stop and D->P, ~3 s of
  // Park, then the human gets in (brake, accel to 20%) and drives off, FSD
  // engaging at the end. The mid-clip park must split the summon into its
  // own drive; pedal input stays outside the summon segment's frame range.
  const clipA = summonClip(
    '2026-07-27/2026-07-27_20-04-00-front.mp4',
    [[GEAR_PARK, 46], [2 /* R */, 727], [GEAR_DRIVE, 917]],
    [
      { flags: 0, frames: 11 },
      { flags: 3, frames: 113 },  // hazards spanning P->R
      { flags: 0, frames: 394 },
      { flags: 2, frames: 256 },  // right signal while maneuvering
      { flags: 0, frames: 301 },
      { flags: 2, frames: 615 },
    ],
    { speed: 2.0 },
  );
  const clipB = summonClip(
    '2026-07-27/2026-07-27_20-04-46-front.mp4',
    [[GEAR_DRIVE, 120], [GEAR_PARK, 84], [GEAR_DRIVE, 1469]],
    [
      { flags: 2, frames: 81 },
      { flags: 3, frames: 89 },   // hazards through the stop and D->P
      { flags: 4, frames: 70 },   // human brake to shift
      { flags: 0, frames: 200 },
      { flags: 8, frames: 690 },  // human accelerator
      { flags: 0, frames: 112 },
      { flags: 1, frames: 431 },
    ],
    { speed: 0.3 },
  );
  // Fast departure after the park — only the first points (summon tail) crawl.
  clipB.speeds = clipB.speeds.map((s, i) => (i < 10 ? 0.3 : 5.4));

  const drives = drivesOf([clipA, clipB]);
  assert.equal(drives.length, 2);
  assert.equal(drives[0].summon, true);       // clip A + clip B's pre-park segment
  assert.equal(drives[1].summon, undefined);  // the human/FSD drive after the park
});

test('summon: point-slice speed pollution does not reject a frame-slow summon', () => {
  // Real 2026-07-27 00:34 failure shape. The park splitter slices point
  // arrays by frame fraction; on deduped points the summon segment inherits
  // speed samples from the fast drive after the park (stats read 9 mph for a
  // 6 mph summon). Per-run maxMps evidence must win over the polluted stats.
  const clipA = summonClip(
    '2026-07-27/2026-07-27_00-34-31-front.mp4',
    [[GEAR_PARK, 68], [2 /* R */, 538], [GEAR_DRIVE, 311]],
    [
      { flags: 0, frames: 7, maxMps: 0 },
      { flags: 3, frames: 144, maxMps: 0.1 },  // hazards spanning P->R
      { flags: 0, frames: 766, maxMps: 2.7 },
    ],
    { speed: 1.5 },
  );
  const clipB = summonClip(
    '2026-07-27/2026-07-27_00-34-59-front.mp4',
    [[GEAR_DRIVE, 579], [GEAR_PARK, 114], [GEAR_DRIVE, 1162]],
    [
      { flags: 0, frames: 143, maxMps: 2.7 },
      { flags: 3, frames: 219, maxMps: 2.6 },  // hazard stop
      { flags: 0, frames: 105, maxMps: 2.0 },
      { flags: 3, frames: 191, maxMps: 1.8 },  // hazards through D->P
      { flags: 4, frames: 50, maxMps: 0 },     // human brake (after the park)
      { flags: 0, frames: 10, maxMps: 0 },
      { flags: 8, frames: 521, maxMps: 4.7 },  // human accelerator
      { flags: 0, frames: 16, maxMps: 4.0 },
      { flags: 8, frames: 545, maxMps: 4.7 },
      { flags: 0, frames: 55, maxMps: 1.0 },
    ],
    { speed: 0.4 },
  );
  // Simulate the dedup skew: the summon segment's fraction-based point slice
  // ([0..31) of 100) reaches into fast post-park samples.
  clipB.speeds = clipB.speeds.map((s, i) => (i < 25 ? 0.4 : 4.7));

  const drives = drivesOf([clipA, clipB]);
  assert.equal(drives.length, 2);
  // Stats are polluted (over the 7.83 mph gate) yet the drive is summon.
  assert.ok(drives[0].maxSpeedMph > 8, 'fixture must reproduce the pollution');
  assert.equal(drives[0].summon, true);
  assert.equal(drives[1].summon, undefined); // the human drive after the park
});
