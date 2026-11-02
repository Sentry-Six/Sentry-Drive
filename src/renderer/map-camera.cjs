'use strict';

// Map camera helpers: how the renderer fits data into view and how it
// remembers the camera between launches.
//
// Any animated move that crosses tile zoom levels requests the tiles for
// every level on the way and then cancels them: MapLibre's default fitBounds
// flight does this at each level twice, and even a short straight zoom from
// the overview into a drive cancels a few hundred tiles. So fits here either
// jump, or "settle": jump to a view slightly zoomed in on the destination and
// ease out to it without leaving that tile zoom level. Vector tiles are
// requested for the integer zoom level, and with the same centre the settle's
// first view lies inside its last one, so every tile it requests is still
// needed when it ends.
(function exposeMapCamera(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MapCamera = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const STORAGE_KEY = 'mapCamera';
  // First-run view, before any drives have been loaded.
  const DEFAULT_CAMERA = Object.freeze({ center: Object.freeze([10, 50]), zoom: 4 });
  const SAVE_DELAY_MS = 500;
  const GLIDE_DURATION_MS = 300;
  // How far in (in zoom levels) a settle starts from its destination, and
  // the least it may when the destination sits near the top of its level.
  const SETTLE_ZOOM = 0.3;
  const MIN_SETTLE_ZOOM = 0.15;
  // Keep the settle's first view below the next tile zoom level.
  const LEVEL_MARGIN = 0.01;
  const MAX_ZOOM = 24;

  // Startup, page changes and reloads replace what is on screen: jump.
  const INSTANT_REASONS = new Set(['initial', 'reload']);
  // User-driven moves: a brief settle so the change does not feel abrupt.
  const GLIDE_REASONS = new Set(['select', 'back', 'zone', 'charging']);

  // 'jump' or 'settle' for a fit reason; unknown reasons are a bug.
  function fitMode(reason) {
    if (INSTANT_REASONS.has(reason)) return 'jump';
    if (GLIDE_REASONS.has(reason)) return 'settle';
    throw new Error(`Unknown map fit reason: ${reason}`);
  }

  // Camera options shared by fitBounds and cameraForBounds.
  function boundsOptions({ padding, maxZoom } = {}) {
    const options = {};
    if (padding !== undefined) options.padding = padding;
    if (maxZoom !== undefined) options.maxZoom = maxZoom;
    return options;
  }

  // Start and end zoom for settling onto targetZoom, both on the target's
  // tile zoom level. Near the top of a level the settle shortens, and the end
  // may come out up to MIN_SETTLE_ZOOM below the target (a little more
  // margin). Null when there is no room to settle (at the map's max zoom).
  function settleZooms(targetZoom, mapMaxZoom = MAX_ZOOM) {
    const level = Math.floor(targetZoom);
    const ceiling = Math.min(level + 1 - LEVEL_MARGIN, mapMaxZoom);
    const end = Math.max(level, Math.min(targetZoom, ceiling - MIN_SETTLE_ZOOM));
    const start = Math.min(end + SETTLE_ZOOM, ceiling);
    if (!(start > end)) return null;
    return { start, end };
  }

  function settleTo(map, center, targetZoom) {
    const zooms = settleZooms(targetZoom, map.getMaxZoom());
    if (!zooms) {
      map.jumpTo({ center, zoom: targetZoom });
      return;
    }
    map.jumpTo({ center, zoom: zooms.start });
    map.easeTo({ center, zoom: zooms.end, duration: GLIDE_DURATION_MS });
  }

  function fitMap(map, bounds, { reason, ...rest } = {}) {
    const options = boundsOptions(rest);
    if (fitMode(reason) === 'jump') {
      map.fitBounds(bounds, { ...options, animate: false });
      return;
    }
    const camera = map.cameraForBounds(bounds, options);
    if (camera) settleTo(map, camera.center, camera.zoom);
  }

  // Centre on a point (charging sites) with the same settle.
  function glideTo(map, center, zoom) {
    settleTo(map, center, zoom);
  }

  const wrapLng = (lng) => (lng >= -180 && lng <= 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180);

  function parseCamera(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let value;
    try { value = JSON.parse(raw); } catch { return null; }
    const center = value?.center;
    const zoom = value?.zoom;
    if (!Array.isArray(center) || center.length !== 2) return null;
    const [lng, lat] = center;
    if (![lng, lat, zoom].every(Number.isFinite)) return null;
    if (lat < -90 || lat > 90 || zoom < 0 || zoom > MAX_ZOOM) return null;
    return { center: [wrapLng(lng), lat], zoom };
  }

  function loadCamera(storage) {
    let raw = null;
    try { raw = storage?.getItem(STORAGE_KEY); } catch { /* Storage unavailable. */ }
    return parseCamera(raw) ?? { center: [...DEFAULT_CAMERA.center], zoom: DEFAULT_CAMERA.zoom };
  }

  function serializeCamera(map) {
    const { lng, lat } = map.getCenter();
    const round = (v, places) => Number(v.toFixed(places));
    return JSON.stringify({ center: [round(wrapLng(lng), 6), round(lat, 6)], zoom: round(map.getZoom(), 2) });
  }

  // Save the camera shortly after the map settles; flush() saves now.
  function rememberCamera(map, storage, {
    delayMs = SAVE_DELAY_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    let timer = null;
    const save = () => {
      timer = null;
      try { storage.setItem(STORAGE_KEY, serializeCamera(map)); } catch { /* Storage unavailable. */ }
    };
    map.on('moveend', () => {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(save, delayMs);
    });
    return {
      flush() {
        if (timer === null) return;
        clearTimer(timer);
        save();
      },
    };
  }

  return {
    DEFAULT_CAMERA,
    GLIDE_DURATION_MS,
    STORAGE_KEY,
    SETTLE_ZOOM,
    fitMap,
    fitMode,
    glideTo,
    loadCamera,
    parseCamera,
    rememberCamera,
    serializeCamera,
    settleZooms,
  };
}));
