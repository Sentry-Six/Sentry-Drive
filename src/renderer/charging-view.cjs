'use strict';

(function exposeChargingView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChargingView = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  function filterAndSortChargingSites(sites, options = {}) {
    const showSuperchargers = options.showSuperchargers !== false;
    const showOther = options.showOther !== false;
    return sites.filter((site) => (
      site.isSupercharger ? showSuperchargers : showOther
    )).sort((a, b) => (
      Number(b.visitCount ?? 0) - Number(a.visitCount ?? 0)
      || String(b.latestVisit ?? '').localeCompare(String(a.latestVisit ?? ''))
      || String(a.siteId).localeCompare(String(b.siteId))
    ));
  }

  function toChargingGeoJSON(sites) {
    return {
      type: 'FeatureCollection',
      features: sites.filter((site) => (
        Number.isFinite(site.latitude) && Number.isFinite(site.longitude)
      )).map((site) => ({
        type: 'Feature',
        properties: {
          siteId: site.siteId,
          displayName: site.displayName,
          visitCount: site.visitCount,
          isSupercharger: Boolean(site.isSupercharger),
          // Bolt count for the map pill; 0 for AC chargers and for any
          // Supercharger the catalog has no rating for.
          speedTier: Number(site.speedTier) || 0,
          // Any visit here tagged "Home" — draws a house on the pill.
          isHome: Boolean(site.isHome),
        },
        geometry: {
          type: 'Point',
          coordinates: [site.longitude, site.latitude],
        },
      })),
    };
  }

  function buildChargingSourceOptions(data) {
    return {
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
    };
  }

  // Markers are pre-rendered pill images rather than circle layers: a pill
  // has to size itself to its contents (a visit count plus up to three
  // bolts), which a circle layer can't express. The image id carries
  // everything needed to draw it, so `styleimagemissing` can mint any pill
  // the data asks for — including cluster totals, which are only known after
  // clustering runs.
  const PILL_IMAGE_PREFIX = 'charging-pill-';

  function chargingPillImageId({ type, count, bolts, home }) {
    return `${PILL_IMAGE_PREFIX}${type}-${count}-${bolts}-${home ? 1 : 0}`;
  }

  function chargingPillFromImageId(imageId) {
    const match = /^charging-pill-(sc|other|mixed)-(\d+)-([0-3])-([01])$/.exec(String(imageId));
    if (!match) return null;
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count)) return null;
    return {
      type: match[1],
      count,
      bolts: Number(match[3]),
      home: match[4] === '1',
    };
  }

  const CLUSTER_TYPE_EXPRESSION = [
    'case',
    ['all', ['>', ['get', 'superchargerSiteCount'], 0], ['>', ['get', 'otherSiteCount'], 0]], 'mixed',
    ['>', ['get', 'superchargerSiteCount'], 0], 'sc',
    'other',
  ];

  function buildChargingSiteLayers() {
    return [{
      id: 'charging-site-pills',
      type: 'symbol',
      source: 'charging-sites',
      filter: ['!', ['has', 'point_count']],
      layout: {
        visibility: 'none',
        'icon-image': [
          'concat',
          PILL_IMAGE_PREFIX,
          ['case', ['==', ['get', 'isSupercharger'], true], 'sc', 'other'],
          '-', ['to-string', ['get', 'visitCount']],
          '-', ['to-string', ['coalesce', ['get', 'speedTier'], 0]],
          '-', ['case', ['==', ['get', 'isHome'], true], '1', '0'],
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }];
  }

  function buildChargingClusterLayers() {
    return [{
      id: 'charging-cluster-pills',
      type: 'symbol',
      source: 'charging-sites',
      filter: ['has', 'point_count'],
      layout: {
        visibility: 'none',
        // Clusters cover several sites, which need not share a rating or a
        // home tag, so they show the total visit count with no bolts and no
        // house — zoom in and the individual pills carry both.
        'icon-image': [
          'concat',
          PILL_IMAGE_PREFIX,
          CLUSTER_TYPE_EXPRESSION,
          '-', ['to-string', ['get', 'clusterVisitCount']],
          '-0-0',
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }];
  }

  function getChargingClusterPresentation(properties = {}) {
    const visitCount = Math.max(0, Math.round(Number(properties.clusterVisitCount) || 0));
    const superchargerSiteCount = Math.max(0, Number(properties.superchargerSiteCount) || 0);
    const otherSiteCount = Math.max(0, Number(properties.otherSiteCount) || 0);
    const type = superchargerSiteCount > 0 && otherSiteCount > 0
      ? 'mixed'
      : superchargerSiteCount > 0 ? 'supercharger' : 'other';
    const typeLabel = type === 'supercharger'
      ? 'Supercharger'
      : type === 'mixed' ? 'Mixed charger' : 'Other charger';
    const sizePx = Math.min(60, 40 + Math.ceil(Math.log2(Math.max(1, visitCount))) * 2);

    return {
      type,
      visitCount,
      label: String(visitCount),
      sizePx,
      accessibleLabel: `${typeLabel} cluster, ${visitCount} charging visits. Zoom in to expand.`,
    };
  }

  function buildChargingCurve(samples, width, height) {
    const points = samples.filter((sample) => (
      Number.isFinite(sample?.timestamp) && Number.isFinite(sample?.powerKw)
    ));
    if (points.length === 0) return null;
    const first = points[0].timestamp;
    const last = points[points.length - 1].timestamp;
    const durationSeconds = Math.max(0, last - first);
    const peakPowerKw = Math.max(...points.map((point) => point.powerKw), 0);
    const pad = 8;
    const drawableHeight = Math.max(0, height - pad * 2);
    const path = points.map((point, index) => {
      const x = durationSeconds > 0
        ? ((point.timestamp - first) / durationSeconds) * width
        : width / 2;
      const y = peakPowerKw > 0
        ? height - pad - (point.powerKw / peakPowerKw) * drawableHeight
        : height - pad;
      return `${index === 0 ? 'M' : 'L'} ${Number(x.toFixed(2))} ${Number(y.toFixed(2))}`;
    }).join(' ');
    return { path, peakPowerKw, durationSeconds };
  }

  return {
    buildChargingClusterLayers,
    buildChargingCurve,
    buildChargingSiteLayers,
    buildChargingSourceOptions,
    chargingPillFromImageId,
    chargingPillImageId,
    filterAndSortChargingSites,
    getChargingClusterPresentation,
    toChargingGeoJSON,
  };
}));
