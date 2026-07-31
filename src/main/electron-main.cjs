'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage, utilityProcess } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const v8 = require('v8');
const {
  geodesicM, GEAR_PARK, CLIP_DURATION_MS, DRIVE_GAP_MS,
  SUMMON_MAX_SPEED_MPS, SUMMON_MAX_DURATION_MS, MPS_TO_MPH,
  computeGearRuns, computeFlagRuns,
} = require('../shared/drive-calc.cjs');

let mainWindow;
let activeChild = null;
let driveLoaderClient = null;

// ─── drive-data.json reading ─────────────────────────────────────────────────
// All reads go through src/main/drive-data-reader.cjs: native JSON.parse for
// files that fit under V8's string cap (~16x faster than token streaming),
// stream-json above it. Every handler that used to JSON.parse(readFileSync())
// here would crash with ERR_STRING_TOO_LONG on >512 MiB files — the shared
// reader fixes that everywhere at once.
const { readDriveData } = require('./drive-data-reader.cjs');
const {
  readTopLevelValues,
  writeDriveDataJSON: writeDriveDataJSONShared,
} = require('./drive-data-writer.cjs');
const {
  createSuperchargerCatalog,
  matchChargingSites,
} = require('./supercharger-catalog.cjs');

let superchargerCatalog = null;
function getSuperchargerCatalog() {
  if (!superchargerCatalog) {
    superchargerCatalog = createSuperchargerCatalog({
      bundledPath: path.join(app.getAppPath(), 'assets', 'tesla-superchargers.json'),
      cachePath: path.join(app.getPath('userData'), 'catalogs', 'tesla-superchargers.json'),
    });
  }
  return superchargerCatalog;
}

// ─── Logging ─────────────────────────────────────────────────────────────────
// Terminal echo + in-memory buffer; exported from Settings → Support → Logs.
const logger = require('./logger.cjs');
const os = require('os');
logger.setAppInfo({ version: app.getVersion(), osBuild: os.release() });
// Crash-surviving sink: appended live; last session rotates to
// previous-session.log and is included in exports.
logger.initFileSink(path.join(app.getPath('userData'), 'logs'));
logger.info('main', `app starting — v${app.getVersion()} | ${process.platform} ${process.arch} (${os.release()}) | ` +
  `${os.cpus().length} CPUs | electron ${process.versions.electron} | node ${process.versions.node}`);
// API-client diagnostics flow into this log (Settings → Support → Logs).
require('../processing/teslascope-api.cjs').setLogger(logger);
require('../processing/tessie-api.cjs').setLogger?.(logger);

app.on('before-quit', () => {
  driveLoaderClient?.close().catch(() => {});
  logger.info('main', 'app quitting');
  logger.flushNow();
});
// The "app went blank / video died" class of crash — record the reason.
app.on('render-process-gone', (_e, _wc, details) => {
  logger.error('main', `renderer process gone: ${details.reason} (exit ${details.exitCode})`);
});
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU' && details.reason === 'clean-exit') return; // routine
  logger.warn('main', `${details.type} process gone: ${details.reason}`);
});

// Log instead of crash: a background hiccup (e.g. a failed async callback)
// shouldn't take down the viewer. The error is preserved in the log export.
process.on('uncaughtException', (err) => logger.error('main', 'Uncaught exception:', err));
process.on('unhandledRejection', (reason) => logger.error('main', 'Unhandled rejection:', reason));

// Renderer-side errors/warnings arrive here (see the forwarder in renderer.js).
ipcMain.on('app-log', (_e, { level, scope, text } = {}) => {
  const lv = level === 'error' || level === 'warn' ? level : 'info';
  logger[lv](typeof scope === 'string' && scope ? scope : 'renderer', String(text ?? ''));
});

// The logs save dialog remembers its own folder (persisted in userData),
// independent of the app-wide "last used directory" — which is usually the
// TeslaCam clips folder and a poor default for a log export. First use
// defaults to the system Downloads folder.
const LOGS_PREFS_FILE = () => path.join(app.getPath('userData'), 'support-prefs.json');

function loadLogsDir() {
  try {
    const { logsDir } = JSON.parse(fs.readFileSync(LOGS_PREFS_FILE(), 'utf-8'));
    if (logsDir && fs.existsSync(logsDir)) return logsDir;
  } catch { /* first use / unreadable — fall through */ }
  return app.getPath('downloads');
}

function saveLogsDir(dir) {
  try { fs.writeFileSync(LOGS_PREFS_FILE(), JSON.stringify({ logsDir: dir })); } catch {}
}

ipcMain.handle('download-logs', async () => {
  try {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(loadLogsDir(), `sentry-drive-logs-${stamp}.txt`),
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    fs.writeFileSync(filePath, logger.getLogText());
    saveLogsDir(path.dirname(filePath));
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// The drive index for a multi-GB drive-data.json is itself large, and the
// system temp folder sits on the OS drive — the one most likely to be full.
// (A full temp drive surfaces as a bare "database or disk is full" from
// SQLite mid-load.) Keep the cache next to the app instead, which is usually
// on the same roomy drive the user keeps their footage on.
//
// Falls back to the system temp folder when the app directory isn't writable:
// a machine-wide install under Program Files needs elevation, and the
// packaged app itself lives inside a read-only asar (only the surrounding
// directory is real). Writability is proven by writing, not by accessSync —
// on Windows that reports W_OK for directories the process cannot write.
function resolveLoaderCacheRoot() {
  const appDir = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
  const preferred = path.join(appDir, 'temp', 'load-cache');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return preferred;
  } catch (err) {
    const fallback = path.join(app.getPath('temp'), 'sentry-drive', 'load-cache');
    logger.warn('main', `index cache: ${preferred} not writable (${err?.code ?? err?.message}) — falling back to ${fallback}`);
    return fallback;
  }
}

// Each load builds its index in a fresh UUID directory that's removed when the
// load closes; a crash or a kill leaves one behind. Sweep them at startup so
// they can't accumulate next to the app.
function sweepStaleLoaderCaches(cacheRoot) {
  let removed = 0;
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(cacheRoot, entry.name);
      try {
        for (const f of fs.readdirSync(dir)) {
          try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* racing cleanup */ }
        }
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch { /* in use by another instance — leave it */ }
    }
  } catch { /* cache root doesn't exist yet */ }
  if (removed > 0) {
    logger.info('main', `index cache: swept ${removed} stale load dir(s), freed ${(bytes / 1048576).toFixed(0)} MB`);
  }
}

function getDriveLoaderClient() {
  if (driveLoaderClient) return driveLoaderClient;
  const { createDriveLoaderClient } = require('./drive-loader-client.cjs');
  const cacheRoot = resolveLoaderCacheRoot();
  sweepStaleLoaderCaches(cacheRoot);
  logger.info('main', `index cache root: ${cacheRoot}`);
  driveLoaderClient = createDriveLoaderClient({
    fork: utilityProcess.fork.bind(utilityProcess),
    workerPath: path.join(__dirname, 'drive-loader-worker.cjs'),
    cacheRoot,
    logger,
  });
  return driveLoaderClient;
}

// ─── Window State Persistence ────────────────────────────────────────────────
const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_WINDOW_STATE = { width: 1440, height: 900, isMaximized: false, isFullScreen: false };

function loadWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_FILE(), 'utf-8');
    return { ...DEFAULT_WINDOW_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    const isFullScreen = mainWindow.isFullScreen();
    // When maximized/fullscreen, getBounds() returns the fullscreen rect, which
    // isn't useful as a restore size. Prefer getNormalBounds() (Electron ≥ 12).
    const bounds = isMaximized || isFullScreen
      ? (mainWindow.getNormalBounds?.() ?? mainWindow.getBounds())
      : mainWindow.getBounds();
    fs.writeFileSync(
      WINDOW_STATE_FILE(),
      JSON.stringify({ ...bounds, isMaximized, isFullScreen }, null, 2),
    );
  } catch {
    // Best-effort; losing the file on next launch just reverts to defaults.
  }
}

// ─── Auto-Updater Setup ─────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateStatus(status, data = {}) {
  mainWindow?.webContents.send('update-status', { status, ...data });
}

autoUpdater.on('checking-for-update', () => { logger.info('update', 'checking for update…'); sendUpdateStatus('checking'); });
autoUpdater.on('update-available', (info) => { logger.info('update', `update available: v${info.version}`); sendUpdateStatus('available', { version: info.version }); });
autoUpdater.on('update-not-available', () => { logger.info('update', `up to date (v${app.getVersion()})`); sendUpdateStatus('up-to-date'); });
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', () => { logger.info('update', 'update downloaded — ready to install'); sendUpdateStatus('ready'); });
autoUpdater.on('error', (err) => {
  logger.error('update', 'auto-updater error:', err?.message ?? err);
  sendUpdateStatus('error', { message: err.message });
});

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1050,
    minHeight: 650,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (state.isMaximized) mainWindow.maximize();
  if (state.isFullScreen) mainWindow.setFullScreen(true);

  mainWindow.on('close', saveWindowState);
  // DevTools shortcuts (application menu is disabled, so wire them here).
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key?.toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      mainWindow.webContents.toggleDevTools();
    } else if ((input.control || input.meta) && key === 'r') {
      mainWindow.webContents.reload();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();
  // Connected integrations — presence only, never the tokens themselves.
  try {
    logger.info('import', `integrations: tessie=${loadTessieToken() ? 'yes' : 'no'} teslascope=${loadTeslascopeToken() ? 'yes' : 'no'}`);
  } catch { /* safeStorage may be unavailable — non-fatal */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('select-directory', async (_e, options) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: options?.defaultPath ?? undefined,
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('select-file', async (_e, options) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters ?? [{ name: 'JSON', extensions: ['json'] }],
    defaultPath: options?.defaultPath ?? undefined,
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('find-drive-data', async (_e, dir) => {
  const filePath = path.join(dir, 'drive-data.json');
  return fs.existsSync(filePath) ? filePath : null;
});

// Packaged builds run from inside the read-only app.asar, so a __dirname-
// relative default isn't writable — use a dedicated Documents folder instead
// (repo root in dev). Created by start-processing, not here, so merely opening
// the app never touches the user's Documents.
ipcMain.handle('get-default-output-dir', () =>
  app.isPackaged
    ? path.join(app.getPath('documents'), 'Sentry Six', 'Sentry Drive')
    : path.join(__dirname, '..', '..'));

ipcMain.handle('check-drive-data', (_e, dir) =>
  fs.existsSync(path.join(dir, 'drive-data.json'))
);

ipcMain.handle('get-cpu-count', () => require('os').cpus().length);

// Reverse geocoding for drive-list location pins. Lazy-init the disk cache on
// first use (app is ready by then), then geocode via Nominatim in the main
// process (throttled, cached, no renderer CSP involved).
let _geocodeInited = false;
ipcMain.handle('reverse-geocode', async (_e, { lat, lng } = {}) => {
  try {
    const geocode = require('../processing/geocode.cjs');
    if (!_geocodeInited) {
      geocode.init(path.join(app.getPath('userData'), 'geocode-cache.json'));
      _geocodeInited = true;
    }
    return { label: await geocode.reverseGeocode(lat, lng) };
  } catch {
    return { label: null };
  }
});

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('set-allow-prerelease', (_e, allow) => {
  autoUpdater.allowPrerelease = allow;
});

ipcMain.handle('remove-drive', (_e, { filePath, driveStartTime }) => withDriveDataLock(async () => {
  try {
    const data = await readDriveData(filePath, { wantProcessedFiles: true });
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives } = groupIntoDrives(data.routes ?? []);
    const target = drives.find((d) => d.startTime === driveStartTime);
    if (!target) return { success: false, error: 'Drive not found' };

    const removeSet = new Set(target.routeFiles.map((f) => f.replace(/\\/g, '/')));
    data.routes = (data.routes ?? []).filter((r) => !removeSet.has(r.file.replace(/\\/g, '/')));
    data.processedFiles = (data.processedFiles ?? []).filter((f) => !removeSet.has(f.replace(/\\/g, '/')));
    if (data.driveTags) delete data.driveTags[driveStartTime];

    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(filePath, data);
    logger.info('main', `removed drive at ${driveStartTime} (${target.routeFiles.length} clip(s))`);
    return { success: true };
  } catch (err) {
    logger.error('main', 'remove drive failed:', err?.message ?? err);
    return { success: false, error: err.message };
  }
}));

// Bulk removal for the drive list's multi-select: same semantics as
// remove-drive, but one read → one filter pass → one atomic write for the
// whole batch (a rewrite per drive would grind on large libraries).
ipcMain.handle('remove-drives', (_e, { filePath, driveStartTimes }) => withDriveDataLock(async () => {
  try {
    const wanted = new Set(driveStartTimes ?? []);
    if (wanted.size === 0) return { success: false, error: 'No drives given' };
    const data = await readDriveData(filePath, { wantProcessedFiles: true });
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives } = groupIntoDrives(data.routes ?? []);
    const targets = drives.filter((d) => wanted.has(d.startTime));
    if (targets.length === 0) return { success: false, error: 'Drives not found' };

    const removeSet = new Set(targets.flatMap((t) => t.routeFiles.map((f) => f.replace(/\\/g, '/'))));
    data.routes = (data.routes ?? []).filter((r) => !removeSet.has(r.file.replace(/\\/g, '/')));
    data.processedFiles = (data.processedFiles ?? []).filter((f) => !removeSet.has(f.replace(/\\/g, '/')));
    if (data.driveTags) for (const t of targets) delete data.driveTags[t.startTime];

    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(filePath, data);
    logger.info('main', `removed ${targets.length} drive(s) (${removeSet.size} clip(s)) via multi-select`);
    return { success: true, removed: targets.length };
  } catch (err) {
    logger.error('main', 'remove drives failed:', err?.message ?? err);
    return { success: false, error: err.message };
  }
}));

ipcMain.handle('revert-to-stable', () => {
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = true;
  return autoUpdater.checkForUpdates().catch(() => {});
});

ipcMain.handle('check-for-update', () => {
  // Unpacked dev runs: electron-updater silently skips the check without
  // emitting any event, which left the button looking dead. Answer explicitly.
  if (!app.isPackaged) {
    sendUpdateStatus('error', { message: 'Update checks only work in the installed app.' });
    return;
  }
  return autoUpdater.checkForUpdates().catch((err) => {
    // autoUpdater normally emits 'error' itself — this is the safety net so
    // the renderer always gets an answer (its UI handles duplicates fine).
    sendUpdateStatus('error', { message: err?.message });
  });
});

ipcMain.handle('download-update', () => autoUpdater.downloadUpdate().catch(() => {}));

ipcMain.handle('install-update', () => autoUpdater.quitAndInstall(false, true));

ipcMain.handle('fetch-remote-changelog', () => {
  const url = 'https://raw.githubusercontent.com/Sentry-Six/Sentry-Drive/main/changelog.json';
  return new Promise((resolve) => {
    const req = require('https').get(
      url,
      { timeout: 5000, headers: { 'User-Agent': 'Sentry-Drive' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve({ success: false, status: res.statusCode }); return; }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ success: true, versions: json.versions ?? [] });
          } catch (err) { resolve({ success: false, error: err.message }); }
        });
      }
    );
    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
  });
});

ipcMain.handle('get-changelog', () => {
  try {
    const filePath = path.join(app.getAppPath(), 'changelog.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { success: true, versions: data.versions ?? [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Serialize loads because each one replaces the utility process's disposable
// disk index. A second load waits for the first, then re-reads fresh state.
let driveLoadChain = Promise.resolve();
function withDriveLoadLock(fn) {
  const result = driveLoadChain.then(fn, fn);
  driveLoadChain = result.then(() => {}, () => {});
  return result;
}

// Bumped on every completed load. Summary/detail requests carry this generation
// so a reload can never serve data for a same-numbered drive from another file.
let driveDetailGen = 0;

ipcMain.handle('load-and-group-drives', (_e, filePath) => withDriveLoadLock(async () => {
  try {
    const loaderResult = await getDriveLoaderClient().load(filePath, (progress) => {
      mainWindow?.webContents.send('load-progress', progress);
    });
    driveDetailGen++;
    logger.info('main', `loaded ${loaderResult.totalDriveCount} drive(s) from ${loaderResult.totalRoutes} clips — ${filePath}`);
    return { ...loaderResult, cacheGen: driveDetailGen };

    /* Legacy in-main loader retained below temporarily while the disk-backed
       loader is exercised; unreachable by design. */
    const sendProgress = (phase, current, total) => {
      mainWindow?.webContents.send('load-progress', { phase, current, total });
    };

    const parsed = await readDriveData(filePath, {
      onProgress: (current, total) => sendProgress('reading', current, total),
    });
    const totalRoutes = parsed.routes.length;
    const processedFileCount = parsed.processedFileCount;
    const driveTags = parsed.driveTags ?? {};

    sendProgress('grouping', 0, 0);
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives: groupedDrives, timeGroupCount, routeCount, droppedCount } = groupIntoDrives(parsed.routes);
    // groupedDrives owns fresh point arrays and doesn't reference the input,
    // so release the raw clip array now to free hundreds of MB.
    parsed.routes = null;
    sendProgress('preparing', 0, 0);

    // SEI always wins: any imported (Tessie / Teslascope) drive whose time
    // window overlaps a real dashcam drive is hidden at load time. The imported
    // clips remain in drive-data.json so the user can recover them by removing
    // SEI later; they're just filtered out of the displayed drive list.
    const seiRanges = [];
    for (const d of groupedDrives) {
      if (d.source !== 'sei' || !d.startTime || !d.endTime) continue;
      const s = Date.parse(d.startTime);
      const e = Date.parse(d.endTime);
      if (Number.isFinite(s) && Number.isFinite(e)) seiRanges.push({ s, e });
    }
    seiRanges.sort((a, b) => a.s - b.s);

    let hiddenTessieCount = 0;
    const hiddenTessieDrives = [];
    const drives = [];
    for (const d of groupedDrives) {
      if (d.source !== 'sei') {
        const s = Date.parse(d.startTime);
        const e = Date.parse(d.endTime);
        let overlapsSEI = false;
        for (const r of seiRanges) {
          if (r.e <= s) continue;   // SEI ends at-or-before Tessie starts → no overlap
          if (r.s >= e) break;       // SEI starts at-or-after Tessie ends → no overlap
          overlapsSEI = true;
          break;
        }
        if (overlapsSEI) {
          hiddenTessieCount++;
          hiddenTessieDrives.push({
            startTime: d.startTime,
            endTime: d.endTime,
            distanceMi: d.distanceMi,
          });
          continue;
        }
      }
      drives.push(d);
    }

    // Attach tags to drives
    for (const d of drives) {
      d.tags = driveTags[d.startTime] ?? [];
    }

    // Cache full drive detail in the main process; strip large point arrays from
    // the IPC payload so we don't serialize millions of GPS coordinates over the
    // context bridge (the main cause of the V8 heap OOM on large files).
    // Each cache entry is stored as a v8.serialize() Buffer rather than the
    // live object graph: one contiguous native buffer per drive instead of
    // millions of small point arrays resident for the whole session. It
    // deserializes to the exact same structure in get-drive-detail.
    // Build into a local map and swap in only when complete — a load that
    // dies mid-loop (e.g. OOM during serialize) must not leave a new
    // generation with a partial cache while the old, valid one is gone.
    const newCache = new Map();
    for (const d of drives) {
      // Bridge routes are the synthetic `-front-bridge.mp4` entries Check
      // Drives writes into GPS gaps — flag drives containing one so the UI
      // can show which drives were bridged.
      d.bridged = (d.routeFiles ?? []).some((f) => f.includes('-front-bridge.mp4'));
      newCache.set(d.id, v8.serialize({
        points: d.points,
        fsdStates: d.fsdStates,
        gearStates: d.gearStates,
        fsdEvents: d.fsdEvents,
      }));
      // 120 pts is visually identical at overview zooms and cuts both the IPC
      // payload and the canvas point count ~40% vs the old 200.
      d.overviewPoints = downsampleForIPC(d.points, 120);
      delete d.points;
      delete d.fsdStates;
      delete d.gearStates;
      delete d.fsdEvents;
      // Fields the renderer never reads — verified against renderer.js. The
      // biggest is routeFiles (one path string per clip); dropping them cuts
      // IPC serialization and renderer residency without any UI change.
      delete d.routeFiles;
      delete d.clipCount;
      delete d.pointCount;
      delete d.avgSpeedKmh;
      delete d.maxSpeedKmh;
      delete d.autosteerEngagedMs;
      delete d.taccEngagedMs;
      delete d.externalSignature;
      delete d.tessieAutopilotPercent;
    }

    driveDetailCache = newCache;
    driveDetailGen++;

    logger.info('main', `loaded ${drives.length} drive(s) from ${totalRoutes} clips` +
      `${hiddenTessieCount > 0 ? `, ${hiddenTessieCount} imported hidden behind dashcam drives` : ''} — ${filePath}`);
    return {
      success: true,
      drives,
      driveTags,
      totalRoutes,
      processedFileCount,
      timeGroupCount,
      routeCount,
      droppedCount,
      hiddenTessieCount,
      hiddenTessieDrives,
      cacheGen: driveDetailGen,
    };
  } catch (err) {
    logger.error('main', 'load drives failed:', err?.message ?? err);
    return { success: false, error: err.message };
  }
}));

ipcMain.handle('list-drive-summaries', async (_e, query) => {
  try {
    if (query?.gen != null && query.gen !== driveDetailGen) {
      return { success: false, error: 'Drive list was reloaded', code: 'STALE_DRIVE_DATA' };
    }
    return { success: true, ...(await getDriveLoaderClient().list(query ?? {})) };
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('get-drive-detail', async (_e, arg) => {
  try {
    const driveId = (arg && typeof arg === 'object') ? arg.driveId : arg;
    const gen = (arg && typeof arg === 'object') ? arg.gen : null;
    if (gen != null && gen !== driveDetailGen) {
      return { success: false, error: 'Drive list was reloaded', code: 'STALE_DRIVE_DATA' };
    }
    const detail = await getDriveLoaderClient().detail(driveId);
    return detail ? { success: true, ...detail } : { success: false, error: 'Drive not found' };
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }
});

function staleDriveData(gen) {
  return gen != null && gen !== driveDetailGen;
}

ipcMain.handle('list-charging-sites', async (_e, { gen } = {}) => {
  try {
    if (staleDriveData(gen)) {
      return { success: false, error: 'Drive data was reloaded', code: 'STALE_DRIVE_DATA' };
    }
    const sites = await getDriveLoaderClient().listChargingSites();
    return {
      success: true,
      sites: matchChargingSites(sites, getSuperchargerCatalog().getCatalog()),
      catalog: getSuperchargerCatalog().getStatus(),
    };
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('list-charging-sessions', async (_e, { gen, siteId } = {}) => {
  try {
    if (staleDriveData(gen)) {
      return { success: false, error: 'Drive data was reloaded', code: 'STALE_DRIVE_DATA' };
    }
    return {
      success: true,
      sessions: await getDriveLoaderClient().listChargingSessions(siteId),
    };
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('get-charging-session', async (_e, { gen, sessionId } = {}) => {
  try {
    if (staleDriveData(gen)) {
      return { success: false, error: 'Drive data was reloaded', code: 'STALE_DRIVE_DATA' };
    }
    const session = await getDriveLoaderClient().getChargingSession(sessionId);
    return session
      ? { success: true, ...session }
      : { success: false, error: 'Charging session not found' };
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('get-supercharger-catalog-status', () => {
  try {
    return { success: true, ...getSuperchargerCatalog().getStatus() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('refresh-supercharger-catalog', async () => {
  try {
    return await getSuperchargerCatalog().refresh();
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-processing', async (_e, { clipsDir, outputDir, workerCount, reprocessAll }) => {
  if (activeChild) return { success: false, error: 'Processing already running' };

  const scriptPath = path.join(__dirname, '..', 'processing', 'process.js');
  const outputPath = path.join(outputDir, 'drive-data.json');

  // The default output dir under Documents doesn't exist until first use, and
  // an uncreatable path (read-only asar, dead drive letter) would otherwise
  // only surface at the end of the run as a cryptic ENOENT from the atomic
  // writer's temp-file open. Create it now and fail fast if we can't.
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    logger.error('processing', `output dir not usable: ${outputDir} — ${err.message}`);
    return { success: false, error: `Cannot create output folder "${outputDir}": ${err.message}` };
  }

  const args = [scriptPath, clipsDir, outputPath];
  if (workerCount && workerCount > 0) args.push(String(workerCount));
  if (reprocessAll) args.push('--reprocess-all');

  // Keep a local handle: the close/error callbacks below fire after this run
  // may already have been stopped (and a NEW run started). Guarding on
  // `activeChild === child` keeps a dying child from clobbering the new run's
  // reference or sending it a spurious 'done'.
  let child;
  try {
    child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (err) {
    logger.error('processing', 'spawn failed:', err.message);
    return { success: false, error: `spawn failed: ${err.message}` };
  }
  activeChild = child;

  logger.info('processing', `${reprocessAll ? 'reprocess-all' : 'process new'} started — workers=${workerCount || 'auto'}, clips=${clipsDir}`);
  child.stderr?.on('data', (chunk) => logger.error('processing', String(chunk).trim()));
  child.on('exit', (code) => logger.info('processing', `child exited with code ${code}`));

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    mainWindow?.webContents.send('processing-output', { type: 'stdout', text });
    // Lift the child's one-line outcome summary into the app log timeline.
    for (const line of text.split('\n')) {
      if (line.startsWith('SUMMARY:')) logger.info('processing', line.slice(8).trim());
    }
  });

  child.stderr.on('data', (chunk) => {
    mainWindow?.webContents.send('processing-output', { type: 'stderr', text: chunk.toString() });
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      const wasCurrent = activeChild === child;
      if (wasCurrent) activeChild = null;
      // A user Stop already painted its own final state in the renderer —
      // sending 'done' with the SIGTERM exit code would overwrite a clean
      // "Stopped" with a spurious error line.
      if (wasCurrent && !child.userStopped) {
        mainWindow?.webContents.send('processing-output', { type: 'done', code });
      }
      resolve({ success: true, exitCode: code });
    });
    child.on('error', (err) => {
      const wasCurrent = activeChild === child;
      if (wasCurrent) activeChild = null;
      if (wasCurrent && !child.userStopped) {
        mainWindow?.webContents.send('processing-output', { type: 'error', text: err.message });
      }
      resolve({ success: false, error: err.message });
    });
  });
});

ipcMain.handle('stop-processing', () => {
  if (!activeChild) return { success: false, error: 'No process running' };
  const child = activeChild;
  child.userStopped = true; // suppress the close handler's 'done' — the renderer paints "Stopped" itself
  child.kill('SIGTERM');
  // Hold activeChild until the child actually exits so a quick Start can't
  // spawn a second run alongside the dying one ('start-processing' refuses
  // while activeChild is set). If the child ignores SIGTERM, escalate to
  // SIGKILL after 5s — never release the slot while the old process could
  // still be writing the output file; SIGKILL can't be ignored, so 'close'
  // always arrives.
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 5000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve({ success: true });
    });
  });
});

// ─── drive-data.json wire format ─────────────────────────────────────────────
// gearStates / autopilotStates are written as base64 strings to match
// Sentry-USB's []uint8 JSON encoding. Codec lives in the ESM grouper module;
// memoize the dynamic import so we pay it once per process.
let _byteFieldCodec;
async function getByteFieldCodec() {
  if (!_byteFieldCodec) {
    const mod = await import('../processing/grouper.js');
    _byteFieldCodec = { encode: mod.encodeByteField, decode: mod.decodeByteField };
  }
  return _byteFieldCodec;
}

async function routesToWireFormat(routes) {
  if (!Array.isArray(routes)) return routes;
  const { encode } = await getByteFieldCodec();
  return routes.map((r) => ({
    ...r,
    autopilotStates: encode(r.autopilotStates),
    gearStates: encode(r.gearStates),
  }));
}

// Stream-write the full drive-data.json so large files don't blow past
// V8's max string length (~512MB) during JSON.stringify. The routes array
// is emitted route-by-route; top-level maps/arrays use a normal stringify.
// Serialize drive-data.json read-modify-write operations so concurrent edits
// (e.g. rapid tag changes via the optimistic UI) can't race or lose updates.
let driveDataLock = Promise.resolve();
function withDriveDataLock(fn) {
  const result = driveDataLock.then(fn, fn);
  driveDataLock = result.then(() => {}, () => {});
  return result;
}

// Rename with retries — on Windows EPERM/EBUSY occurs while a reader holds the
// destination open. A streaming read of a large drive-data.json can hold it
// for several seconds, so back off exponentially (≈11s total) rather than
// giving up after a few fixed 40ms beats and failing the write.
// Merge freshly imported clips into drive-data.json under the write lock.
// The API imports fetch for minutes; merging against a re-read of the file
// (rather than the snapshot taken before the fetch) keeps writes made in the
// meantime — tag edits, drive removals — from being clobbered.
// onProgress (optional) receives {phase, current, total} so the importer's
// progress bar keeps moving through the otherwise-silent save — reading the
// current file, then encoding + writing it back can take several seconds on a
// large drive-data.json and used to look like a freeze.
// tagsToMerge (optional): a driveTags map { startTime: [tag…] } to fold into the
// file's driveTags (union with any existing) — used by the drive-data.json
// import to bring the imported drives' tags along.
function saveImportedClips(filePath, clips, onProgress, tagsToMerge) {
  logger.info('import', `saving ${clips.length} imported clip(s) → ${filePath}`);
  return withDriveDataLock(async () => {
    let data;
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak'); // pre-import restore point
      data = await readDriveData(filePath, {
        wantProcessedFiles: true,
        onProgress: onProgress
          ? (current, total) => onProgress({ phase: 'Saving — reading current data…', current, total })
          : undefined,
      });
    } else {
      data = { routes: [], processedFiles: [], driveTags: {} };
    }
    if (!Array.isArray(data.routes)) data.routes = [];
    if (!Array.isArray(data.processedFiles)) data.processedFiles = [];
    for (const clip of clips) {
      data.routes.push(clip);
      data.processedFiles.push(clip.file);
    }
    if (tagsToMerge && typeof tagsToMerge === 'object') {
      if (!data.driveTags || typeof data.driveTags !== 'object') data.driveTags = {};
      for (const [key, tags] of Object.entries(tagsToMerge)) {
        if (!Array.isArray(tags) || tags.length === 0) continue;
        const merged = new Set(data.driveTags[key] ?? []);
        for (const t of tags) merged.add(t);
        data.driveTags[key] = [...merged];
      }
    }
    if (onProgress) onProgress({ phase: 'Saving — writing drive data…', current: 0, total: 0 });
    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(filePath, data);
  });
}

function writeDriveDataJSON(filePath, data, options = {}) {
  return writeDriveDataJSONShared(filePath, data, {
    ...options,
    onRenamed: noteOwnWrite,
  });
}

// ─── External drive-data change watcher ──────────────────────────────────────
// drive-data.json is a shared file: Sentry USB (Rusty) re-exports it and our
// own processing writes it. Poll the loaded file's mtime+size and tell the
// renderer when it changes underneath us, so the app auto-refreshes. We POLL
// rather than fs.watch because this file usually lives on a network share,
// where fs.watch is unreliable over SMB. Our own writes (imports/tags/removes)
// call noteOwnWrite so the poll doesn't flag them as external (no reload loop).
let _watchedPath = null;
let _watchSig = null;   // last seen { mtimeMs, size }
let _watchTimer = null;

function driveDataSig(p) {
  try { const st = fs.statSync(p); return { mtimeMs: st.mtimeMs, size: st.size }; }
  catch { return null; }
}

function noteOwnWrite(filePath) {
  // Re-baseline after the app writes the file so the next poll sees no change.
  if (filePath && filePath === _watchedPath) _watchSig = driveDataSig(filePath);
}

ipcMain.handle('watch-drive-data', (_e, filePath) => {
  _watchedPath = filePath || null;
  _watchSig = _watchedPath ? driveDataSig(_watchedPath) : null;
  if (!_watchTimer && _watchedPath) {
    _watchTimer = setInterval(() => {
      if (!_watchedPath || !mainWindow || mainWindow.isDestroyed()) return;
      const cur = driveDataSig(_watchedPath);
      if (!cur) return;                 // file briefly missing (mid-rename) — ignore
      if (!_watchSig) { _watchSig = cur; return; }
      if (cur.mtimeMs !== _watchSig.mtimeMs || cur.size !== _watchSig.size) {
        _watchSig = cur;
        mainWindow.webContents.send('drive-data-changed', { filePath: _watchedPath });
      }
    }, 3000);
    if (_watchTimer.unref) _watchTimer.unref();
  }
  return { success: true };
});

async function decodeRoutesByteFields(routes) {
  if (!Array.isArray(routes)) return routes;
  const { decode } = await getByteFieldCodec();
  return routes.map((r) => ({
    ...r,
    autopilotStates: decode(r.autopilotStates),
    gearStates: decode(r.gearStates),
  }));
}

// ─── Drive Tags ──────────────────────────────────────────────────────────────

ipcMain.handle('set-drive-tags', (_e, { filePath, driveKey, tags }) => withDriveDataLock(async () => {
  try {
    const selected = await readTopLevelValues(filePath, ['driveTags']);
    const driveTags = selected.values.driveTags
      && typeof selected.values.driveTags === 'object'
      && !Array.isArray(selected.values.driveTags)
      ? selected.values.driveTags
      : {};

    if (tags.length === 0) {
      delete driveTags[driveKey];
    } else {
      driveTags[driveKey] = tags;
    }

    await writeDriveDataJSON(filePath, { driveTags }, {
      sourceSections: selected.sections,
    });
    // Keep the loaded index's tag column in step so tag FILTERING reflects
    // the edit immediately — without this, a drive tagged mid-session
    // wouldn't appear under that tag's filter until the next load.
    try {
      await getDriveLoaderClient().setTags(driveKey, tags);
    } catch (err) {
      logger.warn('main', `tag filter index not updated for ${driveKey}: ${err?.message ?? err}`);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}));

ipcMain.handle('revert-gps', (_e, filePath) => {
  try {
    const bakPath = filePath + '.bak';
    if (!fs.existsSync(bakPath)) return { success: false, error: 'No backup file found.' };
    fs.copyFileSync(bakPath, filePath);
    logger.info('main', `reverted drive data from backup — ${filePath}`);
    return { success: true };
  } catch (err) {
    logger.error('main', 'revert failed:', err?.message ?? err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('has-gps-backup', (_e, filePath) => {
  return fs.existsSync(filePath + '.bak');
});

ipcMain.handle('check-online', async () => {
  try {
    await new Promise((resolve, reject) => {
      const req = require('https').get('https://router.project-osrm.org/health', { timeout: 5000 }, (res) => {
        res.resume(); // drain — only the status matters; an unread body pins the socket
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    return true;
  } catch {
    return false;
  }
});

async function fetchOSRMRoute(startLat, startLng, endLat, endLng) {
  const url = `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
  return new Promise((resolve, reject) => {
    require('https').get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 'Ok' && json.routes && json.routes.length > 0) {
            const coords = json.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
            resolve(coords);
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

function sendRepairProgress(phase, current, total, etaSec) {
  mainWindow?.webContents.send('repair-progress', { phase, current, total, etaSec });
}

ipcMain.handle('repair-gps', (_e, { filePath, useRouting }) => withDriveDataLock(async () => {
  try {
    sendRepairProgress('Reading…', 0, 1);
    fs.copyFileSync(filePath, filePath + '.bak');
    const data = await readDriveData(filePath, { wantProcessedFiles: true });
    let routes = await decodeRoutesByteFields(data.routes ?? []);
    let bridgedGaps = 0;
    let routedGaps = 0;

    // geodesicM is imported at module scope from ../shared/drive-calc.cjs.

    const FILE_TS_RE = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/;
    const parseTs = (file) => {
      const m = FILE_TS_RE.exec(file);
      if (!m) return null;
      const t = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
      return isNaN(t.getTime()) ? null : t;
    };

    // --- Phase 0: Remove existing bridge routes so they can be re-bridged ---
    const beforeCount = routes.length;
    routes = routes.filter((r) => !r.file.includes('-front-bridge.mp4'));
    data.routes = routes;
    if (data.processedFiles) {
      data.processedFiles = data.processedFiles.filter((f) => !f.includes('-front-bridge.mp4'));
    }
    const removedBridges = beforeCount - routes.length;

    // --- Bridge gaps ---
    // Only bridge gaps > 60s (normal clip boundaries are ~60s and don't need bridging)
    const MIN_BRIDGE_MS = CLIP_DURATION_MS; // clip boundaries (~60s) don't need bridging
    const MAX_BRIDGE_MS = DRIVE_GAP_MS;     // gaps beyond the drive split aren't one drive
    const timedRoutes = routes
      .map((r, idx) => ({ idx, ts: parseTs(r.file), route: r }))
      .filter((r) => r.ts !== null)
      .sort((a, b) => a.ts - b.ts);

    // First pass: quickly identify gaps that need bridging
    sendRepairProgress('Scanning for gaps…', 0, 1);
    const gaps = [];
    for (let i = 0; i < timedRoutes.length - 1; i++) {
      const cur = timedRoutes[i];
      const next = timedRoutes[i + 1];
      const curR = cur.route;
      const nextR = next.route;

      const curEnd = new Date(cur.ts.getTime() + CLIP_DURATION_MS);
      const gapMs = next.ts - curEnd;
      if (gapMs <= MIN_BRIDGE_MS || gapMs > MAX_BRIDGE_MS) continue;
      if (!curR.points || curR.points.length === 0) continue;
      if (!nextR.points || nextR.points.length === 0) continue;

      const curLastGear = curR.gearRuns && curR.gearRuns.length > 0
        ? curR.gearRuns[curR.gearRuns.length - 1].gear
        : (curR.gearStates && curR.gearStates.length > 0 ? curR.gearStates[curR.gearStates.length - 1] : null);
      const nextFirstGear = nextR.gearRuns && nextR.gearRuns.length > 0
        ? nextR.gearRuns[0].gear
        : (nextR.gearStates && nextR.gearStates.length > 0 ? nextR.gearStates[0] : null);

      if (curLastGear === GEAR_PARK || nextFirstGear === GEAR_PARK) continue;
      if (curR.date !== nextR.date) continue;

      gaps.push({
        lastPt: curR.points[curR.points.length - 1],
        firstPt: nextR.points[0],
        curEnd,
        gapMs,
        curLastGear,
        date: curR.date,
      });
    }

    // Second pass: bridge each gap with progress
    const bridgeRoutes = [];
    const bridgeStartMs = Date.now();
    for (let g = 0; g < gaps.length; g++) {
      const elapsedMs = Date.now() - bridgeStartMs;
      const etaSec = g > 0 ? Math.round((elapsedMs / g) * (gaps.length - g) / 1000) : 0;
      sendRepairProgress('Bridging…', g + 1, gaps.length, etaSec);
      const { lastPt, firstPt, curEnd, gapMs, curLastGear, date } = gaps[g];

      let interpPoints;

      // Try OSRM routing if online
      if (useRouting) {
        try {
          const routed = await fetchOSRMRoute(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);
          if (routed && routed.length >= 2) {
            interpPoints = routed;
            routedGaps++;
          }
        } catch {
          // Fall back to straight line
        }
      }

      // Fallback: straight-line interpolation
      if (!interpPoints) {
        const nSteps = Math.max(2, Math.round(gapMs / 1000));
        interpPoints = [];
        for (let s = 1; s < nSteps; s++) {
          const t = s / nSteps;
          interpPoints.push([
            lastPt[0] + (firstPt[0] - lastPt[0]) * t,
            lastPt[1] + (firstPt[1] - lastPt[1]) * t,
          ]);
        }
      }

      const nPts = interpPoints.length;
      const distM = geodesicM(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);
      const avgSpeed = distM / (gapMs / 1000);

      const bridgeTs = new Date(curEnd.getTime());
      const pad = (n) => String(n).padStart(2, '0');
      const synthFile = `${date}/${date}_${pad(bridgeTs.getHours())}-${pad(bridgeTs.getMinutes())}-${pad(bridgeTs.getSeconds())}-front-bridge.mp4`;

      bridgeRoutes.push({
        file: synthFile,
        date,
        points: interpPoints,
        gearStates: new Array(nPts).fill(curLastGear ?? 1),
        autopilotStates: new Array(nPts).fill(0),
        speeds: new Array(nPts).fill(avgSpeed),
        accelPositions: new Array(nPts).fill(0),
        rawParkCount: 0,
        rawFrameCount: nPts,
        gearRuns: [{ gear: curLastGear ?? 1, frames: nPts }],
      });
      bridgedGaps++;
    }

    for (const br of bridgeRoutes) {
      routes.push(br);
      if (!data.processedFiles) data.processedFiles = [];
      data.processedFiles.push(br.file);
    }

    data.routes = await routesToWireFormat(routes);
    await writeDriveDataJSON(filePath, data);
    logger.info('gps', `check drives: ${bridgedGaps} gap(s) bridged (${routedGaps} via routing), ${removedBridges} old bridge(s) rebuilt`);
    return { success: true, bridgedGaps, routedGaps, removedBridges };
  } catch (err) {
    logger.error('gps', 'check drives failed:', err?.message ?? err);
    return { success: false, error: err.message };
  }
}));

// ─── Check for Summon ────────────────────────────────────────────────────────

// Resolve a route's relative clip path against the clips directory. Route
// paths come in two shapes — Drive-processed "2026-07-15/x-front.mp4" and
// Rusty-written "RecentClips/2026-07-15/x-front.mp4" — and the clips dir may
// or may not itself end in RecentClips. Try the plausible joins; first hit wins.
function resolveClipPath(clipsDir, normFile) {
  if (!clipsDir) return null;
  const cands = [path.join(clipsDir, normFile)];
  if (/^RecentClips\//i.test(normFile)) {
    cands.push(path.join(clipsDir, normFile.replace(/^RecentClips\//i, '')));
  } else if (path.basename(clipsDir).toLowerCase() !== 'recentclips') {
    cands.push(path.join(clipsDir, 'RecentClips', normFile));
  }
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* unreadable share — treat as missing */ }
  }
  return null;
}

// Backfill SEI blinker/brake evidence (flagRuns) so the next grouping can tag
// summon drives — the cheap alternative to reprocess-all for libraries
// processed before flags existed (including Rusty-written files).
//
// Candidates come from two places:
//  1. Whole drives inside the summon speed/duration envelope (an isolated
//     summon that already grouped as its own tiny drive).
//  2. The LOW-SPEED EDGE CLIPS of every dashcam drive. A summon fused onto a
//     following drive hides at its head (verified live: Rusty's route for a
//     summon-end clip missed the trailing Park run, so the park splitter
//     never separated the summon from the hour of driving after it — the
//     merged drive fails the envelope and would never be re-read). Summon can
//     only sit at a drive's edges (it is always bracketed by Park), so edge
//     clips at parking-lot speed are the complete hiding set.
//
// Re-extraction refreshes gearRuns/rawFrameCount/rawParkCount alongside
// flagRuns: frame-accurate gear evidence is what lets the splitter isolate a
// fused summon in the first place.
ipcMain.handle('check-summon', (_e, { filePath, clipsDir }) => withDriveDataLock(async () => {
  try {
    sendRepairProgress('Reading…', 0, 1);
    fs.copyFileSync(filePath, filePath + '.bak');
    const data = await readDriveData(filePath, { wantProcessedFiles: true });
    const routes = await decodeRoutesByteFields(data.routes ?? []);

    const routeByFile = new Map();
    for (const r of routes) routeByFile.set(String(r.file).replace(/\\/g, '/'), r);

    sendRepairProgress('Scanning drives…', 0, 1);
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives } = groupIntoDrives(routes);

    const maxMph = SUMMON_MAX_SPEED_MPS * MPS_TO_MPH + 0.01; // r2 rounding guard
    const MAX_EDGE_CLIPS = 10; // summon duration cap is 10 min = 10 minute-clips

    const routeIsSlow = (norm) => {
      const route = routeByFile.get(norm);
      if (!route || !Array.isArray(route.speeds) || route.speeds.length === 0) return false;
      for (const s of route.speeds) {
        if (Math.abs(s) > SUMMON_MAX_SPEED_MPS) return false;
      }
      return true;
    };

    // Unique clips worth re-reading, keyed by normalized path. Evidence is
    // current only when every run carries per-run speed (maxMps) — earlier
    // extractions lacked it and their drives can fail the speed gate on
    // point-slice pollution, so they get one upgrade re-read.
    const hasCurrentEvidence = (route) =>
      Array.isArray(route.flagRuns) && route.flagRuns.length > 0 &&
      route.flagRuns.every((run) => Number.isFinite(run.maxMps));
    const pending = new Map();
    const addClip = (f) => {
      const norm = String(f).replace(/\\/g, '/');
      if (norm.includes('-front-bridge.mp4')) return; // synthetic — no MP4 on disk
      const route = routeByFile.get(norm);
      if (route && !hasCurrentEvidence(route)) {
        pending.set(norm, route);
      }
    };

    let candidateDrives = 0;
    for (const d of drives) {
      if ((d.source ?? 'sei') !== 'sei' || d.summon) continue;
      const files = d.routeFiles ?? [];
      if (files.length === 0) continue;

      // No lower speed bound: reverse-only summons report NEGATIVE SEI
      // speeds, which the display stat ignores — such drives show 0 mph.
      const wholeDrive =
        (d.maxSpeedMph ?? 0) <= maxMph &&
        (d.durationMs ?? 0) <= SUMMON_MAX_DURATION_MS;
      if (wholeDrive) {
        candidateDrives++;
        for (const f of files) addClip(f);
        continue;
      }

      // Low-speed head and tail of a faster drive (fused-summon case). The
      // slow run PLUS ONE boundary clip each way: a summon that ends seconds
      // before the human drives off shares its final clip with fast driving
      // (verified live, 2026-07-27 20:04) — that mixed clip holds the end
      // bookend and the park run that lets the splitter isolate the summon,
      // so a scan that stops at the first fast clip can never free it.
      let took = false;
      for (let i = 0; i < Math.min(files.length, MAX_EDGE_CLIPS); i++) {
        const norm = String(files[i]).replace(/\\/g, '/');
        if (!routeIsSlow(norm)) {
          if (took) addClip(files[i]); // boundary clip after the slow run
          break;
        }
        addClip(files[i]);
        took = true;
      }
      let tookTail = false;
      for (let i = 0; i < Math.min(files.length, MAX_EDGE_CLIPS); i++) {
        const norm = String(files[files.length - 1 - i]).replace(/\\/g, '/');
        if (!routeIsSlow(norm)) {
          if (tookTail) addClip(files[files.length - 1 - i]); // boundary before the slow tail
          break;
        }
        addClip(files[files.length - 1 - i]);
        tookTail = true;
      }
      if (took || tookTail) candidateDrives++;
    }

    const { extractGPSFromFile } = await import('../processing/extract.js');
    const entries = [...pending.entries()];
    let scanned = 0, updated = 0, missing = 0;
    const startMs = Date.now();
    for (let i = 0; i < entries.length; i++) {
      const [norm, route] = entries[i];
      const etaSec = i > 0
        ? Math.round(((Date.now() - startMs) / i) * (entries.length - i) / 1000)
        : 0;
      sendRepairProgress('Reading clips…', i + 1, entries.length, etaSec);
      const fullPath = resolveClipPath(clipsDir, norm);
      if (!fullPath) { missing++; continue; }
      try {
        const extracted = await extractGPSFromFile(fullPath);
        scanned++;
        if (extracted && extracted.flags && extracted.flags.length > 0) {
          route.flagRuns = computeFlagRuns(extracted.flags, extracted.speeds);
          // Authoritative gear evidence from the same frames. Rusty-written
          // routes can miss short trailing Park runs; without them the park
          // splitter can't isolate a summon from the drive that follows.
          route.gearRuns = computeGearRuns(extracted.gears);
          route.rawFrameCount = extracted.gears.length;
          let parkCount = 0;
          for (const g of extracted.gears) if (g === GEAR_PARK) parkCount++;
          route.rawParkCount = parkCount;
          updated++;
        }
      } catch {
        missing++;
      }
    }

    if (updated > 0) {
      sendRepairProgress('Saving…', 1, 1);
      data.routes = await routesToWireFormat(routes);
      await writeDriveDataJSON(filePath, data);
    }
    logger.info('gps', `check summon: ${candidateDrives} candidate drive(s), ${scanned} clip(s) read, ` +
      `${updated} route(s) gained flag+gear evidence, ${missing} clip(s) unavailable`);
    return {
      success: true,
      candidateDrives,
      clipsScanned: scanned,
      updatedRoutes: updated,
      missingClips: missing,
    };
  } catch (err) {
    logger.error('gps', 'check summon failed:', err?.message ?? err);
    return { success: false, error: err.message };
  }
}));

// ─── Tessie Import ───────────────────────────────────────────────────────────
// Two-phase flow so the UI can preview counts before committing to the full
// densification run. The renderer calls `tessie-preview` first, then
// `tessie-import` to actually write.

let tessieImportCancel = false;

function sendTessieProgress(data) {
  mainWindow?.webContents.send('tessie-progress', data);
}

ipcMain.handle('tessie-preview', async (_e, { driveDataPath, drivesCsvPath, statesCsvPath }) => {
  try {
    const { parseDrivesCSV, parseDrivingStatesCSV, buildExistingDriveRanges, hasOverlap, buildExternalSignature, calibrateDriveTime } =
      require('../processing/tessie-import.cjs');

    const drivesText = fs.readFileSync(drivesCsvPath, 'utf-8');
    const statesText = fs.readFileSync(statesCsvPath, 'utf-8');
    const rawDrives = parseDrivesCSV(drivesText);
    const statesIndex = parseDrivingStatesCSV(statesText);
    // Apply per-drive TZ calibration up-front so overlap detection matches
    // what the import phase will actually write.
    const tDrives = rawDrives.map((d) => calibrateDriveTime(d, statesIndex));

    // Load existing drive data to check overlaps
    let existingRanges = [];
    const existingSignatures = new Set();
    if (fs.existsSync(driveDataPath)) {
      const data = await readDriveData(driveDataPath);
      const { groupIntoDrives } = await import('../processing/grouper.js');
      const { drives } = groupIntoDrives(data.routes ?? []);
      existingRanges = buildExistingDriveRanges(drives);
      for (const r of (data.routes ?? [])) {
        if (r.externalSignature) existingSignatures.add(r.externalSignature);
      }
    }

    let toImport = 0;
    let overlapSkipped = 0;
    let duplicateSkipped = 0;

    for (const d of tDrives) {
      if (existingSignatures.has(buildExternalSignature(d))) { duplicateSkipped++; continue; }
      if (hasOverlap(d, existingRanges)) { overlapSkipped++; continue; }
      toImport++;
    }

    return {
      success: true,
      totalDrives: tDrives.length,
      toImport,
      overlapSkipped,
      duplicateSkipped,
      statePointCount: statesIndex.length,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('tessie-import-cancel', () => {
  tessieImportCancel = true;
  return { success: true };
});

ipcMain.handle('tessie-import', (_e, { driveDataPath, drivesCsvPath, statesCsvPath, useRouting }) => withDriveDataLock(async () => {
  tessieImportCancel = false;
  try {
    const tessieMod = require('../processing/tessie-import.cjs');
    const { parseDrivesCSV, parseDrivingStatesCSV, buildExistingDriveRanges, hasOverlap, buildExternalSignature, buildClipsForDrive, calibrateDriveTime } = tessieMod;

    logger.info('import', `tessie csv import: ${path.basename(drivesCsvPath)} + ${path.basename(statesCsvPath)}`);
    sendTessieProgress({ phase: 'Reading CSVs…', current: 0, total: 1 });
    const drivesText = fs.readFileSync(drivesCsvPath, 'utf-8');
    const statesText = fs.readFileSync(statesCsvPath, 'utf-8');
    const rawDrives = parseDrivesCSV(drivesText);
    const statesIndex = parseDrivingStatesCSV(statesText);
    const tDrives = rawDrives.map((d) => calibrateDriveTime(d, statesIndex));

    // Load or init drive data
    let data;
    if (fs.existsSync(driveDataPath)) {
      fs.copyFileSync(driveDataPath, driveDataPath + '.bak');
      data = await readDriveData(driveDataPath, { wantProcessedFiles: true });
    } else {
      data = { routes: [], processedFiles: [], driveTags: {} };
    }
    if (!Array.isArray(data.routes)) data.routes = [];
    if (!Array.isArray(data.processedFiles)) data.processedFiles = [];

    // Build overlap index from existing drives
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives: existingDrives } = groupIntoDrives(data.routes);
    const existingRanges = buildExistingDriveRanges(existingDrives);
    const existingSignatures = new Set();
    for (const r of data.routes) {
      if (r.externalSignature) existingSignatures.add(r.externalSignature);
    }

    // Filter to candidates that will actually be imported
    const candidates = [];
    for (const d of tDrives) {
      if (existingSignatures.has(buildExternalSignature(d))) continue;
      if (hasOverlap(d, existingRanges)) continue;
      candidates.push(d);
    }

    sendTessieProgress({ phase: 'Building clips…', current: 0, total: candidates.length });

    let imported = 0;
    let canceled = false;
    const skipReasons = {};
    const startMs = Date.now();

    for (let i = 0; i < candidates.length; i++) {
      if (tessieImportCancel) { canceled = true; break; }
      const d = candidates[i];
      const elapsed = Date.now() - startMs;
      const etaSec = i > 0 ? Math.round((elapsed / i) * (candidates.length - i) / 1000) : 0;
      sendTessieProgress({ phase: 'Building clips…', current: i + 1, total: candidates.length, etaSec });

      const result = buildClipsForDrive(d, statesIndex);

      if (!result.clips) {
        const key = result.reason || 'unknown';
        skipReasons[key] = (skipReasons[key] || 0) + 1;
        continue;
      }

      for (const clip of result.clips) {
        data.routes.push(clip);
        data.processedFiles.push(clip.file);
      }
      imported++;
    }

    sendTessieProgress({ phase: 'Saving…', current: candidates.length, total: candidates.length });
    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(driveDataPath, data);

    return {
      success: true,
      imported,
      canceled,
      totalCandidates: candidates.length,
      skipReasons,
    };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    tessieImportCancel = false;
  }
}));

// ─── Tessie API Import ───────────────────────────────────────────────────────
// Uses api.tessie.com to fetch dense per-drive polylines (with per-point
// autopilot state). Much better fidelity than the CSV-export path.

const TESSIE_TOKEN_FILE = () => path.join(app.getPath('userData'), 'tessie-token.bin');

function saveTessieToken(token) {
  if (!token) {
    try { fs.unlinkSync(TESSIE_TOKEN_FILE()); } catch {}
    return;
  }
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from('plain:' + token, 'utf-8');
  fs.writeFileSync(TESSIE_TOKEN_FILE(), buf);
}

function loadTessieToken() {
  try {
    const buf = fs.readFileSync(TESSIE_TOKEN_FILE());
    if (buf.slice(0, 6).toString('utf-8') === 'plain:') {
      return buf.slice(6).toString('utf-8');
    }
    return safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}

ipcMain.handle('tessie-api-get-token', () => ({ token: loadTessieToken() }));

ipcMain.handle('tessie-api-save-token', (_e, { token }) => {
  try { saveTessieToken(token); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('tessie-api-validate', async (_e, { token }) => {
  try {
    const { fetchVehicles } = require('../processing/tessie-api.cjs');
    const vehicles = await fetchVehicles(token);
    return {
      success: true,
      vehicles: vehicles.map((v) => ({
        vin: v.vin || v.last_state?.vehicle_state?.vin,
        displayName: v.last_state?.display_name || v.last_state?.vehicle_state?.vehicle_name || '',
      })).filter((v) => v.vin),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

let tessieApiCancel = false;

ipcMain.handle('tessie-api-cancel', () => { tessieApiCancel = true; return { success: true }; });

// Build a normalized drive summary (what buildClipsForApiDrive wants) by
// merging a /drives entry with the per-drive points array from /path.
function normalizeApiDrive(driveEntry, pointsArr) {
  const pts = Array.isArray(pointsArr) ? pointsArr : [];
  const startedAtSec = driveEntry.started_at || (pts[0]?.timestamp ?? null);
  const endedAtSec = driveEntry.ended_at || (pts[pts.length - 1]?.timestamp ?? null);
  return {
    externalId: driveEntry.id,
    startedAt: startedAtSec != null ? startedAtSec * 1000 : null,
    endedAt: endedAtSec != null ? endedAtSec * 1000 : null,
    durationMs: (startedAtSec && endedAtSec) ? (endedAtSec - startedAtSec) * 1000 : 0,
    distanceMi: Number.isFinite(driveEntry.odometer_distance) ? driveEntry.odometer_distance : 0,
    autopilotDistanceMi: Number.isFinite(driveEntry.autopilot_distance) ? driveEntry.autopilot_distance : 0,
    startingOdometer: driveEntry.starting_odometer ?? null,
    endingOdometer: driveEntry.ending_odometer ?? null,
    startLat: driveEntry.starting_latitude ?? pts[0]?.latitude ?? null,
    startLng: driveEntry.starting_longitude ?? pts[0]?.longitude ?? null,
    endLat: driveEntry.ending_latitude ?? pts[pts.length - 1]?.latitude ?? null,
    endLng: driveEntry.ending_longitude ?? pts[pts.length - 1]?.longitude ?? null,
    points: pts,
  };
}

// Import overlap/dedup index — the existing drives' time-ranges and external
// signatures. Building it requires a full parse + group of drive-data.json,
// which the preview and the import would otherwise each do back-to-back on the
// same unchanged file (two 100+ MB parses per import click). Cache the small,
// READ-ONLY derived result keyed by path + mtime + size so the import reuses
// the preview's work; the key self-invalidates the instant the file changes (a
// tag edit, a removal, the import's own write). Only the tiny derived data is
// cached — never the mutable parsed object — so callers can't corrupt it.
let _overlapIndexCache = null; // { key, ranges, signatures }
async function getOverlapIndex(driveDataPath) {
  if (!driveDataPath || !fs.existsSync(driveDataPath)) {
    return { ranges: [], signatures: new Set() };
  }
  const st = fs.statSync(driveDataPath);
  const key = `${driveDataPath}|${st.mtimeMs}|${st.size}`;
  if (_overlapIndexCache && _overlapIndexCache.key === key) {
    return { ranges: _overlapIndexCache.ranges, signatures: _overlapIndexCache.signatures };
  }
  const { buildExistingDriveRanges } = require('../processing/tessie-import.cjs');
  const data = await readDriveData(driveDataPath);
  const { groupIntoDrives } = await import('../processing/grouper.js');
  const { drives: existing } = groupIntoDrives(data.routes ?? []);
  const ranges = buildExistingDriveRanges(existing);
  const signatures = new Set();
  for (const r of (data.routes ?? [])) {
    if (r.externalSignature) signatures.add(r.externalSignature);
  }
  _overlapIndexCache = { key, ranges, signatures };
  return { ranges, signatures };
}

// ─── Import from another drive-data.json ─────────────────────────────────────
// Merge the routes from another Sentry Drive drive-data.json into the current
// one — a backup, or data from a second device. Dedup is by clip file path
// (normalized like the grouper); the grouper also dedups duplicate file paths
// at load time, so a stray duplicate can never produce a doubled drive.
function sendImportProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('import-json-progress', data);
}

function normFileKey(f) { return String(f || '').replace(/\\/g, '/'); }

async function readSourceAndNewRoutes(driveDataPath, sourcePath, onProgress) {
  const src = await readDriveData(sourcePath, { wantProcessedFiles: true, onProgress });
  const srcRoutes = Array.isArray(src.routes) ? src.routes : [];
  const srcDriveTags = (src.driveTags && typeof src.driveTags === 'object') ? src.driveTags : {};
  const have = new Set();
  if (driveDataPath && fs.existsSync(driveDataPath)) {
    const cur = await readDriveData(driveDataPath, { wantProcessedFiles: true });
    for (const r of (cur.routes ?? [])) have.add(normFileKey(r.file));
  }
  const newRoutes = srcRoutes.filter((r) => r.file && !have.has(normFileKey(r.file)));
  return { srcRoutes, newRoutes, srcDriveTags };
}

ipcMain.handle('import-drive-data-file-preview', async (_e, { driveDataPath, sourcePath }) => {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) return { success: false, error: 'File not found.' };
    if (driveDataPath && sourcePath === driveDataPath) return { success: false, error: "That's the file you already have loaded." };
    const { srcRoutes, newRoutes } = await readSourceAndNewRoutes(driveDataPath, sourcePath);
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const totalDrives = groupIntoDrives(srcRoutes).drives.length;
    const toImport = groupIntoDrives(newRoutes).drives.length;
    logger.info('import', `drive-data file preview: ${srcRoutes.length} clips (${newRoutes.length} new) → ${toImport} new drive(s)`);
    return { success: true, totalDrives, toImport };
  } catch (err) {
    logger.error('import', 'drive-data file preview failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('import-drive-data-file', async (_e, { driveDataPath, sourcePath }) => {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) return { success: false, error: 'File not found.' };
    if (driveDataPath && sourcePath === driveDataPath) return { success: false, error: "That's the file you already have loaded." };
    sendImportProgress({ phase: 'Reading file…', current: 0, total: 0 });
    const { newRoutes, srcDriveTags } = await readSourceAndNewRoutes(driveDataPath, sourcePath,
      (current, total) => sendImportProgress({ phase: 'Reading file…', current, total }));
    if (newRoutes.length === 0) return { success: true, imported: 0, clips: 0, tagged: 0 };
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives: newDrives } = groupIntoDrives(newRoutes);
    const imported = newDrives.length;
    // Bring the source's tags along, but only for the drives we're importing
    // (matched by startTime — the key loadAndGroupDrives looks tags up by).
    const newStartTimes = new Set(newDrives.map((d) => d.startTime));
    const tagsToMerge = {};
    let tagged = 0;
    for (const [key, tags] of Object.entries(srcDriveTags)) {
      if (newStartTimes.has(key) && Array.isArray(tags) && tags.length) { tagsToMerge[key] = tags; tagged++; }
    }
    await saveImportedClips(driveDataPath, newRoutes, sendImportProgress, tagsToMerge);
    logger.info('import', `drive-data file import: ${newRoutes.length} new clip(s) → ${imported} drive(s), ${tagged} tagged`);
    return { success: true, imported, clips: newRoutes.length, tagged };
  } catch (err) {
    logger.error('import', 'drive-data file import failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('tessie-api-preview', async (_e, { token, vin, fromSec, toSec, driveDataPath }) => {
  try {
    const { fetchDrives } = require('../processing/tessie-api.cjs');
    const { buildExistingDriveRanges, hasOverlap, buildExternalSignature } = require('../processing/tessie-import.cjs');

    logger.info('import', `tessie preview: vehicle …${String(vin).slice(-6)}, window ${fromSec}→${toSec}`);
    const drives = await fetchDrives(token, vin, { from: fromSec, to: toSec });

    // Existing-drive overlap/dedup index (cached by file mtime — see getOverlapIndex).
    const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);

    let toImport = 0;
    let overlapSkipped = 0;
    let duplicateSkipped = 0;

    for (const d of drives) {
      const normalized = {
        startedAt: (d.started_at ?? 0) * 1000,
        endedAt: (d.ended_at ?? 0) * 1000,
        startingOdometer: d.starting_odometer ?? null,
      };
      if (existingSignatures.has(buildExternalSignature(normalized))) { duplicateSkipped++; continue; }
      if (hasOverlap(normalized, existingRanges)) { overlapSkipped++; continue; }
      toImport++;
    }

    logger.info('import', `tessie preview result: ${drives.length} drives, ${toImport} to import, ${overlapSkipped} overlap-skipped, ${duplicateSkipped} duplicates`);
    return { success: true, totalDrives: drives.length, toImport, overlapSkipped, duplicateSkipped };
  } catch (err) {
    logger.error('import', 'tessie preview failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('tessie-api-import', async (_e, { token, vin, fromSec, toSec, driveDataPath }) => {
  tessieApiCancel = false;
  try {
    const { fetchDrives, fetchPath, Throttler } = require('../processing/tessie-api.cjs');
    const { buildExistingDriveRanges, hasOverlap, buildExternalSignature, buildClipsForApiDrive } = require('../processing/tessie-import.cjs');

    logger.info('import', `tessie import: vehicle …${String(vin).slice(-6)}, window ${fromSec}→${toSec}`);
    sendTessieProgress({ phase: 'Fetching drives list…', current: 0, total: 1 });
    const drivesList = await fetchDrives(token, vin, { from: fromSec, to: toSec });

    // Overlap/dedup snapshot only — reuses the preview's parse when the file is
    // unchanged (getOverlapIndex is mtime-keyed), so one import click doesn't
    // parse the full drive-data twice. The authoritative merge still re-reads
    // under the drive-data lock at save time (the fetch loop below can run for
    // minutes while tags or removals land in between).
    const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);

    // Filter overlap / duplicates
    const candidates = [];
    for (const d of drivesList) {
      const normalized = {
        startedAt: (d.started_at ?? 0) * 1000,
        endedAt: (d.ended_at ?? 0) * 1000,
        startingOdometer: d.starting_odometer ?? null,
      };
      if (existingSignatures.has(buildExternalSignature(normalized))) continue;
      if (hasOverlap(normalized, existingRanges)) continue;
      candidates.push(d);
    }

    sendTessieProgress({ phase: 'Fetching paths…', current: 0, total: candidates.length });

    const throttler = new Throttler(1000);
    const newClips = [];
    let imported = 0;
    let canceled = false;
    const skipReasons = {};
    const startMs = Date.now();

    for (let i = 0; i < candidates.length; i++) {
      if (tessieApiCancel) { canceled = true; break; }
      const d = candidates[i];
      const elapsed = Date.now() - startMs;
      const etaSec = i > 0 ? Math.round((elapsed / i) * (candidates.length - i) / 1000) : 0;
      sendTessieProgress({ phase: 'Fetching paths…', current: i + 1, total: candidates.length, etaSec });

      await throttler.wait();

      let pathBuckets;
      try {
        pathBuckets = await fetchPath(token, vin, {
          from: d.started_at,
          to: d.ended_at,
          separate: true,
          simplify: false,
          details: true,
        });
      } catch (err) {
        skipReasons['fetch-error'] = (skipReasons['fetch-error'] || 0) + 1;
        continue;
      }

      const points = pathBuckets.length > 0 ? pathBuckets[0] : [];
      const apiDrive = normalizeApiDrive(d, points);
      const result = buildClipsForApiDrive(apiDrive);

      if (!result.clips) {
        skipReasons[result.reason || 'unknown'] = (skipReasons[result.reason || 'unknown'] || 0) + 1;
        continue;
      }
      newClips.push(...result.clips);
      imported++;
    }

    sendTessieProgress({ phase: 'Saving…', current: candidates.length, total: candidates.length });
    if (newClips.length > 0) await saveImportedClips(driveDataPath, newClips, sendTessieProgress);

    logger.info('import', `tessie import done: ${imported}/${candidates.length} imported${canceled ? ' (canceled)' : ''}, skips: ${JSON.stringify(skipReasons)}`);
    return { success: true, imported, canceled, totalCandidates: candidates.length, skipReasons };
  } catch (err) {
    logger.error('import', 'tessie import failed:', err);
    return { success: false, error: err.message };
  } finally {
    tessieApiCancel = false;
  }
});

// ─── Teslascope API Import ─────────────────────────────────────────────────
// Mirrors the Tessie API path against teslascope.com. Field mapping lives in
// teslascope-api.cjs (defensive; set TESLASCOPE_DEBUG=1 to log raw responses).

const TESLASCOPE_TOKEN_FILE = () => path.join(app.getPath('userData'), 'teslascope-token.bin');

function saveTeslascopeToken(token) {
  if (!token) {
    try { fs.unlinkSync(TESLASCOPE_TOKEN_FILE()); } catch {}
    return;
  }
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from('plain:' + token, 'utf-8');
  fs.writeFileSync(TESLASCOPE_TOKEN_FILE(), buf);
}

function loadTeslascopeToken() {
  try {
    const buf = fs.readFileSync(TESLASCOPE_TOKEN_FILE());
    if (buf.slice(0, 6).toString('utf-8') === 'plain:') {
      return buf.slice(6).toString('utf-8');
    }
    return safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}

function sendTeslascopeProgress(data) {
  mainWindow?.webContents.send('teslascope-progress', data);
}

ipcMain.handle('teslascope-api-get-token', () => ({ token: loadTeslascopeToken() }));

ipcMain.handle('teslascope-api-save-token', (_e, { token }) => {
  try { saveTeslascopeToken(token); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('teslascope-api-validate', async (_e, { token }) => {
  try {
    const { fetchVehicles } = require('../processing/teslascope-api.cjs');
    const vehicles = await fetchVehicles(token);
    return {
      success: true,
      vehicles: vehicles.map((v) => ({
        publicId: v.publicId,
        vin: v.vin || '',
        displayName: v.displayName || v.name || v.vin || 'Vehicle',
      })).filter((v) => v.publicId != null),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

let teslascopeApiCancel = false;
ipcMain.handle('teslascope-api-cancel', () => { teslascopeApiCancel = true; return { success: true }; });

ipcMain.handle('teslascope-api-preview', async (_e, { token, publicId, fromSec, toSec, driveDataPath }) => {
  try {
    const { fetchDrives, normalizeDrive } = require('../processing/teslascope-api.cjs');
    const { buildExistingDriveRanges, hasOverlap, buildExternalSignature } = require('../processing/tessie-import.cjs');

    logger.info('import', `teslascope preview: vehicle …${String(publicId).slice(-6)}, window ${fromSec}→${toSec}`);
    const drives = await fetchDrives(token, publicId, { from: fromSec, to: toSec });

    // Existing-drive overlap/dedup index (cached by file mtime — see getOverlapIndex).
    const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);

    let toImport = 0, overlapSkipped = 0, duplicateSkipped = 0, badTimestamps = 0;
    for (const d of drives) {
      const n = normalizeDrive(d);
      // Unrecognized timestamp fields ⇒ NaN startedAt. Without this guard the
      // import "succeeds" but produces unparseable clip filenames the grouper
      // silently drops — drives vanish without a trace.
      if (!Number.isFinite(n.startedAt) || !Number.isFinite(n.endedAt)) {
        if (badTimestamps === 0) {
          logger.warn('import', 'teslascope drive has unrecognized timestamp fields; raw keys:', Object.keys(d || {}).join(', '));
        }
        badTimestamps++;
        continue;
      }
      const key = { startedAt: n.startedAt, endedAt: n.endedAt, startingOdometer: n.startingOdometer };
      if (existingSignatures.has(buildExternalSignature(key, 'teslascope'))) { duplicateSkipped++; continue; }
      if (hasOverlap(key, existingRanges)) { overlapSkipped++; continue; }
      toImport++;
    }
    logger.info('import', `teslascope preview result: ${drives.length} drives, ${toImport} to import, ${overlapSkipped} overlap-skipped, ${duplicateSkipped} duplicates, ${badTimestamps} bad-timestamps`);
    return { success: true, totalDrives: drives.length, toImport, overlapSkipped, duplicateSkipped, badTimestamps };
  } catch (err) {
    logger.error('import', 'teslascope preview failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('teslascope-api-import', async (_e, { token, publicId, fromSec, toSec, driveDataPath }) => {
  teslascopeApiCancel = false;
  try {
    const { fetchDrives, fetchDrivePath, normalizeDrive, Throttler } = require('../processing/teslascope-api.cjs');
    const { buildExistingDriveRanges, hasOverlap, buildExternalSignature, buildClipsForApiDrive } = require('../processing/tessie-import.cjs');

    logger.info('import', `teslascope import: vehicle …${String(publicId).slice(-6)}, window ${fromSec}→${toSec}`);
    sendTeslascopeProgress({ phase: 'Fetching drives list…', current: 0, total: 1 });
    const drivesList = await fetchDrives(token, publicId, { from: fromSec, to: toSec });

    // Overlap/dedup snapshot only (mtime-cached, reused from preview); the
    // authoritative merge re-reads under the lock at save time (see the Tessie
    // API import above).
    const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);

    const candidates = [];
    let badTimestamps = 0;
    for (const d of drivesList) {
      const n = normalizeDrive(d);
      // See the preview handler: NaN timestamps would otherwise become
      // unparseable clip filenames that the grouper silently drops.
      if (!Number.isFinite(n.startedAt) || !Number.isFinite(n.endedAt)) { badTimestamps++; continue; }
      const key = { startedAt: n.startedAt, endedAt: n.endedAt, startingOdometer: n.startingOdometer };
      if (existingSignatures.has(buildExternalSignature(key, 'teslascope'))) continue;
      if (hasOverlap(key, existingRanges)) continue;
      candidates.push(d);
    }

    sendTeslascopeProgress({ phase: 'Fetching paths…', current: 0, total: candidates.length });
    const throttler = new Throttler(1000);
    const newClips = [];
    let imported = 0, canceled = false;
    const skipReasons = {};
    if (badTimestamps > 0) skipReasons['bad-timestamps'] = badTimestamps;
    const startMs = Date.now();

    for (let i = 0; i < candidates.length; i++) {
      if (teslascopeApiCancel) { canceled = true; break; }
      const d = candidates[i];
      const elapsed = Date.now() - startMs;
      const etaSec = i > 0 ? Math.round((elapsed / i) * (candidates.length - i) / 1000) : 0;
      sendTeslascopeProgress({ phase: 'Fetching paths…', current: i + 1, total: candidates.length, etaSec });

      await throttler.wait();

      const summary = normalizeDrive(d);
      let detail = null;
      try {
        detail = await fetchDrivePath(token, publicId, summary.id);
      } catch (err) {
        // Detail fetch failed — fall back to summary-only (start/end markers).
        skipReasons['detail-fetch-error'] = (skipReasons['detail-fetch-error'] || 0) + 1;
      }
      const apiDrive = normalizeDrive(d, detail);
      const result = buildClipsForApiDrive(apiDrive, 'teslascope');
      if (!result.clips) {
        skipReasons[result.reason || 'unknown'] = (skipReasons[result.reason || 'unknown'] || 0) + 1;
        continue;
      }
      newClips.push(...result.clips);
      imported++;
    }

    sendTeslascopeProgress({ phase: 'Saving…', current: candidates.length, total: candidates.length });
    if (newClips.length > 0) await saveImportedClips(driveDataPath, newClips, sendTeslascopeProgress);
    logger.info('import', `teslascope import done: ${imported}/${candidates.length} imported${canceled ? ' (canceled)' : ''}, skips: ${JSON.stringify(skipReasons)}`);
    return { success: true, imported, canceled, totalCandidates: candidates.length, skipReasons };
  } catch (err) {
    logger.error('import', 'teslascope import failed:', err);
    return { success: false, error: err.message };
  } finally {
    teslascopeApiCancel = false;
  }
});

// Remove only the Tessie clips whose grouped drive is hidden by SEI overlap.
// Useful for cleaning up legacy imports that landed on the wrong side of an
// overlap-check edge case before this was tightened.
ipcMain.handle('tessie-remove-hidden', (_e, { driveDataPath }) => withDriveDataLock(async () => {
  try {
    if (!fs.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
    const data = await readDriveData(driveDataPath, { wantProcessedFiles: true });

    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives } = groupIntoDrives(data.routes ?? []);

    // Build SEI ranges and find Tessie drives that overlap them. Only real
    // dashcam (SEI) drives count as coverage — excluding just 'tessie' here
    // used to let Teslascope imports count as "dashcam", deleting Tessie
    // drives that only overlapped another import.
    const seiRanges = [];
    for (const d of drives) {
      if (d.source !== 'sei' || !d.startTime || !d.endTime) continue;
      const s = Date.parse(d.startTime);
      const e = Date.parse(d.endTime);
      if (Number.isFinite(s) && Number.isFinite(e)) seiRanges.push({ s, e });
    }
    seiRanges.sort((a, b) => a.s - b.s);

    const hiddenSignatures = new Set();
    for (const d of drives) {
      if (d.source !== 'tessie') continue;
      const s = Date.parse(d.startTime);
      const e = Date.parse(d.endTime);
      for (const r of seiRanges) {
        if (r.e <= s) continue;
        if (r.s >= e) break;
        if (d.externalSignature) hiddenSignatures.add(d.externalSignature);
        break;
      }
    }

    if (hiddenSignatures.size === 0) return { success: true, removed: 0 };

    fs.copyFileSync(driveDataPath, driveDataPath + '.bak');
    const before = (data.routes ?? []).length;
    data.routes = (data.routes ?? []).filter(
      (r) => !(r.source === 'tessie' && hiddenSignatures.has(r.externalSignature))
    );
    const removedRoutes = before - data.routes.length;
    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(driveDataPath, data);
    return { success: true, removed: hiddenSignatures.size, removedRoutes };
  } catch (err) {
    return { success: false, error: err.message };
  }
}));

ipcMain.handle('tessie-remove-all', (_e, { driveDataPath }) => withDriveDataLock(async () => {
  try {
    if (!fs.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
    fs.copyFileSync(driveDataPath, driveDataPath + '.bak');
    const data = await readDriveData(driveDataPath, { wantProcessedFiles: true });

    const tessieFiles = new Set(
      (data.routes ?? [])
        .filter((r) => r.source === 'tessie')
        .map((r) => (r.file || '').replace(/\\/g, '/'))
    );
    if (tessieFiles.size === 0) return { success: true, removed: 0 };

    // Report what the user sees: grouped drives, not the per-minute
    // synthetic clips they expand to ("Removed 339 drives" for 25).
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives: grouped } = groupIntoDrives(data.routes ?? []);
    const removed = grouped.filter((d) => d.source === 'tessie').length;

    data.routes = (data.routes ?? []).filter((r) => r.source !== 'tessie');
    data.processedFiles = (data.processedFiles ?? []).filter(
      (f) => !tessieFiles.has((f || '').replace(/\\/g, '/'))
    );

    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(driveDataPath, data);
    return { success: true, removed };
  } catch (err) {
    return { success: false, error: err.message };
  }
}));

ipcMain.handle('teslascope-remove-hidden', (_e, { driveDataPath }) => withDriveDataLock(async () => {
  try {
    if (!fs.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
    const data = await readDriveData(driveDataPath, { wantProcessedFiles: true });

    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives } = groupIntoDrives(data.routes ?? []);

    const seiRanges = [];
    for (const d of drives) {
      if (d.source !== 'sei' || !d.startTime || !d.endTime) continue;
      const s = Date.parse(d.startTime);
      const e = Date.parse(d.endTime);
      if (Number.isFinite(s) && Number.isFinite(e)) seiRanges.push({ s, e });
    }
    seiRanges.sort((a, b) => a.s - b.s);

    const hiddenSignatures = new Set();
    for (const d of drives) {
      if (d.source !== 'teslascope') continue;
      const s = Date.parse(d.startTime);
      const e = Date.parse(d.endTime);
      for (const r of seiRanges) {
        if (r.e <= s) continue;
        if (r.s >= e) break;
        if (d.externalSignature) hiddenSignatures.add(d.externalSignature);
        break;
      }
    }

    if (hiddenSignatures.size === 0) return { success: true, removed: 0 };

    fs.copyFileSync(driveDataPath, driveDataPath + '.bak');
    const before = (data.routes ?? []).length;
    data.routes = (data.routes ?? []).filter(
      (r) => !(r.source === 'teslascope' && hiddenSignatures.has(r.externalSignature))
    );
    const removedRoutes = before - data.routes.length;
    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(driveDataPath, data);
    return { success: true, removed: hiddenSignatures.size, removedRoutes };
  } catch (err) {
    return { success: false, error: err.message };
  }
}));

ipcMain.handle('teslascope-remove-all', (_e, { driveDataPath }) => withDriveDataLock(async () => {
  try {
    if (!fs.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
    fs.copyFileSync(driveDataPath, driveDataPath + '.bak');
    const data = await readDriveData(driveDataPath, { wantProcessedFiles: true });

    const tsFiles = new Set(
      (data.routes ?? [])
        .filter((r) => r.source === 'teslascope')
        .map((r) => (r.file || '').replace(/\\/g, '/'))
    );
    if (tsFiles.size === 0) return { success: true, removed: 0 };

    // Grouped drive count, not clip count (see tessie-remove-all).
    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives: grouped } = groupIntoDrives(data.routes ?? []);
    const removed = grouped.filter((d) => d.source === 'teslascope').length;

    data.routes = (data.routes ?? []).filter((r) => r.source !== 'teslascope');
    data.processedFiles = (data.processedFiles ?? []).filter(
      (f) => !tsFiles.has((f || '').replace(/\\/g, '/'))
    );

    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(driveDataPath, data);
    return { success: true, removed };
  } catch (err) {
    return { success: false, error: err.message };
  }
}));
