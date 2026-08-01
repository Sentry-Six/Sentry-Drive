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
  speedTierFromPowerKw,
  stationPowerKw,
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

test('reads the stall rating from OSM socket output tags, fastest socket wins', () => {
  assert.equal(stationPowerKw({ 'socket:nacs:output': '250' }), 250);
  assert.equal(stationPowerKw({ 'socket:nacs:output': '325' }), 325);
  // Mixed-generation sites list several outputs on one tag.
  assert.equal(stationPowerKw({ 'socket:nacs:output': '72;250' }), 250);
  // Or across several socket types.
  assert.equal(stationPowerKw({
    'socket:nacs:output': '150',
    'socket:type1_combo:output': '325',
  }), 325);
  assert.equal(stationPowerKw({ 'socket:nacs:output': '250 kW' }), 250); // unit suffix
  assert.equal(stationPowerKw({ 'socket:nacs': '12' }), null);           // count, not output
  assert.equal(stationPowerKw({}), null);
  // Implausible values are OSM typos — the live catalog contains a literal
  // 250000. Reject rather than badge a site as a megacharger.
  assert.equal(stationPowerKw({ 'socket:nacs:output': '250000' }), null);
  assert.equal(stationPowerKw({ 'socket:nacs:output': '0' }), null);
  assert.equal(stationPowerKw({ 'socket:nacs:output': '-5' }), null);
  // A typo alongside a real reading keeps the real one.
  assert.equal(stationPowerKw({ 'socket:nacs:output': '250000;250' }), 250);
  assert.equal(stationPowerKw({ 'socket:nacs:output': '1200' }), 1200); // Semi megacharger
});

test('speed tier maps ratings to bolt counts, split at 120 kW', () => {
  assert.equal(speedTierFromPowerKw(72), 1);    // V1 / urban — slow
  assert.equal(speedTierFromPowerKw(119), 1);   // just under the line
  assert.equal(speedTierFromPowerKw(120), 3);   // the line itself is fast
  assert.equal(speedTierFromPowerKw(150), 3);   // V2
  assert.equal(speedTierFromPowerKw(250), 3);   // V3
  assert.equal(speedTierFromPowerKw(325), 3);   // V4
  assert.equal(speedTierFromPowerKw(500), 3);
  // Unknown or nonsense ratings draw no bolts rather than guessing.
  assert.equal(speedTierFromPowerKw(null), 0);
  assert.equal(speedTierFromPowerKw(undefined), 0);
  assert.equal(speedTierFromPowerKw(0), 0);
  assert.equal(speedTierFromPowerKw(-5), 0);
  assert.equal(speedTierFromPowerKw('nope'), 0);
});

test('matched Superchargers carry the rating and tier; unmatched sites carry neither', () => {
  const sites = [
    { siteId: 'fast', latitude: 40, longitude: -76, displayName: '1 Main St' },
    { siteId: 'away', latitude: 41, longitude: -76, displayName: 'Home' },
  ];
  const matched = matchChargingSites(sites, {
    stations: [{ stationId: 'node/1', name: 'Tesla Supercharger', latitude: 40, longitude: -76, powerKw: 325 }],
  });
  assert.equal(matched[0].powerKw, 325);
  assert.equal(matched[0].speedTier, 3);
  assert.equal(matched[1].powerKw, undefined);
  assert.equal(matched[1].isSupercharger, false);

  // A station the catalog has no rating for is still a Supercharger, just
  // without bolts.
  const unrated = matchChargingSites([sites[0]], {
    stations: [{ stationId: 'node/2', name: 'Tesla Supercharger', latitude: 40, longitude: -76 }],
  });
  assert.equal(unrated[0].isSupercharger, true);
  assert.equal(unrated[0].powerKw, null);
  assert.equal(unrated[0].speedTier, 0);
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
