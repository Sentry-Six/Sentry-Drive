'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fsyncFile } = require('../shared/atomic-write.cjs');
const { haversineMetres } = require('../shared/charging-history.cjs');
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
  }
  for (const station of stations) delete station.coordinateCount;
  return validateCatalog({
    version: 1,
    generatedAt,
    attribution: OSM_ATTRIBUTION,
    stations,
  });
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
      displayName: nearest.name || site.displayName,
      isSupercharger: true,
      chargerType: 'supercharger',
      catalogStationId: nearest.stationId,
      superchargerDistanceM: Math.round(nearestDistance),
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
      if (typeof fetchImpl !== 'function') throw new Error('Refresh is unavailable offline');
      const elements = [];
      for (const query of OVERPASS_QUERIES) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 150_000);
        let response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'user-agent': 'Sentry Drive Supercharger Catalog/1.0',
            },
            body: `data=${encodeURIComponent(query)}`,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!response?.ok) {
          throw new Error(`OpenStreetMap refresh failed (${response?.status ?? 'no response'})`);
        }
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 25 * 1024 * 1024) {
          throw new Error('OpenStreetMap refresh response is too large');
        }
        const payload = await response.json();
        if (!Array.isArray(payload?.elements)) {
          throw new TypeError('Invalid Overpass response: elements must be an array');
        }
        elements.push(...payload.elements);
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
  isTeslaSuperchargerTags,
  matchChargingSites,
  normalizeOverpassCatalog,
  validateCatalog,
};
