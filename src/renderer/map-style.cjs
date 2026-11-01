'use strict';

// Basemap styles come from the SentryUSB VersaTiles server (OpenStreetMap
// vector tiles). This module only composes style JSON so the renderer can
// keep its own route layers between the basemap and the labels; it does no
// network work and is unit tested under Node.
(function exposeMapStyle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MapStyle = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  // Single origin for styles, tiles, glyphs and sprites. The CSP in
  // index.html names the same origin.
  const TILE_ORIGIN = 'https://tiles.sentryusb.com';
  const STYLE_URLS = {
    Light: `${TILE_ORIGIN}/assets/styles/colorful/style.json`,
    Dark: `${TILE_ORIGIN}/assets/styles/sentry-dark/style.json`,
  };
  const LAYER_NAMES = ['Light', 'Dark'];
  const DEFAULT_LAYER = 'Light';
  // Saved layer names from older releases map onto current layers.
  const LAYER_RENAMES = { 'Google Maps': 'Light', 'Google Dark': 'Dark', Satellite: 'Light' };
  const VERSATILES_ATTRIBUTION = '<a href="https://versatiles.org/">VersaTiles</a>';
  // Credit for the OpenStreetMap tileset, applied to every style source.
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  // Painted when the style cannot be fetched (offline) so routes still draw.
  const FALLBACK_BACKGROUND = { Light: '#f8f4f0', Dark: '#141c21' };

  function normalizeLayerName(saved) {
    const name = LAYER_RENAMES[saved] || saved;
    return LAYER_NAMES.includes(name) ? name : DEFAULT_LAYER;
  }

  // Label classes mirror the app's two settings: "map labels" (places,
  // boundaries, water) and "road labels" (street names, shields, one-way
  // arrows). POIs, transit icons and house numbers stay hidden so drive
  // routes remain the focus, as with the previous basemap.
  function labelGroup(layerId) {
    const id = String(layerId);
    if (/^label-(place|boundary|water)-/.test(id)) return 'place';
    if (/^label-(street|motorway)-/.test(id) || /^marking-oneway/.test(id)) return 'road';
    return 'hidden';
  }

  function withVisibility(layer, visible) {
    return { ...layer, layout: { ...(layer.layout || {}), visibility: visible ? 'visible' : 'none' } };
  }

  function fallbackStyle(layerName) {
    return {
      version: 8,
      sources: {},
      layers: [{
        id: 'background',
        type: 'background',
        paint: { 'background-color': FALLBACK_BACKGROUND[normalizeLayerName(layerName)] },
      }],
    };
  }

  // Compose the basemap for a layer name from its fetched style JSON (null
  // when offline). Returns { style, labelLayerIds } where style.layers is
  // base layers then label (symbol) layers; callers insert their own layers
  // before labelLayerIds[0].
  function composeBasemap(layerName, baseStyle, options = {}) {
    const showMapLabels = options.showMapLabels !== false;
    const showRoadLabels = options.showRoadLabels !== false;
    if (!baseStyle) return { style: fallbackStyle(layerName), labelLayerIds: [] };

    const layers = baseStyle.layers || [];
    const baseLayers = layers.filter((l) => l.type !== 'symbol');
    const labelLayers = layers.filter((l) => l.type === 'symbol').map((layer) => {
      const group = labelGroup(layer.id);
      const visible = group === 'place' ? showMapLabels : group === 'road' ? showRoadLabels : false;
      return withVisibility(layer, visible);
    });
    return {
      style: {
        version: 8,
        ...(baseStyle.glyphs ? { glyphs: baseStyle.glyphs } : {}),
        ...(baseStyle.sprite ? { sprite: baseStyle.sprite } : {}),
        sources: Object.fromEntries(Object.entries(baseStyle.sources || {})
          .map(([id, source]) => [id, { ...source, attribution: OSM_ATTRIBUTION }])),
        layers: [...baseLayers, ...labelLayers],
      },
      labelLayerIds: labelLayers.map((l) => l.id),
    };
  }

  // Merge app-owned sources and layers from the live style into a newly
  // composed basemap. App layers keep their relative order; those listed in
  // aboveLabelIds paint over the labels, all others sit just below them.
  function mergeAppLayers(basemap, liveStyle, appSourceIds, aboveLabelIds = []) {
    const appSources = new Set(appSourceIds);
    const above = new Set(aboveLabelIds);
    const sources = { ...basemap.style.sources };
    for (const id of appSources) {
      if (liveStyle?.sources?.[id]) sources[id] = liveStyle.sources[id];
    }
    const appLayers = (liveStyle?.layers || []).filter((l) => appSources.has(l.source));
    const labelIds = new Set(basemap.labelLayerIds);
    const baseLayers = basemap.style.layers.filter((l) => !labelIds.has(l.id));
    const labelLayers = basemap.style.layers.filter((l) => labelIds.has(l.id));
    return {
      ...basemap.style,
      sources,
      layers: [
        ...baseLayers,
        ...appLayers.filter((l) => !above.has(l.id)),
        ...labelLayers,
        ...appLayers.filter((l) => above.has(l.id)),
      ],
    };
  }

  return {
    DEFAULT_LAYER,
    LAYER_NAMES,
    OSM_ATTRIBUTION,
    STYLE_URLS,
    TILE_ORIGIN,
    VERSATILES_ATTRIBUTION,
    composeBasemap,
    fallbackStyle,
    labelGroup,
    mergeAppLayers,
    normalizeLayerName,
  };
}));
