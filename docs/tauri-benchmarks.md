# Sentry Drive: Electron vs Tauri benchmarks

An experiment on branch `claude/tauri-port-d4641b`: Sentry Drive v1.6.3 ported from
Electron 45 to Tauri 2. The web UI is unchanged; the Electron main process,
preload and Node-only code are replaced by Rust. Nothing here is shipped, pushed
or published, and `main` and the Electron release setup are untouched.

## Results

Same Mac, same 1.08 GB `drive-data.json`, same harness. Electron numbers are the
v1.6.3 build from `main`; Tauri numbers are the port on this branch. Times are
medians of 5 cold starts (app fully quit between runs); the "no drive loaded"
row is a single run for both apps.

| | Electron 45 (v1.6.3) | Tauri 2 (this branch) | Change |
|---|---:|---:|---:|
| **DMG download** (universal) | 230.2 MB | 19.9 MB | **11.6× smaller** |
| **ZIP download** (universal) | 222.9 MB | 18.0 MB | 12.4× smaller |
| **Installed .app** (universal) | 517.2 MB | 32.6 MB | 15.9× smaller |
| First contentful paint | 597 ms | 594 ms | same |
| Renderer "ui ready" log line | 608 ms | 590 ms | same |
| **Launch → drive list + map shown** (auto-loads the 1.08 GB file) | 71.7 s | 9.0 s | **7.9× faster** |
| Warm reload of the same file in the running app | 71.5 s | 8.3 s ¹ | 8.6× faster |
| Memory, drive loaded and map open (sum of all app processes) | 482 MiB | 548 MiB | +14% |
| Memory, after start with no drive loaded | 443 MiB | 331 MiB | −25% |
| Peak memory during load (sum of per-process peaks) | 1,212 MiB | 1,504 MiB | +24% |
| Memory after the warm reload | 1,073 MiB | 1,040 MiB | −3% |
| Idle CPU over 60 s, drive loaded | 0.14% | 0.04% | lower |
| Idle CPU over 60 s, no drive loaded | 1.17% | 0.03% | lower |
| Processes attributed to the app | 6 | 6 | — |

¹ One of the five Tauri reloads took 200 s. Its log shows the Rust load itself
finished in 8.1 s (index 5.4 s + group 2.7 s), so the delay was in the page
before the drive list appeared. The most likely cause is WebKit throttling a
window that was covered or in the background: other sessions were using the
screen during the run. It did not recur in the other four runs; the median
ignores it, and the raw value is in `scripts/bench/results/tauri-results.json`.

### Where the time and memory go

- **Loading.** The Electron utility process streams the JSON token by token in
  JavaScript (`stream-json`) into SQLite, then groups drives. The Rust loader
  does the same work in about 5.5 s of indexing plus 2.7 s of grouping. It
  splits the routes array into raw elements, parses batches of them in
  parallel with serde, and groups the 30-minute windows in parallel. For
  reference, the original JS loader run on its own under Node took 81.6 s on
  this file.
- **Memory with a drive loaded** is about the same as Electron, not lower. In
  the Tauri build:
  - The app process itself is about 240 MiB. Roughly 150 MiB of that is the
    window's GPU/compositor memory (IOAccelerator in `vmmap`), which macOS
    charges to the app process. Electron charges the equivalent to its GPU
    helper (180–250 MiB).
  - WebKit's page process (about 265 MiB) is a bit heavier than Chromium's
    renderer for this page (130–200 MiB).
  - With no drive loaded Tauri uses 25% less, because there is no Node runtime
    or Chromium browser process.
- **Peak memory** is higher in Tauri because parsing and grouping run on 9
  cores at once. A smaller batch size would trade some load speed for a lower
  peak.
- The Rust side uses `mimalloc`. With the macOS system allocator, a finished
  load left about 425 MiB of freed-but-mapped heap in the app process (89%
  fragmentation in `vmmap`). `mimalloc` returns it.

## Method

Everything is in `scripts/bench/` so it can be re-run:

```bash
node scripts/bench/bench.mjs --app electron --bundle "dist/mac-universal/Sentry Drive.app" \
  --file /path/to/drive-data.json --work /tmp/bench --runs 5 --idle-runs 1 --out electron.json
node scripts/bench/bench.mjs --app tauri \
  --bundle "src-tauri/target/universal-apple-darwin/release/bundle/macos/Sentry Drive Tauri.app" \
  --file /path/to/drive-data.json --work /tmp/bench --runs 5 --idle-runs 1 --out tauri.json
```

- **Launch.** Each run starts the app through LaunchServices
  (`open -n -F -a <app>`), the way a user does; t0 is taken just before `open`.
  This also makes the app its own "responsible process", so macOS attributes
  its helpers to it. A child of the script would hand them to the terminal.
- **Timings** come from a probe page script (`probe.js`), identical for both
  builds. It records epoch timestamps inside the page:
  - **First contentful paint:** from the Performance API.
  - **Drive shown:** loading overlay gone, `.drive-item` rows rendered, and the
    MapLibre map loaded.
  - **Map idle:** all visible tiles loaded.
  - **Warm reload:** the probe calls the app's own `autoLoadDriveData()` 80 s
    after the drive first shows, and times it until the drive is shown again.

  How each app gets the probe:
  - Electron receives it over the DevTools protocol, with
    `--remote-debugging-port` and a throwaway `--user-data-dir`.
  - The Tauri build injects it from its bridge only when
    `SENTRY_DRIVE_BENCH_OUT` is set.
- **Auto-load setup.** Both apps open the file through their normal
  auto-load-last-file path. Electron's localStorage is seeded once over the
  DevTools protocol; Tauri's is seeded by the same bench-only init script.
- **"ui ready"** is the arrival time of the renderer's own log line on stdout,
  tailed every 25 ms.
- **Memory** is `ri_phys_footprint` (Activity Monitor's "Memory" column) from
  `proc_pid_rusage`, summed over the app process, every process macOS reports
  the app as responsible for (Electron helpers; WebKit WebContent, GPU and
  Networking XPC services), and their descendants (`procstat.py`).
  - **Snapshot:** taken 15 s after the drive shows.
  - **Peak:** the sum of each process's lifetime-maximum footprint, an upper
    bound on the true simultaneous peak.
- **Idle CPU** is the change in user+system CPU time across all those
  processes over 60 s, starting 15 s after the drive shows, as a percentage of
  one core. Nothing polls the page during that window.
- **Sizes**
  - Downloads: the DMG and ZIP file sizes. The Tauri ZIP is made with
    `ditto -c -k --keepParent` (the Tauri CLI doesn't produce one).
  - Installed size: `du -sk` of the `.app`, before any run.
- **Data:** a local SSD copy of `/Volumes/USB/drive-data.json`
  (1,079,974,639 bytes; 36,515 routes; 1,220 drives; 6 charging sites). Copying
  it keeps USB speed out of the timings and guarantees the original is never
  written to.

## Machine and versions

- MacBook Pro, Apple M2 Pro (6 performance + 4 efficiency cores), 16 GB, macOS 27.2 (26B123).
- **Electron build:** Sentry Drive v1.6.3 from `main` (49d9aae), Electron 45.1.0 (Chromium 156.0.8078.49, Node 24.22.1).
  - Built with electron-builder 26.18.0: `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never -c.mac.identity=- -c.mac.notarize=false`
  - Universal DMG + ZIP, ad-hoc signed, not notarized.
- **Tauri build:** tauri 2.12.5, tauri-cli 2.12.4, Rust 1.95.0, WKWebView 22625.2.8.11.9.
  - Built with `npx tauri build --target universal-apple-darwin`.
  - Universal `.app` + DMG, ad-hoc signed (`signingIdentity: "-"`), not notarized.
  - Release profile: `lto = true`, `codegen-units = 1`, `strip = true`.
- Other Claude sessions shared the Mac. Heavy work was taken in turns through a shared schedule, and nothing else heavy ran during either benchmark.

## Caveats

- **Different web engine.** On macOS the UI runs in WKWebView (Safari's
  engine) instead of Chromium. Checked: the map, tiles from
  `tiles.sentryusb.com`, the drive list and the charging pills render, and
  MapLibre's module worker runs. Not checked by eye: every screen, every CSS
  detail, and replay animation smoothness. WKWebView is also the engine that
  throttles background windows (see the outlier above).
- **Windows (WebView2) and Linux (WebKitGTK): not built or tested.**
  - WebView2 is Chromium-based, so rendering should be closest to today's
    build. It is preinstalled on Windows 10/11, but not on every machine, so the
    installer needs its bootstrapper.
  - WebKitGTK varies by distribution, and its WebGL/MapLibre performance is the
    weakest of the three. It needs its own testing on the AppImage and `.deb`
    targets.
  - The Rust code is portable, but nothing here was compiled for either OS.
- **No app identity carried over.** The Tauri build uses its own bundle id
  (`com.sentrysix.sentrydrive.tauripreview`), data folder, WebKit storage and
  cache folder, so it never touches the Electron app's data. A shipping port
  needs a one-time migration of Electron's `userData` files (geocode cache,
  known places, settings) and of its localStorage. That covers the last file,
  colours, units and privacy zones, which live in Chromium's LevelDB.
- **Unsigned, not notarized, so first launch is blocked.** Both apps are
  ad-hoc signed only, so Gatekeeper will block the first open: right-click →
  Open, or `xattr -dr com.apple.quarantine <app>` if they were copied from
  elsewhere. Signing and notarizing changes neither size nor speed meaningfully.
- **Network work at start.** Both apps check GitHub for updates when they
  start: electron-updater versus a GitHub Releases API call. Reverse geocoding
  of drive endpoints (Nominatim) runs in both and is cached after the first run.
- **Index cache.** Both builds write a temporary SQLite index (about 1.4 GB for
  this file) and delete it on a normal quit. A killed process leaves it behind
  until the next start sweeps it. Electron keeps it next to the executable or
  in system temp; Tauri keeps it in `~/Library/Caches/<id>/load-cache`.
- **Time zones.** Clip filenames are parsed in local time in both builds:
  - Rust (`chrono`), WebKit and Electron all use the system's zone data.
  - Node 22's bundled ICU does not. In 2026 it still has America/Edmonton at
    UTC−7, while macOS 27 has it at UTC−6.
  - So the JS-vs-Rust parity runs below pin `TZ=America/Denver`, and the
    harness never parses logged wall-clock times.
- **Small samples.**
  - Five cold starts per app and one idle run each, on one machine.
  - The processing parity sample is 21 clips, with GPS on 5 of them.

## How the port is built

- **Frontend: unchanged.** `scripts/tauri/prepare-frontend.mjs` copies
  `src/renderer` and the vendored assets into `tauri-dist/`, keeping the same
  layout. It removes the HTML's CSP `<meta>`; the same policy is set in
  `tauri.conf.json`, where Tauri can add its IPC origin to it.
- **Preload → `src/tauri-bridge/bridge.js`.** An initialization script that
  installs the same `window.electronAPI` surface. Every method maps to a Rust
  command, and every `on…` subscription maps to a Tauri event with the same
  name. `drive-calc.cjs` and `drive-telemetry-view.cjs` are wrapped as page
  globals, as the preload's `contextBridge` exposed them.
- **Main process + Node code → `src-tauri/src/`:**

| Electron | Rust |
|---|---|
| `drive-loader-*`, `drive-index`, `disk-drive-grouper` (utility process) | `loader/index.rs`, `loader/mod.rs`: parallel split/parse, SQLite (bundled `rusqlite`), windowed grouping |
| `grouper.js`, `drive-calc.cjs`, `event-gap-fill`, `clip-path`, `drive-telemetry` | `loader/grouper.rs`, `loader/calc.rs`, `loader/route.rs`: line-by-line ports keeping JS number semantics (`Math.round`, `Date` truncation, local-time parsing) |
| `charging-history.cjs`, `supercharger-catalog.cjs` | `loader/charging.rs`, `supercharger.rs` |
| `drive-data-writer.cjs`, `atomic-write.cjs` | `drive_data.rs`, `fsutil.rs`: section-preserving writer. Filtered sections are streamed element by element, so editing a 1 GB file never loads the whole thing |
| tags / remove drive(s) / import file / change watcher / GPS backup | `drive_edit.rs` |
| `process.js` + `worker.js` + `extract.js` + `clip-discovery.js` (child process) | `processing/*`: in-process threads; MP4 box walk, SEI/protobuf decode, same stdout lines |
| `geocode.cjs`, `known-places.cjs` | `geocode/*` |
| `logger.cjs` | `logger.rs`: same line format, file sink and redacted export |
| dialogs, `shell.openExternal`, window state | `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-window-state` |
| `electron-updater` | `updater.rs`: checks GitHub Releases and opens the release page (see below) |

The Rust is ported from Sentry Drive's own MIT-licensed JavaScript.
Sentry-USB-Rusty has a Rust grouper and extractor, but it is under PolyForm
Noncommercial with other co-authors, so none of its code was copied.

## Parity checklist

**Verified by comparing against the JavaScript implementation**

- [x] **Load and group `drive-data.json`.** `scripts/tauri/loader-parity.mjs`
  ran the original JS loader and the Rust loader on the 1.08 GB file and
  compared every drive's full summary plus a digest of its detail: point
  count, coordinate/time/speed sums, first and last point, FSD/gear
  histograms and FSD events.
  - Load counts and aggregates are identical.
  - **1,216 of 1,220 drives are identical.** In the other 4, one geocode
    endpoint (the stationary-cluster medoid) differs by 0.000001°, about
    0.1 m. The cause is a near-tie broken differently because V8 and the
    system libm round sin/cos differently. Nothing else differs.
- [x] **Charging history.** Sites and sessions are identical, including
  per-site session lists.
- [x] **Process clips (SEI extraction → `drive-data.json`).** On 21 sample
  clips (two RecentClips days plus a SavedClips event in a gap) the output
  route lines are byte-identical to `process.js`, and `processedFiles` and
  `driveTags` match.

**Verified by unit tests (37 Rust tests, all passing)**

- [x] Rounding and geodesy contract, clip-path normalisation, local-time parsing.
- [x] Section-preserving writer: replace `driveTags`, filter `routes`, keep
  unknown sections.
- [x] Geocoding and known places: all 13 cases from `geocode.test.js` and
  `known-places.test.js` ported, plus extra edge cases. No network calls in
  tests.
- [x] Clip discovery (the `clip-discovery.test.js` cases), protobuf/SEI helpers,
  run-length builders.

**Verified by running the built app** (benchmark runs and a smoke test)

- [x] Window opens; the UI renders in WKWebView with the Tauri `electronAPI` bridge.
- [x] Auto-load of the last drive-data file on start, load progress, drive list
  paging, map with route overview, tiles from `tiles.sentryusb.com`.
- [x] Charging sites listed (`list_charging_sites`, Supercharger matching).
- [x] Update check against GitHub ("up to date (v1.6.3)" in the log).
- [x] Logging: same line format, `session.log` / `previous-session.log`.

**Ported but not clicked through by hand**

- [ ] File and folder pickers; "Download logs" save dialog (`tauri-plugin-dialog`).
- [ ] Add/remove drive tags; remove one drive or several (the writer path is
  unit-tested).
- [ ] Import another `drive-data.json` (preview + import, `.bak` restore point).
- [ ] Reload prompt when `drive-data.json` changes on disk (3 s mtime/size poll).
- [ ] Revert to the GPS backup; "has backup" check.
- [ ] Drive detail view and replay; charging-session detail.
- [ ] Reverse-geocoded labels, geocoder settings, known places and privacy zones.
- [ ] Processing tab end to end in the app: start, stop, progress output.
- [ ] Supercharger catalog refresh (Overpass).
- [ ] Changelog (bundled and remote), external links, `check-online`.
- [ ] DevTools (F12 / Ctrl+Shift+I) and reload (Cmd/Ctrl+R) shortcuts; window
  size/position restore; the app staying in the Dock when its window closes.

**Not ported yet.** The bridge returns "Not available in the Tauri preview
yet." and the UI shows its normal error.

- [ ] **Check Drives:** repair GPS via OSRM, and the Summon check/backfill.
- [ ] **Tessie** CSV import, **Tessie API** import, **Teslascope API** import,
  and "remove all / remove hidden" for imported drives.
- [ ] **API token storage.** Electron uses `safeStorage`; the Tauri version
  would go in the macOS Keychain (`keyring` crate).
- [ ] **In-app update download and install.** The Tauri build only checks
  GitHub and opens the release page (see below).

**Known behaviour differences**

- **macOS menu bar.** Tauri shows the standard app menu (Quit, Edit, Window);
  Electron sets no menu.
- **Removing drives.** The routes to delete come from the grouping in the
  loaded index, which is done window by window. Electron re-groups the whole
  file at that moment. These should agree, since the index groups the same way,
  but this has not been compared on real removals.
- **Processing** (from the port's notes):
  - A route that is re-processed moves to the end of the routes array instead
    of staying in place.
  - App edits made during a run are kept rather than overwritten.
  - Ties in clip order are broken by byte order instead of `localeCompare`.
- **Geocoding:**
  - A `null` setting resets to defaults.
  - Malformed zones or a `null` Nominatim body are skipped where the JS threw.
  - Redirects are not followed, which matches Node's `https.get`.
- **Index cache location:** see Caveats.

## Trade-offs

**Gains**
- About a 12× smaller download and a 16× smaller install.
- The 1 GB drive file loads and shows about 8× faster, including warm reloads.
- Less memory at idle with no drive loaded, and near-zero idle CPU.
- One Rust backend instead of a main process, a utility process and a Node
  child process. Native threads replace Electron's `utilityProcess` and the
  Node processing child.

**Costs**
- WKWebView instead of Chromium on macOS, and WebKitGTK on Linux. This means
  three engines to test instead of one.
- Memory with a big drive loaded is about the same, not lower, and peak memory
  during a load is higher unless the parallelism is reduced.
- About 7,000 lines of Rust now duplicate logic that also lives in JavaScript:
  `drive-calc.cjs` still runs in the renderer, and Sentry USB has its own Rust
  version. The JS↔Rust parity scripts in `scripts/tauri/` would need to run in
  CI to keep them in step.
- Some features are still missing (list above).

## Still needed before this could ship

1. **Signing and notarization.**
   - Set the Developer ID in `tauri.conf.json` (`bundle.macOS.signingIdentity`).
   - Provide the Apple notarization credentials (`APPLE_ID`/`APPLE_TEAM_ID`/an
     app-specific password, or an API key).
   - Review entitlements: the Tauri build needs none of Electron's JIT and
     unsigned-memory exceptions.
2. **Auto-update.**
   - Add `tauri-plugin-updater` and generate an update signing key.
   - Publish signed `.app.tar.gz` artifacts plus a `latest.json` manifest on
     GitHub Releases (the Tauri GitHub Action produces both).
   - Replace `updater.rs`'s open-the-release-page fallback.
   - Decide how existing Electron users move over: the last Electron release
     downloads the Tauri DMG once, then Tauri's updater takes over.
3. **Windows and Linux.**
   - Build and test the NSIS installer with the WebView2 bootstrapper, and the
     AppImage and `.deb` on WebKitGTK.
   - Check paths, the index-cache location and file dialogs on each OS.
4. **Remaining features:** Check Drives (OSRM repair and Summon), the
   Tessie/Teslascope imports, and Keychain-backed tokens.
5. **Migration:** carry over Electron's `userData` files and its localStorage
   settings on first launch.
6. **Testing:**
   - Click through every screen in WKWebView.
   - Run the JS↔Rust parity scripts in CI on a fixture set.
   - Move the release workflow from electron-builder to `tauri-action`.

## Trying the two builds side by side

Both are universal, ad-hoc signed `.app` bundles inside this worktree:

- **Electron v1.6.3:** `dist/mac-universal/Sentry Drive.app` (DMG: `dist/Sentry-Drive-1.6.3-universal.dmg`)
- **Tauri port:** `src-tauri/target/universal-apple-darwin/release/bundle/macos/Sentry Drive Tauri.app`
  (DMG: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/Sentry Drive Tauri_1.6.3_universal.dmg`)

The Tauri app has its own name, bundle id and data, so both can be installed
and run at once. Run from the worktree, the Electron build uses the same data
folder as your installed Sentry Drive (`~/Library/Application Support/sentry-drive`).

To rebuild the Tauri app:

```bash
npm install
npx tauri build --target universal-apple-darwin
```

To check processing parity on a folder of sample clips:

```bash
node src/processing/process.js <clips> out-js.json 2
PARITY_CLIPS=<clips> PARITY_OUT=out-rs.json cargo test --release --manifest-path src-tauri/Cargo.toml \
  --lib processing::pipeline::tests::parity_run -- --ignored --nocapture
node scripts/tauri/processing-parity-compare.mjs out-js.json out-rs.json
```

To check loader parity against the JS implementation:

```bash
TZ=America/Denver node scripts/tauri/loader-parity.mjs dump /path/to/drive-data.json js.ndjson
TZ=America/Denver cargo run --release --manifest-path src-tauri/Cargo.toml --example loader_dump -- /path/to/drive-data.json rust.ndjson
node scripts/tauri/loader-parity.mjs compare js.ndjson rust.ndjson
```
