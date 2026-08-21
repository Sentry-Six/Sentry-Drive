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
  computeGearRuns, computeFlagRuns, computeApRuns,
} = require('../shared/drive-calc.cjs');
const { normalizeClipPath } = require('../shared/clip-path.cjs');

let mainWindow;
let activeChild = null;
let driveLoaderClient = null;

// ─── drive-data.json reading ─────────────────────────────────────────────────
// The shared reader streams files that exceed V8's string limit.
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
const logger = require('./logger.cjs');
const os = require('os');
logger.setAppInfo({ version: app.getVersion(), osBuild: os.release() });
// Keep a disk sink so crashes remain visible in the next support export.
logger.initFileSink(path.join(app.getPath('userData'), 'logs'));
logger.info('main', `app starting — v${app.getVersion()} | ${process.platform} ${process.arch} (${os.release()}) | ` +
  `${os.cpus().length} CPUs | electron ${process.versions.electron} | node ${process.versions.node}`);
require('../processing/teslascope-api.cjs').setLogger(logger);
require('../processing/tessie-api.cjs').setLogger?.(logger);

app.on('before-quit', () => {
  driveLoaderClient?.close().catch(() => {});
  logger.info('main', 'app quitting');
  logger.flushNow();
});
app.on('render-process-gone', (_e, _wc, details) => {
  logger.error('main', `renderer process gone: ${details.reason} (exit ${details.exitCode})`);
});
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU' && details.reason === 'clean-exit') return; // routine
  logger.warn('main', `${details.type} process gone: ${details.reason}`);
});

// Preserve background failures without terminating the viewer.
process.on('uncaughtException', (err) => logger.error('main', 'Uncaught exception:', err));
process.on('unhandledRejection', (reason) => logger.error('main', 'Unhandled rejection:', reason));

ipcMain.on('app-log', (_e, { level, scope, text } = {}) => {
  const lv = level === 'error' || level === 'warn' ? level : 'info';
  logger[lv](typeof scope === 'string' && scope ? scope : 'renderer', String(text ?? ''));
});

// Support exports remember a directory independently of footage selection.
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

// Keep large indexes beside the app when writable, otherwise use system temp.
// Probe with an actual write because Windows access checks can be optimistic.
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

// Crashed loads can leave disposable UUID cache directories behind.
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
    // Preserve the normal bounds while maximized or fullscreen.
    const bounds = isMaximized || isFullScreen
      ? (mainWindow.getNormalBounds?.() ?? mainWindow.getBounds())
      : mainWindow.getBounds();
    fs.writeFileSync(
      WINDOW_STATE_FILE(),
      JSON.stringify({ ...bounds, isMaximized, isFullScreen }, null, 2),
    );
  } catch {
    // Persistence is best-effort; defaults remain usable.
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
  // The disabled application menu cannot provide these shortcuts.
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
  // Log integration presence without credentials.
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

// Packaged builds use Documents because app.asar is read-only.
ipcMain.handle('get-default-output-dir', () =>
  app.isPackaged
    ? path.join(app.getPath('documents'), 'Sentry Six', 'Sentry Drive')
    : path.join(__dirname, '..', '..'));

ipcMain.handle('check-drive-data', (_e, dir) =>
  fs.existsSync(path.join(dir, 'drive-data.json'))
);

ipcMain.handle('get-cpu-count', () => require('os').cpus().length);

// Reverse geocoding stays in the main process and lazily initializes its cache.
let _geocodeInited = false;
function geocodeService() {
  const geocode = require('../processing/geocode.cjs');
  if (!_geocodeInited) {
    const userData = app.getPath('userData');
    geocode.init({
      cacheFile: path.join(userData, 'geocode-cache.json'),
      settingsFile: path.join(userData, 'geocode-settings.json'),
      knownPlacesFile: path.join(userData, 'known-places.json'),
      locale: app.getLocale(),
    });
    _geocodeInited = true;
  }
  return geocode;
}

ipcMain.handle('reverse-geocode', async (_e, { lat, lng, accuracyM, teslaLabel } = {}) => {
  try {
    return await geocodeService().reverseGeocodeDetailed(lat, lng, { accuracyM, teslaLabel });
  } catch {
    return { label: null };
  }
});

ipcMain.handle('get-geocode-settings', () => {
  try { return geocodeService().getSettings(); }
  catch { return null; }
});

ipcMain.handle('set-geocode-settings', (_e, settings) => {
  try { return geocodeService().configure(settings); }
  catch { return null; }
});

ipcMain.handle('remember-known-place', (_e, place) => {
  try { return geocodeService().rememberKnownPlace(place); }
  catch { return null; }
});

ipcMain.handle('remove-known-place', (_e, place) => {
  try { return geocodeService().removeKnownPlace(place); }
  catch { return false; }
});

ipcMain.handle('sync-known-place-zones', (_e, { zones } = {}) => {
  try { return geocodeService().syncKnownPlaceZones(zones); }
  catch { return 0; }
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

// Batch removals use one read and one atomic write.
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
  // electron-updater emits no result for unpackaged builds.
  if (!app.isPackaged) {
    sendUpdateStatus('error', { message: 'Update checks only work in the installed app.' });
    return;
  }
  return autoUpdater.checkForUpdates().catch((err) => {
    // Ensure the renderer receives a result if no updater event is emitted.
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

// Loads are serialized because each replaces the utility process's disk index.
let driveLoadChain = Promise.resolve();
function withDriveLoadLock(fn) {
  const result = driveLoadChain.then(fn, fn);
  driveLoadChain = result.then(() => {}, () => {});
  return result;
}

// Generations prevent detail requests from crossing reload boundaries.
let driveDetailGen = 0;

ipcMain.handle('load-and-group-drives', (_e, filePath) => withDriveLoadLock(async () => {
  try {
    const loaderResult = await getDriveLoaderClient().load(filePath, (progress) => {
      mainWindow?.webContents.send('load-progress', progress);
    });
    driveDetailGen++;
    logger.info('main', `loaded ${loaderResult.totalDriveCount} drive(s) from ${loaderResult.totalRoutes} clips — ${filePath}`);
    return { ...loaderResult, cacheGen: driveDetailGen };

    /* Unreachable compatibility implementation. */
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
    // Grouped drives own their point arrays, so the raw routes can be released.
    parsed.routes = null;
    sendProgress('preparing', 0, 0);

    // Hide imports that overlap SEI footage without deleting their source clips.
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
          if (r.e <= s) continue;
          if (r.s >= e) break;
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

    for (const d of drives) {
      d.tags = driveTags[d.startTime] ?? [];
    }

    // Keep full detail as compact serialized buffers outside the IPC summary.
    // Swap caches only after a complete build to preserve the prior generation
    // if serialization fails.
    const newCache = new Map();
    for (const d of drives) {
      // Synthetic bridge routes identify gap-filled drives in the UI.
      d.bridged = (d.routeFiles ?? []).some((f) => f.includes('-front-bridge.mp4'));
      newCache.set(d.id, v8.serialize({
        points: d.points,
        fsdStates: d.fsdStates,
        gearStates: d.gearStates,
        fsdEvents: d.fsdEvents,
      }));
      // Overview routes use 120 points to bound IPC and canvas costs.
      d.overviewPoints = downsampleForIPC(d.points, 120);
      delete d.points;
      delete d.fsdStates;
      delete d.gearStates;
      delete d.fsdEvents;
      // Omit detail-only fields from the renderer summary.
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

  // Validate the output directory before starting a long processing run.
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    logger.error('processing', `output dir not usable: ${outputDir} — ${err.message}`);
    return { success: false, error: `Cannot create output folder "${outputDir}": ${err.message}` };
  }

  const args = [scriptPath, clipsDir, outputPath];
  if (workerCount && workerCount > 0) args.push(String(workerCount));
  if (reprocessAll) args.push('--reprocess-all');

  // Callback identity checks prevent an exiting child from affecting a newer run.
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
      // A user stop owns the renderer's final status.
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
  child.userStopped = true; // suppress the close handler's status
  child.kill('SIGTERM');
  // Retain the slot until exit; force termination after the SIGTERM grace period.
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
// Byte fields use base64 to match Sentry-USB's []uint8 JSON encoding.
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

// Serialize read-modify-write operations to avoid lost concurrent edits.
let driveDataLock = Promise.resolve();
function withDriveDataLock(fn) {
  const result = driveDataLock.then(fn, fn);
  driveDataLock = result.then(() => {}, () => {});
  return result;
}

// Re-read under the lock after long API fetches so intervening edits survive.
// tagsToMerge unions { startTime: [tag…] } into existing driveTags.
function saveImportedClips(filePath, clips, onProgress, tagsToMerge) {
  logger.info('import', `saving ${clips.length} imported clip(s) → ${filePath}`);
  return withDriveDataLock(async () => {
    let data;
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak'); // import restore point
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
// Poll mtime and size because fs.watch is unreliable on SMB shares. Re-baseline
// app writes to avoid self-triggered reloads.
let _watchedPath = null;
let _watchSig = null;   // { mtimeMs, size }
let _watchTimer = null;

function driveDataSig(p) {
  try { const st = fs.statSync(p); return { mtimeMs: st.mtimeMs, size: st.size }; }
  catch { return null; }
}

function noteOwnWrite(filePath) {
  if (filePath && filePath === _watchedPath) _watchSig = driveDataSig(filePath);
}

ipcMain.handle('watch-drive-data', (_e, filePath) => {
  _watchedPath = filePath || null;
  _watchSig = _watchedPath ? driveDataSig(_watchedPath) : null;
  if (!_watchTimer && _watchedPath) {
    _watchTimer = setInterval(() => {
      if (!_watchedPath || !mainWindow || mainWindow.isDestroyed()) return;
      const cur = driveDataSig(_watchedPath);
      if (!cur) return; // atomic rename in progress
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
    // Keep tag filtering consistent with the persisted edit.
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

    const FILE_TS_RE = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/;
    const parseTs = (file) => {
      const m = FILE_TS_RE.exec(file);
      if (!m) return null;
      const t = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
      return isNaN(t.getTime()) ? null : t;
    };

    // Rebuild synthetic bridges from the current routes.
    const beforeCount = routes.length;
    routes = routes.filter((r) => !r.file.includes('-front-bridge.mp4'));
    data.routes = routes;
    if (data.processedFiles) {
      data.processedFiles = data.processedFiles.filter((f) => !f.includes('-front-bridge.mp4'));
    }
    const removedBridges = beforeCount - routes.length;

    const MIN_BRIDGE_MS = CLIP_DURATION_MS;
    const MAX_BRIDGE_MS = DRIVE_GAP_MS;
    const timedRoutes = routes
      .map((r, idx) => ({ idx, ts: parseTs(r.file), route: r }))
      .filter((r) => r.ts !== null)
      .sort((a, b) => a.ts - b.ts);

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

    const bridgeRoutes = [];
    const bridgeStartMs = Date.now();
    for (let g = 0; g < gaps.length; g++) {
      const elapsedMs = Date.now() - bridgeStartMs;
      const etaSec = g > 0 ? Math.round((elapsedMs / g) * (gaps.length - g) / 1000) : 0;
      sendRepairProgress('Bridging…', g + 1, gaps.length, etaSec);
      const { lastPt, firstPt, curEnd, gapMs, curLastGear, date } = gaps[g];

      let interpPoints;

      if (useRouting) {
        try {
          const routed = await fetchOSRMRoute(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);
          if (routed && routed.length >= 2) {
            interpPoints = routed;
            routedGaps++;
          }
        } catch {
          // Straight-line interpolation remains available below.
        }
      }

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

// Accept route paths with or without a RecentClips prefix.
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

// Backfill missing frame-level flag, gear, and autopilot evidence. Scan whole
// slow drives and low-speed edges where a park-bracketed Summon can be fused
// to a trip.
ipcMain.handle('check-summon', (_e, { filePath, clipsDir }) => withDriveDataLock(async () => {
  try {
    sendRepairProgress('Reading…', 0, 1);
    fs.copyFileSync(filePath, filePath + '.bak');
    const data = await readDriveData(filePath, { wantProcessedFiles: true });
    const routes = await decodeRoutesByteFields(data.routes ?? []);

    // Key on the canonical path: groupIntoDrives normalizes route files (which
    // strips a leading RecentClips/), so drive.routeFiles are in that space.
    // Folding backslashes alone misses every route an older exporter wrote
    // prefixed, and the lookup failure is silent — no clip read, no error.
    const routeByFile = new Map();
    for (const r of routes) routeByFile.set(normalizeClipPath(r.file), r);

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

    // Current evidence includes per-run speed, which avoids point-slice skew,
    // and per-frame autopilot runs for the Self Driving Summon signature.
    const hasCurrentEvidence = (route) =>
      Array.isArray(route.flagRuns) && route.flagRuns.length > 0 &&
      route.flagRuns.every((run) => Number.isFinite(run.maxMps)) &&
      Array.isArray(route.apRuns) && route.apRuns.length > 0;
    const pending = new Map();
    const addClip = (f) => {
      const norm = normalizeClipPath(f);
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

      // Reverse-only Summon can have a zero display statistic.
      const wholeDrive =
        (d.maxSpeedMph ?? 0) <= maxMph &&
        (d.durationMs ?? 0) <= SUMMON_MAX_DURATION_MS;
      if (wholeDrive) {
        candidateDrives++;
        for (const f of files) addClip(f);
        continue;
      }

      // Include one fast boundary clip because it can contain the park split.
      let took = false;
      for (let i = 0; i < Math.min(files.length, MAX_EDGE_CLIPS); i++) {
        const norm = normalizeClipPath(files[i]);
        if (!routeIsSlow(norm)) {
          if (took) addClip(files[i]); // boundary clip after the slow run
          break;
        }
        addClip(files[i]);
        took = true;
      }
      let tookTail = false;
      for (let i = 0; i < Math.min(files.length, MAX_EDGE_CLIPS); i++) {
        const norm = normalizeClipPath(files[files.length - 1 - i]);
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
          // Refresh gear and autopilot evidence from the same frames as the
          // flag evidence.
          route.gearRuns = computeGearRuns(extracted.gears);
          route.apRuns = computeApRuns(extracted.apStates);
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
      `${updated} route(s) gained flag+gear+autopilot evidence, ${missing} clip(s) unavailable`);
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
// Preview overlap counts before running CSV densification.

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
    // Calibrate timestamps before overlap checks.
    const tDrives = rawDrives.map((d) => calibrateDriveTime(d, statesIndex));

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

    let data;
    if (fs.existsSync(driveDataPath)) {
      fs.copyFileSync(driveDataPath, driveDataPath + '.bak');
      data = await readDriveData(driveDataPath, { wantProcessedFiles: true });
    } else {
      data = { routes: [], processedFiles: [], driveTags: {} };
    }
    if (!Array.isArray(data.routes)) data.routes = [];
    if (!Array.isArray(data.processedFiles)) data.processedFiles = [];

    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives: existingDrives } = groupIntoDrives(data.routes);
    const existingRanges = buildExistingDriveRanges(existingDrives);
    const existingSignatures = new Set();
    for (const r of data.routes) {
      if (r.externalSignature) existingSignatures.add(r.externalSignature);
    }

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
// API imports include dense polylines and per-point Autopilot state.

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

// Normalize /drives metadata with the corresponding /path points.
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

// Cache only the derived overlap index, keyed by path, mtime, and size.
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
// Merge by normalized clip path; grouping also deduplicates defensively.
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
    // Import tags only for selected drive start times.
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

    // The final merge re-reads under the lock after the API fetch.
    const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);

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
// Field mapping and optional diagnostics live in teslascope-api.cjs.

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

    const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);

    let toImport = 0, overlapSkipped = 0, duplicateSkipped = 0, badTimestamps = 0;
    for (const d of drives) {
      const n = normalizeDrive(d);
      // Reject timestamps that cannot produce parseable clip filenames.
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

    // The final merge re-reads under the lock after the API fetch.
    const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);

    const candidates = [];
    let badTimestamps = 0;
    for (const d of drivesList) {
      const n = normalizeDrive(d);
      // Invalid timestamps cannot produce groupable clip filenames.
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
        // Summary endpoints are the detail-fetch fallback.
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

// Remove Tessie clips only when their grouped drive overlaps SEI footage.
ipcMain.handle('tessie-remove-hidden', (_e, { driveDataPath }) => withDriveDataLock(async () => {
  try {
    if (!fs.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
    const data = await readDriveData(driveDataPath, { wantProcessedFiles: true });

    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives } = groupIntoDrives(data.routes ?? []);

    // Only SEI footage counts as coverage; imports must not trigger deletion.
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

    // Report grouped drives rather than synthetic clips.
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

    // Report grouped drives rather than synthetic clips.
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
