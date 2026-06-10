// Behavioral tests for drive identification — ported from the canonical Rust
// grouper suite (Sentry-USB-Rusty/crates/drives/src/grouper.rs `#[cfg(test)]`).
//
// These run against Drive's real public entry point, groupIntoDrives, which
// MATERIALIZES the drive list (one drive per group). Where a Rust test targets
// the server's fast summary-count path, we port its intent against the
// materialized result and call out the known fast-path-vs-materialized
// difference (the only one: an all-parked clip → 1 materialized drive here,
// vs 0 from Rust's 0.6 count-only optimization; Rust's own materialized path
// also counts it as 1 — see grouper.rs:1774).

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

test('all-parked clip → 1 materialized drive', () => {
  // Drive materializes the all-parked group as a single drive (the
  // splitByGearState [group] fallback), matching Rust's materialized path
  // (grouper.rs:1774 "count as 1"). Rust's FAST summary endpoint returns 0
  // via its 0.6 count-only shortcut — that approximation is not replicated.
  const drives = drivesOf([
    clipWithGearRuns('/cam/2025-01-15_12-00-00-front.mp4', [[GEAR_PARK, 60]]),
  ]);
  assert.equal(drives.length, 1);
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
