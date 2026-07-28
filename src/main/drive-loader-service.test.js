import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoaderService } from './drive-loader-service.cjs';

function makeSource() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-loader-service-'));
  const cacheRoot = path.join(root, 'cache');
  const sourcePath = path.join(root, 'drive-data.json');
  fs.writeFileSync(sourcePath, JSON.stringify({
    processedFiles: ['a.mp4'],
    routes: [{
      file: 'RecentClips/2026-07-28_10-00-00-front.mp4',
      date: '2026-07-28_10-00-00',
      points: [[39.1, -76.7], [39.11, -76.71]],
      speeds: [1, 2],
    }],
    driveTags: {},
  }));
  return { root, cacheRoot, sourcePath };
}

test('loader service owns a disposable index and serves bounded queries', async (t) => {
  const fixture = makeSource();
  const messages = [];
  const service = createLoaderService({
    cacheRoot: fixture.cacheRoot,
    send: (message) => messages.push(message),
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const loaded = await service.handle({
    type: 'load',
    payload: { filePath: fixture.sourcePath, pageSize: 25 },
  });
  assert.equal(loaded.success, true);
  assert.equal(loaded.totalDriveCount, 1);
  assert.equal(loaded.drives.length, 1);
  assert.ok(messages.some((message) => message.type === 'progress' && message.payload.phase === 'reading'));
  assert.ok(messages.some((message) => message.type === 'progress' && message.payload.phase === 'grouping'));

  const page = await service.handle({
    type: 'list',
    payload: { offset: 0, limit: 25 },
  });
  assert.equal(page.total, 1);
  assert.equal(page.drives.length, 1);

  const detail = await service.handle({
    type: 'detail',
    payload: { id: 0, maxPoints: 100 },
  });
  assert.equal(detail.fullPointCount, 2);

  await service.close();
  assert.deepEqual(fs.readdirSync(fixture.cacheRoot), []);
});

test('loader service converts malformed JSON into a recoverable structured error', async (t) => {
  const fixture = makeSource();
  fs.writeFileSync(fixture.sourcePath, '{"routes": [');
  const service = createLoaderService({ cacheRoot: fixture.cacheRoot, send() {} });
  t.after(async () => {
    await service.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    service.handle({ type: 'load', payload: { filePath: fixture.sourcePath } }),
    (error) => error.code === 'DRIVE_DATA_INVALID' && /parse|JSON|end/i.test(error.message),
  );
});
