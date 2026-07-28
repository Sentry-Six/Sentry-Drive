# Bounded-Memory Drive Data Loader

Date: 2026-07-28

## Problem

Sentry Drive currently stream-parses large `drive-data.json` files, but it
retains every route as ordinary JavaScript objects and nested arrays. A
1.141 GiB real-world file expands beyond Electron 42's approximately 4 GiB
main-process V8 heap before grouping finishes. Grouping then creates additional
route and point representations.

The existing `app.commandLine.appendSwitch('js-flags',
'--max-old-space-size=8192')` does not enlarge the already-created Electron main
isolate. Raising a heap limit would only move the failure threshold and would
not satisfy the requirement that total file size must not determine heap use.

## Goal

Load valid `drive-data.json` files with a bounded JavaScript working set,
regardless of total file size. The app itself must remain alive if loading
fails, a record is malformed, disk space runs out, or the loader process exits.

All existing grouping rules and drive statistics must remain semantically
equivalent. Large histories must remain browsable without transferring the
entire dataset through Electron IPC or retaining it in the renderer.

## Scope Assumptions

- The input is valid JSON using Sentry Drive's supported schema.
- A single scalar JSON token, such as one path or label, must fit in V8's
  maximum string size. Total file size, route count, point count, and drive
  count are not assumed to fit in memory.
- Exact statistics are calculated from all valid samples. Map and replay
  geometry may be deterministically downsampled for display when one drive is
  too large for a bounded IPC response.
- The source file is read-only during loading. A size/mtime change invalidates
  the load and requires a restart so results never combine two file versions.

## Considered Approaches

### Compact in-memory typed arrays

This would substantially reduce the current file's footprint and would be the
smallest change. It still grows linearly with total point count, so another
large enough file would fail.

### Larger heap or high-memory helper

Electron's embedded main and utility isolates remain constrained, and every
heap size is finite. This also leaves large IPC payloads and renderer retention
unaddressed.

### Disk-backed utility-process loader

This is the selected approach. It keeps parsing, grouping, and statistics
outside the main process and uses a disposable SQLite working index. Memory is
bounded by parser buffers, fixed-size SQL batches, and the current aggregation
window rather than by the whole file.

## Architecture

### Process boundary

The main process launches `src/main/drive-loader-worker.cjs` with Electron's
`utilityProcess.fork()` after `app.ready`. The worker owns parsing, the
disk-backed index, grouping, statistics, searching, paging, and drive-detail
queries.

The main process owns only:

- loader lifecycle and request correlation;
- progress forwarding to the renderer;
- lightweight aggregate counters;
- the currently requested bounded result page or drive detail;
- user-facing error conversion.

The worker remains alive while its file is open. Starting another load first
closes the previous worker and removes its disposable index.

An uncaught exception, V8 fatal error, or abnormal worker exit rejects pending
requests and shows a recoverable load error. It does not terminate the Electron
main or renderer processes.

### Disposable SQLite index

Each load creates a unique database below:

`app.getPath('temp')/sentry-drive/load-cache/<load-id>/drive-index.sqlite`

The database is a working cache, never a source of truth. SQLite uses a bounded
cache and file-backed temporary storage. Disposable-cache pragmas may disable
durability features because the database can always be rebuilt.

Core logical tables are:

- `source_meta`: canonical path, size, mtime, schema/cache version;
- `routes`: normalized file identity, timestamp, scalar metadata and source;
- `route_points`: route-local sequence, latitude, longitude and aligned sample
  values;
- `gear_runs`: ordered gear/frame runs;
- `tags`: drive start time and tag value;
- `drive_members`: ordered route segments assigned to each grouped drive;
- `drive_summaries`: computed scalar statistics, provenance and telemetry;
- `drive_points`: filtered full-resolution point stream used for detail queries;
- `drive_events`: disengagement and accelerator events;
- `drive_overview`: bounded overview geometry;
- `global_stats`: counts and aggregate values needed by the UI.

Indexes enforce normalized-file deduplication and support ordered timestamp,
drive, tag, source, and date-range queries.

The implementation uses the bundled Node 24 `node:sqlite` API. No native npm
module or post-install rebuild is added.

## Loading Pipeline

### 1. Validate and initialize

- Resolve and stat the source path.
- Verify available temporary disk space against a conservative estimate.
- Create the cache directory and database.
- Record source size and mtime.
- Emit an `indexing` progress phase.

If free-space reporting is unavailable, loading may proceed, but `SQLITE_FULL`
is converted to a clear disk-space error.

### 2. Token-stream into normalized tables

`stream-json` reads the document once. The loader does not assemble the
top-level object, routes array, or points arrays.

For each route, a small state machine:

- captures scalar metadata;
- normalizes the file path and parses its timestamp;
- filters unsupported event-folder routes;
- inserts GPS and aligned telemetry samples by sequence;
- inserts gear runs as they arrive;
- commits the route in a bounded transaction;
- discards duplicate normalized file paths without retaining a global JS set.

`processedFiles` is counted token-by-token. `driveTags` is written row-by-row.
No collection proportional to the entire file remains in JavaScript.

The parser commits fixed-size batches and checks source size/mtime between
batches. Cancellation rolls back the current batch and removes the cache.

### 3. Assign groups on disk

Routes are scanned in timestamp order. A state machine assigns time-group and
gear-group identifiers using the existing gap, park-run, and legacy parked-clip
rules. Park-split segments reference point ranges rather than copying arrays.

External-signature subdivision is performed with indexed SQL grouping while
preserving the existing ordering convention:

1. unsigned members;
2. signed buckets ordered by their first appearance.

Invalid timestamps and dropped-route counts are recorded exactly as today.

### 4. Compute exact statistics with bounded passes

Each drive's member points are exposed as ordered SQL cursors. Calculations that
currently require arrays become bounded streaming passes:

- count valid points and calculate the middle-50-percent location reference;
- apply null-island and median-distance filtering;
- use a three-point sliding window for isolated-jump filtering;
- calculate distance, speed, assistance state, gear state, events and endpoint
  telemetry;
- keep only the first/last endpoint windows required for geocode snapping;
- write accepted points and events to disk as they are produced.

This preserves the current formulas while limiting live point state to a fixed
window. A deterministic streaming sampler stores at most 120 overview points
per drive.

### 5. Prepare bounded UI results

The loader returns aggregate counts and the first summary page, not all drives.
Drive summaries are fetched in pages. Search, source/date/tag filtering, and
sort order run against SQLite so the renderer never needs the complete history.

The all-drives map receives a globally bounded geometry budget. The sampler
preserves endpoints and allocates remaining points across visible drives. The UI
shows the complete drive count even when overview geometry is reduced.

Selecting a drive requests detail by ID. Detail IPC has a fixed point budget.
When a drive exceeds it, deterministic downsampling preserves:

- first and last points;
- assistance-state transitions;
- gear transitions;
- recorded events;
- representative intervening geometry.

Scalar statistics and counts always reflect the full-resolution data. The
detail response identifies when display geometry was reduced.

## Renderer Changes

- Replace the assumption that every drive summary is resident with a paged
  result model.
- Preserve the current list interactions for loaded pages.
- Route search/filter/sort requests through the main process to the loader.
- Fetch selected-drive detail on demand and release the previous full detail
  when selection changes.
- Display parsing, indexing, grouping, calculating, and preparing progress.
- Show recoverable errors and allow retrying without restarting Sentry Drive.
- Indicate when an exceptionally large selected drive uses reduced display
  geometry; do not label exact statistics as approximate.

## Lifecycle and Cleanup

- A graceful app close asks the worker to close SQLite before termination.
- Cache directories are removed when a load is replaced or the app exits.
- On startup, cache directories older than 24 hours are removed.
- Cleanup resolves and validates every target beneath the dedicated
  `sentry-drive/load-cache` directory before recursive deletion.
- The original `drive-data.json` is never modified by loading.

## Error Handling

The worker emits structured errors with a stable code and user-facing message:

- malformed/unsupported JSON;
- source changed during load;
- source read/permission failure;
- insufficient temporary disk space or `SQLITE_FULL`;
- canceled load;
- worker crash or abnormal exit;
- cache/schema failure.

Errors include the last completed phase and byte offset where available.
Detailed diagnostics go to the existing logger without including tokens or
other secrets.

## Compatibility

The existing `readDriveData()` path remains available for write operations
initially. Removal, importing, checking, and tag edits continue using their
current locked read/modify/write behavior in this change.

The display loader is replaced first because it is the reported crash path.
Large-file write operations are explicitly outside this implementation and
will receive a clear size guard instead of being allowed to OOM. A later design
can migrate them to transactional disk-backed rewrites without coupling that
risk to the display fix.

## Testing

### Unit and parity tests

- token state machine handles field order, missing optional fields, base64 and
  array telemetry, Windows paths, Unicode, and malformed records;
- normalized-file deduplication and event-folder filtering match the current
  grouper;
- time, gear, park, and external-signature grouping match existing fixtures;
- disk-backed drive summaries and events deep-equal current `groupIntoDrives()`
  output for representative fixtures;
- streaming GPS filtering and all statistics match current formulas;
- overview and detail samplers preserve required points and respect budgets;
- pagination/filter/sort/tag queries are stable;
- cancellation and all structured error paths clean up safely.

### Failure-isolation tests

- forced worker exception rejects the load while the app remains responsive;
- forced worker exit rejects outstanding detail/page requests;
- malformed JSON and simulated `SQLITE_FULL` do not terminate the app;
- source mutation during loading is detected.

### Large-file tests

- generate a sparse multi-gigabyte fixture without retaining it in memory;
- load it with a monitored heap and assert the worker/main/renderer working sets
  stay below configured budgets;
- verify memory does not grow linearly between equal-size processing windows;
- verify temporary files are removed after close and cancellation.

### Real-file acceptance test

Load `C:\Users\Jhoan\Downloads\drive-data.json` (1,225,140,118 bytes) under
Electron's normal approximately 4 GiB heap:

- the app remains responsive and completes the load;
- route/drive/drop/tag counts are recorded;
- representative drive summaries and selected details match the legacy
  high-memory implementation run under diagnostic Node;
- the source file remains byte-for-byte unchanged;
- peak memory and cache disk use are recorded in the verification report.

## Success Criteria

- Total source-file size does not produce a proportional JavaScript heap.
- Sentry Drive stays open after loader failure or cancellation.
- Valid histories are browsable through bounded pages and detail responses.
- Exact scalar statistics retain parity with the existing grouper.
- The real 1.141 GiB file completes under the normal Electron heap.
- No loading operation mutates the source file.
- Existing small-file tests remain green.

## Non-Goals

- Redesigning the visual styling of the drive list or map.
- Changing drive grouping or analytics formulas.
- Making import/removal/rewrite operations out-of-core in the same change.
- Persisting the disposable index as a long-term user database.
