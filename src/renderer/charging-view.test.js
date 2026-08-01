import test from 'node:test';
import assert from 'node:assert/strict';
import chargingView from './charging-view.cjs';

const {
  buildChargingClusterLayers,
  buildChargingCurve,
  buildChargingSourceOptions,
  buildChargingSiteLayers,
  chargingPillFromImageId,
  chargingPillImageId,
  filterAndSortChargingSites,
  getChargingClusterPresentation,
  toChargingGeoJSON,
} = chargingView;

const sites = [
  {
    siteId: 'other-old',
    displayName: 'Other old',
    visitCount: 2,
    latestVisit: '2026-01-01T00:00:00.000Z',
    latitude: 40,
    longitude: -76,
    isSupercharger: false,
  },
  {
    siteId: 'tesla',
    displayName: 'Tesla North',
    visitCount: 3,
    latestVisit: '2026-02-01T00:00:00.000Z',
    latitude: 41,
    longitude: -77,
    isSupercharger: true,
  },
  {
    siteId: 'other-new',
    displayName: 'Other new',
    visitCount: 2,
    latestVisit: '2026-03-01T00:00:00.000Z',
    latitude: null,
    longitude: null,
    isSupercharger: false,
  },
];

test('filters charging classifications and sorts by visits then recency', () => {
  assert.deepEqual(
    filterAndSortChargingSites(sites, {
      showSuperchargers: true,
      showOther: true,
    }).map((site) => site.siteId),
    ['tesla', 'other-new', 'other-old'],
  );
  assert.deepEqual(
    filterAndSortChargingSites(sites, {
      showSuperchargers: false,
      showOther: true,
    }).map((site) => site.siteId),
    ['other-new', 'other-old'],
  );
  assert.deepEqual(
    filterAndSortChargingSites(sites, {
      showSuperchargers: true,
      showOther: false,
    }).map((site) => site.siteId),
    ['tesla'],
  );
});

test('creates mappable point features with classification and visit count', () => {
  assert.deepEqual(toChargingGeoJSON(sites), {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          siteId: 'other-old',
          displayName: 'Other old',
          visitCount: 2,
          isSupercharger: false,
          speedTier: 0,
        },
        geometry: { type: 'Point', coordinates: [-76, 40] },
      },
      {
        type: 'Feature',
        properties: {
          siteId: 'tesla',
          displayName: 'Tesla North',
          visitCount: 3,
          isSupercharger: true,
          speedTier: 0,
        },
        geometry: { type: 'Point', coordinates: [-77, 41] },
      },
    ],
  });
});

test('configures charging clusters to sum visits and charger classifications', () => {
  const data = { type: 'FeatureCollection', features: [] };

  assert.deepEqual(buildChargingSourceOptions(data), {
    type: 'geojson',
    data,
    cluster: true,
    clusterRadius: 42,
    clusterMaxZoom: 13,
    clusterProperties: {
      clusterVisitCount: ['+', ['coalesce', ['get', 'visitCount'], 0]],
      superchargerSiteCount: ['+', ['case', ['==', ['get', 'isSupercharger'], true], 1, 0]],
      otherSiteCount: ['+', ['case', ['==', ['get', 'isSupercharger'], false], 1, 0]],
    },
  });
});

test('draws sites and clusters as pill symbols keyed by type, count, and tier', () => {
  const site = buildChargingSiteLayers();
  const cluster = buildChargingClusterLayers();

  assert.deepEqual(site.map((l) => l.id), ['charging-site-pills']);
  assert.deepEqual(cluster.map((l) => l.id), ['charging-cluster-pills']);
  for (const layer of [...site, ...cluster]) {
    assert.equal(layer.type, 'symbol');
    assert.equal(layer.source, 'charging-sites');
    assert.equal(layer.layout.visibility, 'none');
    // Pills must not be dropped or displaced by label collision.
    assert.equal(layer.layout['icon-allow-overlap'], true);
    assert.equal(layer.layout['icon-ignore-placement'], true);
  }
  assert.deepEqual(site[0].filter, ['!', ['has', 'point_count']]);
  assert.deepEqual(cluster[0].filter, ['has', 'point_count']);

  // A site pill carries its own bolt count...
  assert.deepEqual(site[0].layout['icon-image'], [
    'concat',
    'charging-pill-',
    ['case', ['==', ['get', 'isSupercharger'], true], 'sc', 'other'],
    '-', ['to-string', ['get', 'visitCount']],
    '-', ['to-string', ['coalesce', ['get', 'speedTier'], 0]],
  ]);
  // ...while a cluster spans sites of differing ratings, so it shows none.
  assert.ok(cluster[0].layout['icon-image'].at(-1) === '-0');
});

test('pill image ids round-trip and reject anything else', () => {
  assert.equal(chargingPillImageId({ type: 'sc', count: 3, bolts: 2 }), 'charging-pill-sc-3-2');
  assert.deepEqual(chargingPillFromImageId('charging-pill-sc-3-2'), { type: 'sc', count: 3, bolts: 2 });
  assert.deepEqual(chargingPillFromImageId('charging-pill-other-38-0'), { type: 'other', count: 38, bolts: 0 });
  assert.deepEqual(chargingPillFromImageId('charging-pill-mixed-12-0'), { type: 'mixed', count: 12, bolts: 0 });
  // Round-trip every id the layer expressions can produce.
  for (const type of ['sc', 'other', 'mixed']) {
    for (const bolts of [0, 1, 2, 3]) {
      const id = chargingPillImageId({ type, count: 7, bolts });
      assert.deepEqual(chargingPillFromImageId(id), { type, count: 7, bolts });
    }
  }
  assert.equal(chargingPillFromImageId('charging-pill-sc-3-4'), null);   // no 4-bolt tier
  assert.equal(chargingPillFromImageId('charging-pill-bogus-3-1'), null);
  assert.equal(chargingPillFromImageId('charging-pill-sc-3.5-1'), null);
  assert.equal(chargingPillFromImageId('vehicle-35'), null);
});

test('presents all-Supercharger, all-other, and mixed clusters by summed visits', () => {
  assert.deepEqual(getChargingClusterPresentation({
    clusterVisitCount: 12,
    superchargerSiteCount: 2,
    otherSiteCount: 0,
  }), {
    type: 'supercharger',
    visitCount: 12,
    label: '12',
    sizePx: 48,
    accessibleLabel: 'Supercharger cluster, 12 charging visits. Zoom in to expand.',
  });

  assert.equal(getChargingClusterPresentation({
    clusterVisitCount: 3,
    superchargerSiteCount: 0,
    otherSiteCount: 2,
  }).type, 'other');

  assert.equal(getChargingClusterPresentation({
    clusterVisitCount: 7,
    superchargerSiteCount: 1,
    otherSiteCount: 1,
  }).type, 'mixed');

  assert.equal(getChargingClusterPresentation({
    clusterVisitCount: Number.MAX_SAFE_INTEGER,
    superchargerSiteCount: 1,
    otherSiteCount: 1,
  }).sizePx, 60);
});

test('builds a bounded charging-power curve from valid samples', () => {
  assert.deepEqual(buildChargingCurve([
    { timestamp: 100, powerKw: 0 },
    { timestamp: 110, powerKw: 50 },
    { timestamp: 120, powerKw: 25 },
    { timestamp: 'bad', powerKw: 99 },
  ], 200, 80), {
    path: 'M 0 72 L 100 8 L 200 40',
    peakPowerKw: 50,
    durationSeconds: 20,
  });
  assert.equal(buildChargingCurve([], 200, 80), null);
});
