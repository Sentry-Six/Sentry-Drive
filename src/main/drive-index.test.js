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
  // Event-folder routes are stored now (gap-fill parity), and windows split
  // on GAP_FILL_MAX_MS (30 min): [10:00 recent, 10:01 saved] | [11:00 recent].
  const windows = [...index.iterateTimeWindows()];
  assert.equal(windows.length, 2);
  assert.equal(windows[0].length, 2);
  assert.equal(windows[1].length, 1);
  assert.equal(windows[0][0].file, '2026-07-28/2026-07-28_10-00-00-front.mp4');
  assert.equal(
    windows[0][1].file,
    'SavedClips/2026-07-28_10-30-00/2026-07-28_10-01-00-front.mp4',
  );
  assert.equal(windows[1][0].file, '2026-07-28/2026-07-28_11-00-00-front.mp4');
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

test('listDriveSummaries filters by tag and inclusive date range; defaults filter nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-index-'));
  const index = createDriveIndex({
    dbPath: path.join(dir, 'index.sqlite'),
    sourcePath: path.join(dir, 'unused.json'),
  });
  t.after(() => {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const put = (id, startTime, tags) => index.putDrive(
    { id, startTime, source: 'sei', tags },
    { points: [] },
  );
  put(1, '2026-07-10T08:00:00', ['Home']);
  put(2, '2026-07-15T09:30:00', ['Work', 'Road Trip']);
  put(3, '2026-07-15T18:00:00', []);
  put(4, '2026-07-20T12:00:00', ['home']); // case-folded storage

  // Defaults: no filtering
  const all = index.listDriveSummaries({});
  assert.equal(all.total, 4);

  // Tag filter: whole-tag, case-insensitive; "work" must not match a
  // hypothetical "homework"
  assert.equal(index.listDriveSummaries({ tag: 'Home' }).total, 2);
  assert.equal(index.listDriveSummaries({ tag: 'work' }).total, 1);
  assert.equal(index.listDriveSummaries({ tag: 'Road Trip' }).total, 1);
  assert.equal(index.listDriveSummaries({ tag: 'o' }).total, 0);

  // Date range: inclusive both ends, either side may be open
  assert.equal(index.listDriveSummaries({ startDate: '2026-07-15' }).total, 3);
  assert.equal(index.listDriveSummaries({ endDate: '2026-07-15' }).total, 3);
  assert.equal(index.listDriveSummaries({ startDate: '2026-07-15', endDate: '2026-07-15' }).total, 2);
  assert.equal(index.listDriveSummaries({ startDate: '2026-07-16', endDate: '2026-07-19' }).total, 0);

  // Combined + filtered total drives the pager
  const combo = index.listDriveSummaries({ tag: 'home', startDate: '2026-07-11' });
  assert.equal(combo.total, 1);
  assert.equal(combo.drives[0].id, 4);
});

test('setDriveTags keeps tag filtering truthful after an in-session edit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-index-'));
  const index = createDriveIndex({
    dbPath: path.join(dir, 'index.sqlite'),
    sourcePath: path.join(dir, 'unused.json'),
  });
  t.after(() => {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  index.putDrive({ id: 1, startTime: '2026-07-15T09:30:00', source: 'sei', tags: [] }, { points: [] });
  assert.equal(index.listDriveSummaries({ tag: 'errand' }).total, 0);

  index.setDriveTags('2026-07-15T09:30:00', ['Errand']);
  assert.equal(index.listDriveSummaries({ tag: 'errand' }).total, 1);
  assert.deepEqual(index.getDriveTags(), { '2026-07-15T09:30:00': ['Errand'] });

  index.setDriveTags('2026-07-15T09:30:00', []);
  assert.equal(index.listDriveSummaries({ tag: 'errand' }).total, 0);
  assert.deepEqual(index.getDriveTags(), {});
});

test('summon drives filter via the synthetic tag and survive tag edits', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-index-'));
  const index = createDriveIndex({
    dbPath: path.join(dir, 'index.sqlite'),
    sourcePath: path.join(dir, 'unused.json'),
  });
  t.after(() => {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  index.putDrive(
    { id: 1, startTime: '2026-07-15T20:49:56', source: 'sei', tags: [], summon: true },
    { points: [] },
  );
  index.putDrive(
    { id: 2, startTime: '2026-07-15T21:00:00', source: 'sei', tags: ['Work'] },
    { points: [] },
  );

  // The synthetic entry lives in the filter column only — the summary keeps
  // user tags untouched.
  const summonPage = index.listDriveSummaries({ tag: 'summon' });
  assert.equal(summonPage.total, 1);
  assert.equal(summonPage.drives[0].id, 1);
  assert.deepEqual(summonPage.drives[0].tags, []);

  // An in-session user tag edit must not knock the drive out of the Summon
  // filter (setDriveTags re-reads the summary to re-append the synthetic tag).
  index.setDriveTags('2026-07-15T20:49:56', ['Errand']);
  assert.equal(index.listDriveSummaries({ tag: 'summon' }).total, 1);
  assert.equal(index.listDriveSummaries({ tag: 'Errand' }).total, 1);

  // Clearing tags on a non-summon drive never invents a summon entry.
  index.setDriveTags('2026-07-15T21:00:00', []);
  assert.equal(index.listDriveSummaries({ tag: 'summon' }).total, 1);
});
