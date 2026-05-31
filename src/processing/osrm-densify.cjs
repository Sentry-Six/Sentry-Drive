// osrm-densify.js - Shared OSRM routing and polyline densification
// Converts a sparse GPS polyline (e.g. Tessie's ~60s cadence) into a dense
// ~1 Hz route by map-matching segments to real roads via OSRM, falling back
// to linear interpolation when OSRM is unavailable.
//
// CommonJS to match electron-main.cjs; loaded from main process only.

'use strict';

const https = require('https');

const OSRM_HOST = 'router.project-osrm.org';
const MIN_GAP_M = 100;        // below this, linear interpolation is fine
const TARGET_HZ = 1;           // output cadence target
const DEFAULT_RATE_MS = 1000;  // be polite to the public demo server

// Haversine comes from the shared single-source calc module; it is re-exported
// below so existing consumers of this file keep working.
const { haversineM } = require('../shared/drive-calc.cjs');

/**
 * Query OSRM for a driving route between two points.
 * Returns array of [lat, lng] coordinates, or null if routing failed.
 */
function fetchOSRMRoute(startLat, startLng, endLat, endLng) {
  const path = `/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
  return new Promise((resolve, reject) => {
    https.get({ host: OSRM_HOST, path, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 'Ok' && json.routes && json.routes.length > 0) {
            resolve(json.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]));
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    })
      .on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

function linearInterp(startLat, startLng, endLat, endLng, nSteps) {
  const pts = [];
  for (let s = 1; s < nSteps; s++) {
    const t = s / nSteps;
    pts.push([
      startLat + (endLat - startLat) * t,
      startLng + (endLng - startLng) * t,
    ]);
  }
  return pts;
}

/**
 * Densify a sparse polyline into ~1 Hz points by routing long segments
 * through OSRM and linearly interpolating short ones.
 *
 * sparse: array of { lat, lng, timeMs, speedMps?, gear? } ordered by time.
 * opts.useRouting: if false, skip OSRM and use linear interp for everything.
 * opts.rateLimitMs: delay between OSRM requests (default 1000).
 * opts.onProgress: (curSegment, totalSegments) => void, called after each pair.
 * opts.cancel: () => bool, checked between requests — abort if true.
 *
 * Returns { points: [{lat, lng, timeMs, speedMps, gear}], routedSegments }.
 */
async function densifyPolyline(sparse, opts = {}) {
  const useRouting = opts.useRouting !== false;
  const rateMs = opts.rateLimitMs ?? DEFAULT_RATE_MS;
  const onProgress = opts.onProgress || (() => {});
  const cancel = opts.cancel || (() => false);

  if (!Array.isArray(sparse) || sparse.length < 2) {
    return { points: sparse ?? [], routedSegments: 0 };
  }

  const out = [sparse[0]];
  let routedSegments = 0;
  const totalPairs = sparse.length - 1;
  let lastRequestMs = 0;

  for (let i = 0; i < totalPairs; i++) {
    if (cancel()) return { points: out, routedSegments, canceled: true };

    const a = sparse[i];
    const b = sparse[i + 1];
    const distM = haversineM(a.lat, a.lng, b.lat, b.lng);
    const dtMs = Math.max(0, b.timeMs - a.timeMs);
    const dtSec = dtMs / 1000;
    const speedMps = dtSec > 0 ? distM / dtSec : 0;
    const gear = b.gear ?? a.gear ?? 1;

    let latLngs = null;

    if (useRouting && distM > MIN_GAP_M) {
      // Space out requests to avoid rate-limiting the public OSRM demo.
      const sinceLast = Date.now() - lastRequestMs;
      if (sinceLast < rateMs) await new Promise((r) => setTimeout(r, rateMs - sinceLast));
      lastRequestMs = Date.now();

      try {
        const routed = await fetchOSRMRoute(a.lat, a.lng, b.lat, b.lng);
        if (routed && routed.length >= 2) {
          // OSRM returns [start, ..., end]; we already pushed `a`, so skip
          // the first routed point and trust the rest up through the end.
          latLngs = routed.slice(1);
          routedSegments++;
        }
      } catch { /* fall through to linear interp */ }
    }

    if (!latLngs) {
      // Linear interpolation at ~1 Hz (or fewer steps for short segments).
      const nSteps = Math.max(2, Math.round(dtSec * TARGET_HZ));
      const interior = linearInterp(a.lat, a.lng, b.lat, b.lng, nSteps);
      latLngs = [...interior, [b.lat, b.lng]];
    }

    // Distribute timeMs evenly across the inserted points so downstream
    // interpolation/stats have a monotonic timeline.
    const startMs = a.timeMs;
    const n = latLngs.length;
    for (let k = 0; k < n; k++) {
      const tFrac = (k + 1) / n;
      const timeMs = startMs + Math.round(dtMs * tFrac);
      out.push({
        lat: latLngs[k][0],
        lng: latLngs[k][1],
        timeMs,
        speedMps,
        gear,
      });
    }

    onProgress(i + 1, totalPairs);
  }

  return { points: out, routedSegments };
}

module.exports = {
  fetchOSRMRoute,
  densifyPolyline,
  haversineM,
};
