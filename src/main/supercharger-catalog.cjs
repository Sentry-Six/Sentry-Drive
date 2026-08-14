'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fsyncFile } = require('../shared/atomic-write.cjs');
const {
  haversineMetres,
  PLACEHOLDER_SITE_LABELS,
} = require('../shared/charging-history.cjs');
const { renameWithRetry } = require('./drive-data-writer.cjs');

const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERIES = [
  'nwr["amenity"="charging_station"]["brand"="Tesla Supercharger"];',
  'nwr["amenity"="charging_station"]["brand:wikidata"="Q17089620"];',
  'nwr["amenity"="charging_station"]["ref:supercharge_info"];',
  'nwr["amenity"="charging_station"]["socket:tesla_supercharger"];',
  'nwr["amenity"="charging_station"]["socket:tesla_supercharger_ccs"];',
].map((selector) => `[out:json][timeout:120];${selector}out center tags;`);
const OVERPASS_QUERY = OVERPASS_QUERIES.join('\n');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isTeslaSuperchargerTags(tags = {}) {
  if (text(tags.amenity).toLowerCase() !== 'charging_station') return false;
  const description = [
    tags.brand,
    tags.network,
    tags.operator,
    tags.name,
    tags.description,
  ].map(text).join(' ').toLowerCase();
  if (description.includes('destination')) return false;

  const brand = text(tags.brand).toLowerCase();
  const wikidata = text(tags['brand:wikidata']).split(';').map((value) => value.trim());
  const reference = text(tags['ref:supercharge_info']);
  const socketCounts = [
    tags['socket:tesla_supercharger'],
    tags['socket:tesla_supercharger_ccs'],
  ].map((value) => text(value).toLowerCase());
  const hasSuperchargerSocket = socketCounts.some(
    (value) => value.length > 0 && value !== '0' && value !== 'no',
  );
  return brand === 'tesla supercharger'
    || wikidata.includes('Q17089620')
    || reference.length > 0
    || hasSuperchargerSocket;
}

function featureCoordinates(element) {
  const latitude = element?.lat ?? element?.center?.lat;
  const longitude = element?.lon ?? element?.center?.lon;
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

// Overpass commonly rate-limits or times out these selectors. Retry transient
// transport/status failures, but reject invalid payloads immediately.
const OVERPASS_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const OVERPASS_MAX_BYTES = 25 * 1024 * 1024;

async function fetchOverpassElements(query, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    endpoint = OVERPASS_ENDPOINT,
    userAgent = 'Sentry Drive Supercharger Catalog/1.0',
    timeoutMs = 150_000,
    retryDelaysMs = OVERPASS_RETRY_DELAYS_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = null,
  } = options;
  if (typeof fetchImpl !== 'function') throw new Error('Refresh is unavailable offline');

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    let networkError = null;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': userAgent,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
    } catch (error) {
      networkError = error;
    } finally {
      clearTimeout(timeout);
    }

    if (response?.ok) {
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > OVERPASS_MAX_BYTES) {
        throw new Error('OpenStreetMap refresh response is too large');
      }
      const payload = await response.json();
      if (!Array.isArray(payload?.elements)) {
        throw new TypeError('Invalid Overpass response: elements must be an array');
      }
      return payload.elements;
    }

    const status = response?.status;
    const retryable = networkError != null || RETRYABLE_STATUSES.has(status);
    if (!retryable || attempt >= retryDelaysMs.length) {
      throw new Error(
        `OpenStreetMap refresh failed (${status ?? networkError?.message ?? 'no response'})`,
      );
    }
    const delayMs = retryDelaysMs[attempt];
    onRetry?.({ attempt: attempt + 1, delayMs, status: status ?? null, error: networkError });
    await sleep(delayMs);
  }
}

function validateCatalog(catalog) {
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.stations)) {
    throw new TypeError('Invalid Supercharger catalog');
  }
  for (const station of catalog.stations) {
    if (
      !text(station.stationId)
      || !Number.isFinite(station.latitude)
      || station.latitude < -90
      || station.latitude > 90
      || !Number.isFinite(station.longitude)
      || station.longitude < -180
      || station.longitude > 180
    ) {
      throw new TypeError('Invalid Supercharger catalog station');
    }
  }
  return catalog;
}

// Use the fastest declared socket-output rating; observed vehicle power is not
// a reliable cabinet rating. Reject implausible OSM unit/value errors while
// retaining ratings through the 1.2 MW Semi megacharger range.
const MIN_PLAUSIBLE_KW = 1;
const MAX_PLAUSIBLE_KW = 1500;

function stationPowerKw(tags = {}) {
  let best = null;
  for (const [key, value] of Object.entries(tags)) {
    if (!/^socket:.*:output$/.test(key)) continue;
    for (const part of String(value).split(';')) {
      const kw = Number.parseFloat(part);
      if (!Number.isFinite(kw) || kw < MIN_PLAUSIBLE_KW || kw > MAX_PLAUSIBLE_KW) continue;
      if (kw > (best ?? 0)) best = kw;
    }
  }
  return best;
}

function normalizeOverpassCatalog(payload, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(payload?.elements)) {
    throw new TypeError('Invalid Overpass response: elements must be an array');
  }
  const stations = [];
  for (const element of payload.elements) {
    if (!isTeslaSuperchargerTags(element?.tags)) continue;
    const coordinates = featureCoordinates(element);
    if (!coordinates) continue;
    const featureId = `${element.type}/${element.id}`;
    const name = text(element.tags.name)
      || text(element.tags['addr:street'])
      || 'Tesla Supercharger';
    let station = stations.find((candidate) => haversineMetres(
      coordinates.latitude,
      coordinates.longitude,
      candidate.latitude,
      candidate.longitude,
    ) <= 100);
    if (!station) {
      station = {
        stationId: featureId,
        name,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        osmFeatures: [],
        coordinateCount: 0,
      };
      stations.push(station);
    }
    const nextCount = station.coordinateCount + 1;
    station.latitude = (
      station.latitude * station.coordinateCount + coordinates.latitude
    ) / nextCount;
    station.longitude = (
      station.longitude * station.coordinateCount + coordinates.longitude
    ) / nextCount;
    station.coordinateCount = nextCount;
    station.osmFeatures.push(featureId);
    if (station.name === 'Tesla Supercharger' && name !== 'Tesla Supercharger') {
      station.name = name;
    }
    // Mixed-generation sites use their fastest post.
    const powerKw = stationPowerKw(element.tags);
    if (powerKw != null && powerKw > (station.powerKw ?? 0)) station.powerKw = powerKw;
  }
  for (const station of stations) delete station.coordinateCount;
  return validateCatalog({
    version: 1,
    generatedAt,
    attribution: OSM_ATTRIBUTION,
    stations,
  });
}

// Prefer the car's location label over OSM's generic brand-only name.
const GENERIC_CATALOG_NAME = /^tesla\s+supercharger$/i;

function preferredSiteName(catalogName, reportedName) {
  const catalog = text(catalogName);
  const reported = text(reportedName);
  if (catalog && !GENERIC_CATALOG_NAME.test(catalog)) return catalog;
  if (reported && !PLACEHOLDER_SITE_LABELS.has(reported)) return reported;
  return catalog || reported || 'Tesla Supercharger';
}

// Bolt tiers: 3 at 250+ kW, 2 at 150+ kW, 1 below 150 kW, none if unrated.
const SPEED_TIER_MIN_KW = [250, 150, 0];

function speedTierFromPowerKw(powerKw) {
  const kw = Number(powerKw);
  if (!Number.isFinite(kw) || kw <= 0) return 0;
  for (let index = 0; index < SPEED_TIER_MIN_KW.length; index++) {
    if (kw >= SPEED_TIER_MIN_KW[index]) return SPEED_TIER_MIN_KW.length - index;
  }
  return 0;
}

function matchChargingSites(sites, catalog, radiusMetres = 250) {
  const stations = Array.isArray(catalog?.stations) ? catalog.stations : [];
  return sites.map((site) => {
    if (!Number.isFinite(site.latitude) || !Number.isFinite(site.longitude)) {
      return { ...site, isSupercharger: false, chargerType: 'other' };
    }
    let nearest = null;
    let nearestDistance = Infinity;
    for (const station of stations) {
      const distance = haversineMetres(
        site.latitude,
        site.longitude,
        station.latitude,
        station.longitude,
      );
      if (distance < nearestDistance) {
        nearest = station;
        nearestDistance = distance;
      }
    }
    if (!nearest || nearestDistance > radiusMetres) {
      return { ...site, isSupercharger: false, chargerType: 'other' };
    }
    return {
      ...site,
      displayName: preferredSiteName(nearest.name, site.displayName),
      isSupercharger: true,
      chargerType: 'supercharger',
      catalogStationId: nearest.stationId,
      superchargerDistanceM: Math.round(nearestDistance),
      powerKw: nearest.powerKw ?? null,
      speedTier: speedTierFromPowerKw(nearest.powerKw),
    };
  });
}

function readCatalog(filePath) {
  return validateCatalog(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function createSuperchargerCatalog(options) {
  const {
    bundledPath,
    cachePath,
    fetchImpl = globalThis.fetch,
    endpoint = OVERPASS_ENDPOINT,
    now = () => new Date(),
    retryDelaysMs,
    sleep,
  } = options;
  let catalog;
  let source;
  let lastError = null;

  try {
    catalog = readCatalog(cachePath);
    source = 'refreshed';
  } catch {
    catalog = readCatalog(bundledPath);
    source = 'bundled';
  }

  function getStatus() {
    return {
      source,
      generatedAt: catalog.generatedAt,
      stationCount: catalog.stations.length,
      attribution: catalog.attribution || OSM_ATTRIBUTION,
      lastError,
    };
  }

  async function refresh() {
    let tempPath = null;
    try {
      const elements = [];
      for (const query of OVERPASS_QUERIES) {
        elements.push(...await fetchOverpassElements(query, {
          fetchImpl, endpoint, retryDelaysMs, sleep,
        }));
      }
      const refreshed = normalizeOverpassCatalog(
        { elements },
        now().toISOString(),
      );
      if (refreshed.stations.length === 0) {
        throw new Error('Invalid Supercharger catalog: refresh returned no stations');
      }
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, `${JSON.stringify(refreshed)}\n`);
      try {
        await fsyncFile(tempPath);
      } catch {
        // Best effort on network-backed application data.
      }
      await renameWithRetry(tempPath, cachePath);
      tempPath = null;
      catalog = refreshed;
      source = 'refreshed';
      lastError = null;
      return { success: true, ...getStatus() };
    } catch (error) {
      if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
      lastError = error?.message ?? String(error);
      return { success: false, error: lastError, ...getStatus() };
    }
  }

  return {
    getCatalog: () => catalog,
    getStatus,
    refresh,
  };
}

module.exports = {
  OSM_ATTRIBUTION,
  OVERPASS_ENDPOINT,
  OVERPASS_QUERY,
  OVERPASS_QUERIES,
  createSuperchargerCatalog,
  fetchOverpassElements,
  isTeslaSuperchargerTags,
  matchChargingSites,
  normalizeOverpassCatalog,
  speedTierFromPowerKw,
  stationPowerKw,
  validateCatalog,
};
