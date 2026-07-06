// Reverse geocoding for drive-list location pins.
//
// Runs in the MAIN process (Node https), which lets us:
//   • set a proper User-Agent (Nominatim's usage policy requires one),
//   • throttle to ≤1 request/second (the policy's hard limit),
//   • persist a disk cache so we geocode each unique spot only once, and
//   • sidestep the renderer CSP entirely.
//
// Coordinates are rounded to ~1 m for the cache key: drives that end at the
// same spot still collapse to one lookup, but two genuinely different
// doorsteps a few metres apart no longer share a cached (wrong) address —
// the old 4-decimal key (~11 m) was wide enough to merge adjacent houses.
// Bumping the precision orphans old 4-decimal cache entries (harmless; they
// just re-resolve once at the new precision).
//
// Accuracy: a reverse lookup snaps to the NEAREST mapped feature, not to
// "the address here". Lookups are therefore restricted to real addresses and
// POIs (layer=address,poi), and the snapped feature's name/house number is
// only used when the feature verifiably contains or nearly touches the
// queried point (SNAP_TRUST_M); otherwise the label degrades gracefully to
// the street / neighbourhood instead of naming the wrong building.

const https = require('https');
const fs = require('fs');
const { geodesicM } = require('../shared/drive-calc.cjs');

const HOST = 'nominatim.openstreetmap.org';
const RATE_MS = 1100;          // ≤ 1 req/s per Nominatim policy (+ margin)
const KEY_DECIMALS = 5;        // ~1.1 m grouping — house-level distinct
const UA = 'Sentry-Drive/1.0 (https://github.com/JeffFromTheIRS/Sentry-Drive)';
// Reverse geocoding snaps to the NEAREST mapped feature, which is not always
// where the car is — only trust a feature's name/house number when it's
// within this distance of the queried coordinates.
const SNAP_TRUST_M = 75;
// v2: snap-verified labels via layer=address,poi (v1 cached whatever object
// Nominatim happened to snap to). Old entries are dropped on load and
// re-resolve lazily through the throttle as cards render.
const CACHE_VERSION = 2;

let cache = null;              // { "lat,lng": label|null }
let cacheFile = null;
let lastFetchMs = 0;
let saveTimer = null;
const inflight = new Map();    // key -> Promise<label|null>

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

// Distance from the queried coordinates to the matched feature's centroid.
function resultDistanceM(j, lat, lng) {
  const rlat = parseFloat(j.lat);
  const rlng = parseFloat(j.lon);
  if (!isFinite(rlat) || !isFinite(rlng)) return Infinity;
  return geodesicM(lat, lng, rlat, rlng);
}

// Is the queried point inside the feature's bounding box, padded by padM?
// Big features (a store + its lot) legitimately have a far-away centroid, so
// name acceptance tests the box, not the centroid.
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

// Pick the most "pin-like" short label from a Nominatim reverse result:
// POI/business name → "1234 Street" → street → neighbourhood/city.
// The name and house number are only trusted when the matched feature is
// verifiably AT the queried point — reverse geocoding snaps to the nearest
// object, which can be the business across the street or a neighbour's
// address point; in that case fall through to the street instead.
function shortLabel(j, lat, lng) {
  if (!j) return null;
  const a = j.address || {};
  if (j.name && j.name.trim() && withinPaddedBBox(j, lat, lng, SNAP_TRUST_M)) {
    return j.name.trim();                                         // POI/business name
  }
  const road = a.road || a.pedestrian || a.footway || a.path || a.cycleway;
  if (road && a.house_number && resultDistanceM(j, lat, lng) <= SNAP_TRUST_M) {
    return `${a.house_number} ${road}`;                           // "6730 Aviation Dr"
  }
  if (road) return road;
  const place = a.neighbourhood || a.suburb || a.hamlet || a.village
    || a.town || a.city || a.municipality || a.county;
  if (place) return place;
  if (j.display_name) return j.display_name.split(',')[0].trim();
  return null;
}

// City-granularity label for the zoom-10 fallback lookup.
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

// Serial queue. The drive list bursts all its lookups at once when it
// renders, so each fetch chains on the previous one with RATE_MS spacing —
// per-call delays computed against a shared timestamp would let the whole
// burst fire simultaneously and trip Nominatim's rate ban.
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

// Returns a place label (string) or null. Looks up at street zoom first
// (address → street → city, see shortLabel); when that finds nothing at all
// (unmapped spot, "Unable to geocode"), retries at city zoom so the card
// shows the city rather than raw coordinates. Answered lookups are cached
// (including "nothing anywhere" nulls) and concurrent lookups for the same
// spot are coalesced; network failures are not cached so they retry later.
async function reverseGeocode(lat, lng) {
  if (!cache) cache = {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return null;
  const key = keyFor(lat, lng);
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    // layer=address,poi keeps the snap on real addresses and businesses —
    // without it Nominatim happily matches railways, streams, power poles…
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
