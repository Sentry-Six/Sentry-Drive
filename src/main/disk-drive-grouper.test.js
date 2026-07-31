import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDriveIndex, indexDriveData } from './drive-index.cjs';
import { groupIndexedDrives } from './disk-drive-grouper.cjs';
import { groupIntoDrives } from '../processing/grouper.js';

function route(file, lat, extra = {}) {
  return {
    file,
    date: file.match(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/)?.[0],
    points: [
      [lat, -76.7],
      [lat + 0.001, -76.701],
      [lat + 0.002, -76.702],
    ],
    speeds: [1, 2, 3],
    ...extra,
  };
}

function makeIndex(routes, driveTags = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-disk-group-'));
  const sourcePath = path.join(dir, 'drive-data.json');
  const dbPath = path.join(dir, 'index.sqlite');
  fs.writeFileSync(sourcePath, JSON.stringify({
    processedFiles: [],
    routes,
    driveTags,
  }));
  const index = createDriveIndex({ dbPath, sourcePath });
  return { dir, sourcePath, index };
}

function summaryComparable(drive) {
  const copy = structuredClone(drive);
  delete copy.points;
  delete copy.fsdStates;
  delete copy.gearStates;
  delete copy.fsdEvents;
  delete copy.overviewPoints;
  delete copy.tags;
  delete copy.bridged;
  return copy;
}

test('disk grouping preserves existing grouper summaries and stores detail separately', async (t) => {
  const routes = [
    route('RecentClips/2026-07-28_10-00-00-front.mp4', 39.1),
    route('RecentClips/2026-07-28_10-01-00-front.mp4', 39.2),
    route('RecentClips/2026-07-28_11-00-00-front.mp4', 39.4),
  ];
  const expected = groupIntoDrives(routes).drives;
  const fixture = makeIndex(routes, {
    [expected[0].startTime]: ['Morning'],
  });
  t.after(() => {
    fixture.index.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });
  await indexDriveData(fixture.index);

  const result = await groupIndexedDrives(fixture.index);
  const listed = fixture.index.listDriveSummaries({ offset: 0, limit: 10 });

  assert.equal(result.totalDriveCount, expected.length);
  assert.equal(listed.total, expected.length);
  const byId = [...listed.drives].sort((a, b) => a.id - b.id);
  assert.deepEqual(byId.map(summaryComparable), expected.map(summaryComparable));
  assert.deepEqual(byId[0].tags, ['Morning']);
  assert.ok(byId.every((drive) => drive.overviewPoints.length <= 120));

  const detail = fixture.index.getDriveDetail(0, 1000);
  assert.deepEqual(detail.points, expected[0].points);
  assert.equal(detail.downsampled, false);
  assert.equal(detail.fullPointCount, expected[0].points.length);
});

test('detail query enforces a fixed point budget and preserves aligned state arrays', async (t) => {
  const points = Array.from({ length: 101 }, (_, i) => [39 + i / 1000, -76]);
  const routes = [route('RecentClips/2026-07-28_10-00-00-front.mp4', 39, {
    points,
    gearStates: Array.from({ length: 101 }, (_, i) => i % 2),
    autopilotStates: Array.from({ length: 101 }, (_, i) => i % 4),
    speeds: Array.from({ length: 101 }, () => 2),
  })];
  const fixture = makeIndex(routes);
  t.after(() => {
    fixture.index.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });
  await indexDriveData(fixture.index);
  await groupIndexedDrives(fixture.index);

  const detail = fixture.index.getDriveDetail(0, 12);
  assert.equal(detail.downsampled, true);
  assert.equal(detail.fullPointCount, 101);
  assert.equal(detail.points.length, 12);
  assert.deepEqual(detail.points[0], groupIntoDrives(routes).drives[0].points[0]);
  assert.deepEqual(detail.points.at(-1), groupIntoDrives(routes).drives[0].points.at(-1));
  assert.equal(detail.gearStates.length, detail.points.length);
  assert.equal(detail.fsdStates.length, detail.points.length);
});

test('summon drives count in totals but are excluded from FSD aggregates', async (t) => {
  // A summon drive (hazard bookends, no pedals, crawl speed) and a normal
  // dashcam drive an hour later. The summon must appear in totalDistanceMi /
  // summonDriveCount but stay out of every FSD-analytics accumulator —
  // otherwise it dilutes the lifetime score as a fake "0% FSD" drive.
  const n = 100;
  const summonRoute = {
    file: 'RecentClips/2026-07-28_12-00-00-front.mp4',
    date: '2026-07-28_12-00-00',
    points: Array.from({ length: n }, (_, i) => [39.1 + i * 1e-6, -76.7]),
    speeds: new Array(n).fill(1.5),
    gearRuns: [{ gear: 0, frames: 90 }, { gear: 1, frames: 300 }, { gear: 0, frames: 60 }],
    rawFrameCount: 450,
    rawParkCount: 150,
    flagRuns: [
      { flags: 3, frames: 120 },
      { flags: 0, frames: 240 },
      { flags: 3, frames: 90 },
    ],
  };
  const routes = [
    summonRoute,
    route('RecentClips/2026-07-28_13-00-00-front.mp4', 39.4),
  ];
  const fixture = makeIndex(routes);
  t.after(() => {
    fixture.index.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });
  await indexDriveData(fixture.index);
  const result = await groupIndexedDrives(fixture.index);

  const listed = fixture.index.listDriveSummaries({ offset: 0, limit: 10 });
  const summonDrive = listed.drives.find((d) => d.summon === true);
  const normalDrive = listed.drives.find((d) => !d.summon);
  assert.ok(summonDrive, 'summon drive must exist and be tagged');
  assert.ok(normalDrive, 'normal drive must exist');

  const agg = result.aggregates;
  assert.equal(agg.summonDriveCount, 1);
  assert.equal(agg.seiDriveCount, 1); // the normal drive only
  // FSD denominator excludes the summon drive's distance…
  assert.equal(agg.seiDistanceM, (normalDrive.distanceKm ?? 0) * 1000);
  assert.equal(agg.fsdPercentSum, normalDrive.fsdPercent ?? 0);
  // …but lifetime totals still include it.
  assert.equal(
    agg.totalDistanceMi,
    (summonDrive.distanceMi ?? 0) + (normalDrive.distanceMi ?? 0),
  );
});
