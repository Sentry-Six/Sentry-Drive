# Sentry Drive: moving from Electron to Tauri

Branch `claude/tauri-port-d4641b`: Sentry Drive ported from Electron 45 to
Tauri 2. The web UI is unchanged (two `confirm()` calls gained an `await`); the
Electron main process, preload and Node-only code are replaced by Rust. The
port is now feature-complete. The Tauri app is a drop-in update for existing
Electron installs, and the release workflow is ready. Everything is local:
nothing is pushed, tagged or published.

**Start with "[Ready to ship?](#ready-to-ship)"** for what is done, what is
untested and what Scott has to do.

## Results

Same Mac, same 1.08 GB `drive-data.json`, same harness. Times are medians of
5 cold starts (app fully quit between runs). The "no drive loaded" rows are a
single run.

- **Electron 45 (v1.6.3):** the build from `main`.
- **Tauri, experiment:** the first port (commit `0bbaf2a`).
- **Tauri, ship candidate:** this branch now. Every feature is ported, it uses
  the production identity, and it includes the updater, migration and Keychain
  code.

| | Electron 45 (v1.6.3) | Tauri, experiment | **Tauri, ship candidate** |
|---|---:|---:|---:|
| **DMG download** (universal) | 230.2 MB | 19.9 MB | **22.0 MB** (10.5× smaller) |
| **ZIP download** (universal) | 222.9 MB | 18.0 MB | **20.2 MB** |
| **Installed .app** (universal) | 517.2 MB | 32.6 MB | **37.2 MB** (13.9× smaller) |
| First contentful paint | 597 ms | 594 ms | 555 ms |
| Renderer "ui ready" log line | 608 ms | 590 ms | 573 ms |
| **Launch → drive list + map shown** (auto-loads the 1.08 GB file) | 71.7 s | 9.0 s | **9.8 s** (7.3× faster) |
| Warm reload of the same file in the running app | 71.5 s | 8.3 s ¹ | 9.2 s |
| Memory, drive loaded and map open (sum of all app processes) | 482 MiB | 548 MiB | 552 MiB |
| Memory, after start with no drive loaded | 443 MiB | 331 MiB | 337 MiB |
| Peak memory during load (sum of per-process peaks) | 1,212 MiB | 1,504 MiB | 1,498 MiB |
| Memory after the warm reload | 1,073 MiB | 1,040 MiB | 971 MiB |
| Idle CPU over 60 s, drive loaded | 0.14% | 0.04% | 0.03% |
| Idle CPU over 60 s, no drive loaded | 1.17% | 0.03% | 0.03% |
| Processes attributed to the app | 6 | 6 | 6 |

What changed since the experiment:

- **Load is about 0.8 s slower.** All of it is in grouping (3.6 s, was
  2.7 s). The distance maths now uses the `libm` crate, the same fdlibm
  lineage V8 uses, instead of the platform's faster but differently rounded
  libm. That made every drive bit-identical to the Electron build: 1,220 of
  1,220, where the experiment had 4 drives off by 0.1 m. Exact parity seemed
  worth 0.8 s on a 1 GB file.
- **The bundle is about 4.6 MB bigger.** The extra code is
  tauri-plugin-updater (HTTP with TLS, minisign), the Keychain and Secret
  Service client, the LevelDB reader for the settings migration, the
  Tessie/Teslascope clients, and the small relaunch helper for the Squirrel
  update.

¹ In the experiment, one of the five Tauri reloads took 200 s. Its log showed
the Rust load itself finished in 8.1 s, so the delay was in the page, most
likely WebKit throttling a background window while other sessions used the
screen. All five reloads of the ship candidate took 9.1–9.2 s. The raw
results are in `scripts/bench/results/`.

### Where the time and memory go

- **Loading.** The Electron utility process streams the JSON token by token in
  JavaScript (`stream-json`) into SQLite, then groups drives. The Rust loader
  does the same work in about 5.5 s of indexing plus 3.6 s of grouping (2.7 s before the switch to fdlibm trig, see above). It
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
# The Tauri probe only exists in builds made with SENTRY_DRIVE_TEST_HOOKS=1.
# Build those under a test identity (see "Testing without touching real data").
node scripts/bench/bench.mjs --app tauri --bundle "<test build>.app" \
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
  - The Tauri build injects it from its bridge only when it was built with
    `SENTRY_DRIVE_TEST_HOOKS` and `SENTRY_DRIVE_BENCH_OUT` is set at run time.
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
- **Tauri build:** tauri 2.12.5, tauri-cli 2.12.4, tauri-plugin-updater 2.14.1, Rust 1.95.0, WKWebView 22625.2.8.11.9.
  - Sizes: `APPLE_SIGNING_IDENTITY="Developer ID Application: …" npx tauri build --target universal-apple-darwin`
    (universal, Developer ID signed with hardened runtime, not notarized).
  - Timings ("ship candidate" column): the same code built for arm64 under the
    test identity with `SENTRY_DRIVE_TEST_HOOKS=1`, because the production
    identity would read and write the real Sentry Drive data folder. The
    "experiment" column was a universal build; on an Apple silicon Mac both
    run the same arm64 code.
  - Release profile: `lto = true`, `codegen-units = 1`, `strip = true`.
- Other Claude sessions shared the Mac. Heavy work was taken in turns through a shared schedule, and nothing else heavy ran during either benchmark.

## Caveats

- **Different web engine.** On macOS the UI runs in WKWebView (Safari's
  engine) instead of Chromium. The in-window UI test (below) exercised every
  main screen, but no one has compared every CSS detail by eye.
- **Windows (WebView2) and Linux (WebKitGTK) are not tested.** The Windows
  `.exe` was cross-compiled once from the Mac (MinGW,
  `x86_64-pc-windows-gnu`), which proves the Windows-only code compiles. The
  NSIS installer could not be built locally: Homebrew's `makensis` 3.13
  crashes on this macOS even on a two-line script. Linux was not built: that
  needs a GTK/WebKit sysroot or a Linux machine. Both are set up in CI and
  waiting for a run.
- **Not notarized.** The local build is Developer ID signed. Gatekeeper
  rejects it only as "Unnotarized Developer ID". CI notarizes.
- **Network work at start.** Both builds check GitHub for updates at start.
  Reverse geocoding (Nominatim) is cached after the first run.
- **Index cache.** Both builds write a temporary SQLite index (about 1.4 GB
  for this file) and delete it on quit. Electron keeps it next to the
  executable (inside the app bundle on macOS) or in system temp. Tauri keeps
  it in the OS cache folder (`~/Library/Caches/com.jefffromtheirs.sentry-drive`
  on macOS).
- **Time zones.** Node 22's bundled ICU still has America/Edmonton at UTC−7,
  while macOS 27 has UTC−6, so the JS-vs-Rust parity runs pin
  `TZ=America/Denver`. The apps use the system's zone data and agree.
- **Small samples.** Five cold starts and one idle run per build, on one
  machine.

## How the port is built

- **Frontend: unchanged.** `scripts/tauri/prepare-frontend.mjs` copies
  `src/renderer` and the vendored assets into `tauri-dist/`. It drops the
  HTML's CSP `<meta>`; the same policy lives in `tauri.conf.json`.
- **Preload → `src/tauri-bridge/bridge.js`.** Installs the same
  `window.electronAPI`. Every method maps to a Rust command and every `on…`
  subscription to a Tauri event of the same name.
- **Main process + Node code → `src-tauri/src/`:**

| Electron | Rust |
|---|---|
| `drive-loader-*`, `drive-index`, `disk-drive-grouper` (utility process) | `loader/index.rs`, `loader/mod.rs`: parallel split/parse, SQLite, windowed grouping |
| `grouper.js`, `drive-calc.cjs`, `event-gap-fill`, `clip-path`, `drive-telemetry` | `loader/grouper.rs`, `loader/calc.rs` (fdlibm trig via `libm`), `loader/route.rs` |
| `charging-history.cjs`, `supercharger-catalog.cjs` | `loader/charging.rs`, `supercharger.rs` |
| `drive-data-writer.cjs`, `atomic-write.cjs` | `drive_data.rs` (streaming, section-preserving: replace / filter / edit-in-place), `fsutil.rs` |
| tags, remove drive(s), import a drive-data file, change watcher, GPS backup | `drive_edit.rs` |
| `repair-gps`, `check-summon` | `check_drives.rs`: streams the file; Summon groups from a temporary index, one time window at a time |
| `tessie-import.cjs`, `tessie-api.cjs`, `teslascope-api.cjs` and their handlers | `imports.rs`, `imports/*`: CSV, clip building, both API clients, remove all/hidden |
| `safeStorage` token files | `secrets.rs`: OS credential store, plus a one-time import of Electron's tokens |
| `process.js`, `worker.js`, `extract.js`, `clip-discovery.js` (child process) | `processing/*`: in-process threads |
| `geocode.cjs`, `known-places.cjs` | `geocode/*` |
| `logger.cjs` | `logger.rs` |
| dialogs, `shell.openExternal`, window state | `tauri-plugin-dialog`, `tauri-plugin-opener`, `migrate.rs` (Electron's `window-state.json` format) |
| `electron-updater` | `updater.rs`: `tauri-plugin-updater` + GitHub Releases |
| (first launch after the switch) | `migrate.rs`: data folder, localStorage import |

## Parity checklist

Everything Electron does is ported. "Same output" means compared against the
Electron code running in Node on the same input.

**Compared against the JavaScript on real data (the 1.08 GB `drive-data.json`)**

- [x] **Load and group:** 1,220 of 1,220 drives identical (full summary plus a
  digest of every detail), aggregates identical. `scripts/tauri/loader-parity.mjs`.
- [x] **Charging history:** sites and sessions identical.
- [x] **Check Drives, bridge gaps:** the output file is identical route by
  route, with the same 9 gaps bridged. It took 8.7 s against 79 s in Node.
  `scripts/tauri/check-drives-parity.mjs`.
- [x] **Check Drives, Summon check:** the same candidate drives (787) and the
  same clip reads. On a run that re-read 10 clips from the USB drive, the
  written file is identical. It took 23 s against 105 s.
- [x] **Bridge gaps along roads (OSRM):** a gap was bridged with a 95-point
  road route from the live OSRM server.
- [x] **Process clips:** 21 sample clips give byte-identical route lines
  (from the experiment).

**Compared against the JavaScript on fixtures** (`scripts/tauri/imports-parity.mjs`, `scripts/tauri/fixtures/imports/`)

- [x] **Tessie CSV import, Tessie API import, Teslascope API import, remove
  all, remove hidden:**
  - All 25 handler steps give the same results and progress events.
  - The HTTP requests made to a fake server match.
  - All 12 written files and their `.bak` copies are byte-identical.
- [x] **Not called with real accounts.** There are no real tokens for either
  service. The test called both live APIs with fake tokens, and each returned
  its normal "Unauthorized" message.

**Unit tests:** 63 Rust tests pass, and the existing 236 JS tests still pass.

**Exercised in the real Tauri window** (`scripts/tauri/ui-test.js`, results in `scripts/tauri/ui-test-results.ndjson`)

The test clicks the real controls and checks what the page and the file on
disk show. It stubs only the native file pickers, and records `alert()`
messages instead of opening native dialogs.

- [x] Startup auto-load of the last file, drive list and map.
- [x] Processing tab: 60 real clips → 3 drives, progress output, "Complete!".
- [x] Drive detail: select a drive, stats, map.
- [x] Replay: play moves the slider, pause stops it, scrubbing.
- [x] Tags: add in the detail panel, then remove from the list. Each change
  was checked in the file after a reload.
- [x] Check Drives → Bridge Gaps, then Revert; Check Drives → Check for Summon.
- [x] Import Drives → Tessie CSV (preview + import), and → another
  `drive-data.json` (merge + confirmation).
- [x] Remove Imported Drives (Tessie). The test then confirmed nothing
  Tessie-sourced was left in the file.
- [x] Remove one drive; remove two with multi-select.
- [x] Settings: unit switch persists; Integrations shows the connected tokens;
  token save, replace and clear.
- [x] An external change to `drive-data.json` triggers the reload.
- [x] Charging tab: sites, a site's sessions, session detail.
- [x] Changelog dialog; reverse geocoding; geocoder settings round-trip;
  Supercharger catalog refresh from Overpass (5,840 bundled stations →
  refreshed).
- [x] In-app update: check → download with progress → install → relaunch as
  the new version.
- [x] `confirm()` shows a native dialog (checked by screenshot).
- [x] Window position and size restored from `window-state.json`, and saved
  again on quit.

**Not exercised in the window** (ported, but needs a person):

- [ ] Native file and folder pickers, and the "Download logs" save dialog.
- [ ] Privacy-zone editing on the map (zones migrate and render), known-place
  renames from the drive list.
- [ ] DevTools (F12 / Ctrl+Shift+I), reload (Cmd/Ctrl+R), and the app staying
  in the Dock after its window is closed.
- [ ] Cancel in the middle of a long import or processing run.
- [ ] Imports and validation against real Tessie and Teslascope accounts.

**Bugs found and fixed while testing in the window**

- `alert()` and `confirm()` did nothing. Tauri's dialog plugin makes them
  asynchronous, and the app lacked the permission to show them. The
  permission is now granted, and the renderer's two `confirm()` calls are
  awaited. Electron is unaffected, since awaiting a boolean is a no-op.
- Quitting didn't save the window position (Tauri's close event only fires
  when the window is closed). It is now also saved about a second after each
  move or resize.

**Known behaviour differences**

- **macOS menu bar.** Tauri shows the standard app menu; Electron sets none.
- **Duplicate clip paths.** When two routes normalise to the same path, the
  Summon check updates the first one; Electron updates the last.
- **Legacy files.** Electron re-encodes every route when it rewrites the file:
  array-typed gear and autopilot bytes become base64, and malformed elements
  become `{}`. Tauri copies routes it doesn't change byte for byte. Both
  readers accept both forms.
- **Imports.** `Date.parse` of month-name strings ("Jan 5 2024") returns NaN
  in the Teslascope client. No known API response uses that form. Network
  error messages read differently from Node's.
- **Processing** (from the experiment):
  - A re-processed route moves to the end of the routes array.
  - App edits made during a run are kept.
  - Ties in clip order are broken by byte order.
- **Electron bugs ported faithfully**, listed by the import port:
  - Remove-all overwrites the `.bak` file even when nothing is removed.
  - Remove-hidden leaves `processedFiles` entries behind.
  - The CSV import always rewrites the file.
  - Teslascope's millisecond timestamps are scaled twice for pre-2001 values.
  - The fix for each belongs in both builds, so it is left for later.

## Moving existing users over

**The Tauri app is a drop-in replacement, not a separate app with an import
step.** It uses:

- the same product name, "Sentry Drive";
- the same bundle id, `com.jefffromtheirs.sentry-drive`;
- the same executable name: "Sentry Drive" (`sentry-drive` on Linux);
- the same data folder: `<config dir>/sentry-drive`, which is
  `~/Library/Application Support/sentry-drive` on macOS, `%APPDATA%\sentry-drive`
  on Windows and `~/.config/sentry-drive` on Linux.

Everything the Electron main process kept there is used as-is: logs,
`window-state.json`, the geocode cache and settings, known places, the
Supercharger catalog cache and `support-prefs.json`.

Two things lived in Chromium's own storage, and are moved once on first launch
(`migrate.rs`, `secrets.rs`):

- **Renderer settings** (last file, auto-load, units, privacy zones, map and
  marker options, beta enrolment and so on) are in Chromium's localStorage
  LevelDB. A copy of it is read with `rusty-leveldb` and replayed into the
  webview before the page's scripts run. Keys the webview already has are
  skipped, and a marker file stops it from running again.
- **API tokens** are in `tessie-token.bin` and `teslascope-token.bin`,
  encrypted by `safeStorage` (Chromium os_crypt "v10"). They are decrypted
  and moved into the OS credential store, then the files are deleted:
  - macOS: AES-128-CBC with the key from the "sentry-drive Safe Storage"
    Keychain item.
  - Windows: AES-256-GCM with the DPAPI-wrapped key in `Local State`.
  - Linux: Chromium's fixed key.

  Tokens are now stored in the macOS Keychain, Windows Credential Manager or
  Linux Secret Service. This is more secure than Electron's encrypted file
  plus a Keychain key. On Linux, tokens Electron encrypted with the desktop
  keyring ("v11") are not migrated; those users re-enter them.

Nothing else in the folder is deleted, so a user can go back to an Electron
build without losing anything.

**How Electron users get the Tauri build: their existing updater.** Every
release publishes electron-updater's feeds (`latest-mac.yml`, `latest.yml`,
`latest-linux.yml`) alongside Tauri's `latest.json`. The electron-updater
feeds point at the Tauri artifacts. No special "bridge" Electron release is
needed, and users on any older version move over in one step.

- **macOS: proven locally, end to end.** I used Developer-ID-signed builds
  under a separate test identity (`com.sentrysix.sentrydrive.migtest`), so no
  real data was involved:
  1. Installed the Electron build (v1.6.3).
  2. Seeded it with settings, a privacy zone, a Unicode key and two
     encrypted dummy tokens.
  3. Clicked through its normal check → download → install. Squirrel.Mac
     accepted the Tauri zip, because the bundle id and Developer ID team
     match its designated-requirement check.
  4. Squirrel replaced the app in place and relaunched it as Tauri v1.7.0.
  5. The Tauri log showed the tokens moved to the Keychain (no Keychain
     prompt), 9 settings imported, and 1,220 drives auto-loaded from the
     migrated last-file path.

  Two things had to be fixed for this to work:
  - **Bundle name.** Squirrel names the installed bundle after the new
    executable, so the Tauri executable must be called "Sentry Drive"
    (`mainBinaryName`).
  - **Relaunch.** Squirrel relaunches by running
    `<app>/Contents/Frameworks/Squirrel.framework/Resources/ShipIt` from the
    new bundle. The Tauri app ships a tiny signed stand-in at that path that
    only `open`s the app (`src-tauri/macos/squirrel-shim/`, built by
    `scripts/tauri/squirrel-shim.mjs`).
- **Windows: written, untested.** electron-updater runs the Tauri NSIS
  installer. Its pre-install hook (`src-tauri/windows/installer-hooks.nsh`)
  finds electron-builder's install by the GUID derived from the app id and
  runs its uninstaller silently. It uses the same `/KEEP_APP_DATA --updated`
  flags electron-builder uses when it replaces an old version, so
  `%APPDATA%\sentry-drive` is kept.
- **Linux: written, untested.** electron-updater replaces the AppImage in
  place. For `.deb` it installs the new package over the old one, which needs
  the package name to stay `sentry-drive`; CI prints the name.

## Updates and releases

- **In the app** (`updater.rs`): the renderer drives the same flow and status
  events as before (checking → available → downloading % → ready → install).
  1. The release is picked from the GitHub Releases API. This keeps the beta
     toggle and "revert to stable", and only releases that carry `latest.json`
     are offered, so Electron-only releases are skipped.
  2. `tauri-plugin-updater` downloads the platform bundle and checks its
     minisign signature against the public key built into the app.
     `requireSignedVersion` also requires the signature to name the announced
     version, which blocks downgrade tricks.
  3. Install replaces the app and relaunches. A downloaded update that isn't
     installed is installed on quit, as electron-updater did.

  **Proven locally:** v1.7.0 → v1.7.1 check, download with progress,
  signature check, install and relaunch, against a local feed.
- **Release workflow** (`.github/workflows/build.yml`, prepared locally, not
  pushed):
  - Builds on macOS (universal), Windows (NSIS) and Linux (AppImage + deb).
  - Runs the JS and Rust tests.
  - Signs and notarizes the Mac app with the existing secrets and verifies the
    result: universal binaries, Team ID, `spctl`, stapling.
  - Builds the Squirrel zip.
  - On a published release, uploads the installers, then writes and uploads
    `latest.json` and the three `latest*.yml` feeds
    (`scripts/tauri/release-feeds.mjs`). Feeds go last, so they never point at
    a file that isn't uploaded yet.
  - The updater public key comes from a repository variable, so no key is
    committed.

  `test.yml` now runs the Rust tests and a Linux `.deb` packaging smoke test
  instead of electron-builder.

## Ready to ship?

**Done and verified on this Mac**

- [x] Every Electron feature is ported; parity was checked as listed above.
- [x] Every main screen was exercised in the real Tauri window.
- [x] Drop-in identity, the data folder, and settings and token migration.
- [x] The Electron updater installs and relaunches the Tauri app (macOS, test
  identity).
- [x] The Tauri updater updates itself (macOS, local feed).
- [x] A universal production build, Developer ID signed with hardened runtime
  and a timestamp: `codesign --verify --deep --strict` passes, the designated
  requirement matches Electron's, and every Mach-O file is x86_64 + arm64.
- [x] The release workflow and feed generator are written. The feed generator
  ran against the test builds.
- [x] Benchmarks rerun (table above).

**Not verified (needs CI or another machine)**

- [ ] **Notarization.** No notarytool profile was found on this Mac, and I
  didn't go looking through the Keychain. CI notarizes with the existing App
  Store Connect API key.
- [ ] **Windows:**
  - Build the NSIS installer.
  - Check that the app runs in WebView2.
  - Check the Electron → Tauri upgrade, including the uninstall hook and that
    `%APPDATA%\sentry-drive` is kept.
  - Check token migration with DPAPI.
- [ ] **Linux:**
  - Build the AppImage and `.deb`, and check the `.deb` package name.
  - Run the app on WebKitGTK.
  - Check the Electron → Tauri upgrade for both formats.
  - Check Secret Service token storage.
- [ ] **The whole workflow.** It has never run on GitHub: action versions,
  runner images and artifact names are untested.
- [ ] **The items under "Not exercised in the window"** above, and real
  Tessie and Teslascope accounts.
- [ ] **The Squirrel update on an Intel Mac** (it was proven on Apple
  silicon).

**What Scott needs to do**

1. **Create the updater signing key** (a secret, so I didn't make it):

   ```bash
   npx tauri signer generate -w ~/.tauri/sentry-drive-updater.key
   ```

   Choose a password and back the key up somewhere safe: if it's lost,
   installed copies can never update again. Then, in the repository settings:
   - secret `TAURI_SIGNING_PRIVATE_KEY`: the contents of the `.key` file;
   - secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password;
   - **variable** (not secret) `TAURI_UPDATER_PUBKEY`: the contents of the
     `.key.pub` file.
2. **Mac signing secrets:** keep the existing ones
   (`MAC_CERTIFICATE_P12`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_API_KEY`,
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`); nothing changes.
   For local notarization, optionally store a profile once
   (`xcrun notarytool store-credentials …`) and pass the same values as
   `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` to
   `npx tauri build`.
3. **Approve pushing this branch.** Then run "Build and Release" with
   `workflow_dispatch`, and check the three artifacts.
4. **Test the upgrade on real machines** before the first release. Install
   v1.6.3 (Electron) on Windows and Linux, publish a draft or pre-release
   from this branch, and update from inside the app. On a spare Mac, do the
   same with the real identity.
5. **Pick the version number** for the first Tauri release (it must be higher
   than the newest Electron release). The workflow syncs it from the tag.
6. **Afterwards (follow-up):** remove the Electron sources and dependencies
   once no rollback is needed. The parity scripts in `scripts/tauri/` use the
   JS modules, so keep those, or freeze their outputs as fixtures first.

## Testing without touching real data

The production identity reads and writes the real data folder, so never
launch a production build on a machine whose Sentry Drive data matters. All
local tests used a test identity.

```bash
# overlay: productName/mainBinaryName "Sentry Drive Migtest",
#          identifier com.sentrysix.sentrydrive.migtest, updater pubkey, ...
SENTRY_DRIVE_ELECTRON_NAME=sentry-drive-migtest \
SENTRY_DRIVE_UPDATE_FEED=http://127.0.0.1:8765/tauri \
SENTRY_DRIVE_TEST_HOOKS=1 \
npx tauri build --target aarch64-apple-darwin --bundles app --config <overlay.json>
```

- **`SENTRY_DRIVE_ELECTRON_NAME`:** the Electron data folder and Keychain
  names. Default: `sentry-drive`.
- **`SENTRY_DRIVE_UPDATE_FEED`:** a fixed update feed.
- **`SENTRY_DRIVE_TEST_HOOKS`:** compiles in the UI-test and benchmark hooks.
  Release builds have none of these.
- **Running the UI test:**

  ```bash
  open -n -a <app> --env SENTRY_DRIVE_UI_TEST=<script> --env SENTRY_DRIVE_UI_TEST_OUT=<out.ndjson>
  ```

  `<script>` is `window.__UI_TEST__ = {clips, out, fixtures}` followed by
  `scripts/tauri/ui-test.js`.

Parity checks:

```bash
TZ=America/Denver node scripts/tauri/loader-parity.mjs dump /path/to/drive-data.json js.ndjson
TZ=America/Denver cargo run --release --manifest-path src-tauri/Cargo.toml --example loader_dump -- /path/to/drive-data.json rust.ndjson
node scripts/tauri/loader-parity.mjs compare js.ndjson rust.ndjson

# Check Drives (on copies; both rewrite the file)
TZ=America/Denver node scripts/tauri/check-drives-parity.mjs repair copy-js.json
TZ=America/Denver src-tauri/target/release/examples/check_drives_run repair copy-rs.json
node scripts/tauri/check-drives-parity.mjs digest copy-js.json js.ndjson   # and copy-rs.json
node scripts/tauri/check-drives-parity.mjs compare js.ndjson rs.ndjson

node scripts/tauri/imports-parity.mjs   # Tessie / Teslascope, on fixtures
```

## Built apps on this Mac

- **Tauri, production identity:**
  `src-tauri/target/universal-apple-darwin/release/bundle/macos/Sentry Drive.app`,
  with the DMG at `…/bundle/dmg/Sentry Drive_1.6.3_universal.dmg`. It is
  universal, Developer ID signed and not notarized. **Don't open it on this
  Mac:** it would use the real Sentry Drive data folder (see above). Install
  it on a test machine instead.
- **Electron v1.6.3** (the baseline): `dist/mac-universal/Sentry Drive.app`.
