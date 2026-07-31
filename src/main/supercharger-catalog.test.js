import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSuperchargerCatalog,
  isTeslaSuperchargerTags,
  matchChargingSites,
  normalizeOverpassCatalog,
} from './supercharger-catalog.cjs';

test('recognizes explicit Supercharger tags and excludes Destination Charging', () => {
  assert.equal(isTeslaSuperchargerTags({
    amenity: 'charging_station',
    brand: 'Tesla Supercharger',
  }), true);
  assert.equal(isTeslaSuperchargerTags({
    amenity: 'charging_station',
    'brand:wikidata': 'Q17089620',
  }), true);
  assert.equal(isTeslaSuperchargerTags({
    amenity: 'charging_station',
    'ref:supercharge_info': '1234',
  }), true);
  assert.equal(isTeslaSuperchargerTags({
    amenity: 'charging_station',
    'socket:tesla_supercharger': '8',
  }), true);
  assert.equal(isTeslaSuperchargerTags({
    amenity: 'charging_station',
    'socket:tesla_supercharger_ccs': '8',
  }), true);
  assert.equal(isTeslaSuperchargerTags({
    amenity: 'charging_station',
    brand: 'Tesla',
    network: 'Tesla Destination',
    'socket:tesla_supercharger': '2',
  }), false);
  assert.equal(isTeslaSuperchargerTags({
    amenity: 'charging_station',
    brand: 'Tesla',
  }), false);
});

test('normalizes and deduplicates OSM nodes and areas for the same station', () => {
  const catalog = normalizeOverpassCatalog({
    elements: [
      {
        type: 'node',
        id: 1,
        lat: 40,
        lon: -76,
        tags: { amenity: 'charging_station', brand: 'Tesla Supercharger', name: 'Tesla North' },
      },
      {
        type: 'way',
        id: 2,
        center: { lat: 40.0002, lon: -76.0002 },
        tags: { amenity: 'charging_station', 'brand:wikidata': 'Q17089620' },
      },
      {
        type: 'node',
        id: 3,
        lat: 41,
        lon: -77,
        tags: { amenity: 'charging_station', network: 'Tesla Destination' },
      },
    ],
  }, '2026-07-31T00:00:00.000Z');

  assert.equal(catalog.stations.length, 1);
  assert.equal(catalog.stations[0].name, 'Tesla North');
  assert.deepEqual(catalog.stations[0].osmFeatures.sort(), ['node/1', 'way/2']);
  assert.equal(catalog.attribution, '© OpenStreetMap contributors');
});

test('matches only charging sites within 250 metres and uses the catalog name', () => {
  const sites = [
    { siteId: 'inside', latitude: 40, longitude: -76, displayName: 'Raw name' },
    { siteId: 'outside', latitude: 40.005, longitude: -76, displayName: 'High power stop' },
    { siteId: 'unknown', latitude: null, longitude: null, displayName: 'Unknown location' },
  ];
  const matched = matchChargingSites(sites, {
    stations: [{
      stationId: 'node/1',
      name: 'Tesla North Supercharger',
      latitude: 40.002,
      longitude: -76,
    }],
  });

  assert.deepEqual(matched.map((site) => ({
    siteId: site.siteId,
    displayName: site.displayName,
    isSupercharger: site.isSupercharger,
    chargerType: site.chargerType,
  })), [
    {
      siteId: 'inside',
      displayName: 'Tesla North Supercharger',
      isSupercharger: true,
      chargerType: 'supercharger',
    },
    {
      siteId: 'outside',
      displayName: 'High power stop',
      isSupercharger: false,
      chargerType: 'other',
    },
    {
      siteId: 'unknown',
      displayName: 'Unknown location',
      isSupercharger: false,
      chargerType: 'other',
    },
  ]);
});

test('a catalog name that only repeats the brand keeps the name the car reported', () => {
  // Most OSM Supercharger nodes are literally named "Tesla Supercharger",
  // which is less useful than the street the car reported charging at.
  const station = (name) => ({
    stationId: 'node/1', name, latitude: 40, longitude: -76,
  });
  const matchOne = (siteName, catalogName) => matchChargingSites(
    [{ siteId: 's', latitude: 40, longitude: -76, displayName: siteName }],
    { stations: [station(catalogName)] },
  )[0];

  // Generic catalog name loses to the car's street address...
  assert.equal(matchOne('150 Anza Blvd', 'Tesla Supercharger').displayName, '150 Anza Blvd');
  assert.equal(matchOne('150 Anza Blvd', 'tesla  supercharger').displayName, '150 Anza Blvd');
  // ...but a catalog name that identifies the site still wins.
  assert.equal(
    matchOne('150 Anza Blvd', 'Mountain View Supercharger').displayName,
    'Mountain View Supercharger',
  );
  // With nothing but placeholders on the site, the brand is the best we have.
  assert.equal(matchOne('Charging location', 'Tesla Supercharger').displayName, 'Tesla Supercharger');
  assert.equal(matchOne('Unknown location', 'Tesla Supercharger').displayName, 'Tesla Supercharger');
  // A nameless catalog entry never erases a real reported name.
  assert.equal(matchOne('150 Anza Blvd', '').displayName, '150 Anza Blvd');
  // Matching still flags the site regardless of which name won.
  assert.equal(matchOne('150 Anza Blvd', 'Tesla Supercharger').isSupercharger, true);
});

test('manual refresh atomically replaces valid cache and retains prior data on failure', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-superchargers-'));
  const bundledPath = path.join(dir, 'bundled.json');
  const cachePath = path.join(dir, 'cache.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(bundledPath, JSON.stringify({
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    attribution: '© OpenStreetMap contributors',
    stations: [{
      stationId: 'node/old',
      name: 'Old station',
      latitude: 40,
      longitude: -76,
      osmFeatures: ['node/old'],
    }],
  }));
  let requestOptions;
  let response = {
    ok: true,
    async json() {
      return {
        elements: [{
          type: 'node',
          id: 9,
          lat: 41,
          lon: -77,
          tags: { amenity: 'charging_station', brand: 'Tesla Supercharger', name: 'New station' },
        }],
      };
    },
  };
  const catalog = createSuperchargerCatalog({
    bundledPath,
    cachePath,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return response;
    },
    now: () => new Date('2026-07-31T12:00:00.000Z'),
  });

  assert.equal(catalog.getStatus().source, 'bundled');
  const refreshed = await catalog.refresh();
  assert.equal(refreshed.success, true);
  assert.match(requestOptions.headers['user-agent'], /Sentry Drive/i);
  assert.equal(catalog.getStatus().source, 'refreshed');
  assert.equal(catalog.getCatalog().stations[0].name, 'New station');
  const validCacheBytes = fs.readFileSync(cachePath);

  response = {
    ok: true,
    async json() {
      return { elements: 'invalid' };
    },
  };
  const failed = await catalog.refresh();
  assert.equal(failed.success, false);
  assert.equal(catalog.getCatalog().stations[0].name, 'New station');
  assert.deepEqual(fs.readFileSync(cachePath), validCacheBytes);
  assert.match(catalog.getStatus().lastError, /invalid/i);
});
