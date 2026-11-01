import test from 'node:test';
import assert from 'node:assert/strict';
import mapStyle from './map-style.cjs';

const {
  STYLE_URLS,
  composeBasemap,
  fallbackStyle,
  labelGroup,
  mergeAppLayers,
  normalizeLayerName,
} = mapStyle;

const vectorStyle = (bg) => ({
  version: 8,
  glyphs: 'https://tiles.versatiles.org/assets/glyphs/{fontstack}/{range}.pbf',
  sprite: [{ id: 'base', url: 'https://tiles.versatiles.org/assets/sprites/base' }],
  sources: { 'versatiles-shortbread': { type: 'vector', tiles: ['https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}'] } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': bg } },
    { id: 'street-primary', type: 'line', source: 'versatiles-shortbread' },
    { id: 'poi-shop', type: 'symbol', source: 'versatiles-shortbread' },
    { id: 'label-street-primary', type: 'symbol', source: 'versatiles-shortbread' },
    { id: 'label-place-city', type: 'symbol', source: 'versatiles-shortbread', layout: { 'text-field': '{name}' } },
    { id: 'slot-below-labels', type: 'background', paint: { 'background-opacity': 0 } },
  ],
});

test('only VersaTiles styles are used and Google-era names migrate', () => {
  assert.deepEqual(Object.keys(STYLE_URLS), ['Light', 'Dark']);
  for (const url of Object.values(STYLE_URLS)) {
    assert.equal(new URL(url).origin, 'https://tiles.versatiles.org');
  }
  assert.equal(normalizeLayerName('Google Maps'), 'Light');
  assert.equal(normalizeLayerName('Google Dark'), 'Dark');
  assert.equal(normalizeLayerName('Satellite'), 'Light');
  assert.equal(normalizeLayerName('Dark'), 'Dark');
  assert.equal(normalizeLayerName(null), 'Light');
  assert.equal(normalizeLayerName('Unknown'), 'Light');
});

test('label layers are grouped to match the map and road label settings', () => {
  assert.equal(labelGroup('label-place-city'), 'place');
  assert.equal(labelGroup('label-boundary-country-large'), 'place');
  assert.equal(labelGroup('label-water-river'), 'place');
  assert.equal(labelGroup('label-street-residential'), 'road');
  assert.equal(labelGroup('label-motorway-shield'), 'road');
  assert.equal(labelGroup('marking-oneway-reverse'), 'road');
  assert.equal(labelGroup('poi-shop'), 'hidden');
  assert.equal(labelGroup('symbol-transit-bus'), 'hidden');
});

test('composed basemap moves labels after base layers and applies visibility', () => {
  const { style, labelLayerIds } = composeBasemap('Light', vectorStyle('#fff'), {
    showMapLabels: true, showRoadLabels: false,
  });
  assert.deepEqual(style.layers.map((l) => l.id), [
    'background', 'street-primary', 'slot-below-labels', 'poi-shop', 'label-street-primary', 'label-place-city',
  ]);
  assert.deepEqual(labelLayerIds, ['poi-shop', 'label-street-primary', 'label-place-city']);
  const vis = Object.fromEntries(style.layers.filter((l) => l.layout).map((l) => [l.id, l.layout.visibility]));
  assert.deepEqual(vis, { 'poi-shop': 'none', 'label-street-primary': 'none', 'label-place-city': 'visible' });
  assert.equal(style.layers.at(-1).layout['text-field'], '{name}');
  assert.ok(style.glyphs);
});

test('offline fallback keeps a plain background without remote resources', () => {
  const { style, labelLayerIds } = composeBasemap('Dark', null);
  assert.deepEqual(style, fallbackStyle('Dark'));
  assert.deepEqual(labelLayerIds, []);
  assert.equal(style.glyphs, undefined);
  assert.deepEqual(style.sources, {});
});

test('app layers stay between basemap and labels, charging stays on top', () => {
  const basemap = composeBasemap('Dark', vectorStyle('#000'));
  const live = {
    sources: {
      overview: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      'charging-sites': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      'old-basemap': { type: 'raster', tiles: [] },
    },
    layers: [
      { id: 'background', type: 'background' },
      { id: 'overview-native', type: 'line', source: 'overview' },
      { id: 'charging-site-pills', type: 'symbol', source: 'charging-sites' },
      { id: 'overview-dim', type: 'line', source: 'overview' },
    ],
  };
  const merged = mergeAppLayers(basemap, live, ['overview', 'charging-sites'], ['charging-site-pills']);
  assert.deepEqual(merged.layers.map((l) => l.id), [
    'background', 'street-primary', 'slot-below-labels', 'overview-native', 'overview-dim',
    'poi-shop', 'label-street-primary', 'label-place-city', 'charging-site-pills',
  ]);
  assert.ok(merged.sources.overview && merged.sources['charging-sites']);
  assert.equal(merged.sources['old-basemap'], undefined);
});
