import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverProcessingFiles } from './clip-discovery.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-clip-discovery-'));
  const writeClip = (relativePath) => {
    const fullPath = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, '');
    return fullPath;
  };
  return { root, writeClip };
}

test('discovers the same bounded gap fill from RecentClips and TeslaCam roots', async (t) => {
  const { root, writeClip } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeClip('RecentClips/2025-11-30/2025-11-30_09-00-00-front.mp4');
  writeClip('RecentClips/2026-07-27/2026-07-27_14-01-02-front.mp4');
  writeClip('RecentClips/2026-07-27/2026-07-27_14-03-02-front.mp4');
  writeClip('SavedClips/2025-11-30_09-05-00/2025-11-30_09-01-00-front.mp4');
  writeClip('SavedClips/2026-07-27_14-12-29/2026-07-27_14-02-02-front.mp4');
  writeClip('SentryClips/2026-07-27_17-10-00/2026-07-27_17-00-00-front.mp4');
  writeClip('SentryClips/2026-07-27_17-10-00/2026-07-27_17-01-00-front.mp4');

  const options = { cutoffDate: '2025-12-01', processedFiles: [] };
  const direct = await discoverProcessingFiles(path.join(root, 'RecentClips'), options);
  const teslaCam = await discoverProcessingFiles(root, options);
  const expected = [
    '2026-07-27/2026-07-27_14-01-02-front.mp4',
    'SavedClips/2026-07-27_14-12-29/2026-07-27_14-02-02-front.mp4',
    '2026-07-27/2026-07-27_14-03-02-front.mp4',
  ];

  assert.deepEqual(direct.files.map((file) => file.relativePath), expected);
  assert.deepEqual(teslaCam.files.map((file) => file.relativePath), expected);
  assert.equal(direct.recentCount, 2);
  assert.equal(direct.gapFillCount, 1);
  assert.equal(direct.files[1].dateDir, '2026-07-27');
  assert.equal(direct.files[1].fullPath, path.join(
    root,
    'SavedClips',
    '2026-07-27_14-12-29',
    '2026-07-27_14-02-02-front.mp4',
  ));
});

test('processed normal paths anchor holes after their clips rotate off disk', async (t) => {
  const { root, writeClip } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeClip('RecentClips/2026-07-27/2026-07-27_10-02-00-front.mp4');
  writeClip('SavedClips/2026-07-27_10-03-00/2026-07-27_10-01-00-front.mp4');

  const found = await discoverProcessingFiles(root, {
    cutoffDate: '2025-12-01',
    processedFiles: [
      'RecentClips\\2026-07-27\\2026-07-27_10-00-00-front.mp4',
    ],
  });

  assert.deepEqual(found.files.map((file) => file.relativePath), [
    'SavedClips/2026-07-27_10-03-00/2026-07-27_10-01-00-front.mp4',
    '2026-07-27/2026-07-27_10-02-00-front.mp4',
  ]);
  assert.equal(found.gapFillCount, 1);
});

test('already-processed event candidates are not selected again', async (t) => {
  const { root, writeClip } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeClip('RecentClips/2026-07-27/2026-07-27_10-00-00-front.mp4');
  writeClip('RecentClips/2026-07-27/2026-07-27_10-02-00-front.mp4');
  writeClip('SavedClips/2026-07-27_10-03-00/2026-07-27_10-01-00-front.mp4');

  const found = await discoverProcessingFiles(root, {
    cutoffDate: '2025-12-01',
    processedFiles: [
      'SavedClips\\2026-07-27_10-03-00\\2026-07-27_10-01-00-front.mp4',
    ],
  });

  assert.deepEqual(found.files.map((file) => file.relativePath), [
    '2026-07-27/2026-07-27_10-00-00-front.mp4',
    '2026-07-27/2026-07-27_10-02-00-front.mp4',
  ]);
  assert.equal(found.gapFillCount, 0);
});

test('missing optional event roots do not prevent normal discovery', async (t) => {
  const { root, writeClip } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeClip('RecentClips/2026-07-27/2026-07-27_10-00-00-front.mp4');
  fs.writeFileSync(path.join(root, 'SavedClips'), '');
  const found = await discoverProcessingFiles(path.join(root, 'RecentClips'), {
    cutoffDate: '2025-12-01',
  });

  assert.deepEqual(found.files.map((file) => file.relativePath), [
    '2026-07-27/2026-07-27_10-00-00-front.mp4',
  ]);
});
