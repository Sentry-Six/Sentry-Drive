'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { chain } = require('stream-chain');
const parser = require('stream-json/parser.js');
const Assembler = require('stream-json/assembler.js');

// Give V8 more old-space headroom so the main process can parse large
// drive-data.json files (hundreds of MB to ~1GB). Must be set before
// app.whenReady(). The renderer inherits the same flag.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');

let mainWindow;
let activeChild = null;
let driveDetailCache = null;

// ─── Streaming drive-data.json reader ───────────────────────────────────────
// JSON.parse on a 900MB+ file OOMs the main process: it requires the source
// JS string (V8 caps strings at ~1GB) plus the parsed tree (~3-5x the source
// size) in heap simultaneously. This streams the file once, capturing each
// top-level field with the minimum memory needed:
//
//   • routes      — built one element at a time with a sub-Assembler
//   • driveTags   — assembled in full (usually small)
//   • processedFiles — counted only; the actual file paths aren't needed
//                     downstream, just the count for the UI footer
//
// Three-pass parsing (one stream per field) works but takes 3x longer because
// each pass re-tokenizes the whole file. Single-pass parses the 939MB user
// file in ~80s vs ~360s for three passes.

function readDriveDataStreaming(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    let processedFileCount = 0;
    const routes = [];
    let driveTags = {};

    // depth: 1 = inside top-level object; 2 = inside a top-level field's
    // value (array or object); 3 = inside a route element.
    let depth = 0;
    let currentTopKey = null;
    let asm = null;             // sub-assembler for current route or driveTags
    let asmExitDepth = -1;      // depth at which asm completes

    // Track raw bytes read so we can drive a progress bar in the renderer.
    // Throttled to ~10 updates/sec to keep IPC traffic reasonable.
    const totalBytes = onProgress ? fs.statSync(filePath).size : 0;
    let bytesRead = 0;
    let lastEmit = 0;

    const readStream = fs.createReadStream(filePath);
    if (onProgress) {
      readStream.on('data', (chunk) => {
        bytesRead += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 100) {
          lastEmit = now;
          onProgress(bytesRead, totalBytes);
        }
      });
    }

    const pipeline = chain([
      readStream,
      parser({ packKeys: true, packStrings: true, packNumbers: true }),
    ]);

    pipeline.on('data', (token) => {
      const name = token.name;

      if (asm) {
        asm.consume(token);
        if (name === 'startObject' || name === 'startArray') depth++;
        else if (name === 'endObject' || name === 'endArray') {
          depth--;
          if (depth === asmExitDepth) {
            if (currentTopKey === 'routes') routes.push(asm.current);
            else if (currentTopKey === 'driveTags') driveTags = asm.current;
            asm = null;
          }
        }
        return;
      }

      if (name === 'startObject' || name === 'startArray') {
        const before = depth;
        depth++;
        // Start assembling a route element (object at depth 3, inside routes array).
        if (before === 2 && name === 'startObject' && currentTopKey === 'routes') {
          asm = new Assembler();
          asmExitDepth = before;
          asm.consume(token);
        }
        // Start assembling the driveTags object (object at depth 2, value of driveTags key).
        else if (before === 1 && name === 'startObject' && currentTopKey === 'driveTags') {
          asm = new Assembler();
          asmExitDepth = before;
          asm.consume(token);
        }
      } else if (name === 'endObject' || name === 'endArray') {
        depth--;
        if (depth === 1) currentTopKey = null;
      } else if (name === 'keyValue' && depth === 1) {
        currentTopKey = token.value;
      } else if (name === 'stringValue' && depth === 2 && currentTopKey === 'processedFiles') {
        processedFileCount++;
      }
    });

    pipeline.on('end', () => {
      if (onProgress && totalBytes > 0) onProgress(totalBytes, totalBytes);
      resolve({ processedFileCount, routes, driveTags });
    });
    pipeline.on('error', reject);
  });
}

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
autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err.message }));

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

ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('set-allow-prerelease', (_e, allow) => {
  autoUpdater.allowPrerelease = allow;
});

ipcMain.handle('remove-drive', async (_e, { filePath, driveStartTime }) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
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
});

ipcMain.handle('revert-to-stable', () => {
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = true;
  return autoUpdater.checkForUpdates().catch(() => {});
});

ipcMain.handle('check-for-update', () => autoUpdater.checkForUpdates().catch(() => {}));

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

    // Stream-parse the file in a single pass — JSON.parse on a 900MB+ file
    // OOMs the main process even with --max-old-space-size=8192 because peak
    // memory (source string + parsed tree) hits 3-5x the file size.
    const parsed = await readDriveDataStreaming(filePath, (current, total) => {
      sendProgress('reading', current, total);
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

    // SEI always wins: any imported (Tessie) drive whose time window overlaps
    // a real dashcam drive is hidden at load time. The Tessie clips remain in
    // drive-data.json so the user can recover them by removing SEI later;
    // they're just filtered out of the displayed drive list.
    const seiRanges = [];
    for (const d of groupedDrives) {
      if (d.source === 'tessie' || !d.startTime || !d.endTime) continue;
      const s = Date.parse(d.startTime);
      const e = Date.parse(d.endTime);
      if (Number.isFinite(s) && Number.isFinite(e)) seiRanges.push({ s, e });
    }
    seiRanges.sort((a, b) => a.s - b.s);

    let hiddenTessieCount = 0;
    const hiddenTessieDrives = [];
    const drives = [];
    for (const d of groupedDrives) {
      if (d.source === 'tessie') {
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
    return { success: false, error: `spawn failed: ${err.message}` };
  }

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
function writeDriveDataJSON(filePath, data) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    let errored = false;
    ws.on('error', (err) => { errored = true; reject(err); });
    ws.on('finish', () => { if (!errored) resolve(); });

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
        errored = true;
        ws.destroy();
        reject(err);
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

ipcMain.handle('get-drive-tags', (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { success: true, driveTags: data.driveTags ?? {} };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('set-drive-tags', async (_e, { filePath, driveKey, tags }) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
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
});

ipcMain.handle('get-all-tag-names', (_e, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
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

ipcMain.handle('repair-gps', async (_e, { filePath, useRouting }) => {
  try {
    sendRepairProgress('Reading…', 0, 1);
    const raw = fs.readFileSync(filePath, 'utf-8');
    fs.copyFileSync(filePath, filePath + '.bak');
    const data = JSON.parse(raw);
    let routes = await decodeRoutesByteFields(data.routes ?? []);
    let bridgedGaps = 0;
    let routedGaps = 0;

    const toRad = (d) => (d * Math.PI) / 180;
    const haversineM = (lat1, lon1, lat2, lon2) => {
      const R = 6371000;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

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
    const GEAR_PARK = 0;
    const MIN_BRIDGE_MS = 60 * 1000;
    const MAX_BRIDGE_MS = 5 * 60 * 1000;
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

      const curEnd = new Date(cur.ts.getTime() + 60000);
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
      const distM = haversineM(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);
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
});

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
      const raw = fs.readFileSync(driveDataPath, 'utf-8');
      const data = JSON.parse(raw);
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

ipcMain.handle('tessie-import', async (_e, { driveDataPath, drivesCsvPath, statesCsvPath, useRouting }) => {
  tessieImportCancel = false;
  try {
    const tessieMod = require('../processing/tessie-import.cjs');
    const { parseDrivesCSV, parseDrivingStatesCSV, buildExistingDriveRanges, hasOverlap, buildExternalSignature, buildClipsForDrive, calibrateDriveTime } = tessieMod;

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
      data = JSON.parse(fs.readFileSync(driveDataPath, 'utf-8'));
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
});

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

    const drives = await fetchDrives(token, vin, { from: fromSec, to: toSec });

    // Build existing-drive index from current drive-data.json
    let existingRanges = [];
    const existingSignatures = new Set();
    if (driveDataPath && fs.existsSync(driveDataPath)) {
      const raw = fs.readFileSync(driveDataPath, 'utf-8');
      const data = JSON.parse(raw);
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

    return { success: true, totalDrives: drives.length, toImport, overlapSkipped, duplicateSkipped };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('tessie-api-import', async (_e, { token, vin, fromSec, toSec, driveDataPath }) => {
  tessieApiCancel = false;
  try {
    const { fetchDrives, fetchPath, Throttler } = require('../processing/tessie-api.cjs');
    const { buildExistingDriveRanges, hasOverlap, buildExternalSignature, buildClipsForApiDrive } = require('../processing/tessie-import.cjs');

    sendTessieProgress({ phase: 'Fetching drives list…', current: 0, total: 1 });
    const drivesList = await fetchDrives(token, vin, { from: fromSec, to: toSec });

    // Load or init drive data
    let data;
    if (fs.existsSync(driveDataPath)) {
      fs.copyFileSync(driveDataPath, driveDataPath + '.bak');
      data = JSON.parse(fs.readFileSync(driveDataPath, 'utf-8'));
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
      for (const clip of result.clips) {
        data.routes.push(clip);
        data.processedFiles.push(clip.file);
      }
      imported++;
    }

    sendTessieProgress({ phase: 'Saving…', current: candidates.length, total: candidates.length });
    data.routes = await routesToWireFormat(data.routes);
    await writeDriveDataJSON(driveDataPath, data);

    return { success: true, imported, canceled, totalCandidates: candidates.length, skipReasons };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    tessieApiCancel = false;
  }
});

// Remove only the Tessie clips whose grouped drive is hidden by SEI overlap.
// Useful for cleaning up legacy imports that landed on the wrong side of an
// overlap-check edge case before this was tightened.
ipcMain.handle('tessie-remove-hidden', async (_e, { driveDataPath }) => {
  try {
    if (!fs.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
    const data = JSON.parse(fs.readFileSync(driveDataPath, 'utf-8'));

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
});

ipcMain.handle('tessie-remove-all', async (_e, { driveDataPath }) => {
  try {
    if (!fs.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
    fs.copyFileSync(driveDataPath, driveDataPath + '.bak');
    const data = JSON.parse(fs.readFileSync(driveDataPath, 'utf-8'));

    const tessieFiles = new Set(
      (data.routes ?? [])
        .filter((r) => r.source === 'tessie')
        .map((r) => (r.file || '').replace(/\\/g, '/'))
    );
    const removed = tessieFiles.size;
    if (removed === 0) return { success: true, removed: 0 };

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
});
