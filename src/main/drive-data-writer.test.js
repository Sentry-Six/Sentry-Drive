import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readTopLevelValues,
  scanTopLevelSections,
  writeDriveDataJSON,
} from './drive-data-writer.cjs';

function readSection(filePath, section) {
  const length = section.end - section.start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, section.start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}

test('rewrites mutable drive fields while raw-copying every supplemental section', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-writer-'));
  const filePath = path.join(dir, 'drive-data.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(filePath, [
    '{',
    '  "processedFiles": ["old.mp4"],',
    '  "telemetrySamples": [ { "ts": 1, "note": "brace } and quote \\" ok" },',
    '    { "ts": 2, "chargingState": "charging" } ],',
    '  "routes": [{"file":"old.mp4"}],',
    '  "chargeCosts": {"10": { "amount": 2.50, "currency": "$" }},',
    '  "futureSection": { "unicode": "✓", "nested": [true, null, {"x": 1}] },',
    '  "driveTags": {"old": ["tag"]}',
    '}',
  ].join('\r\n'));

  const before = await scanTopLevelSections(filePath);
  const preservedBefore = new Map(
    before
      .filter((section) => ['telemetrySamples', 'chargeCosts', 'futureSection'].includes(section.key))
      .map((section) => [section.key, readSection(filePath, section)]),
  );

  await writeDriveDataJSON(filePath, {
    processedFiles: ['new.mp4'],
    routes: [{ file: 'new.mp4', gearStates: [1, 2] }],
    driveTags: { new: ['Favorite'] },
  }, {
    routeTransform(route) {
      return { ...route, transformed: true };
    },
  });

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed.processedFiles, ['new.mp4']);
  assert.deepEqual(parsed.routes, [{
    file: 'new.mp4',
    gearStates: [1, 2],
    transformed: true,
  }]);
  assert.deepEqual(parsed.driveTags, { new: ['Favorite'] });

  const after = await scanTopLevelSections(filePath);
  for (const section of after) {
    if (!preservedBefore.has(section.key)) continue;
    assert.deepEqual(readSection(filePath, section), preservedBefore.get(section.key));
  }
  assert.equal(after.some((section) => section.key === 'telemetrySamples'), true);
  assert.equal(after.some((section) => section.key === 'chargeCosts'), true);
  assert.equal(after.some((section) => section.key === 'futureSection'), true);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('writes a new drive-data file when there is no source to preserve', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-writer-new-'));
  const filePath = path.join(dir, 'drive-data.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await writeDriveDataJSON(filePath, {
    processedFiles: [],
    routes: [],
    driveTags: {},
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
    processedFiles: [],
    routes: [],
    driveTags: {},
  });
});

test('tag-only writes raw-copy unchanged mutable sections without loading routes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-writer-tags-'));
  const filePath = path.join(dir, 'drive-data.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(filePath, [
    '{',
    '  "processedFiles": [ "one.mp4", "two.mp4" ],',
    '  "routes": [ { "file": "one.mp4", "points": [[1, 2]] } ],',
    '  "driveTags": {"old": ["Favorite"]},',
    '  "telemetrySamples": [{"ts": 1}]',
    '}',
  ].join('\n'));

  const selected = await readTopLevelValues(filePath, ['driveTags']);
  const before = await scanTopLevelSections(filePath);
  const rawBefore = new Map(
    before
      .filter((section) => ['processedFiles', 'routes', 'telemetrySamples'].includes(section.key))
      .map((section) => [section.key, readSection(filePath, section)]),
  );

  assert.deepEqual(selected.values, { driveTags: { old: ['Favorite'] } });
  // The writer scans offsets from its own held handle; precomputed offsets
  // are not accepted because they can go stale against an external replace.
  await writeDriveDataJSON(filePath, {
    driveTags: { next: ['Road trip'] },
  });

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed.driveTags, { next: ['Road trip'] });
  const after = await scanTopLevelSections(filePath);
  for (const section of after) {
    if (rawBefore.has(section.key)) {
      assert.deepEqual(readSection(filePath, section), rawBefore.get(section.key));
    }
  }
});
