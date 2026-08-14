// Rate-limited Tessie REST client for vehicles, drives, and detailed paths.

'use strict';

const https = require('https');

const API_HOST = 'api.tessie.com';
const DEFAULT_RATE_MS = 1000;

function httpGet(path, token, timeoutMs = 15000) {
  const options = {
    host: API_HOST,
    path,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Sentry-Drive',
    },
    timeout: timeoutMs,
  };
  return new Promise((resolve, reject) => {
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Unauthorized (HTTP ${res.statusCode}) — check your token`));
        } else if (res.statusCode === 429) {
          reject(new Error('Rate-limited by Tessie (HTTP 429) — slow down or try later'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Rate-limited request queue so a bulk import doesn't hammer the API.
 */
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

/**
 * List vehicles on the user's account. Use this to confirm the token works
 * and pick the VIN for subsequent calls.
 */
// Main-process diagnostics hook.
let appLogger = null;
function setLogger(l) { appLogger = l; }
function dbg(...args) {
  if (appLogger) appLogger.info('tessie', ...args);
}

async function fetchVehicles(token) {
  const { body } = await httpGet('/vehicles', token);
  const vehicles = Array.isArray(body.results) ? body.results : [];
  dbg('vehicles fetched:', vehicles.length);
  return vehicles;
}

/**
 * List drives for a VIN within an optional time window.
 * from/to are Unix seconds (undefined = Tessie default window).
 */
async function fetchDrives(token, vin, { from, to, limit } = {}) {
  const params = new URLSearchParams();
  params.set('distance_format', 'mi');
  if (from != null) params.set('from', String(from));
  if (to != null) params.set('to', String(to));
  if (limit != null) params.set('limit', String(limit));
  const { body } = await httpGet(`/${encodeURIComponent(vin)}/drives?${params}`, token);
  const drives = Array.isArray(body.results) ? body.results : [];
  dbg('drives fetched:', drives.length, '| first raw:', JSON.stringify(drives[0] ?? null).slice(0, 600));
  return drives;
}

/**
 * Fetch the dense driving path for a specific time window. Pass
 * `details=true` to get per-point autopilot/speed/heading/odometer.
 * `separate=true` splits the returned points by drive.
 */
async function fetchPath(token, vin, { from, to, separate = true, simplify = false, details = true }) {
  const params = new URLSearchParams();
  params.set('from', String(from));
  params.set('to', String(to));
  params.set('separate', String(separate));
  params.set('simplify', String(simplify));
  params.set('details', String(details));
  const { body } = await httpGet(`/${encodeURIComponent(vin)}/path?${params}`, token);
  // Shape varies with `separate`:
  //   separate=false → { results: [point, ...] }
  //   separate=true  → { results: [{ drive_id?, path: [point, ...] }, ...] }
  //                    or { results: [[point, ...], [point, ...]] }
  // Normalize to array-of-arrays.
  const out = [];
  if (Array.isArray(body.results)) {
    for (const r of body.results) {
      if (Array.isArray(r)) out.push(r);
      else if (Array.isArray(r?.path)) out.push(r.path);
      else if (Array.isArray(r?.points)) out.push(r.points);
      else if (r?.latitude != null) { /* flat list, handled below */ }
    }
    // Flat list fallback: whole body.results is a single drive's points
    if (out.length === 0 && body.results.length > 0 && body.results[0]?.latitude != null) {
      out.push(body.results);
    }
  }
  return out;
}

// Tessie's path field distinguishes FSD engagement only, not Autosteer or
// TACC. Imported clips have no accelerator samples, so mapping engagement to
// FSD cannot create pedal-based events.
const AP_OFF_VALUES = new Set(['Unavailable', 'Standby', 'Off', '', null, undefined]);
function mapAutopilotString(s) {
  if (AP_OFF_VALUES.has(s)) return 0;
  return 1;
}

module.exports = {
  setLogger,
  Throttler,
  fetchVehicles,
  fetchDrives,
  fetchPath,
  mapAutopilotString,
};
