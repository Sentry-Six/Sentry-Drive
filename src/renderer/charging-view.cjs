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
    filterAndSortChargingSites,
    toChargingGeoJSON,
  };
}));
