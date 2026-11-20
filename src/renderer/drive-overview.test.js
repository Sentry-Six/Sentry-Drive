import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import driveCalc from '../shared/drive-calc.cjs';
import mapCamera from './map-camera.cjs';
import pageModel from './drive-page-model.cjs';

const rendererSource = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');

function loadRenderer() {
  const history = [
    [5, '2026-10-02', ['Work']],
    [4, '2026-08-05', []],
    [3, '2026-07-30', ['Work']],
    [2, '2026-07-10', []],
    [1, '2026-06-15', ['Work']],
  ].map(([id, date, tags]) => ({
    id, startTime: `${date}T10:00:00`, source: 'sei', tags,
    overviewPoints: [[39 + id / 100, -76], [39 + id / 100, -76.1]],
  }));
  const matching = ({ tag, startDate, endDate }) => history.filter((drive) =>
    (!tag || drive.tags.includes(tag))
    && (!startDate || drive.startTime.slice(0, 10) >= startDate)
    && (!endDate || drive.startTime.slice(0, 10) <= endDate));
  const calls = { pages: [], overview: [], details: [], fits: [], tags: [], loads: [] };
  const mapData = new Map();
  const elements = new Map();
  const document = {
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        classList: { add() {}, remove() {}, toggle() {} },
        handlers: new Map(),
        addEventListener(name, handler) { this.handlers.set(name, handler); },
        querySelectorAll: () => [],
        querySelector: (selector) => document.getElementById(selector.replace('#', '')),
      });
      return elements.get(id);
    },
  };
  const api = {
    async listDriveSummaries(query) {
      calls.pages.push(query);
      const matches = matching(query);
      let offset = query.offset;
      if (query.driveId != null) {
        offset = Math.floor(matches.findIndex((drive) => drive.id === query.driveId) / query.limit) * query.limit;
      }
      return {
        success: true, offset, limit: query.limit, total: matches.length,
        drives: matches.slice(offset, offset + query.limit).map((drive) => structuredClone(drive)),
      };
    },
    async listDriveOverview(query) {
      calls.overview.push(query);
      return { success: true, overviewRoutes: matching(query).map(({ id, source, overviewPoints }) =>
        ({ id, source, overviewPoints })) };
    },
    async getDriveDetail(id, gen) {
      calls.details.push({ id, gen });
      return { success: true, points: [[39, -76], [39.1, -76.1]], fsdStates: [0, 0] };
    },
    async setDriveTags({ filePath, driveKey, tags }) {
      calls.tags.push({ filePath, driveKey, tags: Array.from(tags) });
      history.find((drive) => drive.startTime === driveKey).tags = Array.from(tags);
      return { success: true };
    },
    watchDriveData() {},
    onDriveDataChanged() {},
    async loadAndGroupDrives(filePath) {
      calls.loads.push(filePath);
      return { success: true, cacheGen: 7 + calls.loads.length,
        driveTags: Object.fromEntries(history.map((drive) => [drive.startTime, drive.tags])),
        totalDriveCount: history.length,
        aggregates: { totalDriveCount: history.length,
          importedDriveCount: history.filter((drive) => drive.source !== 'sei').length } };
    },
    async removeDrive({ driveStartTime }) {
      history.splice(history.findIndex((drive) => drive.startTime === driveStartTime), 1);
      return { success: true };
    },
    async removeDrives({ driveStartTimes }) {
      for (let index = history.length - 1; index >= 0; index--) {
        if (driveStartTimes.includes(history[index].startTime)) history.splice(index, 1);
      }
      return { success: true };
    },
  };
  const context = vm.createContext({
    console: { ...console },
    document,
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (callback) => { queueMicrotask(callback); return 1; },
    fixtureTags: Object.fromEntries(history.map((drive) => [drive.startTime, drive.tags])),
    window: {
      addEventListener() {}, electronAPI: api, driveCalc, DrivePageModel: pageModel, MapCamera: mapCamera,
    },
    maplibregl: { LngLatBounds: class { extend() {} } },
    mockMap: {
      getSource: (id) => ({ setData: (data) => mapData.set(id, data) }),
      setLayoutProperty() {},
      setFilter() {},
      fitBounds: (bounds) => calls.fits.push(bounds),
    },
    alert: (message) => assert.fail(message),
  });
  vm.runInContext(rendererSource, context, { filename: 'renderer.js' });
  vm.runInContext(`
    map = mockMap;
    mapReady = true;
    loadedFilePath = 'drive-data.json';
    driveCacheGen = 7;
    refreshAllTags(fixtureTags);
    drivePageModel = window.DrivePageModel.createDrivePageModel({
      pageSize: 2,
      fetchPage: (query) => window.electronAPI.listDriveSummaries(query),
    });
    cleanupReplay = () => {};
    renderDriveList = async () => {};
    drawSelectedDrive = () => {};
    renderSelectedDriveStats = () => {};
    renderDriveStats = (_drives, meta) => { lastDrivesMeta = meta; };
    loadChargingSites = async () => {};
    updateRevertButton = () => {};
    showLoading = () => {};
    hideLoading = () => {};
  `, context);
  return {
    context, calls, api, elements, history,
    routeIds: () => Array.from(mapData.get('overview').features, (feature) => feature.properties.driveId),
    read: (expression) => vm.runInContext(expression, context),
  };
}

test('overview shows all history and paging leaves its routes and camera unchanged', async () => {
  const { context, calls, routeIds, read } = loadRenderer();
  const state = await context.loadDriveView();
  await context.applyDrivePageState(state, { overviewChanged: true });
  assert.deepEqual(Array.from(state.drives, (drive) => drive.id), [5, 4]);
  assert.deepEqual(routeIds(), [5, 4, 3, 2, 1]);
  assert.equal(calls.fits.length, 1);

  await context.changeDrivePage('next');
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [3, 2]);
  assert.deepEqual(routeIds(), [5, 4, 3, 2, 1]);
  assert.equal(calls.overview.length, 1);
  assert.equal(calls.fits.length, 1);
});

test('overview applies tag and date filters across list pages', async () => {
  const { context, calls, routeIds, read } = loadRenderer();
  vm.runInContext("driveFilters = { tag: 'Work', startDate: '', endDate: '' }", context);
  await context.applyDriveFilters();
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [5, 3]);
  assert.deepEqual(routeIds(), [5, 3, 1]);
  assert.equal(calls.overview[0].gen, 7);

  vm.runInContext("driveFilters.startDate = '2026-07-01'; driveFilters.endDate = '2026-07-31'", context);
  await context.applyDriveFilters();
  assert.deepEqual(routeIds(), [3]);
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [3]);
});

test('clicking a route outside the current page loads its card and lazy detail', async () => {
  const { context, calls, routeIds, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  await context.selectOverviewDrive(1);
  assert.equal(read('drivePageState.offset'), 4);
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [1]);
  assert.equal(read('selectedDriveId'), 1);
  assert.equal(read('drives[0].points.length'), 2);
  assert.deepEqual(calls.details, [{ id: 1, gen: 7 }]);
  assert.deepEqual(routeIds(), [5, 4, 3, 2, 1]);
});

test('a superseded overview response cannot replace newer filters', async () => {
  const { context, api, read } = loadRenderer();
  const pending = [];
  api.listDriveOverview = () => new Promise((resolve) => pending.push(resolve));
  const first = context.loadDriveView();
  vm.runInContext("driveFilters.tag = 'Work'", context);
  const second = context.loadDriveView();
  pending[1]({ success: true, overviewRoutes: [{ id: 3 }] });
  assert.ok(await second);
  pending[0]({ success: true, overviewRoutes: [{ id: 5 }] });
  assert.equal(await first, null);
  assert.deepEqual(Array.from(read('overviewRoutes'), (route) => route.id), [3]);
  assert.equal(read('driveViewLoading'), false);
});

test('filter changes cancel a pending selection from another page', async () => {
  const { context, api, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  const fetchPage = api.listDriveSummaries;
  let resolveSelection;
  api.listDriveSummaries = (query) => query.driveId != null
    ? new Promise((resolve) => { resolveSelection = () => fetchPage(query).then(resolve); })
    : fetchPage(query);
  const selection = context.selectOverviewDrive(1);
  vm.runInContext("driveFilters.startDate = '2026-07-01'", context);
  await context.applyDriveFilters();
  await resolveSelection();
  await selection;
  assert.equal(read('selectedDriveId'), null);
  assert.equal(read('drivePageState.offset'), 0);
});

test('jumping directly to a page updates the list and leaves the entire map intact', async () => {
  const { context, calls, elements, routeIds, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  await context.changeDrivePage(3);
  assert.equal(read('drivePageState.offset'), 4);
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [1]);
  assert.equal(elements.get('drive-page-number').value, 3);
  assert.equal(elements.get('drive-page-number').max, 3);
  assert.deepEqual(routeIds(), [5, 4, 3, 2, 1]);
  assert.equal(calls.overview.length, 1);
  assert.equal(calls.fits.length, 1);
});

function setListHeight(context, height) {
  const list = context.document.getElementById('drives-list');
  list.clientHeight = height;
  list.querySelectorAll = (selector) => [{
    getBoundingClientRect: () => ({ height: selector === '.drive-date-header' ? 32 : 160 }),
  }];
  vm.runInContext('queueDrivePageResize = () => {}', context);
}

test('fitting a page to the viewport retains the selected drive and loaded detail', async () => {
  const { context, calls, routeIds, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  await context.selectOverviewDrive(4);
  const points = read('drives[1].points');
  setListHeight(context, 250);
  await context.fitDrivePageToViewport();
  assert.equal(read('drivePageState.limit'), 1);
  assert.equal(read('drivePageState.offset'), 1);
  assert.equal(read('selectedDriveId'), 4);
  assert.equal(read('drives[0].points'), points);
  assert.equal(calls.details.length, 1);
  assert.deepEqual(routeIds(), [5, 4, 3, 2, 1]);
  assert.equal(calls.fits.length, 1);

  setListHeight(context, 650);
  await context.fitDrivePageToViewport();
  assert.equal(read('drivePageState.limit'), 3);
  assert.equal(read('selectedDriveId'), 4);
  assert.equal(read('drives[1].points'), points);
});

test('resizing while selected detail is pending still finishes opening the drive', async () => {
  const { context, api, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  const getDetail = api.getDriveDetail;
  let finishFirst;
  let count = 0;
  api.getDriveDetail = (id, gen) => ++count === 1
    ? new Promise((resolve) => { finishFirst = () => getDetail(id, gen).then(resolve); })
    : getDetail(id, gen);
  const selection = context.selectOverviewDrive(4);
  setListHeight(context, 250);
  await context.fitDrivePageToViewport();
  await finishFirst();
  await selection;
  assert.equal(read('selectedDriveId'), 4);
  assert.equal(read('drives[0].id'), 4);
  assert.equal(read('drives[0].points.length'), 2);
});

test('a card click during resizing cannot leave the rendered page out of sync', async () => {
  const { context, api, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  const fetchPage = api.listDriveSummaries;
  let finishResize;
  api.listDriveSummaries = (query) => new Promise((resolve) => {
    finishResize = () => fetchPage(query).then(resolve);
  });
  setListHeight(context, 250);
  const resize = context.fitDrivePageToViewport();
  await context.selectDrive(read('drives[1]'));
  await finishResize();
  await resize;
  assert.equal(read('drivePageState.limit'), 1);
  assert.equal(read('drivePageState'), read('drivePageModel.current()'));
});

test('removing a tag retains filter options from other pages', async () => {
  const { context, history, read } = loadRenderer();
  history[2].tags = ['Vacation'];
  context.refreshAllTags(Object.fromEntries(history.map((drive) => [drive.startTime, drive.tags])));
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  await context.removeTag(read('drives[0]'), 'Work');
  assert.deepEqual(Array.from(read('allTags')), ['Vacation', 'Work']);
  await context.changeDrivePage('next');
  assert.deepEqual(Array.from(read('drives[0].tags')), ['Vacation']);
});

test('removing an active tag refreshes both the list and all map routes after saving', async () => {
  const { context, routeIds, read } = loadRenderer();
  vm.runInContext("driveFilters.tag = 'Work'", context);
  await context.applyDriveFilters();
  await context.removeTag(read('drives[0]'), 'Work');
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [3, 1]);
  assert.deepEqual(routeIds(), [3, 1]);
  assert.equal(read('drivePageState.total'), 2);
  assert.equal(read('driveFilters.tag'), 'Work');
});

test('removing the last matching tag keeps a clearable empty filter', async () => {
  const { context, elements, routeIds, read } = loadRenderer();
  vm.runInContext("driveFilters.tag = 'Work'", context);
  await context.applyDriveFilters();
  for (let count = 0; count < 3; count++) await context.removeTag(read('drives[0]'), 'Work');
  assert.equal(read('drivePageState.total'), 0);
  assert.deepEqual(routeIds(), []);
  assert.equal(read('driveFilters.tag'), 'Work');
  assert.match(elements.get('tag-filter').innerHTML, /value="Work"/);
  vm.runInContext("driveFilters.tag = ''", context);
  await context.applyDriveFilters();
  assert.equal(read('drivePageState.total'), 5);
});

test('failed tag writes retain the original tags and library options', async () => {
  const { context, api, read } = loadRenderer();
  const alerts = [];
  context.alert = (message) => alerts.push(message);
  await context.applyDrivePageState(await context.loadDriveView());
  api.setDriveTags = async () => ({ success: false, error: 'Disk unavailable' });
  await context.addTag(read('drives[0]'), 'Vacation');
  await context.removeTag(read('drives[0]'), 'Work');
  assert.deepEqual(Array.from(read('drives[0].tags')), ['Work']);
  assert.deepEqual(Array.from(read('allTags')), ['Work']);
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /Disk unavailable/);
});

test('queued edits from a replaced card preserve earlier saved tags', async () => {
  const { context, api, calls, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView());
  const staleCard = read('drives[0]');
  const save = api.setDriveTags;
  let finishFirst;
  let count = 0;
  api.setDriveTags = (query) => ++count === 1
    ? new Promise((resolve) => { finishFirst = () => save(query).then(resolve); }) : save(query);
  const first = context.addTag(staleCard, 'Vacation');
  const second = context.addTag(staleCard, 'Family');
  await Promise.resolve();
  await context.changeDrivePage('next');
  await context.changeDrivePage('previous');
  await finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls.tags.map((call) => call.tags), [['Work', 'Vacation'], ['Work', 'Vacation', 'Family']]);
  assert.deepEqual(Array.from(read('drives[0].tags')), ['Work', 'Vacation', 'Family']);
  await context.changeDrivePage('next');
  await context.changeDrivePage('previous');
  assert.deepEqual(Array.from(read('drives[0].tags')), ['Work', 'Vacation', 'Family']);
});

test('a queued edit from another stale card cannot restore the last removed tag', async () => {
  const { context, api, calls, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView());
  const firstCard = read('drives[0]');
  await context.changeDrivePage('next');
  await context.changeDrivePage('previous');
  const secondCard = read('drives[0]');
  const save = api.setDriveTags;
  let finishFirst;
  let count = 0;
  api.setDriveTags = (query) => ++count === 1
    ? new Promise((resolve) => { finishFirst = () => save(query).then(resolve); }) : save(query);
  const first = context.removeTag(firstCard, 'Work');
  const second = context.addTag(secondCard, 'Family');
  await Promise.resolve();
  await finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls.tags.map((call) => call.tags), [[], ['Family']]);
  assert.deepEqual(Array.from(read('drives[0].tags')), ['Family']);
});

test('reloading waits for a pending tag write and reads its saved metadata', async () => {
  const { context, api, calls, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView());
  const save = api.setDriveTags;
  let finish;
  api.setDriveTags = (query) => new Promise((resolve) => { finish = () => save(query).then(resolve); });
  const edit = context.addTag(read('drives[0]'), 'Vacation');
  await Promise.resolve();
  const reload = context.reloadDrivesAfterWrite();
  await Promise.resolve();
  assert.equal(calls.loads.length, 0);
  await finish();
  await Promise.all([edit, reload]);
  assert.equal(calls.loads.length, 1);
  assert.deepEqual(Array.from(read('drives[0].tags')), ['Work', 'Vacation']);
});

test('editing a selected matching drive preserves its selection, detail, and camera', async () => {
  const { context, calls, routeIds, read } = loadRenderer();
  vm.runInContext("driveFilters.tag = 'Work'", context);
  await context.applyDriveFilters();
  await context.selectOverviewDrive(5);
  const points = read('drives[0].points');
  await context.addTag(read('drives[0]'), 'Family');
  assert.equal(read('selectedDriveId'), 5);
  assert.equal(read('drives[0].points'), points);
  assert.deepEqual(routeIds(), [5, 3, 1]);
  assert.equal(calls.details.length, 1);
  assert.equal(calls.fits.length, 1);
});

function initRemovalControls(context) {
  vm.runInContext('initDrivePagination = () => {}; initTessieImport = () => {};', context);
  context.initViewDrivesTab();
}

test('single-drive deletion rebuilds page state without ghosts or skipped surviving drives', async () => {
  const { context, calls, elements, routeIds, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  initRemovalControls(context);
  vm.runInContext('pendingRemoveDrive = drives[0]', context);
  await elements.get('btn-remove-drive-confirm').handlers.get('click')();
  assert.equal(calls.loads.length, 1);
  assert.equal(read('drivePageState.total'), 4);
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [4, 3]);
  assert.deepEqual(routeIds(), [4, 3, 2, 1]);
  await context.changeDrivePage(1);
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [4, 3]);
  await context.changeDrivePage('next');
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [2, 1]);
});

test('bulk deletion of the final page returns to the nearest surviving page', async () => {
  const { context, elements, read } = loadRenderer();
  await context.applyDrivePageState(await context.loadDriveView());
  await context.changeDrivePage(3);
  initRemovalControls(context);
  vm.runInContext('pendingBulkRemove = [...drives]', context);
  await elements.get('btn-remove-drives-confirm').handlers.get('click')();
  assert.equal(read('drivePageState.total'), 4);
  assert.equal(read('drivePageState.offset'), 2);
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [3, 2]);
  assert.equal(elements.get('drive-page-number').value, 2);
  assert.equal(elements.get('drive-page-number').max, 2);
});

test('deleting dashcam footage reloads an overlapping import into the list and map', async () => {
  const { context, api, history, elements, routeIds, read } = loadRenderer();
  const load = api.loadAndGroupDrives;
  const overlapping = { ...history[0], id: 6, source: 'teslascope' };
  api.loadAndGroupDrives = (filePath) => {
    if (!history.some((drive) => drive.id === 5)) history.unshift(overlapping);
    return load(filePath);
  };
  await context.applyDrivePageState(await context.loadDriveView(), { overviewChanged: true });
  initRemovalControls(context);
  vm.runInContext('pendingRemoveDrive = drives[0]', context);
  await elements.get('btn-remove-drive-confirm').handlers.get('click')();
  assert.equal(read('drivePageState.total'), 5);
  assert.deepEqual(Array.from(read('drives'), (drive) => drive.id), [6, 4]);
  assert.deepEqual(routeIds(), [6, 4, 3, 2, 1]);
  assert.equal(elements.get('btn-remove-tessie').disabled, false);
});

test('removing imported drives stays available when filters and the current page hide imports', async () => {
  const { context, api, history, elements, routeIds } = loadRenderer();
  history.at(-1).source = 'tessie';
  await context.applyLoadedDriveData(await api.loadAndGroupDrives('drive-data.json'), 'drive-data.json');
  assert.equal(elements.get('btn-remove-tessie').disabled, false);
  vm.runInContext("driveFilters.startDate = '2026-09-01'", context);
  await context.applyDriveFilters();
  assert.deepEqual(routeIds(), [5]);
  assert.equal(elements.get('btn-remove-tessie').disabled, false);
});
