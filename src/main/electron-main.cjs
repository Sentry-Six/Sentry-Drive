'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { geodesicM, GEAR_PARK, CLIP_DURATION_MS, DRIVE_GAP_MS } = require('../shared/drive-calc.cjs');

// Give V8 more old-space headroom so the main process can parse large
// drive-data.json files (hundreds of MB to ~1GB). Must be set before
// app.whenReady(). The renderer inherits the same flag.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');

let mainWindow;
let activeChild = null;
let driveDetailCache = null;

// ─── drive-data.json reading ─────────────────────────────────────────────────
// All reads go through src/main/drive-data-reader.cjs: native JSON.parse for
// files that fit under V8's string cap (~16x faster than token streaming),
// stream-json above it. Every handler that used to JSON.parse(readFileSync())
// here would crash with ERR_STRING_TOO_LONG on >512 MiB files — the shared
// reader fixes that everywhere at once.
const { readDriveData } = require('./drive-data-reader.cjs');

// ─── Logging ─────────────────────────────────────────────────────────────────
// Terminal echo + in-memory buffer; exported from Settings → Support → Logs.
const logger = require('./logger.cjs');
logger.setAppInfo({ version: app.getVersion() });
logger.info('main', 'app starting');
// Teslascope API diagnostics flow into this log (Settings → Support → Logs).
require('../processing/teslascope-api.cjs').setLogger(logger);

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

function downsampleForIPC(pts, maxPts) {
  if (!pts || pts.length === 0) return [];
  if (pts.length <= maxPts) return pts.map((p) => [p[0], p[1]]);
  const result = [];
  const step = (pts.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) {
    const p = pts[Math.round(i * step)];
    result.push([p[0], p[1]]);
  }
  return result;
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

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('up-to-date'));
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', () => sendUpdateStatus('ready'));
autoUpdater.on('error', (err) => {
  logger.error('updater', err?.message ?? err);
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

app.whenReady().then(createWindow);

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

ipcMain.handle('get-default-output-dir', () => path.join(__dirname, '..', '..'));

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
    return { success: true };
  } catch (err) {
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
  const url = 'https://raw.githubusercontent.com/JeffFromTheIRS/Sentry-Drive/main/changelog.json';
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

ipcMain.handle('load-and-group-drives', async (_e, filePath) => {
  try {
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
    driveDetailCache = new Map();
    for (const d of drives) {
      driveDetailCache.set(d.id, {
        points: d.points,
        fsdStates: d.fsdStates,
        gearStates: d.gearStates,
        fsdEvents: d.fsdEvents,
      });
      d.overviewPoints = downsampleForIPC(d.points, 200);
      delete d.points;
      delete d.fsdStates;
      delete d.gearStates;
      delete d.fsdEvents;
    }

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
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-drive-detail', (_e, driveId) => {
  if (!driveDetailCache) return { success: false, error: 'No drives loaded' };
  const detail = driveDetailCache.get(driveId);
  if (!detail) return { success: false, error: 'Drive not found' };
  return { success: true, ...detail };
});

ipcMain.handle('start-processing', async (_e, { clipsDir, outputDir, workerCount, reprocessAll }) => {
  if (activeChild) return { success: false, error: 'Processing already running' };

  const scriptPath = path.join(__dirname, '..', 'processing', 'process.js');
  const outputPath = path.join(outputDir, 'drive-data.json');
  const args = [scriptPath, clipsDir, outputPath];
  if (workerCount && workerCount > 0) args.push(String(workerCount));
  if (reprocessAll) args.push('--reprocess-all');

  try {
    activeChild = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (err) {
    logger.error('processing', 'spawn failed:', err.message);
    return { success: false, error: `spawn failed: ${err.message}` };
  }

  logger.info('processing', 'child started:', args.join(' '));
  activeChild.stderr?.on('data', (chunk) => logger.error('processing', String(chunk).trim()));
  activeChild.on('exit', (code) => logger.info('processing', `child exited with code ${code}`));

  activeChild.stdout.on('data', (chunk) => {
    mainWindow?.webContents.send('processing-output', { type: 'stdout', text: chunk.toString() });
  });

  activeChild.stderr.on('data', (chunk) => {
    mainWindow?.webContents.send('processing-output', { type: 'stderr', text: chunk.toString() });
  });

  return new Promise((resolve) => {
    activeChild.on('close', (code) => {
      activeChild = null;
      mainWindow?.webContents.send('processing-output', { type: 'done', code });
      resolve({ success: true, exitCode: code });
    });
    activeChild.on('error', (err) => {
      activeChild = null;
      mainWindow?.webContents.send('processing-output', { type: 'error', text: err.message });
      resolve({ success: false, error: err.message });
    });
  });
});

ipcMain.handle('stop-processing', () => {
  if (!activeChild) return { success: false, error: 'No process running' };
  activeChild.kill('SIGTERM');
  activeChild = null;
  return { success: true };
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
function renameWithRetry(from, to, attempts = 12) {
  return new Promise((resolve, reject) => {
    const tryOnce = (n) => {
      try { fs.renameSync(from, to); resolve(); }
      catch (err) {
        if (n > 0 && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
          setTimeout(() => tryOnce(n - 1), Math.min(1500, 40 * 2 ** (attempts - n)));
        } else {
          reject(err);
        }
      }
    };
    tryOnce(attempts);
  });
}

// Merge freshly imported clips into drive-data.json under the write lock.
// The API imports fetch for minutes; merging against a re-read of the file
// (rather than the snapshot taken before the fetch) keeps writes made in the
// meantime — tag edits, drive removals — from being clobbered.
function saveImportedClips(filePath, clips) {
  logger.info('import', `saving ${clips.length} imported clip(s) → ${filePath}`);
  return withDriveDataLock(async () => {
    let data;
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak'); // pre-import restore point
      data = await readDriveData(filePath, { wantProcessedFiles: true });
    } else {
      data = { routes: [], processedFiles: [], driveTags: {} };
    }
    if (!Array.isArray(data.routes)) data.routes = [];
    if (!Array.isArray(data.processedFiles)) data.processedFiles = [];
    for (const clip of clips) {
      data.routes.push(clip);
      data.processedFiles.push(clip.file);
    }
    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(filePath, data);
  });
}

function writeDriveDataJSON(filePath, data) {
  // Write to a unique temp file, then atomically rename over the target so
  // readers (the streaming loader, get/set-drive-tags, etc.) never see a
  // half-written/truncated file — the cause of intermittent "Unexpected end of
  // JSON input" errors when a read overlapped a write.
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmpPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { ws.destroy(); } catch {}
      fs.unlink(tmpPath, () => reject(err));
    };
    ws.on('error', fail);
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      renameWithRetry(tmpPath, filePath).then(resolve, (err) => fs.unlink(tmpPath, () => reject(err)));
    });

    const write = (chunk) => {
      // Respect backpressure — wait for drain on full buffers.
      if (!ws.write(chunk)) return new Promise((r) => ws.once('drain', r));
      return null;
    };

    (async () => {
      try {
        await write('{\n');

        // processedFiles
        await write('  "processedFiles": ');
        await write(JSON.stringify(data.processedFiles ?? [], null, 2).replace(/\n/g, '\n  '));
        await write(',\n');

        // routes — one compact object per line to avoid one huge string
        const routes = Array.isArray(data.routes) ? data.routes : [];
        await write('  "routes": [');
        for (let i = 0; i < routes.length; i++) {
          await write(i === 0 ? '\n    ' : ',\n    ');
          await write(JSON.stringify(routes[i]));
        }
        if (routes.length > 0) await write('\n  ');
        await write('],\n');

        // driveTags
        await write('  "driveTags": ');
        await write(JSON.stringify(data.driveTags ?? {}, null, 2).replace(/\n/g, '\n  '));

        await write('\n}\n');
        ws.end();
      } catch (err) {
        fail(err);
      }
    })();
  });
}

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

ipcMain.handle('get-drive-tags', async (_e, filePath) => {
  try {
    const data = await readDriveData(filePath);
    return { success: true, driveTags: data.driveTags ?? {} };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('set-drive-tags', (_e, { filePath, driveKey, tags }) => withDriveDataLock(async () => {
  try {
    const data = await readDriveData(filePath, { wantProcessedFiles: true });
    if (!data.driveTags) data.driveTags = {};

    if (tags.length === 0) {
      delete data.driveTags[driveKey];
    } else {
      data.driveTags[driveKey] = tags;
    }

    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(filePath, data);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}));

ipcMain.handle('get-all-tag-names', async (_e, filePath) => {
  try {
    const data = await readDriveData(filePath);
    const driveTags = data.driveTags ?? {};
    const set = new Set();
    for (const tags of Object.values(driveTags)) {
      for (const t of tags) set.add(t);
    }
    return { success: true, tags: [...set].sort() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('revert-gps', (_e, filePath) => {
  try {
    const bakPath = filePath + '.bak';
    if (!fs.existsSync(bakPath)) return { success: false, error: 'No backup file found.' };
    fs.copyFileSync(bakPath, filePath);
    return { success: true };
  } catch (err) {
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
    return { success: true, bridgedGaps, routedGaps, removedBridges };
  } catch (err) {
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

ipcMain.handle('tessie-api-preview', async (_e, { token, vin, fromSec, toSec, driveDataPath }) => {
  try {
    const { fetchDrives } = require('../processing/tessie-api.cjs');
    const { buildExistingDriveRanges, hasOverlap, buildExternalSignature } = require('../processing/tessie-import.cjs');

    logger.info('import', `tessie preview: vehicle …${String(vin).slice(-6)}, window ${fromSec}→${toSec}`);
    const drives = await fetchDrives(token, vin, { from: fromSec, to: toSec });

    // Build existing-drive index from current drive-data.json
    let existingRanges = [];
    const existingSignatures = new Set();
    if (driveDataPath && fs.existsSync(driveDataPath)) {
      const data = await readDriveData(driveDataPath);
      const { groupIntoDrives } = await import('../processing/grouper.js');
      const { drives: existing } = groupIntoDrives(data.routes ?? []);
      existingRanges = buildExistingDriveRanges(existing);
      for (const r of (data.routes ?? [])) {
        if (r.externalSignature) existingSignatures.add(r.externalSignature);
      }
    }

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

    // Snapshot for overlap/duplicate decisions only — the authoritative merge
    // re-reads the file under the drive-data lock at save time (the fetch loop
    // below can run for minutes while tags or removals land in between).
    let data;
    if (fs.existsSync(driveDataPath)) {
      data = await readDriveData(driveDataPath);
    } else {
      data = { routes: [], processedFiles: [], driveTags: {} };
    }
    if (!Array.isArray(data.routes)) data.routes = [];

    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives: existingDrives } = groupIntoDrives(data.routes);
    const existingRanges = buildExistingDriveRanges(existingDrives);
    const existingSignatures = new Set();
    for (const r of data.routes) {
      if (r.externalSignature) existingSignatures.add(r.externalSignature);
    }

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
    if (newClips.length > 0) await saveImportedClips(driveDataPath, newClips);

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

    let existingRanges = [];
    const existingSignatures = new Set();
    if (driveDataPath && fs.existsSync(driveDataPath)) {
      const data = await readDriveData(driveDataPath, { wantProcessedFiles: true });
      const { groupIntoDrives } = await import('../processing/grouper.js');
      const { drives: existing } = groupIntoDrives(data.routes ?? []);
      existingRanges = buildExistingDriveRanges(existing);
      for (const r of (data.routes ?? [])) {
        if (r.externalSignature) existingSignatures.add(r.externalSignature);
      }
    }

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
    return { success: true, totalDrives: drives.length, toImport, overlapSkipped, duplicateSkipped };
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

    // Snapshot for overlap/duplicate decisions only — the authoritative merge
    // re-reads the file under the drive-data lock at save time (see the
    // Tessie API import above).
    let data;
    if (fs.existsSync(driveDataPath)) {
      data = await readDriveData(driveDataPath);
    } else {
      data = { routes: [], processedFiles: [], driveTags: {} };
    }
    if (!Array.isArray(data.routes)) data.routes = [];

    const { groupIntoDrives } = await import('../processing/grouper.js');
    const { drives: existingDrives } = groupIntoDrives(data.routes);
    const existingRanges = buildExistingDriveRanges(existingDrives);
    const existingSignatures = new Set();
    for (const r of data.routes) {
      if (r.externalSignature) existingSignatures.add(r.externalSignature);
    }

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
    if (newClips.length > 0) await saveImportedClips(driveDataPath, newClips);
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

    // Build SEI ranges and find Tessie drives that overlap them.
    const seiRanges = [];
    for (const d of drives) {
      if (d.source === 'tessie' || !d.startTime || !d.endTime) continue;
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
