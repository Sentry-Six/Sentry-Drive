import test from 'node:test';
import assert from 'node:assert/strict';
import pageModelModule from './drive-page-model.cjs';

const { createDrivePageModel, libraryHasImportedDrives } = pageModelModule;

test('page model retains one bounded page and navigates with fixed offsets', async () => {
  const calls = [];
  const model = createDrivePageModel({
    pageSize: 2,
    async fetchPage(query) {
      calls.push(query);
      return {
        success: true,
        offset: query.offset,
        limit: query.limit,
        total: 5,
        drives: [{ id: query.offset }, { id: query.offset + 1 }].slice(0, 5 - query.offset),
      };
    },
  });

  await model.load();
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [0, 1]);
  await model.next();
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [2, 3]);
  await model.next();
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [4]);
  await model.previous();
  assert.equal(model.current().offset, 2);
  assert.deepEqual(calls.map((call) => call.offset), [0, 2, 4, 2]);
});

test('page model ignores a stale response superseded by a newer load', async () => {
  const resolvers = [];
  const model = createDrivePageModel({
    pageSize: 2,
    fetchPage(query) {
      return new Promise((resolve) => resolvers.push({ query, resolve }));
    },
  });

  const first = model.load({ tag: 'old' });
  const second = model.load({ tag: 'new' });
  resolvers[1].resolve({ success: true, offset: 0, limit: 2, total: 1, drives: [{ id: 'new' }] });
  await second;
  resolvers[0].resolve({ success: true, offset: 0, limit: 2, total: 1, drives: [{ id: 'old' }] });
  await first;

  assert.deepEqual(model.current().drives, [{ id: 'new' }]);
});

test('library import state uses aggregates when the current page has only SEI drives', () => {
  const currentPage = [{ id: 1, source: 'sei' }];
  assert.equal(libraryHasImportedDrives(currentPage, {
    aggregates: { importedDriveCount: 2 },
  }), true);
  assert.equal(libraryHasImportedDrives(currentPage, {
    aggregates: { importedDriveCount: 0 },
  }), false);
  assert.equal(libraryHasImportedDrives([{ id: 2, source: 'tessie' }], null), true);
});
