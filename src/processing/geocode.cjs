// Main-process Nominatim client with policy-compliant identification,
// one-request-per-second throttling, request coalescing, and a disk cache.
// Five-decimal cache keys distinguish adjacent addresses while grouping GPS
// jitter. Trust snapped names and house numbers according to the matched
// feature type; otherwise fall back to street or locality.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { geodesicM } = require('../shared/drive-calc.cjs');
const { createKnownPlaceStore } = require('./known-places.cjs');

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org';
const RATE_MS = 1100;          // ≤ 1 req/s per Nominatim policy (+ margin)
const KEY_DECIMALS = 5;        // ~1.1 m grouping — house-level distinct
const UA = 'Sentry-Drive/1.0 (https://github.com/Sentry-Six/Sentry-Drive)';
const ADDRESS_POINT_TRUST_M = 25;
const POI_POINT_TRUST_M = 30;
const ENTRANCE_TRUST_M = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = Object.freeze({
  high: 365 * DAY_MS,
  medium: 180 * DAY_MS,
  low: 90 * DAY_MS,
  miss: 30 * DAY_MS,
});
// v5 namespaces records by provider and includes query-accuracy evidence.
const CACHE_VERSION = 5;

const POI_CATEGORIES = new Set([
  'aeroway', 'amenity', 'club', 'craft', 'healthcare', 'historic', 'leisure',
  'office', 'shop', 'sport', 'tourism',
]);
const POI_TYPE_DENYLIST = new Set([
  'bench', 'bicycle_parking', 'drinking_water', 'fire_hydrant', 'give_way',
  'guidepost', 'information', 'post_box', 'recycling', 'street_lamp',
  'telephone', 'traffic_signals', 'vending_machine', 'waste_basket',
  'waste_disposal',
]);

let cache = null;
let cacheFile = null;
let settingsFile = null;
let knownPlaces = null;
let settings = { endpoint: DEFAULT_ENDPOINT, language: '' };
let systemLanguage = '';
let lastFetchMs = 0;
let saveTimer = null;
const inflight = new Map();

function normalizeEndpoint(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_ENDPOINT;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_ENDPOINT;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/(?:reverse)?\/?$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

function normalizeLanguage(value, fallback = '') {
  const language = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return /^[A-Za-z0-9,;=._* -]*$/.test(language) ? language : fallback;
}

function atomicWriteJson(filePath, value) {
  if (!filePath) return;
  const tempPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(value));
    fs.renameSync(tempPath, filePath);
  } catch {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function loadSettings(locale = '') {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
  systemLanguage = normalizeLanguage(locale);
  settings = {
    endpoint: normalizeEndpoint(raw?.endpoint),
    language: normalizeLanguage(raw?.language),
  };
}

function init(options) {
  const config = typeof options === 'string' ? { cacheFile: options } : (options || {});
  cacheFile = config.cacheFile || null;
  settingsFile = config.settingsFile || null;
  knownPlaces = config.knownPlacesFile ? createKnownPlaceStore(config.knownPlacesFile) : null;
  loadSettings(config.locale);
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache = raw && raw.__v === CACHE_VERSION && raw.entries
      && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
      ? raw.entries
      : {};
  } catch { cache = {}; }
}

function getSettings() {
  return { ...settings, defaultEndpoint: DEFAULT_ENDPOINT };
}

function configure(next = {}) {
  settings = {
    endpoint: normalizeEndpoint(next.endpoint),
    language: normalizeLanguage(next.language),
  };
  atomicWriteJson(settingsFile, settings);
  return getSettings();
}

function keyFor(lat, lng) {
  return `${lat.toFixed(KEY_DECIMALS)},${lng.toFixed(KEY_DECIMALS)}`;
}

function scheduleSave() {
  if (saveTimer || !cacheFile) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    atomicWriteJson(cacheFile, { __v: CACHE_VERSION, entries: cache });
  }, 2000);
}

function resultDistanceM(j, lat, lng) {
  const rlat = parseFloat(j.lat);
  const rlng = parseFloat(j.lon);
  if (!isFinite(rlat) || !isFinite(rlng)) return Infinity;
  return geodesicM(lat, lng, rlat, rlng);
}

function featureClass(j) {
  return String(j.category || j.class || '').toLowerCase();
}

function isAreaFeature(j) {
  const osmType = String(j.osm_type || '').toLowerCase();
  return osmType === 'way' || osmType === 'relation';
}

function isAddressFeature(j) {
  const category = featureClass(j);
  const addressType = String(j.addresstype || '').toLowerCase();
  const type = String(j.type || '').toLowerCase();
  return category === 'place'
    || category === 'building'
    || addressType === 'house'
    || addressType === 'building'
    || type === 'house';
}

function resultLayer(j) {
  const category = featureClass(j);
  return ['place', 'building', 'highway', 'boundary', 'landuse'].includes(category)
    || isAddressFeature(j)
    ? 'address'
    : 'poi';
}

function isMeaningfulPoi(j) {
  const category = featureClass(j);
  const type = String(j.type || '').toLowerCase();
  return POI_CATEGORIES.has(category) && !POI_TYPE_DENYLIST.has(type);
}

function pointOnSegment(x, y, ax, ay, bx, by) {
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-12) return false;
  return x >= Math.min(ax, bx) - 1e-12 && x <= Math.max(ax, bx) + 1e-12
    && y >= Math.min(ay, by) - 1e-12 && y <= Math.max(ay, by) + 1e-12;
}

// Returns 1 inside, 0 outside, and 2 on the boundary.
function ringRelation(lng, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    const ax = Number(a[0]); const ay = Number(a[1]);
    const bx = Number(b[0]); const by = Number(b[1]);
    if (![ax, ay, bx, by].every(isFinite)) return 0;
    if (pointOnSegment(lng, lat, ax, ay, bx, by)) return 2;
    if ((ay > lat) !== (by > lat)
        && lng < ((bx - ax) * (lat - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? 1 : 0;
}

function polygonContainsPoint(coordinates, lat, lng) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
  const outer = ringRelation(lng, lat, coordinates[0]);
  if (outer === 0) return false;
  for (let i = 1; i < coordinates.length; i++) {
    const hole = ringRelation(lng, lat, coordinates[i]);
    if (hole === 1) return false;
    if (hole === 2) return true;
  }
  return true;
}

function geometryContainsPoint(geometry, lat, lng) {
  if (!geometry || typeof geometry !== 'object') return false;
  if (geometry.type === 'Polygon') {
    return polygonContainsPoint(geometry.coordinates, lat, lng);
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.some((polygon) => polygonContainsPoint(polygon, lat, lng));
  }
  if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    return geometry.geometries.some((part) => geometryContainsPoint(part, lat, lng));
  }
  return false;
}

function closestEntranceDistanceM(j, lat, lng) {
  if (!Array.isArray(j?.entrances)) return Infinity;
  let closest = Infinity;
  for (const entrance of j.entrances) {
    const entranceLat = Number(entrance?.lat);
    const entranceLng = Number(entrance?.lon);
    if (!Number.isFinite(entranceLat) || !Number.isFinite(entranceLng)) continue;
    closest = Math.min(closest, geodesicM(lat, lng, entranceLat, entranceLng));
  }
  return closest;
}

// Area centroids can be far from a legitimately parked coordinate. Their
// names and house numbers are accepted only when the returned OSM geometry
// actually covers the query point; point features use conservative distances.
function featureIsTrusted(j, lat, lng, pointLimitM, queryAccuracyM = 0) {
  if (isAreaFeature(j)) {
    if (geometryContainsPoint(j.geojson, lat, lng)) return true;
    const entranceLimit = ENTRANCE_TRUST_M + Math.min(10, Math.max(0, queryAccuracyM));
    return closestEntranceDistanceM(j, lat, lng) <= entranceLimit;
  }
  return resultDistanceM(j, lat, lng) <= pointLimitM;
}

function osmFeatureId(j) {
  return j?.osm_type && j?.osm_id != null ? `${j.osm_type}/${j.osm_id}` : null;
}

function confidenceForAccuracy(confidence, queryAccuracyM) {
  if (!(queryAccuracyM > 15)) return confidence;
  if (queryAccuracyM > 30) return 'low';
  return confidence === 'high' ? 'medium' : 'low';
}

function matchResult(j, label, featureType, confidence, lat, lng, queryAccuracyM = 0) {
  const distanceM = resultDistanceM(j, lat, lng);
  return {
    label,
    featureType,
    confidence: confidenceForAccuracy(confidence, queryAccuracyM),
    distanceM: Number.isFinite(distanceM) ? Math.round(distanceM * 10) / 10 : null,
    osmId: osmFeatureId(j),
    queryAccuracyM: Number.isFinite(queryAccuracyM) ? Math.round(queryAccuracyM * 10) / 10 : null,
  };
}

function formatHouseAddress(j, road, houseNumber) {
  const displayParts = String(j?.display_name || '').split(',').map((part) => part.trim());
  const numberIndex = displayParts.findIndex((part) => part === String(houseNumber));
  const roadIndex = displayParts.findIndex((part) => part.toLocaleLowerCase() === road.toLocaleLowerCase());
  if (roadIndex >= 0 && numberIndex >= 0 && roadIndex < numberIndex) return `${road} ${houseNumber}`;
  return `${houseNumber} ${road}`;
}

// Prefer POI, verified address, street, then locality, while retaining the
// evidence used to choose the user-facing label.
function labelMatch(j, lat, lng, queryAccuracyM = 0) {
  if (!j) return null;
  const a = j.address || {};
  const nameLimitM = isAddressFeature(j) ? ADDRESS_POINT_TRUST_M : POI_POINT_TRUST_M;
  const nameEligible = isAddressFeature(j) || isMeaningfulPoi(j);
  if (nameEligible && j.name && j.name.trim()
      && featureIsTrusted(j, lat, lng, nameLimitM, queryAccuracyM)) {
    const featureType = isAreaFeature(j)
      ? (featureClass(j) === 'building' ? 'building' : 'area')
      : (isAddressFeature(j) ? 'address-point' : 'poi');
    return matchResult(j, j.name.trim(), featureType, 'high', lat, lng, queryAccuracyM);
  }
  const road = a.road || a.pedestrian || a.footway || a.path || a.cycleway;
  if (road && a.house_number
      && featureIsTrusted(j, lat, lng, ADDRESS_POINT_TRUST_M, queryAccuracyM)) {
    const featureType = isAreaFeature(j) ? 'building' : 'address-point';
    return matchResult(
      j,
      formatHouseAddress(j, road, a.house_number),
      featureType,
      'high',
      lat,
      lng,
      queryAccuracyM,
    );
  }
  if (road) return matchResult(j, road, 'road', 'medium', lat, lng, queryAccuracyM);
  const place = a.neighbourhood || a.suburb || a.hamlet || a.village
    || a.town || a.city || a.municipality || a.county;
  if (place) return matchResult(j, place, 'locality', 'low', lat, lng, queryAccuracyM);
  if (j.display_name) {
    return matchResult(j, j.display_name.split(',')[0].trim(), 'locality', 'low', lat, lng, queryAccuracyM);
  }
  return null;
}

function shortLabel(j, lat, lng) {
  return labelMatch(j, lat, lng)?.label ?? null;
}

function cityMatch(j, lat, lng, queryAccuracyM = 0) {
  if (!j) return null;
  const a = j.address || {};
  const place = a.city || a.town || a.village || a.municipality
    || a.hamlet || a.county;
  if (place) return matchResult(j, place, 'locality', 'low', lat, lng, queryAccuracyM);
  if (j.display_name) {
    return matchResult(j, j.display_name.split(',')[0].trim(), 'locality', 'low', lat, lng, queryAccuracyM);
  }
  return null;
}

function cacheRecord(match, resolvedAt = Date.now(), provider = settings.endpoint) {
  return {
    label: match?.label ?? null,
    featureType: match?.featureType ?? 'none',
    confidence: match?.confidence ?? 'low',
    distanceM: match?.distanceM ?? null,
    osmId: match?.osmId ?? null,
    queryAccuracyM: match?.queryAccuracyM ?? null,
    source: match?.source ?? 'provider',
    provider: normalizeEndpoint(provider),
    resolvedAt,
  };
}

function cacheRecordIsFresh(record, now = Date.now(), provider = settings.endpoint) {
  if (!record || typeof record !== 'object' || !Number.isFinite(record.resolvedAt)
      || !(record.label === null || typeof record.label === 'string')
      || normalizeEndpoint(record.provider) !== normalizeEndpoint(provider)) return false;
  const ttl = record.label == null
    ? CACHE_TTL_MS.miss
    : (CACHE_TTL_MS[record.confidence] || CACHE_TTL_MS.low);
  return now - record.resolvedAt >= 0 && now - record.resolvedAt < ttl;
}

function buildReverseUrl(lat, lng, zoom, layer) {
  const url = new URL(`${settings.endpoint}/reverse`);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('zoom', String(zoom));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('entrances', '1');
  if (zoom === 18) url.searchParams.set('polygon_geojson', '1');
  if (layer) url.searchParams.set('layer', layer);
  return url;
}

// Resolves { ok: true, json } when Nominatim answered, or { ok: false } on
// network error / timeout / non-2xx so the caller knows not to cache the miss.
function requestNominatim(lat, lng, zoom, layer) {
  return new Promise((resolve) => {
    const url = buildReverseUrl(lat, lng, zoom, layer);
    const transport = url.protocol === 'http:' ? http : https;
    const language = settings.language || systemLanguage;
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (language) headers['Accept-Language'] = language;
    const req = transport.get(
      url,
      { headers, timeout: 12000 },
      (res) => {
        let data = '';
        let oversized = false;
        res.on('data', (c) => {
          if (oversized) return;
          data += c;
          if (data.length > 5 * 1024 * 1024) {
            oversized = true;
            req.destroy();
            resolve({ ok: false });
          }
        });
        res.on('end', () => {
          if (oversized) return;
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

function confidenceRank(match) {
  return ({ high: 3, medium: 2, low: 1 })[match?.confidence] || 0;
}

function featureRank(match) {
  return ({
    'known-place': 7,
    poi: 6,
    building: 5,
    'address-point': 5,
    area: 4,
    road: 2,
    locality: 1,
  })[match?.featureType] || 0;
}

function chooseBetterMatch(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  const confidenceDelta = confidenceRank(second) - confidenceRank(first);
  if (confidenceDelta) return confidenceDelta > 0 ? second : first;
  const featureDelta = featureRank(second) - featureRank(first);
  if (featureDelta) return featureDelta > 0 ? second : first;
  const firstDistance = Number.isFinite(first.distanceM) ? first.distanceM : Infinity;
  const secondDistance = Number.isFinite(second.distanceM) ? second.distanceM : Infinity;
  return secondDistance < firstDistance ? second : first;
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
function knownPlaceMatch(place, queryAccuracyM = 0) {
  if (!place) return null;
  return {
    label: place.label,
    featureType: 'known-place',
    confidence: confidenceForAccuracy('high', queryAccuracyM),
    distanceM: place.distanceM,
    osmId: null,
    queryAccuracyM: Number.isFinite(queryAccuracyM) ? Math.round(queryAccuracyM * 10) / 10 : null,
    source: place.source,
  };
}

function rememberKnownPlace(input) {
  return knownPlaces?.upsert(input) ?? null;
}

function removeKnownPlace(input = {}) {
  return knownPlaces?.removeNear(
    Number(input.lat),
    Number(input.lng),
    input.source || 'manual',
    Number(input.maxDistanceM) || 100,
  ) ?? false;
}

function syncKnownPlaceZones(zones) {
  return knownPlaces?.replaceZones(zones) ?? 0;
}

async function reverseGeocodeDetailed(lat, lng, options = {}) {
  if (!cache) cache = {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return null;
  const queryAccuracyM = Math.max(0, Number(options.accuracyM) || 0);
  const teslaLabel = typeof options.teslaLabel === 'string' ? options.teslaLabel.trim() : '';
  if (teslaLabel && knownPlaces) {
    knownPlaces.upsert({
      lat,
      lng,
      label: teslaLabel,
      source: 'tesla',
      radiusM: Math.min(50, Math.max(25, queryAccuracyM + 10)),
    });
  }
  const place = knownPlaces?.find(lat, lng);
  if (place) return knownPlaceMatch(place, queryAccuracyM);

  const key = keyFor(lat, lng);
  const cached = cache[key];
  if (cacheRecordIsFresh(cached, Date.now(), settings.endpoint)) return { ...cached };
  const requestKey = `${settings.endpoint}|${key}|${Math.round(queryAccuracyM / 5)}`;
  if (inflight.has(requestKey)) return inflight.get(requestKey);

  const p = (async () => {
    const street = await fetchNominatim(lat, lng, 18, 'address,poi');
    if (!street.ok) {
      inflight.delete(requestKey);
      return cached?.label != null ? { ...cached } : null;
    }
    let match = labelMatch(street.json, lat, lng, queryAccuracyM);
    // Nominatim reverse returns only one object. If it is not a confident
    // match, compare it with the opposite address/POI layer once.
    if (match?.confidence !== 'high') {
      const alternateLayer = resultLayer(street.json) === 'poi' ? 'address' : 'poi';
      const alternate = await fetchNominatim(lat, lng, 18, alternateLayer);
      if (alternate.ok) {
        match = chooseBetterMatch(
          match,
          labelMatch(alternate.json, lat, lng, queryAccuracyM),
        );
      }
    }
    if (!match) {
      const city = await fetchNominatim(lat, lng, 10);
      if (!city.ok) {
        inflight.delete(requestKey);
        return cached?.label != null ? { ...cached } : null;
      }
      match = cityMatch(city.json, lat, lng, queryAccuracyM);
    }
    inflight.delete(requestKey);
    cache[key] = cacheRecord(match, Date.now(), settings.endpoint);
    scheduleSave();
    return { ...cache[key] };
  })();
  inflight.set(requestKey, p);
  return p;
}

async function reverseGeocode(lat, lng, options = {}) {
  return (await reverseGeocodeDetailed(lat, lng, options))?.label ?? null;
}

module.exports = {
  configure,
  getSettings,
  init,
  rememberKnownPlace,
  removeKnownPlace,
  reverseGeocode,
  reverseGeocodeDetailed,
  syncKnownPlaceZones,
  _test: {
    buildReverseUrl,
    cacheRecord,
    cacheRecordIsFresh,
    chooseBetterMatch,
    geometryContainsPoint,
    labelMatch,
    shortLabel,
  },
};
