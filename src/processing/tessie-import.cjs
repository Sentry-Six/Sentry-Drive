// tessie-import.js - Import Tessie CSV exports as synthetic SEI-compatible routes
//
// Input: two CSV files exported from Tessie.com:
//   - drives CSV: one row per drive with start/end time, odometer, autopilot total
//   - driving_states CSV: ~60s-cadence GPS breadcrumbs (lat, lng, shift, speed)
//
// Output: an array of route objects matching Sentry-USB's wire format, so the
// grouper pipeline can ingest them alongside native SEI clips. Each Tessie
// drive becomes multiple 60-second synthetic "clips" so the existing
// per-clip timestamp interpolation in buildDriveStats stays correct.

'use strict';

// Raw Tessie GPS is kept as-is — no OSRM densification. Road-matching was
// introducing large distance errors (e.g. ~16 mi trips becoming 22 mi when
// OSRM chose a highway route the driver didn't actually take). Straight
// lines between the breadcrumbs Tessie gives us look less pretty but match
// reality much more closely.

// Drive-math constants and haversine come from the shared single-source module.
const {
  haversineM,
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
    if (rows[r].length === 1 && rows[r][0] === '') continue; // blank trailing line
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = rows[r][c] ?? '';
    }
    records.push(obj);
  }
  return { headers, records };
}

// ─── Timezone handling ───────────────────────────────────────────────────────
// Tessie's drives CSV header includes the export-time TZ abbreviation, e.g.
// "Started At (EDT)". We treat that as a fixed offset for every row in the
// file — Tessie displays all timestamps in the user's current zone regardless
// of when the drive actually happened, so a single offset is the correct read.

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
  return asUtc - offsetMs; // local → true UTC
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
 * Tessie's drives CSV header names a timezone (e.g. "EDT") that reflects the
 * user's TZ at EXPORT time, not the drive's actual TZ. Winter drives in an
 * export taken during summer get labeled with the wrong offset, so EDT→UTC
 * conversion lands the drive ±1h from reality. We correct this per-drive by
 * finding the driving_states sample near the drive's start coordinates and
 * using its real UTC timestamp as the anchor.
 */
function calibrateDriveTime(drive, statesIndex) {
  if (drive.startLat == null || drive.startLng == null) return drive;

  // Search a wide enough window to cover DST flips and any TZ labeling error,
  // but not so wide we match an unrelated visit to the same location.
  const searchWindow = 6 * 3600 * 1000;
  const lo = drive.startedAt - searchWindow;
  const hi = drive.startedAt + searchWindow;

  let best = null;
  let bestDelta = Infinity;
  for (const s of statesIndex) {
    if (s.timeMs < lo) continue;
    if (s.timeMs > hi) break;
    if (s.shift !== 'D') continue;
    // Location filter — within ~300m of the declared start.
    const dLat = (s.lat - drive.startLat);
    const dLng = (s.lng - drive.startLng);
    if (dLat * dLat + dLng * dLng > 0.003 * 0.003) continue;
    const delta = Math.abs(s.timeMs - drive.startedAt);
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }

  if (!best) return drive;
  const shift = best.timeMs - drive.startedAt;
  if (Math.abs(shift) < 60 * 1000) return drive; // already well-aligned

  return {
    ...drive,
    startedAt: drive.startedAt + shift,
    endedAt: drive.endedAt + shift,
    _tzShiftMs: shift,
  };
}

function joinDriveWithPoints(drive, statesIndex) {
  // Grab every state sample inside the drive's [start, end] window that
  // is a moving gear (D or R). Include a small padding so a point exactly
  // on the boundary still counts.
  const tolerance = 90 * 1000; // 90s
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

// Stable signature for idempotent re-imports. Combines rounded-to-minute
// start time and starting odometer — both are stable even if Tessie slightly
// adjusts drive boundaries between exports.
function buildExternalSignature(drive) {
  const minuteBucket = Math.floor(drive.startedAt / 60000);
  const od = drive.startingOdometer != null ? drive.startingOdometer.toFixed(2) : 'x';
  return `tessie:${minuteBucket}:${od}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Filenames use LOCAL wall-clock time to match the SEI convention: Tesla
// dashcam files are named with the vehicle's local time, and grouper.js
// parses them with `new Date(iso)` which JS treats as local. Emitting UTC
// here would shift Tessie drives by the TZ offset relative to neighbors.
//
// sigSuffix embeds the drive's external signature so that adjacent Tessie
// drives (e.g. a re-park right at the end of a real drive) don't collide
// on the shared minute boundary — grouper dedupes by file path.
function formatClipFilename(windowStartMs, sigSuffix) {
  const d = new Date(windowStartMs);
  const Y = d.getFullYear();
  const Mo = pad2(d.getMonth() + 1);
  const D = pad2(d.getDate());
  const H = pad2(d.getHours());
  const Mi = pad2(d.getMinutes());
  const S = pad2(d.getSeconds());
  return `tessie/${Y}-${Mo}-${D}/${Y}-${Mo}-${D}_${H}-${Mi}-${S}-front-tessie-${sigSuffix}.mp4`;
}

function signatureToFilenameSuffix(signature) {
  // "tessie:28763976:446.49" → "28763976-44649"
  return signature.replace(/^tessie:/, '').replace(/[^\w]/g, '');
}

function formatClipDate(windowStartMs) {
  const d = new Date(windowStartMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Split a densified drive into 60-second clips that match the SEI per-clip
 * cadence. Each clip must have ≥1 point; empty windows are skipped.
 */
function splitIntoSyntheticClips(drive, densePoints) {
  if (densePoints.length === 0) return [];

  const firstMs = densePoints[0].timeMs;
  // Anchor the clip grid to the minute containing the first point so filenames
  // align to minute boundaries like Tesla dashcam clips do.
  const anchor = Math.floor(firstMs / 60000) * 60000;
  const lastMs = densePoints[densePoints.length - 1].timeMs;
  const signature = buildExternalSignature(drive);
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
    const autopilotStates = new Uint8Array(n); // all 0 — Tessie CSV has no per-point AP
    const speeds = new Array(n);
    const accelPositions = new Array(n);

    for (let i = 0; i < n; i++) {
      gearStates[i] = windowPts[i].gear ?? 1;
      speeds[i] = Math.max(0, windowPts[i].speedMps ?? 0);
      accelPositions[i] = 0;
    }

    clips.push({
      file: formatClipFilename(wStart, sigSuffix),
      date: formatClipDate(wStart),
      points,
      gearStates,
      autopilotStates,
      speeds,
      accelPositions,
      rawParkCount: 0,
      rawFrameCount: n,
      // Single run of drive gear — prevents splitClipAtParkGaps from firing
      gearRuns: [{ gear: 1, frames: n }],
      source: 'tessie',
      externalSignature: signature,
      tessieAutopilotPercent: Math.round(autopilotPercent * 10) / 10,
    });
  }

  // Park-gap injection is not reliable for back-to-back Tessie drives that
  // share a minute boundary — grouper deduplicates clips by file path and
  // sorts by timestamp, so tied timestamps between two Tessie drives can
  // swallow the park clip. Instead, grouper.js::groupIntoDrives now splits
  // time groups by externalSignature, guaranteeing each Tessie drive stays
  // its own drive regardless of spacing.

  return clips;
}

/**
 * Fill in minute-gaps between anchors with a single linearly-interpolated
 * point each. Raw Tessie samples are preserved bit-for-bit; interp only
 * runs for minutes with no real sample. This keeps the route visually
 * honest (straight lines between the points Tessie actually collected)
 * while giving grouper a gapless clip sequence — without this, any Tessie
 * drive with > 5 min of polling gaps would fragment into separate drives.
 */
function fillMinuteGaps(rawPts, drive) {
  const anchors = [...rawPts];
  // Bookend with drive start/end so we cover the full drive span even if
  // Tessie polling only caught a portion of it.
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
    // Find the anchor pair bracketing tMid.
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
 * Build synthetic SEI-compatible clips for a single Tessie drive from its
 * raw ~60s GPS breadcrumbs. No OSRM routing — the polyline just connects
 * the points Tessie actually sampled plus linear-interp minute-fillers so
 * grouper doesn't fragment the drive on > 5min polling gaps. Always
 * produces at least a 2-point straight line (start → end from drives.csv)
 * when Tessie polling missed the drive entirely.
 */
function buildClipsForDrive(originalDrive, statesIndex) {
  // Per-drive TZ correction — Tessie's header-declared offset can be wrong
  // for drives that happened outside the export's DST period.
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

  const clips = splitIntoSyntheticClips(drive, allPts);
  if (clips.length === 0) return { clips: null, reason: 'no-clips' };

  return { clips, pointCount: allPts.length };
}

// ─── Overlap detection ───────────────────────────────────────────────────────

function buildExistingDriveRanges(existingDrives) {
  const ranges = [];
  for (const d of existingDrives) {
    if (!d.startTime || !d.endTime) continue;
    // grouper.js::formatISO emits naive local ISO strings (no TZ suffix).
    // Date.parse() on a naive string interprets it as LOCAL time, which is
    // exactly what we want: both the SEI-drive timestamps and the Tessie
    // drive.startedAt values (converted from Tessie's EDT/EST header) land
    // as true UTC epoch ms, so overlap math is apples-to-apples.
    const start = Date.parse(d.startTime);
    const end = Date.parse(d.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    ranges.push({ start, end, source: d.source ?? 'sei' });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function hasOverlap(drive, ranges) {
  // Gap-only policy: any temporal overlap with an existing drive (any source)
  // causes this Tessie drive to be skipped. Round to minute boundaries to
  // match the load-time hide filter — Tessie's API gives second-precision
  // timestamps, but synthetic clip filenames are minute-aligned, so the
  // effective drive range after grouping is wider than the raw start/end.
  const start = Math.floor(drive.startedAt / 60000) * 60000;
  const end = Math.ceil(drive.endedAt / 60000) * 60000;
  for (const r of ranges) {
    if (r.end <= start) continue; // r ends at or before drive starts → no overlap
    if (r.start >= end) break;     // r starts at or after drive ends → no overlap
    return true;
  }
  return false;
}

// ─── API path-based clip builder ─────────────────────────────────────────────
// For drives fetched via the Tessie API, we already have dense GPS points
// plus per-point autopilot/speed. Skip the CSV-polling join and just emit
// 60-second synthetic clips from the supplied points array.

const { mapAutopilotString } = require('./tessie-api.cjs');

/**
 * apiDrive: normalized drive summary, should include id, startedAt, endedAt,
 *   distanceMi, autopilotDistanceMi, startLat/Lng, endLat/Lng, and points[]
 *   where each point has { timestamp, latitude, longitude, speed?, autopilot? }
 */
function buildClipsForApiDrive(apiDrive) {
  const rawPoints = Array.isArray(apiDrive.points) ? apiDrive.points : [];

  const pts = rawPoints
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    .map((p) => ({
      lat: p.latitude,
      lng: p.longitude,
      // Tessie's /path gives Unix seconds. Normalize to ms.
      timeMs: p.timestamp > 1e12 ? p.timestamp : p.timestamp * 1000,
      // speed is mph; convert to m/s for downstream code.
      speedMps: Number.isFinite(p.speed) ? p.speed * MPH_TO_MPS : 0,
      gear: 1,
      apState: mapAutopilotString(p.autopilot),
    }))
    .sort((a, b) => a.timeMs - b.timeMs);

  // If the API returned no points for some reason, fall back to start/end
  // bookends from the drive summary so we still get something on the map.
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

  const clips = splitIntoApiClips(apiDrive, pts);
  if (clips.length === 0) return { clips: null, reason: 'no-clips' };
  return { clips, pointCount: pts.length };
}

function splitIntoApiClips(drive, pts) {
  const firstMs = pts[0].timeMs;
  const lastMs = pts[pts.length - 1].timeMs;
  const anchor = Math.floor(firstMs / 60000) * 60000;
  const signature = buildExternalSignature(drive);
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
      file: formatClipFilename(wStart, sigSuffix),
      date: formatClipDate(wStart),
      points,
      gearStates,
      autopilotStates,
      speeds,
      accelPositions,
      rawParkCount: 0,
      rawFrameCount: n,
      gearRuns: [{ gear: 1, frames: n }],
      source: 'tessie',
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
