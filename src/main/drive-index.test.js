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
      route('RecentClips/2026-07-28_10-00-00-front.mp4', 39.1),
      route('RecentClips\\2026-07-28_10-00-00-front.mp4', 39.2),
      route('SavedClips/2026-07-28_10-01-00-front.mp4', 39.3),
      route('RecentClips/2026-07-28_11-00-00-front.mp4', 39.4),
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
    routeCount: 2,
    droppedCount: 1,
    duplicateCount: 1,
  });
  const windows = [...index.iterateTimeWindows()];
  assert.equal(windows.length, 2);
  assert.equal(windows[0].length, 1);
  assert.equal(windows[1].length, 1);
  assert.equal(windows[0][0].file, 'RecentClips/2026-07-28_10-00-00-front.mp4');
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
