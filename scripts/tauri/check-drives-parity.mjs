#!/usr/bin/env node
// Check Drives parity: run Electron's repair-gps / check-summon handler logic
// (copied from src/main/electron-main.cjs, minus IPC and progress) on a
// drive-data.json copy, and digest a file for comparison with the Rust port.
//
//   node scripts/tauri/check-drives-parity.mjs repair <file>
//   node scripts/tauri/check-drives-parity.mjs summon <file> <clipsDir>
//   node scripts/tauri/check-drives-parity.mjs digest <file> <out.ndjson>
//   node scripts/tauri/check-drives-parity.mjs compare <a.ndjson> <b.ndjson>
//
// Run both sides with the same TZ (e.g. TZ=America/Denver). Never point it at
// a drive-data.json you care about: repair and summon rewrite the file.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const { readDriveData } = require('../../src/main/drive-data-reader.cjs');
const { writeDriveDataJSON } = require('../../src/main/drive-data-writer.cjs');
const {
  geodesicM, GEAR_PARK, CLIP_DURATION_MS, DRIVE_GAP_MS,
  SUMMON_MAX_SPEED_MPS, SUMMON_MAX_DURATION_MS, MPS_TO_MPH,
  computeGearRuns, computeFlagRuns, computeApRuns,
} = require('../../src/shared/drive-calc.cjs');
const { normalizeClipPath } = require('../../src/shared/clip-path.cjs');
const grouper = await import('../../src/processing/grouper.js');
const path = (await import('node:path')).default;

const decodeRoutesByteFields = (routes) => routes.map((r) => ({
  ...r, autopilotStates: grouper.decodeByteField(r.autopilotStates), gearStates: grouper.decodeByteField(r.gearStates),
}));
const routesToWireFormat = (routes) => routes.map((r) => ({
  ...r, autopilotStates: grouper.encodeByteField(r.autopilotStates), gearStates: grouper.encodeByteField(r.gearStates),
}));

async function repair(filePath) {
  fs.copyFileSync(filePath, filePath + '.bak');
  const data = await readDriveData(filePath, { wantProcessedFiles: true });
  let routes = decodeRoutesByteFields(data.routes ?? []);
  let bridgedGaps = 0;
  const routedGaps = 0;
  const FILE_TS_RE = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/;
  const parseTs = (file) => {
    const m = FILE_TS_RE.exec(file);
    if (!m) return null;
    const t = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
    return isNaN(t.getTime()) ? null : t;
  };
  const beforeCount = routes.length;
  routes = routes.filter((r) => !r.file.includes('-front-bridge.mp4'));
  data.routes = routes;
  if (data.processedFiles) data.processedFiles = data.processedFiles.filter((f) => !f.includes('-front-bridge.mp4'));
  const removedBridges = beforeCount - routes.length;
  const timedRoutes = routes.map((r, idx) => ({ idx, ts: parseTs(r.file), route: r }))
    .filter((r) => r.ts !== null).sort((a, b) => a.ts - b.ts);
  const gaps = [];
  for (let i = 0; i < timedRoutes.length - 1; i++) {
    const cur = timedRoutes[i]; const next = timedRoutes[i + 1];
    const curR = cur.route; const nextR = next.route;
    const curEnd = new Date(cur.ts.getTime() + CLIP_DURATION_MS);
    const gapMs = next.ts - curEnd;
    if (gapMs <= CLIP_DURATION_MS || gapMs > DRIVE_GAP_MS) continue;
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
    gaps.push({ lastPt: curR.points[curR.points.length - 1], firstPt: nextR.points[0], curEnd, gapMs, curLastGear, date: curR.date });
  }
  const bridgeRoutes = [];
  for (const { lastPt, firstPt, curEnd, gapMs, curLastGear, date } of gaps) {
    const nSteps = Math.max(2, Math.round(gapMs / 1000));
    const interpPoints = [];
    for (let s = 1; s < nSteps; s++) {
      const t = s / nSteps;
      interpPoints.push([lastPt[0] + (firstPt[0] - lastPt[0]) * t, lastPt[1] + (firstPt[1] - lastPt[1]) * t]);
    }
    const nPts = interpPoints.length;
    const distM = geodesicM(lastPt[0], lastPt[1], firstPt[0], firstPt[1]);
    const avgSpeed = distM / (gapMs / 1000);
    const bridgeTs = new Date(curEnd.getTime());
    const pad = (n) => String(n).padStart(2, '0');
    const synthFile = `${date}/${date}_${pad(bridgeTs.getHours())}-${pad(bridgeTs.getMinutes())}-${pad(bridgeTs.getSeconds())}-front-bridge.mp4`;
    bridgeRoutes.push({
      file: synthFile, date, points: interpPoints,
      gearStates: new Array(nPts).fill(curLastGear ?? 1), autopilotStates: new Array(nPts).fill(0),
      speeds: new Array(nPts).fill(avgSpeed), accelPositions: new Array(nPts).fill(0),
      rawParkCount: 0, rawFrameCount: nPts, gearRuns: [{ gear: curLastGear ?? 1, frames: nPts }],
    });
    bridgedGaps++;
  }
  for (const br of bridgeRoutes) {
    routes.push(br);
    if (!data.processedFiles) data.processedFiles = [];
    data.processedFiles.push(br.file);
  }
  data.routes = routesToWireFormat(routes);
  await writeDriveDataJSON(filePath, data);
  return { success: true, bridgedGaps, routedGaps, removedBridges };
}

function resolveClipPath(clipsDir, normFile) {
  if (!clipsDir) return null;
  const cands = [path.join(clipsDir, normFile)];
  if (/^RecentClips\//i.test(normFile)) cands.push(path.join(clipsDir, normFile.replace(/^RecentClips\//i, '')));
  else if (path.basename(clipsDir).toLowerCase() !== 'recentclips') cands.push(path.join(clipsDir, 'RecentClips', normFile));
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* missing */ } }
  return null;
}

async function summon(filePath, clipsDir) {
  const data = await readDriveData(filePath, { wantProcessedFiles: true });
  const routes = decodeRoutesByteFields(data.routes ?? []);
  const routeByFile = new Map();
  for (const r of routes) routeByFile.set(normalizeClipPath(r.file), r);
  const { drives } = grouper.groupIntoDrives(routes);
  const maxMph = SUMMON_MAX_SPEED_MPS * MPS_TO_MPH + 0.01;
  const MAX_EDGE_CLIPS = 10;
  const routeIsSlow = (norm) => {
    const route = routeByFile.get(norm);
    if (!route || !Array.isArray(route.speeds) || route.speeds.length === 0) return false;
    for (const s of route.speeds) if (Math.abs(s) > SUMMON_MAX_SPEED_MPS) return false;
    return true;
  };
  const hasCurrentEvidence = (route) =>
    Array.isArray(route.flagRuns) && route.flagRuns.length > 0 &&
    route.flagRuns.every((run) => Number.isFinite(run.maxMps)) &&
    Array.isArray(route.apRuns) && route.apRuns.length > 0;
  const pending = new Map();
  const addClip = (f) => {
    const norm = normalizeClipPath(f);
    if (norm.includes('-front-bridge.mp4')) return;
    const route = routeByFile.get(norm);
    if (route && !hasCurrentEvidence(route)) pending.set(norm, route);
  };
  let candidateDrives = 0;
  for (const d of drives) {
    if ((d.source ?? 'sei') !== 'sei' || d.summon) continue;
    const files = d.routeFiles ?? [];
    if (files.length === 0) continue;
    const wholeDrive = (d.maxSpeedMph ?? 0) <= maxMph && (d.durationMs ?? 0) <= SUMMON_MAX_DURATION_MS;
    if (wholeDrive) { candidateDrives++; for (const f of files) addClip(f); continue; }
    let took = false;
    for (let i = 0; i < Math.min(files.length, MAX_EDGE_CLIPS); i++) {
      const norm = normalizeClipPath(files[i]);
      if (!routeIsSlow(norm)) { if (took) addClip(files[i]); break; }
      addClip(files[i]); took = true;
    }
    let tookTail = false;
    for (let i = 0; i < Math.min(files.length, MAX_EDGE_CLIPS); i++) {
      const norm = normalizeClipPath(files[files.length - 1 - i]);
      if (!routeIsSlow(norm)) { if (tookTail) addClip(files[files.length - 1 - i]); break; }
      addClip(files[files.length - 1 - i]); tookTail = true;
    }
    if (took || tookTail) candidateDrives++;
  }
  const { extractGPSFromFile } = await import('../../src/processing/extract.js');
  let scanned = 0, updated = 0, missing = 0;
  for (const [norm, route] of pending.entries()) {
    const fullPath = resolveClipPath(clipsDir, norm);
    if (!fullPath) { missing++; continue; }
    try {
      const extracted = await extractGPSFromFile(fullPath);
      scanned++;
      if (extracted && extracted.flags && extracted.flags.length > 0) {
        route.flagRuns = computeFlagRuns(extracted.flags, extracted.speeds);
        route.gearRuns = computeGearRuns(extracted.gears);
        route.apRuns = computeApRuns(extracted.apStates);
        route.rawFrameCount = extracted.gears.length;
        let parkCount = 0;
        for (const g of extracted.gears) if (g === GEAR_PARK) parkCount++;
        route.rawParkCount = parkCount;
        updated++;
      }
    } catch { missing++; }
  }
  if (updated > 0) {
    fs.copyFileSync(filePath, filePath + '.bak');
    data.routes = routesToWireFormat(routes);
    await writeDriveDataJSON(filePath, data);
  }
  return { success: true, candidateDrives, clipsScanned: scanned, updatedRoutes: updated, missingClips: missing };
}

// One line per route (file + hash of its canonical JSON, byte fields as
// base64), then processedFiles and driveTags hashes. Key order matters.
async function digest(filePath, out) {
  const data = await readDriveData(filePath, { wantProcessedFiles: true });
  const lines = [];
  for (const r of data.routes ?? []) {
    const c = { ...r, autopilotStates: grouper.encodeByteField(grouper.decodeByteField(r.autopilotStates)), gearStates: grouper.encodeByteField(grouper.decodeByteField(r.gearStates)) };
    if (r.autopilotStates === undefined) delete c.autopilotStates;
    if (r.gearStates === undefined) delete c.gearStates;
    const json = JSON.stringify(c);
    lines.push(`${r.file}\t${crypto.createHash('sha1').update(json).digest('hex')}`);
  }
  lines.push(`processedFiles\t${crypto.createHash('sha1').update(JSON.stringify(data.processedFiles ?? null)).digest('hex')}`);
  lines.push(`driveTags\t${crypto.createHash('sha1').update(JSON.stringify(data.driveTags ?? null)).digest('hex')}`);
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`${lines.length - 2} routes digested`);
}

async function compare(a, b) {
  const read = async (p) => {
    const out = [];
    for await (const line of readline.createInterface({ input: fs.createReadStream(p) })) out.push(line);
    return out;
  };
  const [la, lb] = [await read(a), await read(b)];
  let diffs = 0;
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) { if (diffs < 10) console.log(`line ${i + 1}:\n  ${la[i]}\n  ${lb[i]}`); diffs++; }
  }
  console.log(`${la.length} vs ${lb.length} lines, ${diffs} differ`);
  process.exitCode = diffs ? 1 : 0;
}

const [mode, ...args] = process.argv.slice(2);
const t = Date.now();
if (mode === 'repair') console.log(JSON.stringify(await repair(args[0])));
else if (mode === 'summon') console.log(JSON.stringify(await summon(args[0], args[1])));
else if (mode === 'digest') await digest(args[0], args[1]);
else if (mode === 'compare') await compare(args[0], args[1]);
else { console.error('usage: repair <file> | summon <file> <clipsDir> | digest <file> <out> | compare <a> <b>'); process.exit(2); }
console.error(`${((Date.now() - t) / 1000).toFixed(1)} s`);
