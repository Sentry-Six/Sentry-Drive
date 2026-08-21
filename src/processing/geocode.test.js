import test from 'node:test';
import assert from 'node:assert/strict';
import geocode from './geocode.cjs';

const {
  cacheRecord,
  cacheRecordIsFresh,
  buildReverseUrl,
  chooseBetterMatch,
  geometryContainsPoint,
  labelMatch,
  shortLabel,
} = geocode._test;
const queryLat = 0;
const queryLng = 0;

function pointResult({ lat, category, name, houseNumber }) {
  return {
    lat: String(lat),
    lon: '0',
    osm_type: 'node',
    category,
    type: houseNumber ? 'house' : category,
    addresstype: houseNumber ? 'house' : category,
    name,
    address: {
      road: 'Main Street',
      ...(houseNumber ? { house_number: houseNumber } : {}),
    },
  };
}

test('trusts address points within 25 m and rejects farther house numbers', () => {
  const nearby = pointResult({ lat: 0.00018, category: 'place', houseNumber: '10' });
  const farther = pointResult({ lat: 0.00027, category: 'place', houseNumber: '12' });

  assert.equal(shortLabel(nearby, queryLat, queryLng), '10 Main Street');
  assert.equal(shortLabel(farther, queryLat, queryLng), 'Main Street');
});

test('trusts point POI names within 30 m and rejects farther POIs', () => {
  const nearby = pointResult({ lat: 0.00025, category: 'amenity', name: 'Corner Cafe' });
  const farther = pointResult({ lat: 0.00032, category: 'amenity', name: 'Wrong Cafe' });

  assert.equal(shortLabel(nearby, queryLat, queryLng), 'Corner Cafe');
  assert.equal(shortLabel(farther, queryLat, queryLng), 'Main Street');
});

test('rejects incidental map objects even when they are nearby POIs', () => {
  const bench = pointResult({ lat: 0.00005, category: 'amenity', name: 'Memorial Bench' });
  bench.type = 'bench';
  assert.equal(shortLabel(bench, queryLat, queryLng), 'Main Street');
});

test('trusts named building areas only when their exact geometry contains the point', () => {
  const building = {
    lat: '0.0005',
    lon: '0.0005',
    osm_type: 'way',
    osm_id: 42,
    category: 'building',
    type: 'commercial',
    name: 'Market Hall',
    boundingbox: ['-0.0001', '0.001', '-0.0001', '0.001'],
    geojson: {
      type: 'Polygon',
      coordinates: [[
        [-0.001, -0.001], [0.001, -0.001], [0.001, 0.001],
        [-0.001, 0.001], [-0.001, -0.001],
      ]],
    },
    address: { road: 'Main Street' },
  };
  const adjacent = {
    ...building,
    name: 'Adjacent Market',
    // Its axis-aligned bounds still cover the query, but the concave polygon
    // does not. Bounding-box validation used to accept this false positive.
    geojson: {
      type: 'Polygon',
      coordinates: [[
        [-0.001, -0.001], [0.001, -0.001], [0.001, -0.0002],
        [-0.0002, -0.0002], [-0.0002, 0.001], [-0.001, 0.001],
        [-0.001, -0.001],
      ]],
    },
  };

  assert.equal(shortLabel(building, queryLat, queryLng), 'Market Hall');
  assert.equal(shortLabel(adjacent, queryLat, queryLng), 'Main Street');
});

test('polygon containment handles holes, multipolygons, and their boundaries', () => {
  const polygonWithHole = {
    type: 'Polygon',
    coordinates: [
      [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]],
      [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]],
    ],
  };
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
      [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
    ],
  };

  assert.equal(geometryContainsPoint(polygonWithHole, 0, 0), false);
  assert.equal(geometryContainsPoint(polygonWithHole, 0, 1), true);
  assert.equal(geometryContainsPoint(multi, 0, 0), true);
});

test('trusts an area name when a mapped entrance is close to the endpoint', () => {
  const building = {
    lat: '0.001', lon: '0.001', osm_type: 'way', category: 'building',
    type: 'commercial', name: 'Entrance Market', address: { road: 'Main Street' },
    entrances: [{ lat: '0.00012', lon: '0' }],
  };
  assert.equal(shortLabel(building, queryLat, queryLng), 'Entrance Market');
});

test('endpoint uncertainty lowers otherwise confident matches', () => {
  const cafe = pointResult({ lat: 0.00005, category: 'amenity', name: 'Corner Cafe' });
  assert.equal(labelMatch(cafe, queryLat, queryLng, 20).confidence, 'medium');
  assert.equal(labelMatch(cafe, queryLat, queryLng, 35).confidence, 'low');
});

test('formats house numbers in the order used by the provider display name', () => {
  const house = pointResult({ lat: 0.00005, category: 'place', houseNumber: '10' });
  house.display_name = 'Main Street, 10, Sampletown';
  assert.equal(shortLabel(house, queryLat, queryLng), 'Main Street 10');
});

test('comparison prefers confidence, then useful feature specificity', () => {
  const road = { label: 'Main Street', confidence: 'medium', featureType: 'road', distanceM: 2 };
  const poi = { label: 'Corner Cafe', confidence: 'high', featureType: 'poi', distanceM: 20 };
  const building = { label: 'Market Hall', confidence: 'high', featureType: 'building', distanceM: 5 };
  assert.equal(chooseBetterMatch(road, poi), poi);
  assert.equal(chooseBetterMatch(building, poi), poi);
});

test('provider URL supports custom base paths, entrances, polygons, and layers', () => {
  geocode.configure({ endpoint: 'https://geo.example/base/reverse', language: 'fr' });
  const url = buildReverseUrl(1, 2, 18, 'poi');
  assert.equal(url.origin + url.pathname, 'https://geo.example/base/reverse');
  assert.equal(url.searchParams.get('entrances'), '1');
  assert.equal(url.searchParams.get('polygon_geojson'), '1');
  assert.equal(url.searchParams.get('layer'), 'poi');
  geocode.configure({ endpoint: 'https://nominatim.openstreetmap.org', language: '' });
});

test('structured cache records retain provenance and refresh according to confidence', () => {
  const match = labelMatch({
    lat: '0.00018',
    lon: '0',
    osm_type: 'node',
    osm_id: 99,
    category: 'place',
    type: 'house',
    addresstype: 'house',
    address: { house_number: '10', road: 'Main Street' },
  }, queryLat, queryLng);
  const resolvedAt = Date.UTC(2026, 0, 1);
  const record = cacheRecord(match, resolvedAt);

  assert.deepEqual(record, {
    label: '10 Main Street',
    featureType: 'address-point',
    confidence: 'high',
    distanceM: match.distanceM,
    osmId: 'node/99',
    queryAccuracyM: 0,
    source: 'provider',
    provider: 'https://nominatim.openstreetmap.org',
    resolvedAt,
  });
  assert.equal(cacheRecordIsFresh(record, resolvedAt + 364 * 86400000), true);
  assert.equal(cacheRecordIsFresh(record, resolvedAt + 366 * 86400000), false);

  const miss = cacheRecord(null, resolvedAt);
  assert.equal(cacheRecordIsFresh(miss, resolvedAt + 29 * 86400000), true);
  assert.equal(cacheRecordIsFresh(miss, resolvedAt + 31 * 86400000), false);
  assert.equal(cacheRecordIsFresh(record, resolvedAt + 1, 'https://geo.example'), false);
});
