import test from 'node:test';
import assert from 'node:assert/strict';
import chargingView from './charging-view.cjs';

const {
  buildChargingCurve,
  filterAndSortChargingSites,
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
        },
        geometry: { type: 'Point', coordinates: [-77, 41] },
      },
    ],
  });
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
