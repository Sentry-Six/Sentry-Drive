// Fast and streaming readers must return identical data.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDriveData, FAST_PARSE_LIMIT_BYTES } from './drive-data-reader.cjs';

// Covers exporter byte fields, Windows paths, Unicode, nested runs, precision,
// optional values, and BLE telemetry.
const FIXTURE = {
  processedFiles: [
    'RecentClips/2026-05-17_18-47-34-front.mp4',
    'SavedClips\\2026-05-17_19-00-00\\2026-05-17_18-59-00-back.mp4',
    'RecentClips/üñïçødé — "quoted" name.mp4',
  ],
  routes: [
    {
      file: 'RecentClips/2026-05-17_18-47-34-front.mp4',
      date: '2026-05-17_18-47-34',
      points: [[39.198835, -76.795246], [39.19885, -76.79526], [0.0001, 0.0001]],
      gearStates: 'AAEAAA==',
      autopilotStates: 'AAAAAQ==',
      speeds: [0, 1.25, 30.000001],
      gearRuns: [{ gear: 0, frames: 2 }, { gear: 1, frames: 58 }],
      source: 'sei',
      locationNameStart: '123 Main St',
      locationNameEnd: null,
      batteryPctStart: 81.5,
    },
    {
      file: 'RecentClips/2026-05-17_18-48-34-front.mp4',
      date: '2026-05-17_18-48-34',
      points: [],
      externalSignature: 'tessie:1747510054:1747510254',
      tessieAutopilotPercent: 42.42,
    },
  ],
  driveTags: {
    '2026-05-17T18:47:34': ['Road trip', 'tag "with quotes"', 'üñïçødé'],
    '2026-05-18T08:00:00': [],
  },
};

function writeFixture(json) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-reader-')), 'drive-data.json');
  fs.writeFileSync(file, json);
  return file;
}

test('fast and streaming paths return identical data (pretty-printed file)', async () => {
  const file = writeFixture(JSON.stringify(FIXTURE, null, 2));
  const fast = await readDriveData(file, { wantProcessedFiles: true });
  const streamed = await readDriveData(file, { wantProcessedFiles: true, forceStreaming: true });
  assert.deepEqual(fast, streamed);
  assert.deepEqual(fast.routes, FIXTURE.routes);
  assert.deepEqual(fast.driveTags, FIXTURE.driveTags);
  assert.deepEqual(fast.processedFiles, FIXTURE.processedFiles);
  assert.equal(fast.processedFileCount, 3);
});

test('fast and streaming paths return identical data (compact single-line file)', async () => {
  const file = writeFixture(JSON.stringify(FIXTURE));
  const fast = await readDriveData(file, { wantProcessedFiles: true });
  const streamed = await readDriveData(file, { wantProcessedFiles: true, forceStreaming: true });
  assert.deepEqual(fast, streamed);
});

test('processedFiles omitted unless requested, but count always present', async () => {
  const file = writeFixture(JSON.stringify(FIXTURE));
  for (const forceStreaming of [false, true]) {
    const r = await readDriveData(file, { forceStreaming });
    assert.deepEqual(r.processedFiles, []);
    assert.equal(r.processedFileCount, 3);
    assert.equal(r.routes.length, 2);
  }
});

test('missing top-level fields default to empty (both paths)', async () => {
  const file = writeFixture('{"routes": []}');
  for (const forceStreaming of [false, true]) {
    const r = await readDriveData(file, { wantProcessedFiles: true, forceStreaming });
    assert.deepEqual(r.routes, []);
    assert.deepEqual(r.driveTags, {});
    assert.deepEqual(r.processedFiles, []);
    assert.equal(r.processedFileCount, 0);
  }
});

test('progress fires and finishes at totalBytes on both paths', async () => {
  const file = writeFixture(JSON.stringify(FIXTURE, null, 2));
  const total = fs.statSync(file).size;
  for (const forceStreaming of [false, true]) {
    const calls = [];
    await readDriveData(file, { forceStreaming, onProgress: (a, b) => calls.push([a, b]) });
    assert.ok(calls.length >= 1);
    assert.deepEqual(calls[calls.length - 1], [total, total]);
  }
});

test('threshold constant is sane (under V8 max string length)', () => {
  assert.ok(FAST_PARSE_LIMIT_BYTES < 536_870_888, 'must stay under V8 string cap');
  assert.ok(FAST_PARSE_LIMIT_BYTES >= 256 * 1024 * 1024, 'should cover typical files');
});

test('unmodeled top-level sections are captured verbatim (both paths)', async () => {
  // Exporter-specific sections must survive read-modify-write cycles.
  const withExtras = {
    formatVersion: 3,
    ...FIXTURE,
    telemetrySamples: [
      { ts: 1752606000, batteryPct: 81.5, hvacOn: 1, source: 'state' },
      { ts: 1752606060, batteryPct: 81, hvacOn: 0, source: 'body-controller-state' },
    ],
    chargeTags: { '2026-05-17T20:00:00': ['home', 'üñïçødé'] },
    chargeCosts: { '2026-05-17T20:00:00': 4.2 },
    exportedBy: 'rusty',
    partial: null,
    complete: true,
  };
  const file = writeFixture(JSON.stringify(withExtras));
  const fast = await readDriveData(file, { wantProcessedFiles: true });
  const streamed = await readDriveData(file, { wantProcessedFiles: true, forceStreaming: true });
  assert.deepEqual(fast, streamed);
  assert.deepEqual(fast.extraSections, {
    formatVersion: 3,
    telemetrySamples: withExtras.telemetrySamples,
    chargeTags: withExtras.chargeTags,
    chargeCosts: withExtras.chargeCosts,
    exportedBy: 'rusty',
    partial: null,
    complete: true,
  });
  assert.equal('routes' in fast.extraSections, false);
  assert.equal('driveTags' in fast.extraSections, false);
  assert.equal('processedFiles' in fast.extraSections, false);
  const plain = await readDriveData(writeFixture(JSON.stringify(FIXTURE)), { forceStreaming: true });
  assert.deepEqual(plain.extraSections, {});
});
