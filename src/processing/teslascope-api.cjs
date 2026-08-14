// Teslascope REST client shaped like the Tessie provider. The per-drive schema
// is not published, so normalization accepts known field variants and debug
// mode logs a truncated first response.

'use strict';

const https = require('https');

const API_HOST = 'teslascope.com';
const DEFAULT_RATE_MS = 1000;

// Send milestones through the app logger, or stderr in debug mode.
let appLogger = null;
function setLogger(l) { appLogger = l; }
function dbg(...args) {
  if (appLogger) appLogger.info('teslascope', ...args);
  else if (process.env.TESLASCOPE_DEBUG) console.error('[teslascope-api]', ...args);
}

// Unwrap common single-key response envelopes.
function unwrapEnvelope(body) {
  let b = body;
  for (let i = 0; i < 3 && b && typeof b === 'object' && !Array.isArray(b); i++) {
    const inner = b.response ?? b.result ?? b.payload;
    if (inner == null) break;
    b = inner;
  }
  return b;
}

// Support Bearer tokens and legacy `api_key` credentials. Retry the alternate
// style once after authorization failure and remember the successful form.
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
      if (!e.unauthorized) throw e;
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

// Count only explicit engagement states; missing or ambiguous states are off.
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
    ({ body } = await httpGet('/api/vehicles', token));
  }
  dbg('account/vehicles raw:', JSON.stringify(body).slice(0, 1200));
  const list = pickArray(pick(body, ['vehicles', 'results', 'data', 'response']) ?? body, ['vehicles', 'results', 'data', 'response']);
  const vehicles = (Array.isArray(list) ? list : []).map((v) => ({
    publicId: pick(v, ['public_id', 'publicId', 'id', 'uuid']),
    vin: pick(v, ['vin', 'VIN']),
    // Match the renderer's shared provider contract.
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
  // Fall back to client-side filtering if date parameters are unsupported.
  const toDateStr = (sec) => {
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const base = `/api/vehicle/${encodeURIComponent(publicId)}/drives`;
  // The API rejects limits above 100; page at its maximum.
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 50;

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
      if (batch.length < PAGE_LIMIT) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return all;
  };

  let drives = await fetchAll(true);
  dbg('drives count (windowed):', drives.length);

  // An empty windowed response may indicate unsupported parameters; retry
  // unfiltered and apply the window locally.
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
  // `progress` is the observed path key; retain compatible alternatives.
  const arr = pickArray(detail, ['progress', 'path', 'points', 'locations', 'coordinates', 'gps', 'route']);
  return arr
    .map((p) => {
      // Points may be objects or [lat,lng] / [lat,lng,ts] tuples.
      if (Array.isArray(p)) {
        return { latitude: num(p[0]), longitude: num(p[1]), timestamp: toMs(p[2]), speed: num(p[3]), autopilot: undefined };
      }
      return {
        latitude: num(pick(p, ['latitude', 'lat'])),
        longitude: num(pick(p, ['longitude', 'lng', 'lon', 'long'])),
        // Clip construction expects epoch milliseconds.
        timestamp: toMs(pick(p, ['timestamp', 'time', 'date', 'recorded_at', 'created_at', 't'])),
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
// Observed list responses use string miles/coordinates, `created_at` as start,
// duration in seconds, no explicit end, and self-driving start/end counters.
// Retain alternate names for richer detail responses.
function normalizeDrive(raw, detail) {
  const d = { ...(raw || {}), ...(detail || {}) };
  const startedAt = toMs(pick(d, ['started_at', 'start_date', 'start_time', 'starting_time', 'start', 'startedAt', 'created_at']));
  let endedAt = toMs(pick(d, ['ended_at', 'end_date', 'end_time', 'finishing_time', 'finished_at', 'end', 'endedAt']));
  const durationSec = num(pick(d, ['duration', 'duration_sec', 'duration_seconds']));
  if (!Number.isFinite(endedAt) && Number.isFinite(startedAt) && Number.isFinite(durationSec)) {
    endedAt = startedAt + durationSec * 1000;
  }
  const distanceMi = num(pick(d, ['distance', 'distance_miles', 'distance_mi', 'miles', 'odometer_distance'])) ?? 0;
  // Derive FSD distance from counters when no direct value exists.
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
    // Bridge boolean engagement into the shared provider string contract.
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
  _internals: { pick, pickArray, toMs, num, extractPoints },
};
