import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDriveIndex,
  indexDriveData,
} from './drive-index.cjs';

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-index-'));
  const sourcePath = path.join(dir, 'drive-data.json');
  const dbPath = path.join(dir, 'index.sqlite');
  const route = (file, lat) => ({
    file,
    date: file.slice(-29, -10),
    points: [[lat, -76.7], [lat + 0.001, -76.701]],
    speeds: [1, 2],
  });
  fs.writeFileSync(sourcePath, JSON.stringify({
    driveTags: {
      '2026-07-28T10:00:00': ['Work', 'Unicode ✓'],
    },
    routes: [
      route('RecentClips/2026-07-28/2026-07-28_10-00-00-front.mp4', 39.1),
      route('RecentClips\\2026-07-28\\2026-07-28_10-00-00-front.mp4', 39.2),
      route('2026-07-28/2026-07-28_10-00-00-front.mp4', 39.25),
      route('SavedClips/2026-07-28_10-30-00/2026-07-28_10-01-00-front.mp4', 39.3),
      route('RecentClips/2026-07-28/2026-07-28_11-00-00-front.mp4', 39.4),
    ],
    processedFiles: ['one.mp4', 'two.mp4'],
  }));
  return { dir, sourcePath, dbPath };
}

test('indexes routes on disk with normalized deduplication and bounded time windows', async (t) => {
  const fixture = makeFixture();
  const index = createDriveIndex(fixture);
  t.after(() => {
    index.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });
  const meta = await indexDriveData(index);

  assert.deepEqual(meta, {
    processedFileCount: 2,
    routeCount: 3,
    droppedCount: 0,
    duplicateCount: 2,
    chargingSessionCount: 0,
    chargingSiteCount: 0,
  });
  const windows = [...index.iterateTimeWindows()];
  assert.equal(windows.length, 2);
  assert.equal(windows[0].length, 2);
  assert.equal(windows[1].length, 1);
  assert.equal(windows[0][0].file, '2026-07-28/2026-07-28_10-00-00-front.mp4');
  assert.equal(
    windows[0][1].file,
    'SavedClips/2026-07-28_10-30-00/2026-07-28_10-01-00-front.mp4',
  );
  assert.deepEqual(index.getDriveTags(), {
    '2026-07-28T10:00:00': ['Work', 'Unicode ✓'],
  });
});

test('reports byte progress and cancellation without returning partial success', async (t) => {
  const fixture = makeFixture();
  const index = createDriveIndex(fixture);
  t.after(() => {
    index.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const progress = [];
  await assert.rejects(
    indexDriveData(index, {
      signal: controller.signal,
      onProgress(current, total) {
        progress.push([current, total]);
        controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.ok(progress.length >= 1);
});

test('indexes charging summaries separately from detailed curve samples', async (t) => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.sourcePath, JSON.stringify({
    processedFiles: [],
    routes: [],
    driveTags: {},
    telemetrySamples: [
      { ts: 1_000, lat: 40, lng: -76, locationName: 'North charger', batteryPct: 10 },
      { ts: 1_010, chargingState: 'charging', chargeEnergyAddedKwh: 0.1 },
      { ts: 1_020, chargerPowerKw: 50, chargeRateMph: 220, chargeEnergyAddedKwh: 2, batteryPct: 25 },
      { ts: 1_030, chargingState: 'complete', batteryPct: 30 },
      { ts: 2_000, lat: 40.0006, lng: -76.0004, locationName: 'North charger' },
      { ts: 2_010, chargingState: 'charging', chargeEnergyAddedKwh: 1 },
      { ts: 2_020, chargingState: 'stopped' },
      { ts: 3_000, chargingState: 'charging', chargeEnergyAddedKwh: 3 },
      { ts: 3_010, chargingState: 'complete' },
    ],
    chargeCosts: {
      1010: { amount: 4.5, currency: '$' },
    },
  }));
  const index = createDriveIndex(fixture);
  t.after(() => {
    index.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const counts = await indexDriveData(index);
  assert.equal(counts.chargingSessionCount, 3);
  assert.equal(counts.chargingSiteCount, 2);

  const sites = index.listChargingSites();
  assert.deepEqual(sites.map((site) => [site.siteId, site.visitCount]), [
    ['site-charge-1010-1', 2],
    ['unknown', 1],
  ]);

  const summaries = index.listChargingSessions('site-charge-1010-1');
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].sessionId, 'charge-2010-2');
  assert.equal('chargeRateSamples' in summaries[0], false);

  const detail = index.getChargingSession('charge-1010-1');
  assert.equal(detail.cost.amount, 4.5);
  assert.equal(detail.chargeRateSamples.length, 2);
  assert.equal(index.getChargingSession('missing'), null);
});
