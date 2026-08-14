// Converts Tessie drive and driving-state CSV exports into 60-second synthetic
// clips compatible with the shared Sentry USB route format.

'use strict';

// Preserve raw Tessie GPS. Road matching can choose a plausible but incorrect
// route and materially inflate distance.

const {
  MPH_TO_MPS,
  GEAR_PARK,
  GEAR_DRIVE,
  GEAR_REVERSE,
  GEAR_NEUTRAL,
} = require('../shared/drive-calc.cjs');

// ─── CSV parser (RFC 4180 subset, handles quoted fields with commas) ─────────

function parseCSV(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function rowsToObjects(rows) {
  if (rows.length < 1) return { headers: [], records: [] };
  const headers = rows[0];
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === '') continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = rows[r][c] ?? '';
    }
    records.push(obj);
  }
  return { headers, records };
}

// ─── Timezone handling ───────────────────────────────────────────────────────
// Tessie labels every drive with the export-time timezone; parse that fixed
// offset first, then correct individual DST mismatches against state samples.

const TZ_OFFSET_HOURS = {
  UTC: 0, GMT: 0,
  EDT: -4, EST: -5,
  CDT: -5, CST: -6,
  MDT: -6, MST: -7,
  PDT: -7, PST: -8,
  AKDT: -8, AKST: -9,
  HST: -10,
  BST: 1, CET: 1, CEST: 2,
  AEST: 10, AEDT: 11,
};

function extractTzOffsetMs(header) {
  const m = /\(([A-Z]{2,5})\)/.exec(header || '');
  if (!m) return -4 * 3600000;
  const tz = m[1].toUpperCase();
  if (tz in TZ_OFFSET_HOURS) return TZ_OFFSET_HOURS[tz] * 3600000;
  return -4 * 3600000;
}

// "2024-09-08 19:19" or "2024-09-08 19:19:30" → epoch ms, applying offset
function parseLocalTimestamp(str, offsetMs) {
  if (!str) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str.trim());
  if (!m) return NaN;
  const [, Y, Mo, D, H, Mi, S] = m;
  const asUtc = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0));
  return asUtc - offsetMs;
}

function parseUtcTimestamp(str) {
  if (!str) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str.trim());
  if (!m) return NaN;
  const [, Y, Mo, D, H, Mi, S] = m;
  return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S || 0));
}

// ─── CSV → structured data ───────────────────────────────────────────────────

function parseDrivesCSV(text) {
  const rows = parseCSV(text);
  const { headers, records } = rowsToObjects(rows);
  const startCol = headers.find((h) => h.startsWith('Started At'));
  const endCol = headers.find((h) => h.startsWith('Ended At'));
  const offsetMs = extractTzOffsetMs(startCol);

  const out = [];
  for (const r of records) {
    const startedAt = parseLocalTimestamp(r[startCol], offsetMs);
    const endedAt = parseLocalTimestamp(r[endCol], offsetMs);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) continue;

    const distanceMi = parseFloat(r['Distance (mi)']);
    const autopilotDistanceMi = parseFloat(r['Autopilot Distance (mi)']);
    const startingOdometer = parseFloat(r['Starting Odometer (mi)']);
    const endingOdometer = parseFloat(r['Ending Odometer (mi)']);
    const startLat = parseFloat(r['Starting Latitude']);
    const startLng = parseFloat(r['Starting Longitude']);
    const endLat = parseFloat(r['Ending Latitude']);
    const endLng = parseFloat(r['Ending Longitude']);

    out.push({
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      distanceMi: Number.isFinite(distanceMi) ? distanceMi : 0,
      autopilotDistanceMi: Number.isFinite(autopilotDistanceMi) ? autopilotDistanceMi : 0,
      startingOdometer: Number.isFinite(startingOdometer) ? startingOdometer : null,
      endingOdometer: Number.isFinite(endingOdometer) ? endingOdometer : null,
      startLat: Number.isFinite(startLat) ? startLat : null,
      startLng: Number.isFinite(startLng) ? startLng : null,
      endLat: Number.isFinite(endLat) ? endLat : null,
      endLng: Number.isFinite(endLng) ? endLng : null,
    });
  }
  return out;
}

function parseDrivingStatesCSV(text) {
  const rows = parseCSV(text);
  const { records } = rowsToObjects(rows);

  const out = [];
  for (const r of records) {
    const timeMs = parseUtcTimestamp(r['Timestamp (UTC)']);
    const lat = parseFloat(r['Latitude']);
    const lng = parseFloat(r['Longitude']);
    if (!Number.isFinite(timeMs) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const shift = (r['Shift State'] || '').trim().toUpperCase();
    const speedMph = parseFloat(r['Speed (mph)']);
    const odometer = parseFloat(r['Odometer (mi)']);

    out.push({
      timeMs,
      lat,
      lng,
      shift,
      speedMph: Number.isFinite(speedMph) ? speedMph : 0,
      odometer: Number.isFinite(odometer) ? odometer : null,
    });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

// ─── Joining drives ↔ points ─────────────────────────────────────────────────

const GEAR_MAP = { P: GEAR_PARK, D: GEAR_DRIVE, R: GEAR_REVERSE, N: GEAR_NEUTRAL };

/**
 * Correct an export-time timezone mismatch by anchoring the drive to a nearby
 * driving-state sample with an authoritative UTC timestamp.
 */
function calibrateDriveTime(drive, statesIndex) {
  if (drive.startLat == null || drive.startLng == null) return drive;

  // Cover timezone errors without matching an unrelated visit.
  const searchWindow = 6 * 3600 * 1000;
  const lo = drive.startedAt - searchWindow;
  const hi = drive.startedAt + searchWindow;

  let best = null;
  let bestDelta = Infinity;
  for (const s of statesIndex) {
    if (s.timeMs < lo) continue;
    if (s.timeMs > hi) break;
    if (s.shift !== 'D') continue;
    // Match the declared start within roughly 300 m.
    const dLat = (s.lat - drive.startLat);
    const dLng = (s.lng - drive.startLng);
    if (dLat * dLat + dLng * dLng > 0.003 * 0.003) continue;
    const delta = Math.abs(s.timeMs - drive.startedAt);
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }

  if (!best) return drive;
  const shift = best.timeMs - drive.startedAt;
  if (Math.abs(shift) < 60 * 1000) return drive;

  return {
    ...drive,
    startedAt: drive.startedAt + shift,
    endedAt: drive.endedAt + shift,
    _tzShiftMs: shift,
  };
}

function joinDriveWithPoints(drive, statesIndex) {
  // Include moving-gear samples near the drive boundaries.
  const tolerance = 90 * 1000;
  const lo = drive.startedAt - tolerance;
  const hi = drive.endedAt + tolerance;

  const pts = [];
  for (const s of statesIndex) {
    if (s.timeMs < lo) continue;
    if (s.timeMs > hi) break;
    if (s.shift !== 'D' && s.shift !== 'R') continue;
    pts.push(s);
  }
  return pts;
}

// ─── Route builder ───────────────────────────────────────────────────────────

// Stable import identity despite small boundary adjustments between exports.
function buildExternalSignature(drive, source = 'tessie') {
  const minuteBucket = Math.floor(drive.startedAt / 60000);
  const od = drive.startingOdometer != null ? drive.startingOdometer.toFixed(2) : 'x';
  return `${source}:${minuteBucket}:${od}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Use local wall-clock filenames to match SEI parsing. Include the external
// signature so adjacent imports sharing a minute do not deduplicate by path.
function formatClipFilename(windowStartMs, sigSuffix, source = 'tessie') {
  const d = new Date(windowStartMs);
  const Y = d.getFullYear();
  const Mo = pad2(d.getMonth() + 1);
  const D = pad2(d.getDate());
  const H = pad2(d.getHours());
  const Mi = pad2(d.getMinutes());
  const S = pad2(d.getSeconds());
  return `${source}/${Y}-${Mo}-${D}/${Y}-${Mo}-${D}_${H}-${Mi}-${S}-front-${source}-${sigSuffix}.mp4`;
}

function signatureToFilenameSuffix(signature) {
  return signature.replace(/^[a-z]+:/, '').replace(/[^\w]/g, '');
}

function formatClipDate(windowStartMs) {
  const d = new Date(windowStartMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Split a drive into nonempty, 60-second SEI-compatible clips.
 */
function splitIntoSyntheticClips(drive, densePoints, source = 'tessie') {
  if (densePoints.length === 0) return [];

  const firstMs = densePoints[0].timeMs;
  // Align synthetic filenames to Tesla's minute grid.
  const anchor = Math.floor(firstMs / 60000) * 60000;
  const lastMs = densePoints[densePoints.length - 1].timeMs;
  const signature = buildExternalSignature(drive, source);
  const sigSuffix = signatureToFilenameSuffix(signature);
  const autopilotPercent = drive.distanceMi > 0
    ? Math.max(0, Math.min(100, (drive.autopilotDistanceMi / drive.distanceMi) * 100))
    : 0;

  const clips = [];
  for (let wStart = anchor; wStart <= lastMs; wStart += 60000) {
    const wEnd = wStart + 60000;
    const windowPts = densePoints.filter((p) => p.timeMs >= wStart && p.timeMs < wEnd);
    if (windowPts.length === 0) continue;

    const n = windowPts.length;
    const points = windowPts.map((p) => [
      Math.round(p.lat * 1e6) / 1e6,
      Math.round(p.lng * 1e6) / 1e6,
    ]);
    const gearStates = new Uint8Array(n);
    const autopilotStates = new Uint8Array(n); // CSV has no per-point autopilot state.
    const speeds = new Array(n);
    const accelPositions = new Array(n);

    for (let i = 0; i < n; i++) {
      gearStates[i] = windowPts[i].gear ?? 1;
      speeds[i] = Math.max(0, windowPts[i].speedMps ?? 0);
      accelPositions[i] = 0;
    }

    clips.push({
      file: formatClipFilename(wStart, sigSuffix, source),
      date: formatClipDate(wStart),
      points,
      gearStates,
      autopilotStates,
      speeds,
      accelPositions,
      rawParkCount: 0,
      rawFrameCount: n,
      // Avoid synthetic park splits within one imported drive.
      gearRuns: [{ gear: 1, frames: n }],
      source,
      externalSignature: signature,
      tessieAutopilotPercent: Math.round(autopilotPercent * 10) / 10,
    });
  }

  // externalSignature, rather than an injected park clip, separates adjacent
  // imports that share a minute and deduplicate by file path.

  return clips;
}

/**
 * Fill empty minute windows with one linearly interpolated point. Preserve raw
 * samples while preventing polling gaps from fragmenting one drive.
 */
function fillMinuteGaps(rawPts, drive) {
  const anchors = [...rawPts];
  // Cover the full drive even when polling missed either endpoint.
  if (drive.startLat != null && drive.startLng != null && Number.isFinite(drive.startedAt)) {
    anchors.push({ lat: drive.startLat, lng: drive.startLng, timeMs: drive.startedAt, speedMps: 0, gear: 1, synthetic: true });
  }
  if (drive.endLat != null && drive.endLng != null && Number.isFinite(drive.endedAt)) {
    anchors.push({ lat: drive.endLat, lng: drive.endLng, timeMs: drive.endedAt, speedMps: 0, gear: 1, synthetic: true });
  }
  anchors.sort((a, b) => a.timeMs - b.timeMs);
  if (anchors.length < 2) return anchors;

  const minuteKey = (ms) => Math.floor(ms / 60000);
  const occupied = new Set(anchors.map((a) => minuteKey(a.timeMs)));

  const firstMin = minuteKey(anchors[0].timeMs);
  const lastMin = minuteKey(anchors[anchors.length - 1].timeMs);

  const filled = [];
  let bracketIdx = 0;
  for (let m = firstMin; m <= lastMin; m++) {
    if (occupied.has(m)) continue;
    const tMid = m * 60000 + 30000;
    while (bracketIdx < anchors.length - 2 && anchors[bracketIdx + 1].timeMs < tMid) bracketIdx++;
    const a = anchors[bracketIdx];
    const b = anchors[bracketIdx + 1];
    const span = b.timeMs - a.timeMs;
    const frac = span > 0 ? Math.max(0, Math.min(1, (tMid - a.timeMs) / span)) : 0;
    filled.push({
      lat: a.lat + (b.lat - a.lat) * frac,
      lng: a.lng + (b.lng - a.lng) * frac,
      timeMs: tMid,
      speedMps: 0,
      gear: 1,
      synthetic: true,
    });
  }

  return [...anchors, ...filled].sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Build SEI-compatible clips from raw Tessie breadcrumbs plus minute-gap
 * fillers. Fall back to the drive-summary endpoints if polling returned none.
 */
function buildClipsForDrive(originalDrive, statesIndex, source = 'tessie') {
  // Correct DST mismatch against authoritative state timestamps.
  const drive = calibrateDriveTime(originalDrive, statesIndex);
  const raw = joinDriveWithPoints(drive, statesIndex);

  const pts = raw.map((r) => ({
    lat: r.lat,
    lng: r.lng,
    timeMs: r.timeMs,
    speedMps: (r.speedMph || 0) * MPH_TO_MPS,
    gear: GEAR_MAP[r.shift] ?? 1,
  }));

  const allPts = fillMinuteGaps(pts, drive);
  if (allPts.length < 2) return { clips: null, reason: 'no-coords' };

  const clips = splitIntoSyntheticClips(drive, allPts, source);
  if (clips.length === 0) return { clips: null, reason: 'no-clips' };

  return { clips, pointCount: allPts.length };
}

// ─── Overlap detection ───────────────────────────────────────────────────────

function buildExistingDriveRanges(existingDrives) {
  const ranges = [];
  for (const d of existingDrives) {
    if (!d.startTime || !d.endTime) continue;
    // Naive SEI timestamps parse in local time, matching converted Tessie epochs.
    const start = Date.parse(d.startTime);
    const end = Date.parse(d.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    ranges.push({ start, end, source: d.source ?? 'sei' });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function hasOverlap(drive, ranges) {
  // Skip any overlap after widening to synthetic clips' minute boundaries.
  const start = Math.floor(drive.startedAt / 60000) * 60000;
  const end = Math.ceil(drive.endedAt / 60000) * 60000;
  for (const r of ranges) {
    if (r.end <= start) continue;
    if (r.start >= end) break;
    return true;
  }
  return false;
}

// ─── API path-based clip builder ─────────────────────────────────────────────
// API imports already contain dense, per-point telemetry.

const { mapAutopilotString } = require('./tessie-api.cjs');

/**
 * apiDrive: normalized drive summary, should include id, startedAt, endedAt,
 *   distanceMi, autopilotDistanceMi, startLat/Lng, endLat/Lng, and points[]
 *   where each point has { timestamp, latitude, longitude, speed?, autopilot? }
 */
function buildClipsForApiDrive(apiDrive, source = 'tessie') {
  const rawPoints = Array.isArray(apiDrive.points) ? apiDrive.points : [];

  const pts = rawPoints
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    .map((p) => ({
      lat: p.latitude,
      lng: p.longitude,
      // Tessie path timestamps are Unix seconds.
      timeMs: p.timestamp > 1e12 ? p.timestamp : p.timestamp * 1000,
      // Tessie speed is mph; the route contract uses m/s.
      speedMps: Number.isFinite(p.speed) ? p.speed * MPH_TO_MPS : 0,
      gear: 1,
      apState: mapAutopilotString(p.autopilot),
    }))
    .sort((a, b) => a.timeMs - b.timeMs);

  // Fall back to summary endpoints when the API omits path points.
  if (pts.length < 2) {
    const fallback = [];
    if (apiDrive.startLat != null && apiDrive.startLng != null && Number.isFinite(apiDrive.startedAt)) {
      fallback.push({ lat: apiDrive.startLat, lng: apiDrive.startLng, timeMs: apiDrive.startedAt, speedMps: 0, gear: 1, apState: 0 });
    }
    if (apiDrive.endLat != null && apiDrive.endLng != null && Number.isFinite(apiDrive.endedAt)) {
      fallback.push({ lat: apiDrive.endLat, lng: apiDrive.endLng, timeMs: apiDrive.endedAt, speedMps: 0, gear: 1, apState: 0 });
    }
    if (fallback.length < 2) return { clips: null, reason: 'no-points' };
    pts.push(...fallback);
  }

  const clips = splitIntoApiClips(apiDrive, pts, source);
  if (clips.length === 0) return { clips: null, reason: 'no-clips' };
  return { clips, pointCount: pts.length };
}

function splitIntoApiClips(drive, pts, source = 'tessie') {
  const firstMs = pts[0].timeMs;
  const lastMs = pts[pts.length - 1].timeMs;
  const anchor = Math.floor(firstMs / 60000) * 60000;
  const signature = buildExternalSignature(drive, source);
  const sigSuffix = signatureToFilenameSuffix(signature);
  const autopilotPercent = drive.distanceMi > 0
    ? Math.max(0, Math.min(100, (drive.autopilotDistanceMi / drive.distanceMi) * 100))
    : 0;

  const clips = [];
  for (let wStart = anchor; wStart <= lastMs; wStart += 60000) {
    const wEnd = wStart + 60000;
    const windowPts = pts.filter((p) => p.timeMs >= wStart && p.timeMs < wEnd);
    if (windowPts.length === 0) continue;

    const n = windowPts.length;
    const points = windowPts.map((p) => [
      Math.round(p.lat * 1e6) / 1e6,
      Math.round(p.lng * 1e6) / 1e6,
    ]);
    const gearStates = new Uint8Array(n);
    const autopilotStates = new Uint8Array(n);
    const speeds = new Array(n);
    const accelPositions = new Array(n);

    for (let i = 0; i < n; i++) {
      gearStates[i] = windowPts[i].gear ?? 1;
      autopilotStates[i] = windowPts[i].apState ?? 0;
      speeds[i] = Math.max(0, windowPts[i].speedMps ?? 0);
      accelPositions[i] = 0;
    }

    clips.push({
      file: formatClipFilename(wStart, sigSuffix, source),
      date: formatClipDate(wStart),
      points,
      gearStates,
      autopilotStates,
      speeds,
      accelPositions,
      rawParkCount: 0,
      rawFrameCount: n,
      gearRuns: [{ gear: 1, frames: n }],
      source,
      externalSignature: signature,
      tessieAutopilotPercent: Math.round(autopilotPercent * 10) / 10,
    });
  }
  return clips;
}

module.exports = {
  parseDrivesCSV,
  parseDrivingStatesCSV,
  joinDriveWithPoints,
  buildClipsForDrive,
  buildClipsForApiDrive,
  buildExternalSignature,
  buildExistingDriveRanges,
  hasOverlap,
  calibrateDriveTime,
};
