// Main-process Nominatim client with policy-compliant identification,
// one-request-per-second throttling, request coalescing, and a disk cache.
// Five-decimal cache keys distinguish adjacent addresses while grouping GPS
// jitter. Trust snapped names only when the feature contains or nearly touches
// the query point; otherwise fall back to street or locality.

const https = require('https');
const fs = require('fs');
const { geodesicM } = require('../shared/drive-calc.cjs');

const HOST = 'nominatim.openstreetmap.org';
const RATE_MS = 1100;          // ≤ 1 req/s per Nominatim policy (+ margin)
const KEY_DECIMALS = 5;        // ~1.1 m grouping — house-level distinct
const UA = 'Sentry-Drive/1.0 (https://github.com/Sentry-Six/Sentry-Drive)';
// Maximum distance for trusting a snapped name or house number.
const SNAP_TRUST_M = 75;
// Version changes invalidate labels created before snap verification.
const CACHE_VERSION = 2;

let cache = null;
let cacheFile = null;
let lastFetchMs = 0;
let saveTimer = null;
const inflight = new Map();

function init(filePath) {
  cacheFile = filePath;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache = raw && raw.__v === CACHE_VERSION && raw.entries ? raw.entries : {};
  } catch { cache = {}; }
}

function keyFor(lat, lng) {
  return `${lat.toFixed(KEY_DECIMALS)},${lng.toFixed(KEY_DECIMALS)}`;
}

function scheduleSave() {
  if (saveTimer || !cacheFile) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(cacheFile, JSON.stringify({ __v: CACHE_VERSION, entries: cache })); } catch {}
  }, 2000);
}

function resultDistanceM(j, lat, lng) {
  const rlat = parseFloat(j.lat);
  const rlng = parseFloat(j.lon);
  if (!isFinite(rlat) || !isFinite(rlng)) return Infinity;
  return geodesicM(lat, lng, rlat, rlng);
}

// A large feature may contain the query despite a distant centroid.
function withinPaddedBBox(j, lat, lng, padM) {
  const bb = j.boundingbox;
  if (!Array.isArray(bb) || bb.length !== 4) return false;
  const [minLat, maxLat, minLng, maxLng] = bb.map(Number);
  if (![minLat, maxLat, minLng, maxLng].every(isFinite)) return false;
  const latPad = padM / 111320;
  const lngPad = padM / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return lat >= minLat - latPad && lat <= maxLat + latPad
      && lng >= minLng - lngPad && lng <= maxLng + lngPad;
}

// Prefer POI, verified address, street, then locality.
function shortLabel(j, lat, lng) {
  if (!j) return null;
  const a = j.address || {};
  if (j.name && j.name.trim() && withinPaddedBBox(j, lat, lng, SNAP_TRUST_M)) {
    return j.name.trim();
  }
  const road = a.road || a.pedestrian || a.footway || a.path || a.cycleway;
  if (road && a.house_number && resultDistanceM(j, lat, lng) <= SNAP_TRUST_M) {
    return `${a.house_number} ${road}`;
  }
  if (road) return road;
  const place = a.neighbourhood || a.suburb || a.hamlet || a.village
    || a.town || a.city || a.municipality || a.county;
  if (place) return place;
  if (j.display_name) return j.display_name.split(',')[0].trim();
  return null;
}

function cityLabel(j) {
  if (!j) return null;
  const a = j.address || {};
  const place = a.city || a.town || a.village || a.municipality
    || a.hamlet || a.county;
  if (place) return place;
  if (j.display_name) return j.display_name.split(',')[0].trim();
  return null;
}

// Resolves { ok: true, json } when Nominatim answered, or { ok: false } on
// network error / timeout / non-2xx so the caller knows not to cache the miss.
function requestNominatim(lat, lng, zoom, layer) {
  return new Promise((resolve) => {
    const path = `/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=${zoom}&addressdetails=1`
      + (layer ? `&layer=${layer}` : '');
    const req = https.get(
      { host: HOST, path, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve({ ok: true, json: JSON.parse(data) }); }
            catch { resolve({ ok: false }); }
          } else {
            resolve({ ok: false });
          }
        });
      },
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

// A promise chain serializes render-time lookup bursts at RATE_MS spacing.
let queueTail = Promise.resolve();
function fetchNominatim(lat, lng, zoom, layer) {
  const run = queueTail.then(async () => {
    const wait = RATE_MS - (Date.now() - lastFetchMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchMs = Date.now();
    return requestNominatim(lat, lng, zoom, layer);
  });
  queueTail = run.catch(() => {});
  return run;
}

// Try street-level detail, then locality. Cache answered misses, coalesce
// concurrent requests, and leave transport failures retryable.
async function reverseGeocode(lat, lng) {
  if (!cache) cache = {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return null;
  const key = keyFor(lat, lng);
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    // Restrict snapping to address-like features.
    const street = await fetchNominatim(lat, lng, 18, 'address,poi');
    if (!street.ok) { inflight.delete(key); return null; }
    let label = shortLabel(street.json, lat, lng);
    if (!label) {
      const city = await fetchNominatim(lat, lng, 10);
      if (!city.ok) { inflight.delete(key); return null; }
      label = cityLabel(city.json);
    }
    inflight.delete(key);
    cache[key] = label;
    scheduleSave();
    return label;
  })();
  inflight.set(key, p);
  return p;
}

module.exports = { init, reverseGeocode };
