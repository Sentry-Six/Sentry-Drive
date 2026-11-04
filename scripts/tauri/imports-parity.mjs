#!/usr/bin/env node
// Tessie / Teslascope import parity: run the JavaScript import code (the
// processing modules plus the Electron handler bodies, reproduced below) over
// scripts/tauri/fixtures/imports, run the Rust port over the same fixtures
// (`cargo run --example imports_dump`), and diff the two dumps.
//
//   node scripts/tauri/imports-parity.mjs                     # dump both + compare
//   node scripts/tauri/imports-parity.mjs dump <out.json> <workdir>
//   node scripts/tauri/imports-parity.mjs compare <js.json> <rust.json>
//
// Both sides run with TZ=America/Denver (clip filenames and SEI timestamps are
// local wall-clock). HTTP is faked from tessie-api.json / teslascope-api.json,
// so the request URLs and headers each side sends are compared too. The
// write-path steps run every handler against a scratch copy of
// drive-data.json and compare the parsed file (key order included) after each
// step.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const FIX = path.join(root, 'scripts/tauri/fixtures/imports');
const TZ = 'America/Denver';

// ── JSON encoding shared with the Rust dumper ──────────────────────────────
// NaN / ±Infinity / undefined are made explicit so they can't collapse into
// null; byte arrays are base64 like encodeByteField.
function enc(v) {
  if (v === undefined) return '__undefined';
  if (typeof v === 'number') return Number.isFinite(v) ? v : `__${v}`;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = enc(x);
    return o;
  }
  return v;
}

const wire = (clips) => clips.map((c) => ({
  ...c,
  autopilotStates: Buffer.from(c.autopilotStates).toString('base64'),
  gearStates: Buffer.from(c.gearStates).toString('base64'),
}));
const built = (r) => (r.clips ? { clips: wire(r.clips), pointCount: r.pointCount } : { clips: null, reason: r.reason });
const attempt = (f) => { try { return f(); } catch (e) { return { __error: e.message }; } };

// ── Fake HTTPS (same rules as the Rust FakeHttp) ───────────────────────────
const tessieFix = JSON.parse(fs.readFileSync(path.join(FIX, 'tessie-api.json'), 'utf8'));
const tscFix = JSON.parse(fs.readFileSync(path.join(FIX, 'teslascope-api.json'), 'utf8'));
const requests = [];

function fakeResponse(host, p, headers) {
  const route = (fix) => {
    const r = fix.routes[p];
    if (!r) return { status: 404, body: 'Not Found' };
    return { status: r.status, body: r.json !== undefined ? JSON.stringify(r.json) : r.text };
  };
  if (host === 'api.tessie.com') {
    if (headers.Authorization !== tessieFix.auth) return { status: 401, body: '{"error":"unauthorized"}' };
    return route(tessieFix);
  }
  if (host === 'teslascope.com') {
    const key = /[?&]api_key=([^&]*)/.exec(p);
    if (headers.Authorization || !key || decodeURIComponent(key[1]) !== tscFix.legacyKey) return { status: 401, body: 'Unauthorized' };
    return route(tscFix);
  }
  return { status: 404, body: 'Not Found' };
}

function installFakeHttps() {
  const https = require('https');
  https.get = (options, cb) => {
    const { host, path: p, headers } = options;
    requests.push({ host, path: p, headers: Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) });
    const req = new EventEmitter();
    req.destroy = () => {};
    const { status, body } = fakeResponse(host, p, headers);
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      cb(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    return req;
  };
}

// ── Electron handler bodies (src/main/electron-main.cjs, verbatim logic) ───
function electronHandlers(events) {
  const fsx = fs;
  const { readDriveData } = require(path.join(root, 'src/main/drive-data-reader.cjs'));
  const { writeDriveDataJSON: writeShared } = require(path.join(root, 'src/main/drive-data-writer.cjs'));
  const logger = { info() {}, warn() {}, error() {} };
  const mainWindow = { isDestroyed: () => false, webContents: { send: (ch, data) => events.push([ch, data]) } };
  const H = {};
  const ipcMain = { handle: (name, fn) => { H[name] = (args) => fn(null, args); } };
  const grouperP = import(path.join(root, 'src/processing/grouper.js'));

  async function routesToWireFormat(routes) {
    if (!Array.isArray(routes)) return routes;
    const { encodeByteField: encode } = await grouperP;
    return routes.map((r) => ({ ...r, autopilotStates: encode(r.autopilotStates), gearStates: encode(r.gearStates) }));
  }
  let driveDataLock = Promise.resolve();
  function withDriveDataLock(fn) {
    const result = driveDataLock.then(fn, fn);
    driveDataLock = result.then(() => {}, () => {});
    return result;
  }
  const writeDriveDataJSON = (filePath, data) => writeShared(filePath, data, {});
  function saveImportedClips(filePath, clips, onProgress, tagsToMerge) {
    return withDriveDataLock(async () => {
      let data;
      if (fsx.existsSync(filePath)) {
        fsx.copyFileSync(filePath, filePath + '.bak');
        data = await readDriveData(filePath, {
          wantProcessedFiles: true,
          onProgress: onProgress ? (current, total) => onProgress({ phase: 'Saving — reading current data…', current, total }) : undefined,
        });
      } else {
        data = { routes: [], processedFiles: [], driveTags: {} };
      }
      if (!Array.isArray(data.routes)) data.routes = [];
      if (!Array.isArray(data.processedFiles)) data.processedFiles = [];
      for (const clip of clips) { data.routes.push(clip); data.processedFiles.push(clip.file); }
      if (tagsToMerge && typeof tagsToMerge === 'object') { /* unused by these importers */ }
      if (onProgress) onProgress({ phase: 'Saving — writing drive data…', current: 0, total: 0 });
      data.routes = await routesToWireFormat(data.routes);
      await writeDriveDataJSON(filePath, data);
    });
  }
  const sendTessieProgress = (d) => mainWindow?.webContents.send('tessie-progress', d);
  const sendTeslascopeProgress = (d) => mainWindow?.webContents.send('teslascope-progress', d);
  const tiPath = path.join(root, 'src/processing/tessie-import.cjs');
  const taPath = path.join(root, 'src/processing/tessie-api.cjs');
  const tsPath = path.join(root, 'src/processing/teslascope-api.cjs');
  // `new Throttler(1000)` in the app; zero here so the run doesn't sleep.
  const fastThrottler = (Mod) => class extends Mod.Throttler { constructor() { super(0); } };

  let tessieImportCancel = false;
  ipcMain.handle('tessie-preview', async (_e, { driveDataPath, drivesCsvPath, statesCsvPath }) => {
    try {
      const { parseDrivesCSV, parseDrivingStatesCSV, buildExistingDriveRanges, hasOverlap, buildExternalSignature, calibrateDriveTime } = require(tiPath);
      const drivesText = fsx.readFileSync(drivesCsvPath, 'utf-8');
      const statesText = fsx.readFileSync(statesCsvPath, 'utf-8');
      const rawDrives = parseDrivesCSV(drivesText);
      const statesIndex = parseDrivingStatesCSV(statesText);
      const tDrives = rawDrives.map((d) => calibrateDriveTime(d, statesIndex));
      let existingRanges = [];
      const existingSignatures = new Set();
      if (fsx.existsSync(driveDataPath)) {
        const data = await readDriveData(driveDataPath);
        const { groupIntoDrives } = await grouperP;
        const { drives } = groupIntoDrives(data.routes ?? []);
        existingRanges = buildExistingDriveRanges(drives);
        for (const r of (data.routes ?? [])) if (r.externalSignature) existingSignatures.add(r.externalSignature);
      }
      let toImport = 0, overlapSkipped = 0, duplicateSkipped = 0;
      for (const d of tDrives) {
        if (existingSignatures.has(buildExternalSignature(d))) { duplicateSkipped++; continue; }
        if (hasOverlap(d, existingRanges)) { overlapSkipped++; continue; }
        toImport++;
      }
      return { success: true, totalDrives: tDrives.length, toImport, overlapSkipped, duplicateSkipped, statePointCount: statesIndex.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('tessie-import', (_e, { driveDataPath, drivesCsvPath, statesCsvPath }) => withDriveDataLock(async () => {
    tessieImportCancel = false;
    try {
      const { parseDrivesCSV, parseDrivingStatesCSV, buildExistingDriveRanges, hasOverlap, buildExternalSignature, buildClipsForDrive, calibrateDriveTime } = require(tiPath);
      sendTessieProgress({ phase: 'Reading CSVs…', current: 0, total: 1 });
      const drivesText = fsx.readFileSync(drivesCsvPath, 'utf-8');
      const statesText = fsx.readFileSync(statesCsvPath, 'utf-8');
      const rawDrives = parseDrivesCSV(drivesText);
      const statesIndex = parseDrivingStatesCSV(statesText);
      const tDrives = rawDrives.map((d) => calibrateDriveTime(d, statesIndex));
      let data;
      if (fsx.existsSync(driveDataPath)) {
        fsx.copyFileSync(driveDataPath, driveDataPath + '.bak');
        data = await readDriveData(driveDataPath, { wantProcessedFiles: true });
      } else {
        data = { routes: [], processedFiles: [], driveTags: {} };
      }
      if (!Array.isArray(data.routes)) data.routes = [];
      if (!Array.isArray(data.processedFiles)) data.processedFiles = [];
      const { groupIntoDrives } = await grouperP;
      const { drives: existingDrives } = groupIntoDrives(data.routes);
      const existingRanges = buildExistingDriveRanges(existingDrives);
      const existingSignatures = new Set();
      for (const r of data.routes) if (r.externalSignature) existingSignatures.add(r.externalSignature);
      const candidates = [];
      for (const d of tDrives) {
        if (existingSignatures.has(buildExternalSignature(d))) continue;
        if (hasOverlap(d, existingRanges)) continue;
        candidates.push(d);
      }
      sendTessieProgress({ phase: 'Building clips…', current: 0, total: candidates.length });
      let imported = 0, canceled = false;
      const skipReasons = {};
      const startMs = Date.now();
      for (let i = 0; i < candidates.length; i++) {
        if (tessieImportCancel) { canceled = true; break; }
        const d = candidates[i];
        const elapsed = Date.now() - startMs;
        const etaSec = i > 0 ? Math.round((elapsed / i) * (candidates.length - i) / 1000) : 0;
        sendTessieProgress({ phase: 'Building clips…', current: i + 1, total: candidates.length, etaSec });
        const result = buildClipsForDrive(d, statesIndex);
        if (!result.clips) { const key = result.reason || 'unknown'; skipReasons[key] = (skipReasons[key] || 0) + 1; continue; }
        for (const clip of result.clips) { data.routes.push(clip); data.processedFiles.push(clip.file); }
        imported++;
      }
      sendTessieProgress({ phase: 'Saving…', current: candidates.length, total: candidates.length });
      data.routes = await routesToWireFormat(data.routes);
      await writeDriveDataJSON(driveDataPath, data);
      return { success: true, imported, canceled, totalCandidates: candidates.length, skipReasons };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      tessieImportCancel = false;
    }
  }));

  ipcMain.handle('tessie-api-validate', async (_e, { token }) => {
    try {
      const { fetchVehicles } = require(taPath);
      const vehicles = await fetchVehicles(token);
      return { success: true, vehicles: vehicles.map((v) => ({ vin: v.vin || v.last_state?.vehicle_state?.vin, displayName: v.last_state?.display_name || v.last_state?.vehicle_state?.vehicle_name || '' })).filter((v) => v.vin) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  let tessieApiCancel = false;
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
  let _overlapIndexCache = null;
  async function getOverlapIndex(driveDataPath) {
    if (!driveDataPath || !fsx.existsSync(driveDataPath)) return { ranges: [], signatures: new Set() };
    const st = fsx.statSync(driveDataPath);
    const key = `${driveDataPath}|${st.mtimeMs}|${st.size}`;
    if (_overlapIndexCache && _overlapIndexCache.key === key) return { ranges: _overlapIndexCache.ranges, signatures: _overlapIndexCache.signatures };
    const { buildExistingDriveRanges } = require(tiPath);
    const data = await readDriveData(driveDataPath);
    const { groupIntoDrives } = await grouperP;
    const { drives: existing } = groupIntoDrives(data.routes ?? []);
    const ranges = buildExistingDriveRanges(existing);
    const signatures = new Set();
    for (const r of (data.routes ?? [])) if (r.externalSignature) signatures.add(r.externalSignature);
    _overlapIndexCache = { key, ranges, signatures };
    return { ranges, signatures };
  }
  ipcMain.handle('tessie-api-preview', async (_e, { token, vin, fromSec, toSec, driveDataPath }) => {
    try {
      const { fetchDrives } = require(taPath);
      const { hasOverlap, buildExternalSignature } = require(tiPath);
      const drives = await fetchDrives(token, vin, { from: fromSec, to: toSec });
      const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);
      let toImport = 0, overlapSkipped = 0, duplicateSkipped = 0;
      for (const d of drives) {
        const normalized = { startedAt: (d.started_at ?? 0) * 1000, endedAt: (d.ended_at ?? 0) * 1000, startingOdometer: d.starting_odometer ?? null };
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
      const mod = require(taPath);
      const { fetchDrives, fetchPath } = mod;
      const Throttler = fastThrottler(mod);
      const { hasOverlap, buildExternalSignature, buildClipsForApiDrive } = require(tiPath);
      sendTessieProgress({ phase: 'Fetching drives list…', current: 0, total: 1 });
      const drivesList = await fetchDrives(token, vin, { from: fromSec, to: toSec });
      const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);
      const candidates = [];
      for (const d of drivesList) {
        const normalized = { startedAt: (d.started_at ?? 0) * 1000, endedAt: (d.ended_at ?? 0) * 1000, startingOdometer: d.starting_odometer ?? null };
        if (existingSignatures.has(buildExternalSignature(normalized))) continue;
        if (hasOverlap(normalized, existingRanges)) continue;
        candidates.push(d);
      }
      sendTessieProgress({ phase: 'Fetching paths…', current: 0, total: candidates.length });
      const throttler = new Throttler(1000);
      const newClips = [];
      let imported = 0, canceled = false;
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
          pathBuckets = await fetchPath(token, vin, { from: d.started_at, to: d.ended_at, separate: true, simplify: false, details: true });
        } catch (err) {
          skipReasons['fetch-error'] = (skipReasons['fetch-error'] || 0) + 1;
          continue;
        }
        const points = pathBuckets.length > 0 ? pathBuckets[0] : [];
        const apiDrive = normalizeApiDrive(d, points);
        const result = buildClipsForApiDrive(apiDrive);
        if (!result.clips) { skipReasons[result.reason || 'unknown'] = (skipReasons[result.reason || 'unknown'] || 0) + 1; continue; }
        newClips.push(...result.clips);
        imported++;
      }
      sendTessieProgress({ phase: 'Saving…', current: candidates.length, total: candidates.length });
      if (newClips.length > 0) await saveImportedClips(driveDataPath, newClips, sendTessieProgress);
      return { success: true, imported, canceled, totalCandidates: candidates.length, skipReasons };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      tessieApiCancel = false;
    }
  });

  ipcMain.handle('teslascope-api-validate', async (_e, { token }) => {
    try {
      const { fetchVehicles } = require(tsPath);
      const vehicles = await fetchVehicles(token);
      return { success: true, vehicles: vehicles.map((v) => ({ publicId: v.publicId, vin: v.vin || '', displayName: v.displayName || v.name || v.vin || 'Vehicle' })).filter((v) => v.publicId != null) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  let teslascopeApiCancel = false;
  ipcMain.handle('teslascope-api-preview', async (_e, { token, publicId, fromSec, toSec, driveDataPath }) => {
    try {
      const { fetchDrives, normalizeDrive } = require(tsPath);
      const { hasOverlap, buildExternalSignature } = require(tiPath);
      const drives = await fetchDrives(token, publicId, { from: fromSec, to: toSec });
      const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);
      let toImport = 0, overlapSkipped = 0, duplicateSkipped = 0, badTimestamps = 0;
      for (const d of drives) {
        const n = normalizeDrive(d);
        if (!Number.isFinite(n.startedAt) || !Number.isFinite(n.endedAt)) { badTimestamps++; continue; }
        const key = { startedAt: n.startedAt, endedAt: n.endedAt, startingOdometer: n.startingOdometer };
        if (existingSignatures.has(buildExternalSignature(key, 'teslascope'))) { duplicateSkipped++; continue; }
        if (hasOverlap(key, existingRanges)) { overlapSkipped++; continue; }
        toImport++;
      }
      return { success: true, totalDrives: drives.length, toImport, overlapSkipped, duplicateSkipped, badTimestamps };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('teslascope-api-import', async (_e, { token, publicId, fromSec, toSec, driveDataPath }) => {
    teslascopeApiCancel = false;
    try {
      const mod = require(tsPath);
      const { fetchDrives, fetchDrivePath, normalizeDrive } = mod;
      const Throttler = fastThrottler(mod);
      const { hasOverlap, buildExternalSignature, buildClipsForApiDrive } = require(tiPath);
      sendTeslascopeProgress({ phase: 'Fetching drives list…', current: 0, total: 1 });
      const drivesList = await fetchDrives(token, publicId, { from: fromSec, to: toSec });
      const { ranges: existingRanges, signatures: existingSignatures } = await getOverlapIndex(driveDataPath);
      const candidates = [];
      let badTimestamps = 0;
      for (const d of drivesList) {
        const n = normalizeDrive(d);
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
        try { detail = await fetchDrivePath(token, publicId, summary.id); } catch (err) { skipReasons['detail-fetch-error'] = (skipReasons['detail-fetch-error'] || 0) + 1; }
        const apiDrive = normalizeDrive(d, detail);
        const result = buildClipsForApiDrive(apiDrive, 'teslascope');
        if (!result.clips) { skipReasons[result.reason || 'unknown'] = (skipReasons[result.reason || 'unknown'] || 0) + 1; continue; }
        newClips.push(...result.clips);
        imported++;
      }
      sendTeslascopeProgress({ phase: 'Saving…', current: candidates.length, total: candidates.length });
      if (newClips.length > 0) await saveImportedClips(driveDataPath, newClips, sendTeslascopeProgress);
      return { success: true, imported, canceled, totalCandidates: candidates.length, skipReasons };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      teslascopeApiCancel = false;
    }
  });

  const removeHidden = (source) => (_e, { driveDataPath }) => withDriveDataLock(async () => {
    try {
      if (!fsx.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
      const data = await readDriveData(driveDataPath, { wantProcessedFiles: true });
      const { groupIntoDrives } = await grouperP;
      const { drives } = groupIntoDrives(data.routes ?? []);
      const seiRanges = [];
      for (const d of drives) {
        if (d.source !== 'sei' || !d.startTime || !d.endTime) continue;
        const s = Date.parse(d.startTime), e = Date.parse(d.endTime);
        if (Number.isFinite(s) && Number.isFinite(e)) seiRanges.push({ s, e });
      }
      seiRanges.sort((a, b) => a.s - b.s);
      const hiddenSignatures = new Set();
      for (const d of drives) {
        if (d.source !== source) continue;
        const s = Date.parse(d.startTime), e = Date.parse(d.endTime);
        for (const r of seiRanges) {
          if (r.e <= s) continue;
          if (r.s >= e) break;
          if (d.externalSignature) hiddenSignatures.add(d.externalSignature);
          break;
        }
      }
      if (hiddenSignatures.size === 0) return { success: true, removed: 0 };
      fsx.copyFileSync(driveDataPath, driveDataPath + '.bak');
      const before = (data.routes ?? []).length;
      data.routes = (data.routes ?? []).filter((r) => !(r.source === source && hiddenSignatures.has(r.externalSignature)));
      const removedRoutes = before - data.routes.length;
      data.routes = await routesToWireFormat(data.routes);
      await writeDriveDataJSON(driveDataPath, data);
      return { success: true, removed: hiddenSignatures.size, removedRoutes };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  const removeAll = (source) => (_e, { driveDataPath }) => withDriveDataLock(async () => {
    try {
      if (!fsx.existsSync(driveDataPath)) return { success: false, error: 'File not found' };
      fsx.copyFileSync(driveDataPath, driveDataPath + '.bak');
      const data = await readDriveData(driveDataPath, { wantProcessedFiles: true });
      const files = new Set((data.routes ?? []).filter((r) => r.source === source).map((r) => (r.file || '').replace(/\\/g, '/')));
      if (files.size === 0) return { success: true, removed: 0 };
      const { groupIntoDrives } = await grouperP;
      const { drives: grouped } = groupIntoDrives(data.routes ?? []);
      const removed = grouped.filter((d) => d.source === source).length;
      data.routes = (data.routes ?? []).filter((r) => r.source !== source);
      data.processedFiles = (data.processedFiles ?? []).filter((f) => !files.has((f || '').replace(/\\/g, '/')));
      data.routes = await routesToWireFormat(data.routes);
      await writeDriveDataJSON(driveDataPath, data);
      return { success: true, removed };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('tessie-remove-hidden', removeHidden('tessie'));
  ipcMain.handle('tessie-remove-all', removeAll('tessie'));
  ipcMain.handle('teslascope-remove-hidden', removeHidden('teslascope'));
  ipcMain.handle('teslascope-remove-all', removeAll('teslascope'));
  return H;
}

// ── The shared step list (mirrored in src-tauri/examples/imports_dump.rs) ──
export function steps(work) {
  const args = JSON.parse(fs.readFileSync(path.join(FIX, 'args.json'), 'utf8'));
  const dd = path.join(work, 'drive-data.json');
  const fresh = path.join(work, 'new.json');
  const missing = path.join(work, 'missing.json');
  const csv = { drivesCsvPath: path.join(FIX, 'drives.csv'), statesCsvPath: path.join(FIX, 'driving_states.csv') };
  const tsArgs = { ...args.teslascope, driveDataPath: dd };
  const tArgs = { ...args.tessie, driveDataPath: dd };
  return [
    ['tessie-preview', { driveDataPath: missing, ...csv }, null],
    ['tessie-preview', { driveDataPath: dd, ...csv }, null],
    ['tessie-preview', { driveDataPath: dd, ...csv, drivesCsvPath: path.join(FIX, 'drives-bad-tz.csv') }, null],
    ['tessie-preview', { driveDataPath: dd, ...csv, statesCsvPath: path.join(FIX, 'nope.csv') }, null],
    ['tessie-import', { driveDataPath: dd, ...csv }, dd],
    ['tessie-import', { driveDataPath: dd, ...csv }, dd],
    ['tessie-import', { driveDataPath: fresh, ...csv }, fresh],
    ['tessie-import', { driveDataPath: fresh, ...csv, drivesCsvPath: path.join(FIX, 'drives-legacy.csv') }, fresh],
    ['tessie-api-validate', { token: 'wrong' }, null],
    ['tessie-api-validate', { token: args.tessie.token }, null],
    ['tessie-api-preview', tArgs, null],
    ['tessie-api-import', tArgs, dd],
    ['tessie-api-preview', tArgs, null],
    ['teslascope-api-validate', { token: 'wrong' }, null],
    ['teslascope-api-validate', { token: args.teslascope.token }, null],
    ['teslascope-api-preview', tsArgs, null],
    ['teslascope-api-import', tsArgs, dd],
    ['teslascope-api-preview', tsArgs, null],
    ['tessie-remove-hidden', { driveDataPath: dd }, dd],
    ['teslascope-remove-hidden', { driveDataPath: dd }, dd],
    ['teslascope-remove-hidden', { driveDataPath: dd }, dd],
    ['tessie-remove-all', { driveDataPath: dd }, dd],
    ['teslascope-remove-all', { driveDataPath: dd }, dd],
    ['tessie-remove-all', { driveDataPath: dd }, dd],
    ['tessie-remove-hidden', { driveDataPath: missing }, null],
  ];
}

// Raw text: the comparison parses both sides with JSON.parse (serde_json's
// default float parser is not correctly rounded, so Rust must not re-parse).
const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

/// Progress events with the timing-dependent etaSec masked and consecutive
/// duplicates collapsed (Electron's reader reports the same final byte count
/// twice on small files).
function normEvents(events) {
  const out = [];
  for (const [ch, d] of events) {
    const e = JSON.stringify([ch, 'etaSec' in d ? { ...d, etaSec: 'eta' } : d]);
    if (out[out.length - 1] !== e) out.push(e);
  }
  return out.map((e) => JSON.parse(e));
}

async function dump(outPath, work) {
  if (process.env.TZ !== TZ) throw new Error(`run with TZ=${TZ}`);
  installFakeHttps();
  const ti = require(path.join(root, 'src/processing/tessie-import.cjs'));
  const ts = require(path.join(root, 'src/processing/teslascope-api.cjs'));
  const { readDriveData } = require(path.join(root, 'src/main/drive-data-reader.cjs'));
  const { groupIntoDrives } = await import(path.join(root, 'src/processing/grouper.js'));
  const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf-8');
  const out = {};

  // CSV parsing, calibration, signatures, clip building.
  const states = ti.parseDrivingStatesCSV(read('driving_states.csv'));
  const drives = ti.parseDrivesCSV(read('drives.csv'));
  const legacy = ti.parseDrivesCSV(read('drives-legacy.csv'));
  out.csvDrives = enc(drives);
  out.csvLegacy = enc(legacy);
  out.csvBadTz = attempt(() => enc(ti.parseDrivesCSV(read('drives-bad-tz.csv'))));
  out.states = enc(states);
  const cal = drives.map((d) => ti.calibrateDriveTime(d, states));
  out.calibrated = enc(cal);
  out.signatures = cal.map((d) => ti.buildExternalSignature(d));
  out.built = drives.map((d) => built(ti.buildClipsForDrive(d, states)));
  out.legacyBuilt = legacy.map((d) => built(ti.buildClipsForDrive(d, states)));
  out.sigCases = [
    [1721052000000, 12345.675, 'tessie'], [1721052059999, 0.125, 'tessie'], [-1, 99999.995, 'tessie'], [0, 1.005, 'teslascope'],
    [NaN, null, 'tessie'], [1.5e12, -0.125, 'tessie'], [1721052000000, undefined, 'teslascope'], [1721052000000, 1e21, 'tessie'],
  ].map(([startedAt, startingOdometer, source]) => ti.buildExternalSignature({ startedAt, startingOdometer }, source));

  // Overlap against the fixture drive-data.json.
  const data = await readDriveData(path.join(FIX, 'drive-data.json'));
  const ranges = ti.buildExistingDriveRanges(groupIntoDrives(data.routes).drives);
  out.ranges = enc(ranges);
  out.overlap = cal.map((d) => ti.hasOverlap(d, ranges));

  // Teslascope normalization and clips straight from the fixture responses.
  const dates = JSON.parse(read('date-strings.json'));
  out.toMs = dates.map((s) => enc(ts._internals.toMs(s)));
  out.num = ['12.5', ' 7', '1e3x', 'abc', '', 3, null, true, '-0.5'].map((v) => enc(ts._internals.num(v)));
  out.mapAutopilot = ['on', ' Active ', 'FSD', 'standby', '', 'true', '1', 1, 0, -1, true, false, null, 'engaged!'].map((v) => ts.mapAutopilot(v));
  const unwrap = (b) => { let x = b; for (let i = 0; i < 3 && x && typeof x === 'object' && !Array.isArray(x); i++) { const inner = x.response ?? x.result ?? x.payload; if (inner == null) break; x = inner; } return x; };
  const tsList = unwrap(tscFix.routes['/api/vehicle/tsv1/drives?limit=100&api_key=ts-key'].json).drives;
  out.tsNormalized = [];
  out.tsBuilt = [];
  for (const raw of tsList) {
    const r = tscFix.routes[`/api/vehicle/tsv1/drive/${encodeURIComponent(String(raw.id))}?api_key=ts-key`];
    const body = r?.json !== undefined ? unwrap(r.json) : null;
    const det = body == null ? null : (ts._internals.pick(body, ['drive', 'result', 'data']) ?? body);
    const n = ts.normalizeDrive(raw, det);
    out.tsNormalized.push(enc(ts.normalizeDrive(raw)), enc(n));
    out.tsBuilt.push(Number.isFinite(n.startedAt) ? built(ti.buildClipsForApiDrive(n, 'teslascope')) : null);
  }

  // Handlers against a scratch copy, step by step.
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'drive-data.json'), path.join(work, 'drive-data.json'));
  const events = [];
  const H = electronHandlers(events);
  out.steps = [];
  for (const [name, args, file] of steps(work)) {
    events.length = 0;
    requests.length = 0;
    const result = await H[name](args);
    out.steps.push({
      name,
      result,
      events: normEvents(events),
      requests: [...requests],
      file: file ? readText(file) : null,
      bak: file ? readText(file + '.bak') : null,
    });
  }
  fs.writeFileSync(outPath, JSON.stringify(out));
}

// ── Compare ────────────────────────────────────────────────────────────────
function firstDiff(a, b, at = '$') {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    return `${at}: ${JSON.stringify(a)?.slice(0, 160)} vs ${JSON.stringify(b)?.slice(0, 160)}`;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${at}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join() !== kb.join()) return `${at}: keys [${ka}] vs [${kb}]`;
    for (const k of ka) { const d = firstDiff(a[k], b[k], `${at}.${k}`); if (d) return d; }
    return null;
  }
  return a === b ? null : `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

function compare(jsPath, rustPath) {
  const js = JSON.parse(fs.readFileSync(jsPath, 'utf8'));
  const rs = JSON.parse(fs.readFileSync(rustPath, 'utf8'));
  let failures = 0;
  const report = (label, a, b, note = '') => {
    const d = firstDiff(a, b);
    if (d) failures++;
    console.log(`${d ? 'DIFF' : 'ok  '}  ${label}${note}${d ? `\n        ${d}` : ''}`);
  };
  // Known, accepted divergence: V8's legacy Date.parse also reads month-name
  // forms ("Jan 5 2024", RFC 2822); the port returns NaN for them.
  const dates = JSON.parse(fs.readFileSync(path.join(FIX, 'date-strings.json'), 'utf8'));
  const known = dates.map((d) => typeof d === 'string' && /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(d));
  js.toMs = js.toMs.map((v, i) => {
    if (!known[i] || firstDiff(v, rs.toMs?.[i]) == null) return v;
    console.log(`known toMs[${i}]  Date.parse(${JSON.stringify(dates[i])}): JS ${v}, Rust ${rs.toMs?.[i]} (month-name form not ported)`);
    return rs.toMs[i];
  });
  for (const key of Object.keys(js)) {
    if (key === 'steps') continue;
    const n = Array.isArray(js[key]) ? ` (${js[key].length})` : '';
    report(key, js[key], rs[key], n);
  }
  const clipCount = (f) => (f?.routes ?? []).filter((r) => r.source === 'tessie' || r.source === 'teslascope').length;
  const parse = (t) => (t == null ? null : JSON.parse(t));
  let identical = 0, written = 0;
  js.steps.forEach((s, i) => {
    const r = rs.steps?.[i] ?? {};
    const tag = `step ${String(i + 1).padStart(2)} ${s.name}`;
    report(`${tag} result`, s.result, r.result, ` ${JSON.stringify(s.result).slice(0, 110)}`);
    report(`${tag} events`, s.events, r.events, ` (${s.events.length})`);
    report(`${tag} requests`, s.requests, r.requests, ` (${s.requests.length})`);
    if (s.file || r.file) {
      const [a, b] = [parse(s.file), parse(r.file)];
      written++;
      if (s.file === r.file) identical++;
      report(`${tag} file`, a, b, ` (${a?.routes?.length ?? 0} routes, ${clipCount(a)} imported${s.file === r.file ? ', byte-identical' : ''})`);
    }
    if (s.bak || r.bak) report(`${tag} .bak`, parse(s.bak), parse(r.bak), s.bak === r.bak ? ' (byte-identical)' : '');
  });
  console.log(`\n${identical}/${written} written files byte-identical`);
  console.log(failures ? `${failures} difference(s)` : 'all sections match');
  return failures;
}

// ── main ───────────────────────────────────────────────────────────────────
const [mode, a, b] = process.argv.slice(2);
if (mode === 'dump') {
  await dump(a, b);
} else if (mode === 'compare') {
  process.exitCode = compare(a, b) ? 1 : 0;
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-imports-parity-'));
  const env = { ...process.env, TZ };
  const jsOut = path.join(tmp, 'js.json');
  const rsOut = path.join(tmp, 'rust.json');
  let r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'dump', jsOut, path.join(tmp, 'js')], { env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  r = spawnSync('cargo', ['run', '-q', '--example', 'imports_dump', '--', FIX, path.join(tmp, 'rust'), rsOut], {
    cwd: path.join(root, 'src-tauri'), env, stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`dumps: ${jsOut}  ${rsOut}\n`);
  process.exitCode = compare(jsOut, rsOut) ? 1 : 0;
}
