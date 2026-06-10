// teslascope-api.cjs - Teslascope REST API client
//
// Fetches drives (and, where available, per-drive GPS) from teslascope.com.
// Mirrors tessie-api.cjs in shape so the import pipeline can treat both
// providers the same way.
//
// Auth: Bearer access token from Teslascope (Account → Developer / API).
// Endpoints (per https://teslascope.com/developers/documentation):
//   GET /api/account                       → account + vehicles list
//   GET /api/vehicle/:public_id/drives      → list of driving sessions
//   GET /api/vehicle/:public_id/drive/:id   → one driving session (may include a path)
//
// IMPORTANT: Teslascope's per-drive field schema is NOT published (the docs
// hide example bodies behind JS "View Response" widgets). So normalizeDrive()
// and the point extractor accept common field-name variants, and the first raw
// response is logged when TESLASCOPE_DEBUG=1 — paste that log (or a sample
// response) to lock the exact mapping. Until then this is best-effort.

'use strict';

const https = require('https');

const API_HOST = 'teslascope.com';
const DEFAULT_RATE_MS = 1000; // self-throttle; documented limits unknown

// Diagnostics. The field mapping here is best-effort against an undocumented
// schema, so key milestones (and truncated raw responses) are always logged —
// through the injected app logger when running in the main process (exported
// via Settings → Support → Logs), else to stderr when TESLASCOPE_DEBUG=1.
let appLogger = null;
function setLogger(l) { appLogger = l; }
function dbg(...args) {
  if (appLogger) appLogger.info('teslascope', ...args);
  else if (process.env.TESLASCOPE_DEBUG) console.error('[teslascope-api]', ...args);
}

// Teslascope wraps payloads in envelopes (e.g. { response: {...} }); descend
// through the common single-wrapper keys so the pickers see the real body.
function unwrapEnvelope(body) {
  let b = body;
  for (let i = 0; i < 3 && b && typeof b === 'object' && !Array.isArray(b); i++) {
    const inner = b.response ?? b.result ?? b.payload;
    if (inner == null) break;
    b = inner;
  }
  return b;
}

// Teslascope accepts two credential styles:
//   • personal access tokens → "Authorization: Bearer <token>" (current),
//   • legacy API keys → "?api_key=<key>" query param (deprecated but still
//     issued from the account page, and they do NOT work as Bearer tokens).
// Users paste whichever they have, so on 401/403 the other style is retried
// once and the working style is remembered for the rest of the session.
let authMode = 'bearer';

function requestOnce(path, token, mode, timeoutMs) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Sentry-Drive' };
  let fullPath = path;
  if (mode === 'bearer') {
    headers.Authorization = `Bearer ${token}`;
  } else {
    fullPath += `${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(token)}`;
  }
  const options = { host: API_HOST, path: fullPath, method: 'GET', headers, timeout: timeoutMs };
  return new Promise((resolve, reject) => {
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ status: res.statusCode, body: unwrapEnvelope(JSON.parse(data)) }); }
          catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          const err = new Error(`Unauthorized (HTTP ${res.statusCode})`);
          err.unauthorized = true;
          reject(err);
        } else if (res.statusCode === 429) {
          reject(new Error('Rate-limited by Teslascope (HTTP 429) — slow down or try later'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

let lastLoggedAuthMode = null;

async function httpGet(path, token, timeoutMs = 15000) {
  const modes = authMode === 'legacy' ? ['legacy', 'bearer'] : ['bearer', 'legacy'];
  let lastErr;
  for (const mode of modes) {
    try {
      const res = await requestOnce(path, token, mode, timeoutMs);
      authMode = mode;
      if (lastLoggedAuthMode !== mode) {
        lastLoggedAuthMode = mode;
        dbg('auth mode in use:', mode);
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (!e.unauthorized) throw e; // network/HTTP errors: don't retry as auth
    }
  }
  throw new Error(
    `${lastErr.message} — check the key (Teslascope → Account → Security). ` +
    `If you're using a personal access token, it needs the "account" and "vehicles" scopes`
  );
}

/** Rate-limited request pacing so a bulk import doesn't hammer the API. */
class Throttler {
  constructor(rateMs = DEFAULT_RATE_MS) {
    this.rateMs = rateMs;
    this.lastMs = 0;
  }
  async wait() {
    const elapsed = Date.now() - this.lastMs;
    if (elapsed < this.rateMs) {
      await new Promise((r) => setTimeout(r, this.rateMs - elapsed));
    }
    this.lastMs = Date.now();
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// First non-null value among candidate keys (case-insensitive).
function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) {
    if (obj[n] != null) return obj[n];
    // case-insensitive fallback
    const lk = Object.keys(obj).find((k) => k.toLowerCase() === n.toLowerCase());
    if (lk && obj[lk] != null) return obj[lk];
  }
  return undefined;
}

// First array found under candidate keys, else [] (or the value itself if array).
function pickArray(obj, names) {
  if (Array.isArray(obj)) return obj;
  const v = pick(obj, names);
  return Array.isArray(v) ? v : [];
}

// Coerce a timestamp (Unix s, Unix ms, or ISO string) to epoch ms.
function toMs(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t > 1e12 ? t : t * 1000;
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : NaN;
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

// Teslascope autopilot/state → our enum (extract.js AUTOPILOT_{OFF,FSD}=0,1).
// Conservative: only an explicit "on/active/engaged/autopilot/fsd" counts as
// engaged; everything else (and missing) is off. Mirrors tessie-api's policy.
const AP_ON = /^(on|active|engaged|autopilot|autosteer|fsd|true|1)$/i;
function mapAutopilot(v) {
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v > 0 ? 1 : 0;
  return AP_ON.test(String(v).trim()) ? 1 : 0;
}

// ─── endpoints ───────────────────────────────────────────────────────────────

/**
 * List vehicles on the account. Confirms the token works and yields the
 * public_id used by the per-vehicle endpoints. Returns [{ publicId, vin, name }].
 */
async function fetchVehicles(token) {
  let body;
  try {
    ({ body } = await httpGet('/api/account', token));
  } catch (e) {
    // Some deployments expose vehicles directly.
    ({ body } = await httpGet('/api/vehicles', token));
  }
  dbg('account/vehicles raw:', JSON.stringify(body).slice(0, 1200));
  const list = pickArray(pick(body, ['vehicles', 'results', 'data', 'response']) ?? body, ['vehicles', 'results', 'data', 'response']);
  const vehicles = (Array.isArray(list) ? list : []).map((v) => ({
    publicId: pick(v, ['public_id', 'publicId', 'id', 'uuid']),
    vin: pick(v, ['vin', 'VIN']),
    // The renderer's vehicle dropdown reads `displayName` (same contract as
    // the Tessie validate path) — returning `name` left it falling back to
    // the VIN/ID instead of the car's nickname.
    displayName: pick(v, ['name', 'display_name', 'vehicle_name', 'nickname']) || pick(v, ['vin']) || 'Vehicle',
  })).filter((v) => v.publicId != null);
  return vehicles;
}

/**
 * List drives for a vehicle within an optional Unix-seconds window.
 * Returns the raw drive objects (caller normalizes).
 */
async function fetchDrives(token, publicId, { from, to } = {}) {
  const listFrom = (body) => pickArray(body, ['drives', 'results', 'data', 'response']);
  // Date params are sent as local YYYY-MM-DD; the 0-result fallback below
  // covers the param names/format being wrong.
  const toDateStr = (sec) => {
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const base = `/api/vehicle/${encodeURIComponent(publicId)}/drives`;
  // Verified against the live API: limit > 100 → HTTP 422 "The limit may not
  // be greater than 100." (Laravel-style validation), so page through with
  // the maximum page size instead of relying on one big response.
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 50; // safety stop: 5,000 drives per fetch

  const fetchAll = async (withWindow) => {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams();
      if (withWindow && from != null) params.set('from', toDateStr(from));
      if (withWindow && to != null) params.set('to', toDateStr(to));
      params.set('limit', String(PAGE_LIMIT));
      if (page > 1) params.set('page', String(page));
      const { body } = await httpGet(`${base}?${params.toString()}`, token);
      const batch = listFrom(body);
      if (page === 1) {
        dbg(`drives raw (${withWindow ? 'windowed' : 'unfiltered'}, page 1):`, JSON.stringify(body).slice(0, 1200));
      }
      all.push(...batch);
      if (batch.length < PAGE_LIMIT) break; // short page = last page
      await new Promise((r) => setTimeout(r, 300)); // be polite between pages
    }
    return all;
  };

  let drives = await fetchAll(true);
  dbg('drives count (windowed):', drives.length);

  // The from/to parameter names are guesses against an undocumented API — if
  // a windowed query returns nothing, fetch unfiltered and apply the window
  // client-side off each drive's start timestamp instead.
  if (drives.length === 0 && (from != null || to != null)) {
    const all = await fetchAll(false);
    const fromMs = from != null ? from * 1000 : -Infinity;
    const toFilterMs = to != null ? to * 1000 : Infinity;
    drives = all.filter((d) => {
      const t = toMs(pick(d, ['started_at', 'start_date', 'start_time', 'starting_time', 'start', 'startedAt', 'created_at']));
      return !Number.isFinite(t) || (t >= fromMs && t <= toFilterMs);
    });
    dbg(`drives count: ${all.length} unfiltered → ${drives.length} in window`);
  }

  dbg('first raw drive:', JSON.stringify(drives[0] ?? null).slice(0, 1200));
  return drives;
}

/**
 * Fetch one drive's detail (which may embed the GPS path). Returns the raw
 * detail object, or null on failure.
 */
async function fetchDrivePath(token, publicId, driveId) {
  const path = `/api/vehicle/${encodeURIComponent(publicId)}/drive/${encodeURIComponent(driveId)}`;
  const { body } = await httpGet(path, token);
  const detail = pick(body, ['drive', 'result', 'data']) ?? body;
  dbg('drive detail raw:', JSON.stringify(detail).slice(0, 1500));
  return detail;
}

// Pull a GPS point list out of a drive detail, accepting several shapes.
function extractPoints(detail) {
  const arr = pickArray(detail, ['path', 'points', 'locations', 'coordinates', 'gps', 'route']);
  return arr
    .map((p) => {
      // Points may be objects or [lat,lng] / [lat,lng,ts] tuples.
      if (Array.isArray(p)) {
        return { latitude: num(p[0]), longitude: num(p[1]), timestamp: p[2], speed: num(p[3]), autopilot: undefined };
      }
      return {
        latitude: num(pick(p, ['latitude', 'lat'])),
        longitude: num(pick(p, ['longitude', 'lng', 'lon', 'long'])),
        timestamp: pick(p, ['timestamp', 'time', 'date', 'recorded_at', 't']),
        speed: num(pick(p, ['speed', 'speed_mph', 'velocity'])),
        autopilot: pick(p, ['autopilot', 'autopilot_state', 'state', 'ap']),
      };
    })
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

/**
 * Normalize a raw Teslascope drive (+ optional detail with a path) into the
 * shape buildClipsForApiDrive() expects:
 *   { id, startedAt(ms), endedAt(ms), distanceMi, autopilotDistanceMi,
 *     startingOdometer, startLat, startLng, endLat, endLng,
 *     points: [{ timestamp, latitude, longitude, speed, autopilot }] }
 */
// Verified against the live API (drives list, 2026-06): a drive looks like
//   { id, name, distance: "9.570000" (string miles), duration: 4161 (sec),
//     latitude_start/longitude_start/latitude_end/longitude_end (strings),
//     created_at: "2026-06-08T19:01:53.000000Z" (the drive's timestamp —
//     there is NO explicit end field; end = created_at + duration),
//     self_driving_miles_start/_end, self_driving_perc, battery_*, ... }
// The earlier guessed names are kept as fallbacks for the (unseen) per-drive
// detail endpoint, which may use a richer shape.
function normalizeDrive(raw, detail) {
  const d = { ...(raw || {}), ...(detail || {}) };
  const startedAt = toMs(pick(d, ['started_at', 'start_date', 'start_time', 'starting_time', 'start', 'startedAt', 'created_at']));
  let endedAt = toMs(pick(d, ['ended_at', 'end_date', 'end_time', 'finishing_time', 'finished_at', 'end', 'endedAt']));
  const durationSec = num(pick(d, ['duration', 'duration_sec', 'duration_seconds']));
  if (!Number.isFinite(endedAt) && Number.isFinite(startedAt) && Number.isFinite(durationSec)) {
    endedAt = startedAt + durationSec * 1000;
  }
  const distanceMi = num(pick(d, ['distance', 'distance_miles', 'distance_mi', 'miles', 'odometer_distance'])) ?? 0;
  // Teslascope reports FSD usage as start/end mile counters; fall back to the
  // delta when no direct autopilot-distance field exists.
  const sdStart = num(pick(d, ['self_driving_miles_start']));
  const sdEnd = num(pick(d, ['self_driving_miles_end']));
  const apDistMi = num(pick(d, ['autopilot_distance', 'autopilot_distance_miles', 'fsd_distance', 'autopilotDistanceMi']))
    ?? ((Number.isFinite(sdStart) && Number.isFinite(sdEnd) && sdEnd >= sdStart) ? sdEnd - sdStart : 0);
  const startingOdometer = num(pick(d, ['starting_odometer', 'start_odometer', 'odometer_start', 'startingOdometer']));

  return {
    id: pick(d, ['id', 'drive_id', 'uuid', 'public_id']),
    startedAt,
    endedAt,
    distanceMi,
    autopilotDistanceMi: apDistMi,
    startingOdometer: startingOdometer != null ? startingOdometer : undefined,
    startLat: num(pick(d, ['latitude_start', 'starting_latitude', 'start_latitude', 'start_lat', 'from_latitude'])),
    startLng: num(pick(d, ['longitude_start', 'starting_longitude', 'start_longitude', 'start_lng', 'from_longitude'])),
    endLat: num(pick(d, ['latitude_end', 'ending_latitude', 'end_latitude', 'end_lat', 'to_latitude'])),
    endLng: num(pick(d, ['longitude_end', 'ending_longitude', 'end_longitude', 'end_lng', 'to_longitude'])),
    // buildClipsForApiDrive maps autopilot via tessie-api's mapAutopilotString
    // (off-values are specific strings; 0 would read as "on"). Bridge our
    // boolean mapping to the 'Active'/'Off' strings it understands.
    points: extractPoints(d).map((p) => ({
      ...p,
      autopilot: mapAutopilot(p.autopilot) ? 'Active' : 'Off',
    })),
  };
}

module.exports = {
  setLogger,
  Throttler,
  fetchVehicles,
  fetchDrives,
  fetchDrivePath,
  normalizeDrive,
  mapAutopilot,
  // exported for unit-level checks
  _internals: { pick, pickArray, toMs, num, extractPoints },
};
