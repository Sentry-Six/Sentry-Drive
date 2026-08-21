import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knownPlaces from './known-places.cjs';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-known-'));
  return { dir, store: knownPlaces.createKnownPlaceStore(path.join(dir, 'known-places.json')) };
}

test('known places prefer manual corrections, then zones, then learned Tesla labels', (t) => {
  const { dir, store } = tempStore();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  store.upsert({ lat: 40, lng: -76, label: 'Tesla label', source: 'tesla' });
  store.replaceZones([{ id: 'home', lat: 40, lng: -76, label: 'Home', radiusM: 150 }]);
  store.upsert({ lat: 40, lng: -76, label: 'My driveway', source: 'manual' });

  assert.equal(store.find(40.00001, -76).label, 'My driveway');
  store.removeNear(40, -76, 'manual');
  assert.equal(store.find(40.00001, -76).label, 'Home');
  store.replaceZones([]);
  assert.equal(store.find(40.00001, -76).label, 'Tesla label');
});

test('known places persist, merge repeated Tesla labels, and respect their radius', (t) => {
  const { dir, store } = tempStore();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'known-places.json');
  store.upsert({ lat: 40, lng: -76, label: 'Office', source: 'tesla', radiusM: 25 });
  store.upsert({ lat: 40.00001, lng: -76, label: 'Office', source: 'tesla', radiusM: 25 });

  assert.equal(store.list().length, 1);
  const reloaded = knownPlaces.createKnownPlaceStore(filePath);
  assert.equal(reloaded.find(40, -76).label, 'Office');
  assert.equal(reloaded.find(40.001, -76), null);
});
