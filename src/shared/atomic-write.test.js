// Exercises integrity checks against real temporary files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsyncFile, tempLooksComplete } from './atomic-write.cjs';

let counter = 0;
function tmpFile(contents) {
  const p = path.join(os.tmpdir(), `aw-test-${process.pid}-${counter++}.tmp`);
  fs.writeFileSync(p, contents);
  return p;
}
const MISSING = path.join(os.tmpdir(), `aw-missing-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);

test('tempLooksComplete: accepts a complete pretty-printed document', () => {
  const p = tmpFile('{\n  "processedFiles": [],\n  "routes": [],\n  "driveTags": {}\n}\n');
  try { assert.equal(tempLooksComplete(p), true); } finally { fs.unlinkSync(p); }
});

test('tempLooksComplete: accepts a complete compact document (no trailing newline)', () => {
  const p = tmpFile('{"processedFiles":[],"routes":[],"driveTags":{}}');
  try { assert.equal(tempLooksComplete(p), true); } finally { fs.unlinkSync(p); }
});

test('tempLooksComplete: accepts a populated document', () => {
  const p = tmpFile('{"processedFiles":["a/b.mp4"],"routes":[{"file":"a/b.mp4","points":[[1,2]]}],"driveTags":{}}');
  try { assert.equal(tempLooksComplete(p), true); } finally { fs.unlinkSync(p); }
});

test('tempLooksComplete: rejects a truncated write (cut off before closing brace)', () => {
  const p = tmpFile('{"processedFiles":[],"routes":[{"file":"a","points":[[1,2],[3,4');
  try { assert.equal(tempLooksComplete(p), false); } finally { fs.unlinkSync(p); }
});

test('tempLooksComplete: rejects an empty file', () => {
  const p = tmpFile('');
  try { assert.equal(tempLooksComplete(p), false); } finally { fs.unlinkSync(p); }
});

test('tempLooksComplete: rejects a tiny file under the size floor', () => {
  const p = tmpFile('{}');
  try { assert.equal(tempLooksComplete(p), false); } finally { fs.unlinkSync(p); }
});

test('tempLooksComplete: rejects content not starting with a brace', () => {
  const p = tmpFile('garbage that happens to be long enough to pass the size floor }');
  try { assert.equal(tempLooksComplete(p), false); } finally { fs.unlinkSync(p); }
});

test('tempLooksComplete: rejects a missing file', () => {
  assert.equal(tempLooksComplete(MISSING), false);
});

test('fsyncFile: flushes a real file without rejecting', async () => {
  const p = tmpFile('{"processedFiles":[],"routes":[],"driveTags":{}}');
  try { await assert.doesNotReject(() => fsyncFile(p)); } finally { fs.unlinkSync(p); }
});

test('fsyncFile: rejects on a missing file (callers treat this as non-fatal)', async () => {
  await assert.rejects(() => fsyncFile(MISSING));
});
