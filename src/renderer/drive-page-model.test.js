import test from 'node:test';
import assert from 'node:assert/strict';
import pageModelModule from './drive-page-model.cjs';

const { createDrivePageModel } = pageModelModule;

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

test('opening a map drive uses its list page and retains filters for further paging', async () => {
  const calls = [];
  const model = createDrivePageModel({
    pageSize: 2,
    async fetchPage(query) {
      calls.push(query);
      const offset = query.driveId === 4 ? 4 : query.offset;
      return { success: true, offset, limit: 2, total: 8, drives: [{ id: offset }] };
    },
  });
  await model.load({ tag: 'Work', endDate: '2026-07-31' });
  await model.showDrive(4);
  assert.equal(model.current().offset, 4);
  assert.deepEqual(model.current().drives, [{ id: 4 }]);
  await model.next();
  assert.equal(model.current().offset, 6);
  assert.deepEqual(calls[1], { tag: 'Work', endDate: '2026-07-31', offset: 0, limit: 2, driveId: 4 });
  assert.deepEqual(calls[2], { tag: 'Work', endDate: '2026-07-31', offset: 6, limit: 2 });
});

function indexedPages(pageSize = 3) {
  const calls = [];
  const history = Array.from({ length: 11 }, (_, id) => ({ id }));
  const model = createDrivePageModel({
    pageSize,
    async fetchPage(query) {
      calls.push(query);
      const offset = query.driveId == null ? query.offset
        : Math.floor(query.driveId / query.limit) * query.limit;
      return { success: true, offset, limit: query.limit, total: history.length,
        drives: history.slice(offset, offset + query.limit) };
    },
  });
  return { model, calls, history };
}

test('page jumps retain filters and stay within the available pages', async () => {
  const { model, calls } = indexedPages();
  await model.load({ tag: 'Work', startDate: '2026-07-01' });
  await model.goToPage(3);
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [6, 7, 8]);
  assert.deepEqual(calls.at(-1), { tag: 'Work', startDate: '2026-07-01', offset: 6, limit: 3 });
  await model.goToPage(100);
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [9, 10]);
  await model.goToPage(0);
  assert.equal(model.current().offset, 0);
  const count = calls.length;
  await model.goToPage('invalid');
  await model.goToPage(Infinity);
  assert.equal(calls.length, count);
});

test('resizing a page keeps its anchor drive and uses the new size for navigation', async () => {
  const { model, calls } = indexedPages();
  await model.load({ endDate: '2026-07-31' });
  await model.goToPage(3);
  await model.setPageSize(2, 7);
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [6, 7]);
  assert.deepEqual(calls.at(-1), { endDate: '2026-07-31', offset: 6, limit: 2, driveId: 7 });
  await model.next();
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [8, 9]);
  await model.setPageSize(4);
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [8, 9, 10]);
  assert.equal(model.current().limit, 4);
});

test('a failed resize retains the previous page size for subsequent jumps', async () => {
  const calls = [];
  const model = createDrivePageModel({ pageSize: 3, async fetchPage(query) {
    calls.push(query);
    return query.limit === 2 ? { success: false, error: 'Unable to load' }
      : { success: true, offset: query.offset, limit: query.limit, total: 11, drives: [] };
  } });
  await model.load();
  await assert.rejects(model.setPageSize(2), /Unable to load/);
  await model.goToPage(3);
  assert.equal(calls.at(-1).limit, 3);
  assert.equal(model.current().offset, 6);
});

test('jumping back to the current page cancels an unfinished jump', async () => {
  let resolvePage;
  const model = createDrivePageModel({ pageSize: 3, fetchPage(query) {
    const page = { success: true, offset: query.offset, limit: 3, total: 11, drives: [{ id: query.offset }] };
    return query.offset === 0 ? Promise.resolve(page)
      : new Promise((resolve) => { resolvePage = () => resolve(page); });
  } });
  await model.load();
  const jump = model.goToPage(3);
  await model.goToPage(1);
  resolvePage();
  await jump;
  assert.equal(model.current().offset, 0);
});

test('empty libraries can resize before loading without requesting a page', async () => {
  const calls = [];
  const model = createDrivePageModel({ fetchPage: async (query) => {
    calls.push(query);
    return { success: true, total: 0, drives: [] };
  } });
  await model.setPageSize(4);
  assert.equal(model.current().limit, 4);
  assert.equal(calls.length, 0);
  await model.load();
  assert.equal(calls[0].limit, 4);
});

test('refreshing after removal fills the current page without resurrecting or skipping drives', async () => {
  const { model, calls, history } = indexedPages();
  await model.load({ tag: 'Work' });
  history.shift();
  await model.refresh();
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [1, 2, 3]);
  assert.equal(model.current().total, 10);
  assert.equal(calls.at(-1).tag, 'Work');
  await model.goToPage(1);
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [1, 2, 3]);
  await model.next();
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [4, 5, 6]);
});

test('refreshing a removed final page returns the nearest valid page, including an empty library', async () => {
  const { model, history } = indexedPages();
  await model.load();
  await model.goToPage(4);
  history.splice(9);
  await model.refresh();
  assert.equal(model.current().offset, 6);
  assert.deepEqual(model.current().drives.map((drive) => drive.id), [6, 7, 8]);
  history.splice(0);
  await model.refresh();
  assert.equal(model.current().offset, 0);
  assert.equal(model.current().total, 0);
  assert.deepEqual(model.current().drives, []);
});
