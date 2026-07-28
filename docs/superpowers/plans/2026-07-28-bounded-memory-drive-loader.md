# Bounded-Memory Drive Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the whole-file in-memory display loader with an isolated, disk-backed loader that completes the user's 1.141 GiB file under Electron's normal heap and keeps Sentry Drive alive on loader failure.

**Architecture:** A focused loader service stream-parses routes into a disposable `node:sqlite` index, groups timestamp windows from disk with the existing grouper, and persists full drive details back to SQLite. Electron launches that service through `utilityProcess.fork`; the renderer receives bounded summary pages, overview geometry, and one selected-drive detail at a time.

**Tech Stack:** Electron utility processes, Node 24 `node:sqlite`, `stream-json`, Node test runner, existing ESM grouper.

## Global Constraints

- The source `drive-data.json` is read-only during display loading.
- Total source size, route count, and point count must not be retained in JavaScript collections.
- Main/renderer IPC responses must have fixed page and geometry budgets.
- Existing grouping/statistics formulas remain unchanged unless a parity test proves equivalence.
- Loader exceptions and exits must reject the load without exiting the Electron main process.
- No new native npm dependency or post-install rebuild.
- Write operations keep the current reader but reject inputs above its safe limit with a clear error.
- Verify against `C:\Users\Jhoan\Downloads\drive-data.json` without modifying it.

---

### Task 1: Disposable SQLite route index

**Files:**
- Create: `src/main/drive-index.cjs`
- Create: `src/main/drive-index.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createDriveIndex({ dbPath, sourcePath })`
- Produces: `indexDriveData(index, { onProgress, signal })`
- Produces: index methods `getMeta()`, `iterateTimeWindows()`, `putDrive()`, `getDriveDetail(id, maxPoints)`, `listDrives(query)`, and `close()`

- [ ] **Step 1: Write failing schema/lifecycle tests**

Create a real temporary SQLite database and assert:

```js
const index = createDriveIndex({ dbPath, sourcePath: fixturePath });
await indexDriveData(index, {});
assert.deepEqual(index.getMeta(), {
  processedFileCount: 2,
  routeCount: 3,
  droppedCount: 1,
});
assert.equal([...index.iterateTimeWindows()].flat().length, 2);
index.close();
```

The fixture must include two duplicate normalized paths, one event-folder
route, Windows separators, reordered top-level fields, Unicode tags, and
aligned point/state/speed arrays.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/main/drive-index.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `drive-index.cjs`.

- [ ] **Step 3: Implement the real index**

Use `DatabaseSync` from `node:sqlite`, bounded pragmas
(`temp_store=FILE`, negative `cache_size`, disposable journal/sync settings),
prepared statements, and fixed-size transactions. Implement a token-state
machine for each route: scalar fields update the `routes` row; every point,
speed, state, accelerator sample, and gear run is inserted by route-local
sequence as its token completes. Do not use `Assembler` for a route or points
array. Store tags row-by-row and count processed files token-by-token.

`iterateTimeWindows()` must expose a cursor over route metadata ordered by
`timestamp_ms, sequence`; it must not deserialize route payloads or return a
collection proportional to a time window.

- [ ] **Step 4: Verify GREEN and existing reader parity**

Run:

```powershell
node --test src/main/drive-index.test.js src/main/drive-data-reader.test.js
```

Expected: all tests pass with no leaked database handles.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/main/drive-index.cjs src/main/drive-index.test.js
git commit -m "feat: add disk-backed drive route index"
```

---

### Task 2: Windowed grouping and persisted drive details

**Files:**
- Create: `src/main/disk-drive-grouper.cjs`
- Create: `src/main/disk-drive-grouper.test.js`
- Modify: `src/main/drive-index.cjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: ordered metadata and point cursors from `drive-index.cjs`
- Produces: `groupIndexedDrives(index, { onProgress, signal })`
- Produces: exact aggregate metadata and bounded overview geometry

- [ ] **Step 1: Write failing parity tests**

For every behavior represented in `src/processing/grouper.test.js`, index its routes, run
`groupIndexedDrives`, fetch every resulting summary/detail, and compare literal
fields to the current grouper:

```js
assert.deepEqual(actual.map(normalizeDrive), expected.map(normalizeDrive));
assert.ok(actual.every((d) => d.overviewPoints.length <= 120));
```

Add a generated fixture with 10,000 time windows. During grouping, sample
`process.memoryUsage().heapUsed` and assert the retained increase is below
128 MiB after forced GC when available.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --expose-gc --test src/main/disk-drive-grouper.test.js`

Expected: FAIL because `groupIndexedDrives` does not exist.

- [ ] **Step 3: Implement windowed grouping**

Port the existing grouping rules into a cursor state machine:

1. assign time-group IDs while scanning route metadata in timestamp order;
2. inspect `gear_runs` and create point-range segment rows without copying;
3. assign gear groups using the current park-gap and legacy parked rules;
4. assign signed/unsigned external-signature buckets in SQL while preserving
   first-appearance order;
5. stream each drive's joined point rows through bounded passes.

The first point pass counts valid samples and calculates the middle-50-percent
reference. A second pass applies null-island/median-distance filtering into a
disposable per-drive SQL table. A third pass uses a three-point sliding window
for isolated jumps and calculates the current distance, speed, assistance,
event, endpoint, and telemetry formulas. Accepted detail points are inserted
row-by-row; no drive-sized JavaScript array is created.

The existing `groupIntoDrives` is used only as the test oracle on small
fixtures. Assign monotonically increasing stable IDs and build exact global
aggregates while persisting summaries so the renderer no longer reduces over
every drive.

`getDriveDetail(id, maxPoints)` must return at most `maxPoints` display points,
preserve endpoints and transition/event indexes, and include
`displayPointCount`, `fullPointCount`, and `downsampled`.

- [ ] **Step 4: Verify GREEN and grouper parity**

Run:

```powershell
node --expose-gc --test src/main/disk-drive-grouper.test.js src/processing/grouper.test.js
```

Expected: parity fixtures and bounded-retention test pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/main/drive-index.cjs src/main/disk-drive-grouper.cjs src/main/disk-drive-grouper.test.js
git commit -m "feat: group indexed routes with bounded memory"
```

---

### Task 3: Loader service protocol and cache cleanup

**Files:**
- Create: `src/main/drive-loader-service.cjs`
- Create: `src/main/drive-loader-service.test.js`
- Create: `src/main/drive-loader-worker.cjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `createLoaderService({ cacheRoot, send })`
- Worker requests: `{ id, type: 'load'|'list'|'detail'|'close', payload }`
- Worker responses: `{ id, ok, result }` or `{ id, ok: false, error }`
- Progress: `{ type: 'progress', payload: { phase, current, total } }`

- [ ] **Step 1: Write failing service integration tests**

Use a real temporary cache root and real fixture:

```js
const sent = [];
const service = createLoaderService({ cacheRoot, send: (m) => sent.push(m) });
const loaded = await service.handle({ type: 'load', payload: { filePath } });
assert.equal(loaded.totalDriveCount, 2);
assert.ok(sent.some((m) => m.type === 'progress' && m.payload.phase === 'indexing'));
await service.close();
assert.deepEqual(fs.readdirSync(cacheRoot), []);
```

Also test abort, malformed JSON, source mutation, simulated `SQLITE_FULL`, and
cleanup refusing a path outside the resolved cache root.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/main/drive-loader-service.test.js`

Expected: FAIL because the service module is absent.

- [ ] **Step 3: Implement service and worker entrypoint**

The service creates one unique load directory, validates source stat before and
after each phase, maps errors to stable codes, and deletes only validated
descendants of `cacheRoot`.

The worker entrypoint registers `process.parentPort.on('message')`, dispatches
to the service, posts progress/responses, and closes on parent disconnect.

- [ ] **Step 4: Verify GREEN**

Run: `node --test src/main/drive-loader-service.test.js`

Expected: all service and cleanup tests pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/main/drive-loader-service.cjs src/main/drive-loader-service.test.js src/main/drive-loader-worker.cjs
git commit -m "feat: add isolated drive loader service"
```

---

### Task 4: Electron utility-process client and IPC integration

**Files:**
- Create: `src/main/drive-loader-client.cjs`
- Create: `src/main/drive-loader-client.test.js`
- Modify: `src/main/electron-main.cjs`
- Modify: `src/main/electron-preload.cjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `createDriveLoaderClient({ fork, workerPath, cacheRoot, logger })`
- Client methods: `load(filePath, onProgress)`, `list(query)`,
  `detail(id, maxPoints)`, `close()`
- Renderer APIs: `listDriveSummaries(query)` and existing
  `getDriveDetail(id)` routed to the worker

- [ ] **Step 1: Write failing client lifecycle tests**

Use a protocol-compatible fake child EventEmitter and assert real client
outcomes: correlated responses resolve the correct promise, worker exit rejects
all pending requests, replacing a load closes the previous child, and progress
is delivered only to the active load.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/main/drive-loader-client.test.js`

Expected: FAIL because the client is absent.

- [ ] **Step 3: Implement client and replace display loader**

Import `utilityProcess` in `electron-main.cjs`, launch the worker only after
`app.ready`, remove the ineffective `js-flags` switch and in-memory
`driveDetailCache`, and route:

- `load-and-group-drives` to `client.load`;
- `list-drive-summaries` to `client.list`;
- `get-drive-detail` to `client.detail`;
- `before-quit` to `client.close`.

Preserve existing progress event names while adding `indexing` and
`calculating`. Return structured errors rather than throwing fatal failures.

- [ ] **Step 4: Verify GREEN and all main tests**

Run:

```powershell
node --test src/main/drive-loader-client.test.js src/main/drive-index.test.js src/main/disk-drive-grouper.test.js src/main/drive-loader-service.test.js
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/main/drive-loader-client.cjs src/main/drive-loader-client.test.js src/main/electron-main.cjs src/main/electron-preload.cjs
git commit -m "feat: isolate drive loading from Electron main"
```

---

### Task 5: Bounded renderer paging and detail retention

**Files:**
- Create: `src/renderer/drive-page-model.cjs`
- Create: `src/renderer/drive-page-model.test.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/renderer.js`
- Modify: `src/renderer/styles.css`
- Modify: `package.json`

**Interfaces:**
- Produces: `createDrivePageModel({ pageSize: 250, fetchPage })`
- Model methods: `load(filters)`, `next()`, `previous()`, `current()`
- Consumes: `window.electronAPI.listDriveSummaries(query)`

- [ ] **Step 1: Write failing page-model tests**

Assert that the model retains one 250-drive page, drops previous selected
detail on page/selection changes, ignores stale async responses, and forwards
tag/source/date/sort filters as literal query values.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/renderer/drive-page-model.test.js`

Expected: FAIL because the page model is absent.

- [ ] **Step 3: Implement paging UI**

Add Previous/Next controls and `page X of Y` below `#drives-list`. Refactor both
manual and automatic load flows through one `applyLoadedDriveData(result)`
function. Render lifetime statistics from worker-provided aggregates, not the
current page. Fetch pages after tag-filter changes. Keep only the current page
and selected detail in `drives`; delete the prior drive's `points`, states, and
events when selection changes.

Update loading copy for `indexing`, `grouping`, `calculating`, and `preparing`.
Show a small note when `detail.downsampled` is true.

- [ ] **Step 4: Verify GREEN and renderer tests**

Run:

```powershell
node --test src/renderer/drive-page-model.test.js src/renderer/replay-bearing.test.js
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/renderer/drive-page-model.cjs src/renderer/drive-page-model.test.js src/renderer/index.html src/renderer/renderer.js src/renderer/styles.css
git commit -m "feat: page large drive histories in the renderer"
```

---

### Task 6: Guard legacy write paths from main-isolate OOM

**Files:**
- Modify: `src/main/drive-data-reader.cjs`
- Modify: `src/main/drive-data-reader.test.js`
- Modify: `src/main/electron-main.cjs`

**Interfaces:**
- Produces: `assertWritableDriveDataSize(filePath)`
- Error code: `DRIVE_DATA_WRITE_TOO_LARGE`

- [ ] **Step 1: Write failing size-guard tests**

Stub `fs.statSync` at the module boundary only if a sparse test file cannot be
created cheaply. Assert files above the documented write-safe threshold reject
before `readDriveData` and return a message explaining that display remains
available but the requested edit/import needs a smaller or migrated file.

- [ ] **Step 2: Run and verify RED**

Run: `node --test src/main/drive-data-reader.test.js`

Expected: FAIL because no write-size guard exists.

- [ ] **Step 3: Implement and apply the guard**

Apply the guard to removal, import, tag-edit, repair, and revert paths before
their read/modify/write work. Do not apply it to `load-and-group-drives`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: complete suite passes.

- [ ] **Step 5: Commit**

```powershell
git add src/main/drive-data-reader.cjs src/main/drive-data-reader.test.js src/main/electron-main.cjs
git commit -m "fix: guard oversized legacy rewrite operations"
```

---

### Task 7: Real-file and packaged-runtime verification

**Files:**
- Create: `scripts/verify-large-drive-load.cjs`
- Create: `docs/verification/2026-07-28-large-drive-load.md`
- Modify: `package.json`

**Interfaces:**
- Script arguments: `--file <absolute path> --max-heap-mb 4096`
- Output: newline-delimited phase, heap/RSS, count, checksum, and timing records

- [ ] **Step 1: Add the verification harness**

The harness runs the real loader service used by the utility worker, polls
`process.memoryUsage()`, records source SHA-256 before and after, requests
representative first/middle/last details, and exits nonzero for load error,
memory-budget breach, count mismatch, or source mutation.

- [ ] **Step 2: Run the complete automated suite**

Run:

```powershell
npm test
npm run prebuild
```

Expected: exit 0 with no failures.

- [ ] **Step 3: Verify the actual 1.141 GiB file**

Run:

```powershell
node --max-old-space-size=4096 scripts/verify-large-drive-load.cjs --file 'C:\Users\Jhoan\Downloads\drive-data.json' --max-heap-mb 4096
```

Expected: load completes, heap remains below budget, representative detail
queries succeed, and pre/post source SHA-256 values match.

- [ ] **Step 4: Exercise Electron utility-process failure isolation**

Launch `npm start`, load the real file, confirm page/detail navigation, then run
the harness's `--force-worker-exit` mode. Record that the app shows a recoverable
error and remains open.

- [ ] **Step 5: Record evidence and commit**

Write exact commands, versions, counts, timings, peak heap/RSS, cache size, and
source hashes to the verification report.

```powershell
git add package.json scripts/verify-large-drive-load.cjs docs/verification/2026-07-28-large-drive-load.md
git commit -m "test: verify bounded large drive loading"
```

---

### Task 8: Final regression and graph maintenance prompt

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Run final verification from a clean app state**

Run:

```powershell
npm test
npm run prebuild
git diff --check HEAD~7
git status --short
```

Expected: tests and prebuild pass; only intentional commits plus the pre-existing
untracked `graphify-out/` remain.

- [ ] **Step 2: Review implementation against the design**

Check every success criterion in
`docs/superpowers/specs/2026-07-28-unbounded-drive-data-loader-design.md`
against a test result or verification-report entry. Fix any uncovered gap using
a fresh RED/GREEN cycle.

- [ ] **Step 3: Suggest graph refresh**

Because the loader adds a new service, worker, index, and IPC relationships,
ask the user whether to run `/graphify --update`. Do not rebuild the graph
silently.
