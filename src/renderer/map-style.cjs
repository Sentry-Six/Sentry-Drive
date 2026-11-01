'use strict';

// Basemap styles come from the public VersaTiles server (OpenStreetMap vector
// tiles). This module only composes style
// JSON so the renderer can keep its own route layers between the basemap and
// the labels; it does no network work and is unit tested under Node.
(function exposeMapStyle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MapStyle = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const VERSATILES_ORIGIN = 'https://tiles.versatiles.org';
  const STYLE_URLS = {
    Light: `${VERSATILES_ORIGIN}/assets/styles/colorful/style.json`,
    Dark: `${VERSATILES_ORIGIN}/assets/styles/colorful-dark/style.json`,
  };
  const LAYER_NAMES = ['Light', 'Dark'];
  const DEFAULT_LAYER = 'Light';
  // Saved names from older releases. Satellite was Google imagery; the free
  // VersaTiles imagery is global only to about z12, too coarse for drives.
  const LAYER_RENAMES = { 'Google Maps': 'Light', 'Google Dark': 'Dark', Satellite: 'Light' };
  const VERSATILES_ATTRIBUTION = '<a href="https://versatiles.org/">VersaTiles</a>';
  // Painted when the style cannot be fetched (offline) so routes still draw.
  const FALLBACK_BACKGROUND = { Light: '#f8f4f0', Dark: '#282725' };

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
        sources: { ...baseStyle.sources },
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
    STYLE_URLS,
    VERSATILES_ATTRIBUTION,
    VERSATILES_ORIGIN,
    composeBasemap,
    fallbackStyle,
    labelGroup,
    mergeAppLayers,
    normalizeLayerName,
  };
}));
