import test from 'node:test';
import assert from 'node:assert/strict';
import processResult from './process-result.cjs';

const { buildProcessedRoute } = processResult;

function extracted(relativePath, extra = {}) {
  return {
    relativePath,
    dateDir: '2026-07-27',
    hasGPS: true,
    points: [[39, -76]],
    gearRuns: [{ gear: 1, frames: 60 }],
    gearStates: [1],
    autopilotStates: [0],
    speeds: [4],
    accelPositions: [0],
    rawParkCount: 0,
    rawFrameCount: 60,
    ...extra,
  };
}

test('parked event extraction is marked processed without becoming a route', () => {
  const result = buildProcessedRoute(extracted(
    'SavedClips/event/2026-07-27_14-02-02-front.mp4',
    {
      gearRuns: [{ gear: 0, frames: 60 }],
      gearStates: [0],
      speeds: [0],
      rawParkCount: 60,
    },
  ));

  assert.equal(result.processedPath, 'SavedClips/event/2026-07-27_14-02-02-front.mp4');
  assert.equal(result.parkedEventSkipped, true);
  assert.equal(result.route, null);
});

test('driving event extraction keeps its real event path', () => {
  const result = buildProcessedRoute(extracted(
    'SavedClips/event/2026-07-27_14-02-02-front.mp4',
  ));

  assert.equal(result.parkedEventSkipped, false);
  assert.equal(result.route.file, 'SavedClips/event/2026-07-27_14-02-02-front.mp4');
  assert.deepEqual(result.route.points, [[39, -76]]);
});

test('normal extraction stores one canonical path', () => {
  const result = buildProcessedRoute(extracted(
    'RecentClips\\2026-07-27\\2026-07-27_14-01-02-front.mp4',
  ));

  assert.equal(result.processedPath, '2026-07-27/2026-07-27_14-01-02-front.mp4');
  assert.equal(result.route.file, '2026-07-27/2026-07-27_14-01-02-front.mp4');
});

test('summon evidence survives into the stored route', () => {
  const flagRuns = [{ flags: 3, frames: 30, maxMps: 0.4 }, { flags: 0, frames: 30, maxMps: 2.1 }];
  const apRuns = [{ ap: 0, frames: 10 }, { ap: 1, frames: 50 }];
  const result = buildProcessedRoute(extracted(
    '2026-07-27/2026-07-27_14-01-02-front.mp4',
    { flagRuns, apRuns },
  ));

  // Without these the drive can only be tagged after Check for Summon reruns.
  assert.deepEqual(result.route.flagRuns, flagRuns);
  assert.deepEqual(result.route.apRuns, apRuns);
});

test('errors and clips without GPS are processed without routes', () => {
  assert.deepEqual(
    buildProcessedRoute(extracted('2026-07-27/error-front.mp4', { error: 'bad video' })),
    {
      processedPath: '2026-07-27/error-front.mp4',
      route: null,
      parkedEventSkipped: false,
    },
  );
  assert.deepEqual(
    buildProcessedRoute(extracted('2026-07-27/no-gps-front.mp4', { hasGPS: false })),
    {
      processedPath: '2026-07-27/no-gps-front.mp4',
      route: null,
      parkedEventSkipped: false,
    },
  );
});
