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
    buildChargingCurve,
    buildChargingSourceOptions,
    filterAndSortChargingSites,
    getChargingClusterPresentation,
    toChargingGeoJSON,
  };
}));
