// Behavioral parity tests for drive identification.

import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoDrives, isEventFolderPath } from './grouper.js';
import { GEAR_PARK, GEAR_DRIVE } from '../shared/drive-calc.cjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function linePoints(n, baseLat = 37.0, baseLng = -122.0) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([baseLat + i * 1e-4, baseLng]);
  return pts;
}

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

// One point per frame keeps frame-fraction slicing aligned with point indices.
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

// ─── Event-folder paths ──────────────────────────────────────────────────────

test('isEventFolderPath: top-level SavedClips/SentryClips only', () => {
  assert.equal(isEventFolderPath('SavedClips/2026-05-17_18-47-59/2026-05-17_18-47-34-front.mp4'), true);
  assert.equal(isEventFolderPath('SentryClips/2026-05-17_18-46-39/2026-05-17_18-35-39-front.mp4'), true);
  assert.equal(isEventFolderPath('SavedClips\\2026-05-17_18-47-59\\2026-05-17_18-47-34-front.mp4'), true);
  assert.equal(isEventFolderPath('SentryClips\\foo\\bar-front.mp4'), true);
  assert.equal(isEventFolderPath('RecentClips/2026-05-17/2026-05-17_18-47-34-front.mp4'), false);
  assert.equal(isEventFolderPath('2026-05-17/2026-05-17_18-47-34-front.mp4'), false);
  assert.equal(isEventFolderPath('2026-05-17\\2026-05-17_18-47-34-front.mp4'), false);
  assert.equal(isEventFolderPath(''), false);
  // Only top-level path segments identify event folders.
  assert.equal(isEventFolderPath('foo/SavedClips/x.mp4'), false);
  assert.equal(isEventFolderPath('MySavedClips/x.mp4'), false);
});

// ─── Grouping ────────────────────────────────────────────────────────────────

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

// ─── Gear-state park splitting ───────────────────────────────────────────────

test('two internal park gaps split one clip into three drives', () => {
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
  // Fully parked groups are recordings, not trips.
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

test('RecentClips-prefixed and canonical route paths are one clip', () => {
  const drives = drivesOf([
    testRoute('RecentClips/2026-07-27/2026-07-27_14-01-02-front.mp4', [[37, -122]]),
    testRoute('2026-07-27/2026-07-27_14-01-02-front.mp4', [[38, -123]]),
  ]);
  assert.equal(drives.length, 1);
  assert.deepEqual(
    drives[0].routeFiles,
    ['2026-07-27/2026-07-27_14-01-02-front.mp4'],
  );
});

test('event-folder routes are filtered out of grouping (grouper.rs:3314)', () => {
  const drives = drivesOf([
    testRoute('RecentClips/2025-01-15/2025-01-15_12-30-00-front.mp4', [[37.0, -122.0]]),
    testRoute('SavedClips/2025-01-15_12-30-30/2025-01-15_12-30-00-front.mp4', [[37.0, -122.0]]),
    testRoute('SentryClips/2025-01-15_12-29-30/2025-01-15_12-30-00-front.mp4', [[37.0, -122.0]]),
  ]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].routeFiles.length, 1);
  assert.equal(drives[0].routeFiles[0], '2025-01-15/2025-01-15_12-30-00-front.mp4');
});

test('July 27 manual save: driving SavedClips fill the RecentClips hole', () => {
  const routes = [
    testRoute(
      '2026-07-27/2026-07-27_14-01-02-front.mp4',
      [[39.0, -76.7]],
    ),
  ];
  const savedClipTimes = [
    '14-02-02',
    '14-03-02',
    '14-04-03',
    '14-05-03',
    '14-06-03',
    '14-07-03',
    '14-08-04',
    '14-09-04',
    '14-10-04',
    '14-11-04',
    '14-12-05',
  ];
  savedClipTimes.forEach((time, index) => {
    routes.push(testRoute(
      `SavedClips/2026-07-27_14-12-29/2026-07-27_${time}-front.mp4`,
      [[39.001 + index * 0.001, -76.7]],
    ));
  });
  routes.push(testRoute(
    '2026-07-27/2026-07-27_14-12-26-front.mp4',
    [[39.013, -76.7]],
  ));

  const drives = drivesOf(routes);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].routeFiles.length, 13);
  assert.equal(
    drives[0].routeFiles.filter((file) => file.startsWith('SavedClips/')).length,
    11,
  );
  assert.deepEqual(drives[0].routeFiles, routes.map((route) => route.file));
});

test('May 17 regression: event clips do not create a phantom parked drive', () => {
  // Event recordings must not create a parked drive alongside the trip.
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
  const expectedDriveFiles = [
    '2026-05-17/2026-05-17_18-47-34-front.mp4',
    '2026-05-17/2026-05-17_18-48-34-front.mp4',
    '2026-05-17/2026-05-17_18-49-34-front.mp4',
    '2026-05-17/2026-05-17_18-50-34-front.mp4',
    '2026-05-17/2026-05-17_18-51-34-front.mp4',
  ];
  driveStarts.forEach((f, i) => {
    routes.push(testRoute(f, [[39.198835 + i * 1e-4, -76.795246]]));
  });

  const drives = drivesOf(routes);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].routeFiles.length, driveStarts.length);
  assert.deepEqual(drives[0].routeFiles, expectedDriveFiles);
});

// ─── BLE location-name rollup ────────────────────────────────────────────────
// Preserve the first start and last end value; omit fields with no samples.

test('locationName rollup: first non-null start, last non-null end (Rust roll_up_telemetry)', () => {
  const routes = [
    { ...testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', [[37.0, -122.0]]),
      locationNameEnd: '100 First St' },
    { ...testRoute('RecentClips/2026-05-17_10-01-00-front.mp4', [[37.001, -122.0]]),
      locationNameStart: '100 First St', locationNameEnd: '250 Mid Ave' },
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
// Preserve the first start and last end value; omit fields with no samples.

test('battery rollup: first non-null start, last non-null end', () => {
  const routes = [
    testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', [[37.0, -122.0]]),
    { ...testRoute('RecentClips/2026-05-17_10-01-00-front.mp4', [[37.001, -122.0]]),
      batteryPctStart: 78, batteryPctEnd: 71 },
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

// ─── Geocode endpoint snapping ───────────────────────────────────────────────
// Use stationary-cluster medians; retain a rolling endpoint with <3 fixes.

test('complete BLE telemetry rollup matches Sentry USB drive summaries', () => {
  const drives = drivesOf([
    {
      ...testRoute('2026-07-27/2026-07-27_10-00-00-front.mp4', [[37, -122]]),
      batteryPctStart: 80, batteryPctEnd: 79,
      interiorTempMin: 20, interiorTempMax: 24, exteriorTempAvg: 30,
      hvacRuntimeS: 30, tireFlPsi: 42, tireRlPsi: 43,
      odometerMiStart: 1000,
    },
    {
      ...testRoute('2026-07-27/2026-07-27_10-01-00-front.mp4', [[37.001, -122]]),
      batteryPctStart: 79, batteryPctEnd: 78,
      interiorTempMin: 18, interiorTempMax: 28, exteriorTempAvg: 32,
      hvacRuntimeS: 45, tireFlPsi: 41.5, tireFrPsi: 42.5,
      tireRrPsi: 43.5, odometerMiEnd: 1002.25,
    },
  ]);
  assert.equal(drives.length, 1);
  assert.deepEqual({
    batteryPctStart: drives[0].batteryPctStart,
    batteryPctEnd: drives[0].batteryPctEnd,
    batteryPctUsed: drives[0].batteryPctUsed,
    interiorTempMinC: drives[0].interiorTempMinC,
    interiorTempMaxC: drives[0].interiorTempMaxC,
    exteriorTempAvgC: drives[0].exteriorTempAvgC,
    hvacRuntimeS: drives[0].hvacRuntimeS,
    tireFlPsi: drives[0].tireFlPsi,
    tireFrPsi: drives[0].tireFrPsi,
    tireRlPsi: drives[0].tireRlPsi,
    tireRrPsi: drives[0].tireRrPsi,
    odometerMiStart: drives[0].odometerMiStart,
    odometerMiEnd: drives[0].odometerMiEnd,
    odometerMiDriven: drives[0].odometerMiDriven,
  }, {
    batteryPctStart: 80, batteryPctEnd: 78, batteryPctUsed: 2,
    interiorTempMinC: 18, interiorTempMaxC: 28, exteriorTempAvgC: 31,
    hvacRuntimeS: 75, tireFlPsi: 41.5, tireFrPsi: 42.5,
    tireRlPsi: 43, tireRrPsi: 43.5,
    odometerMiStart: 1000, odometerMiEnd: 1002.25, odometerMiDriven: 2.25,
  });
});

test('geocode endpoints: stationary-median start, raw terminal fix when rolling', () => {
  const pts = [
    [37.000000, -122.0],
    [37.000018, -122.0],
    [36.999991, -122.0],
    [37.000009, -122.0],
    [37.000036, -122.0],
    [37.000300, -122.0],
    [37.000600, -122.0],
    [37.000900, -122.0],
  ];
  const drives = drivesOf([testRoute('RecentClips/2026-05-17_10-00-00-front.mp4', pts)]);
  assert.equal(drives.length, 1);
  const d = drives[0];
  assert.equal(d.geocodeStartPoint[0], 37.000009);
  assert.equal(d.geocodeStartPoint[1], -122.0);
  assert.equal(d.geocodeEndPoint[0], 37.000900);
  assert.equal(d.geocodeEndPoint[1], -122.0);
});

// ─── Drive end-time convention ───────────────────────────────────────────────
// Park-split drives end at the last driving frame; unsplit clips retain +60 s.

test('drive ends at the last driving frame, not +60s, when the final clip is park-split', () => {
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

// ─── Event-clip gap fill ─────────────────────────────────────────────────────
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

  // The 30-minute cap is measured from the chain anchor.
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
  // rawFrameCount alone does not establish driving telemetry.
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
    '2026-07-04/2026-07-04_20-42-50-front.mp4',
    '2026-07-04/2026-07-04_20-43-50-front.mp4',
    'SentryClips/2026-07-04_20-55-50/2026-07-04_20-44-51-front.mp4',
    'SentryClips/2026-07-04_20-55-50/2026-07-04_20-45-51-front.mp4',
  ]);
});

// ─── Clip span ───────────────────────────────────────────────────────────────

test('a clip that stopped early stamps its points inside the drive, not across a minute', () => {
  // The next clip starts 20 s later, so clip A's recording covered 20 s — its
  // 700 frames are not a minute's worth. Spreading them across a nominal
  // minute pushed points past the drive's own end and made the next clip's
  // first point step backwards, inflating every duration-weighted statistic.
  const a = clipWithGearRuns('2026-08-11/2026-08-11_00-33-32-front.mp4', [[GEAR_DRIVE, 700]], 37.0);
  const b = clipWithGearRuns('2026-08-11/2026-08-11_00-33-52-front.mp4', [[GEAR_DRIVE, 2100]], 37.1);

  const drives = drivesOf([a, b]);
  assert.equal(drives.length, 1);
  const pts = drives[0].points;
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i][2] >= pts[i - 1][2], `point ${i} steps backwards`);
  }
  const span = pts[pts.length - 1][2] - pts[0][2];
  assert.ok(span <= drives[0].durationMs, `point span ${span} exceeds duration ${drives[0].durationMs}`);
  // 20 s of clip A, then clip B runs to its own nominal end.
  assert.equal(drives[0].durationMs, 80000);
});

test('clip spans do not stretch across a recording gap', () => {
  // Ten minutes apart is not one clip lasting ten minutes; each keeps the
  // nominal minute, and the drive splitter separates them anyway.
  const a = clipWithGearRuns('2026-08-11/2026-08-11_00-33-32-front.mp4', [[GEAR_DRIVE, 2100]], 37.0);
  const b = clipWithGearRuns('2026-08-11/2026-08-11_00-43-32-front.mp4', [[GEAR_DRIVE, 2100]], 37.1);
  const drives = drivesOf([a, b]);
  assert.equal(drives.length, 2);
  assert.equal(drives[0].durationMs, 60000);
  assert.equal(drives[1].durationMs, 60000);
});

// ─── Summon detection ────────────────────────────────────────────────────────
// flagRuns and gearRuns share the raw SEI frame sequence.

function summonClip(
  file,
  gearRunPairs,
  flagRuns,
  { speed = 2.0, n = 100, baseLat = 37.0, apRuns, apState } = {},
) {
  const clip = clipWithGearRuns(file, gearRunPairs, baseLat);
  clip.points = clip.points.slice(0, n);
  while (clip.points.length < n) clip.points.push([baseLat + clip.points.length * 1e-6, -122.0]);
  clip.speeds = new Array(n).fill(speed);
  clip.flagRuns = flagRuns;
  // apRuns is the raw-frame autopilot evidence; apState fills the per-point
  // states the FSD statistics are built from.
  if (apRuns) clip.apRuns = apRuns;
  if (apState !== undefined) clip.autopilotStates = new Array(n).fill(apState);
  return clip;
}

const ASS_START_RUNS = [
  { flags: 0, frames: 27 },
  { flags: 3, frames: 123 },  // hazards through P→D
  { flags: 0, frames: 17 },
  { flags: 1, frames: 873 },
  { flags: 0, frames: 746 },
];
const ASS_END_RUNS = [
  { flags: 0, frames: 471 },
  { flags: 3, frames: 82 },   // hazards through D→P
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
  // Missing evidence must not infer Summon.
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

test('summon: Self Driving crawl without hazards is flagged and skips FSD stats', () => {
  // Newer firmware reports Summon as autopilot_state = FSD; the hazards that
  // older firmware alone identified it by need not be in evidence.
  const clip = summonClip(
    '2026-08-14/2026-08-14_09-00-00-front.mp4',
    [[GEAR_PARK, 90], [GEAR_DRIVE, 300], [GEAR_PARK, 60]],
    [{ flags: 0, frames: 450 }],
    {
      apRuns: [{ ap: 0, frames: 90 }, { ap: 1, frames: 300 }, { ap: 0, frames: 60 }],
      apState: 1,
    },
  );
  const drives = drivesOf([clip]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].summon, true);
  // The maneuver is driverless, so it books no FSD engagement and no
  // disengagement where the car parked itself.
  assert.equal(drives[0].fsdEngagedMs, 0);
  assert.equal(drives[0].fsdDistanceKm, 0);
  assert.equal(drives[0].fsdPercent, 0);
  assert.equal(drives[0].fsdDisengagements, 0);
  assert.equal(drives[0].assistedPercent, 0);
  assert.equal(drives[0].fsdEvents, undefined);
});

test('summon: a slow pedal-free FSD fragment is not summon and keeps its FSD stats', () => {
  // An unfilled hole in RecentClips cuts a trip into legs, so this leg begins
  // mid-motion: no Park run, hence no park split, and under FSD nobody touches
  // a pedal. Only the park bracketing separates it from a maneuver — without
  // it, a real FSD drive would be badged Summon and erased from FSD analytics.
  const clip = summonClip(
    '2026-08-14/2026-08-14_11-00-00-front.mp4',
    [[GEAR_DRIVE, 450]],
    [{ flags: 0, frames: 450 }],
    { apRuns: [{ ap: 1, frames: 450 }], apState: 1 },
  );
  const drives = drivesOf([clip]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].summon, undefined);
  assert.ok(drives[0].fsdEngagedMs > 0);
  assert.equal(drives[0].fsdPercent, 100);
});

test('summon: a pedal-free FSD crawl still needs the speed gate', () => {
  // Same Self Driving evidence, driven at road speed: an ordinary FSD trip.
  const clip = summonClip(
    '2026-08-14/2026-08-14_10-00-00-front.mp4',
    [[GEAR_PARK, 90], [GEAR_DRIVE, 300], [GEAR_PARK, 60]],
    [{ flags: 0, frames: 450 }],
    {
      speed: 12.0,
      apRuns: [{ ap: 0, frames: 90 }, { ap: 1, frames: 300 }, { ap: 0, frames: 60 }],
      apState: 1,
    },
  );
  const drives = drivesOf([clip]);
  assert.equal(drives.length, 1);
  assert.equal(drives[0].summon, undefined);
  assert.ok(drives[0].fsdEngagedMs > 0);
});

test('summon: reverse-only summon (negative SEI speeds) is flagged', () => {
  // Reverse SEI speeds are negative; detection uses their magnitude.
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
  // Display statistics also use the SEI magnitude.
  assert.equal(drives[0].maxSpeedMph, 3.36);
  assert.equal(drives[0].avgSpeedMph, 3.36);
});

test('summon: reverse summon ending seconds before the human drives off splits and flags', () => {
  // A mid-clip park isolates Summon evidence from the following human drive.
  const clipA = summonClip(
    '2026-07-27/2026-07-27_20-04-00-front.mp4',
    [[GEAR_PARK, 46], [2 /* R */, 727], [GEAR_DRIVE, 917]],
    [
      { flags: 0, frames: 11 },
      { flags: 3, frames: 113 },  // hazards spanning P→R
      { flags: 0, frames: 394 },
      { flags: 2, frames: 256 },
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
      { flags: 3, frames: 89 },   // hazards through D→P
      { flags: 4, frames: 70 },
      { flags: 0, frames: 200 },
      { flags: 8, frames: 690 },
      { flags: 0, frames: 112 },
      { flags: 1, frames: 431 },
    ],
    { speed: 0.3 },
  );
  // Only the pre-park tail remains at Summon speed.
  clipB.speeds = clipB.speeds.map((s, i) => (i < 10 ? 0.3 : 5.4));

  const drives = drivesOf([clipA, clipB]);
  assert.equal(drives.length, 2);
  assert.equal(drives[0].summon, true);
  assert.equal(drives[1].summon, undefined);
});

test('summon: point-slice speed pollution does not reject a frame-slow summon', () => {
  // Per-run maxima override point-slice contamination from a following drive.
  const clipA = summonClip(
    '2026-07-27/2026-07-27_00-34-31-front.mp4',
    [[GEAR_PARK, 68], [2 /* R */, 538], [GEAR_DRIVE, 311]],
    [
      { flags: 0, frames: 7, maxMps: 0 },
      { flags: 3, frames: 144, maxMps: 0.1 },  // hazards spanning P→R
      { flags: 0, frames: 766, maxMps: 2.7 },
    ],
    { speed: 1.5 },
  );
  const clipB = summonClip(
    '2026-07-27/2026-07-27_00-34-59-front.mp4',
    [[GEAR_DRIVE, 579], [GEAR_PARK, 114], [GEAR_DRIVE, 1162]],
    [
      { flags: 0, frames: 143, maxMps: 2.7 },
      { flags: 3, frames: 219, maxMps: 2.6 },
      { flags: 0, frames: 105, maxMps: 2.0 },
      { flags: 3, frames: 191, maxMps: 1.8 },  // hazards through D→P
      { flags: 4, frames: 50, maxMps: 0 },
      { flags: 0, frames: 10, maxMps: 0 },
      { flags: 8, frames: 521, maxMps: 4.7 },
      { flags: 0, frames: 16, maxMps: 4.0 },
      { flags: 8, frames: 545, maxMps: 4.7 },
      { flags: 0, frames: 55, maxMps: 1.0 },
    ],
    { speed: 0.4 },
  );
  // The fraction-based slice reaches into faster post-park samples.
  clipB.speeds = clipB.speeds.map((s, i) => (i < 25 ? 0.4 : 4.7));

  const drives = drivesOf([clipA, clipB]);
  assert.equal(drives.length, 2);
  assert.ok(drives[0].maxSpeedMph > 8, 'fixture must reproduce the pollution');
  assert.equal(drives[0].summon, true);
  assert.equal(drives[1].summon, undefined);
});

// ─── Park splitting: short segments survive GPS deduplication ────────────────

test('summon: a tail finishing seconds into the next clip survives GPS dedup', () => {
  // The maneuver ends a few seconds into clip B, so the closing hazard flash
  // the bookend signature needs lives in a segment only ~120 raw frames long.
  // A barely-moving car dedups to a handful of GPS points, and both ends of
  // that segment used to round onto the same point index — deleting it, its
  // hazards, and the detection. Point density must not decide this.
  const clipsFor = (n) => [
    summonClip(
      '2026-08-01/2026-08-01_09-00-00-front.mp4',
      [[GEAR_PARK, 60], [GEAR_DRIVE, 1740]],
      [
        { flags: 0, frames: 20, maxMps: 0 },
        { flags: 3, frames: 130, maxMps: 0.4 },  // hazards through P→D
        { flags: 0, frames: 1650, maxMps: 2.2 },
      ],
      { n: 100 },
    ),
    summonClip(
      '2026-08-01/2026-08-01_09-01-00-front.mp4',
      [[GEAR_DRIVE, 120], [GEAR_PARK, 120], [GEAR_DRIVE, 1560]],
      [
        { flags: 3, frames: 120, maxMps: 1.1 },  // hazards through D→P
        { flags: 0, frames: 120, maxMps: 0 },
        { flags: 8, frames: 1560, maxMps: 12.0 },
      ],
      { n, speed: 1.0 },
    ),
  ];

  // Six points across clip B is the dedup level that used to lose the tail.
  for (const n of [6, 12, 100]) {
    const drives = drivesOf(clipsFor(n));
    assert.equal(drives.length, 2, `n=${n}`);
    assert.equal(drives[0].summon, true, `n=${n}`);
    assert.equal(drives[0].routeFiles.length, 2, `n=${n}: tail segment kept`);
    // Duration comes from the raw frame bounds, so a one-point tail still
    // measures its true 4 s: 58 s of clip A plus 4 s of clip B.
    assert.equal(drives[0].durationMs, 62000, `n=${n}`);
    // The human drive off the same clip keeps its pedal input and is not Summon.
    assert.equal(drives[1].summon, undefined, `n=${n}`);
  }
});

test('park split: leading and middle motion segments survive at any point density', () => {
  // Four motion runs separated by park gaps. At six points the leading and
  // middle 30-frame runs both collapse to a single index; only the trailing
  // one was rescued, by the clamp that pulls startIdx back inside the array.
  // Every segment with at least one raw frame must produce a drive, and the
  // frame-derived durations must not move with the point count.
  const runs = [
    [GEAR_DRIVE, 30], [GEAR_PARK, 120],
    [GEAR_DRIVE, 420], [GEAR_PARK, 120],
    [GEAR_DRIVE, 30], [GEAR_PARK, 120],
    [GEAR_DRIVE, 960],
  ];
  const expected = [1000, 14000, 1000, 32000];

  for (const n of [6, 100, 1800]) {
    const clip = clipWithGearRuns('2026-08-02/2026-08-02_09-00-00-front.mp4', runs);
    clip.points = clip.points.slice(0, n);
    const drives = drivesOf([clip]);
    assert.equal(drives.length, expected.length, `n=${n}: one drive per motion run`);
    assert.deepEqual(drives.map((d) => d.durationMs), expected, `n=${n}`);
    for (const drive of drives) assert.ok(drive.pointCount > 0, `n=${n}: every drive keeps a point`);
  }
});
