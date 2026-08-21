'use strict';

const fmt = (n) => Number(n).toLocaleString('en-US');

// ─── State ────────────────────────────────────────────────────────────────────
let map = null;
let mapReady = false;
let pendingMapTasks = [];      // Deferred until sources and layers exist.
let selectedMarkers = [];
let drives = [];
let driveCacheGen = null;
let drivePageModel = null;
let drivePageState = { offset: 0, limit: 250, total: 0, drives: [] };
let overviewRoutes = [];
let loadedFilePath = null;
let pendingExternalReload = false;
let selectedDriveId = null;
let removeOutputListener = null;
let processingStartTime = null;
let cpuCount = 1;
let allTags = [];
let hasSummonDrives = false;
// Filters must run in the loader because the renderer holds only one page.
let driveFilters = { tag: '', startDate: '', endDate: '' };
const driveFiltersActive = () =>
  Boolean(driveFilters.tag || driveFilters.startDate || driveFilters.endDate);
let hideOtherDrives = false;
let showFsdMarkers = true;
let fsdEventMarkers = [];
let showMapLabels = true;
let showRoadLabels = true;
let applyMapLabelsSetting = () => {};
let activeMainTab = 'drives';
let chargingSites = [];
let chargingCatalogStatus = null;
let selectedChargingSiteId = null;
let selectedChargingSessionId = null;
let showSuperchargers = localStorage.getItem('showSuperchargers') !== 'false';
let showOtherChargers = localStorage.getItem('showOtherChargers') !== 'false';
let driveCameraBeforeCharging = null;

// Replay state
let replayMarker = null;
let mapInteracting = false; // Suspend marker easing during pan and zoom.
let replayTrailCtx = null;
let replayInterval = null;
let replayPlaying = false;
let replayIdx = 0;
let replayDrive = null;
let replaySpeed = 1;
const REPLAY_BASE_MS = 100;

// Shared calculation constants keep display and processing conversions aligned.
const { MI_TO_KM, M_PER_MILE, MPS_TO_MPH, geodesicM } = window.driveCalc;

// ─── Error forwarding ────────────────────────────────────────────────────────
// Forward renderer failures to the main-process log without propagating errors.
(() => {
  const send = (level, scope, text) => {
    try { window.electronAPI?.appLog({ level, scope, text }); } catch { /* Logging is best-effort. */ }
  };
  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  window.addEventListener('error', (e) => {
    send('error', 'renderer', `${e.message} (${e.filename ?? '?'}:${e.lineno ?? '?'})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    send('error', 'renderer', `Unhandled rejection: ${fmt(e.reason)}`);
  });
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      send(level, 'renderer.console', args.map(fmt).join(' '));
    };
  }
})();

// Add user-action context to crash logs.
function logAction(text) {
  try { window.electronAPI?.appLog({ level: 'info', scope: 'ui', text }); } catch { /* Logging is best-effort. */ }
}

// Imported FSD data changes aggregate scores, so merging requires confirmation.
function confirmMergeDriveData() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('import-json-confirm-overlay');
    const yes = document.getElementById('btn-import-json-confirm');
    const no = document.getElementById('btn-import-json-cancel');
    const done = (result) => {
      overlay.classList.add('hidden');
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      overlay.removeEventListener('click', onBackdrop);
      resolve(result);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    const onBackdrop = (e) => { if (e.target === overlay) done(false); };
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    overlay.addEventListener('click', onBackdrop);
    overlay.classList.remove('hidden');
  });
}

const UNIT_SYSTEM = {
  imperial: {
    dist:  { mult: 1,       short: 'mi',   long: 'Miles' },
    speed: { mult: 1,       short: 'mph',  long: 'MPH' },
  },
  metric: {
    dist:  { mult: MI_TO_KM, short: 'km',   long: 'Kilometers' },
    speed: { mult: MI_TO_KM, short: 'km/h', long: 'KM/H' },
  },
};
let unitSystem = localStorage.getItem('unitSystem') === 'metric' ? 'metric' : 'imperial';
let lastDrivesMeta = null;
let markerType  = localStorage.getItem('markerType')  || 'arrow';
let markerColor = localStorage.getItem('markerColor') || '#ffffff';
// Each vehicle pairs a texture with a white-body paint mask. `lengthM` controls
// map scale; only the w/h ratio controls aspect. Missing artwork prunes options.
const VEHICLE_MODELS = {
  // Keys are persisted as markerType values.
  model3:      { texture: '../../assets/map-ui/model3_t.png',        mask: '../../assets/map-ui/model3_c.png',        w: 47, h: 90,  lengthM: 4.72 },
  highland:    { texture: '../../assets/map-ui/highland_t.png',      mask: '../../assets/map-ui/highland_c.png',      w: 46, h: 90,  lengthM: 4.72 },
  highlandPerf:{ texture: '../../assets/map-ui/highland-perf_t.png', mask: '../../assets/map-ui/highland-perf_c.png', w: 46, h: 90,  lengthM: 4.72 },
  modelY:      { texture: '../../assets/map-ui/modely_t.png',        mask: '../../assets/map-ui/modely_c.png',        w: 48, h: 92,  lengthM: 4.75 },
  juniper:     { texture: '../../assets/map-ui/juniper_t.png',       mask: '../../assets/map-ui/juniper_c.png',       w: 48, h: 92,  lengthM: 4.79 },
  juniperPerf: { texture: '../../assets/map-ui/juniper-perf_t.png',  mask: '../../assets/map-ui/juniper-perf_c.png',  w: 47, h: 92,  lengthM: 4.79 },
  modelYL:     { texture: '../../assets/map-ui/modelyL_t.png',       mask: '../../assets/map-ui/modelyL_c.png',       w: 48, h: 96,  lengthM: 4.98 },
  modelS:      { texture: '../../assets/map-ui/models_t.png',        mask: '../../assets/map-ui/models_c.png',        w: 49, h: 95,  lengthM: 5.02 },
  modelSPlaid: { texture: '../../assets/map-ui/models-plaid_t.png',  mask: '../../assets/map-ui/models-plaid_c.png',  w: 49, h: 96,  lengthM: 5.02 },
  modelX:      { texture: '../../assets/map-ui/modelx_t.png',        mask: '../../assets/map-ui/modelx_c.png',        w: 50, h: 98,  lengthM: 5.06 },
  cybertruck:  { texture: '../../assets/map-ui/cybertruck_t.png',    mask: '../../assets/map-ui/cybertruck_c.png',    w: 54, h: 111, lengthM: 5.68 },
};
// Clamp physical-scale vehicles before they become unreadable.
const VEHICLE_MIN_PX = 38;
let vehicleColoredUrl = null;
let carColorPicker   = null;
let markerColorDebounceTimer = null;

function scheduleMarkerColorUpdate(color) {
  clearTimeout(markerColorDebounceTimer);
  markerColorDebounceTimer = setTimeout(() => applyMarkerColor(color), 250);
}

// CSS variables keep map lines, legends, and share bars on the same palette.
const DRIVE_LINE_COLOR_DEFAULTS = {
  manual:   '#2266cc',
  fsd:      '#22cc55',
  summon:   '#facc15',
  imported: '#a855f7',
  overview: '#3b82f6',
};
let driveLineColors = (() => {
  const colors = { ...DRIVE_LINE_COLOR_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem('driveLineColors') || '{}');
    for (const k of Object.keys(colors)) {
      if (/^#[0-9a-fA-F]{6}$/.test(saved[k] || '')) colors[k] = saved[k];
    }
  } catch { /* Invalid settings fall back to defaults. */ }
  return colors;
})();
let driveLineColorsDebounceTimer = null;

// Debounce per-frame color-wheel events that re-bake route GeoJSON.
function scheduleDriveLineColorsApply() {
  clearTimeout(driveLineColorsDebounceTimer);
  driveLineColorsDebounceTimer = setTimeout(applyDriveLineColors, 250);
}

// The shared color popup retargets its change callback and anchor.
let colorPopupApply = null;
let colorPopupAnchor = null;

function openColorPopup(anchor, title, color, onChange) {
  const popup = document.getElementById('car-color-popup');
  if (!popup.classList.contains('hidden') && colorPopupAnchor === anchor) {
    closeColorPopup();
    return;
  }
  colorPopupApply = null; // Suppress color:change while synchronizing.
  carColorPicker.color.hexString = color;
  document.getElementById('inp-car-hex').value = color;
  document.querySelector('.car-color-popup-title').textContent = title;
  colorPopupApply = onChange;
  colorPopupAnchor = anchor;
  const rect = anchor.getBoundingClientRect();
  popup.style.top  = `${rect.bottom + 8}px`;
  popup.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
  popup.classList.remove('hidden');
}

function closeColorPopup() {
  document.getElementById('car-color-popup').classList.add('hidden');
  colorPopupApply = null;
  colorPopupAnchor = null;
}

function distVal(mi, decimals = 1) {
  return (mi * UNIT_SYSTEM[unitSystem].dist.mult).toFixed(decimals);
}
function distShort() { return UNIT_SYSTEM[unitSystem].dist.short; }
function distLong()  { return UNIT_SYSTEM[unitSystem].dist.long; }
function speedVal(mph, decimals = 0) {
  return (mph * UNIT_SYSTEM[unitSystem].speed.mult).toFixed(decimals);
}
function speedShort() { return UNIT_SYSTEM[unitSystem].speed.short; }

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();
  initProcessingTab();
  initViewDrivesTab();
  initChargingTab();
  initFooter();
  initChangelogModal();
  loadDefaultPaths();
  applyDriveLineColors();
  updatePrivacyZoneLayer();
  logAction(`ui ready — units=${unitSystem}, marker=${markerType}, mapLayer=${localStorage.getItem('mapLayer') || 'Light'}`);
});

// ─── Map ──────────────────────────────────────────────────────────────────────
// MapLibre renders Google raster tiles and GPU-backed GeoJSON routes.
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Piecewise stops implement max(2, base * zoom / 10).
const OVERVIEW_LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 0, 3, 8, 3, 10, 3.5, 20, 6];
// MapLibre requires zoom interpolation at the expression's top level.
const OVERVIEW_IMPORTED_LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 0, 2.5, 8, 2.5, 10, 2.9, 20, 4.75];
const SELECTED_LINE_WIDTH = ['interpolate', ['linear'], ['zoom'],
  0, 2, 4, 2, 10, ['max', 2, ['get', 'w']], 20, ['max', 2, ['*', ['get', 'w'], 2]]];

// Queue source and layer work until the style loads.
function whenMapReady(fn) {
  if (mapReady) fn();
  else pendingMapTasks.push(fn);
}

function initMap() {
  // Base tiles omit labels; an overlay restores selected label classes.
  showMapLabels = localStorage.getItem('showMapLabels') !== 'false';
  // Unset road-label preferences inherit the city-label preference.
  const savedRoadLabels = localStorage.getItem('showRoadLabels');
  showRoadLabels = savedRoadLabels != null ? savedRoadLabels !== 'false' : showMapLabels;
  // Night rules explicitly set highway fill because high zoom ignores generic geometry.
  const GMAPS_NIGHT_RULES = 's.e%3Ag%7Cp.c%3A%23242f3e,s.e%3Al.t.f%7Cp.c%3A%23ffffff,s.e%3Al.t.s%7Cp.c%3A%23242f3e,s.t%3A37%7Cs.e%3Ag%7Cp.c%3A%23263c3f,s.t%3A81%7Cs.e%3Ag%7Cp.c%3A%232b3645,s.t%3A6%7Cs.e%3Ag%7Cp.c%3A%2317263c,s.t%3A3%7Cs.e%3Ag%7Cp.c%3A%2338414e,s.t%3A3%7Cs.e%3Ag.s%7Cp.c%3A%23212a37,s.t%3A49%7Cs.e%3Ag%7Cp.c%3A%235f6b7c,s.t%3A49%7Cs.e%3Ag.f%7Cp.c%3A%235f6b7c,s.t%3A49%7Cs.e%3Ag.s%7Cp.c%3A%232a3340,s.t%3A4%7Cs.e%3Ag%7Cp.c%3A%232f3948';
  // Restore administrative and road labels independently.
  const gmapsLabelRules = () => {
    const rules = ['s.e%3Al%7Cp.v%3Aoff'];
    if (showMapLabels) rules.push('s.t%3A1%7Cs.e%3Al%7Cp.v%3Aon');
    if (showRoadLabels) rules.push('s.t%3A3%7Cs.e%3Al%7Cp.v%3Aon', 's.t%3A49%7Cs.e%3Al%7Cp.v%3Aon');
    return rules.join(',');
  };
  // The transparent label overlay stays above dense route lines.
  const ALL_LABELS_OFF = 's.e%3Al%7Cp.v%3Aoff';
  const gmapsUrls = () => ({
    'Dark': `https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&apistyle=${GMAPS_NIGHT_RULES},${ALL_LABELS_OFF}`,
    'Light': `https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&apistyle=${ALL_LABELS_OFF}`,
    'Satellite': `https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}`,
  });
  // Dark mode uses white overlay labels with a dark halo.
  const NIGHT_LABEL_TEXT = 's.e%3Al.t.f%7Cp.c%3A%23ffffff,s.e%3Al.t.s%7Cp.c%3A%23242f3e';
  const gmapsLabelOverlayUrl = () => {
    const rules = [];
    if (currentBaseLayer === 'Dark') rules.push(NIGHT_LABEL_TEXT);
    rules.push('s.e%3Ag%7Cp.v%3Aoff', gmapsLabelRules());
    return `https://mt1.google.com/vt/lyrs=h&x={x}&y={y}&z={z}&apistyle=${rules.join(',')}`;
  };
  // Preserve layer choices saved under legacy names.
  const LAYER_RENAMES = { 'Google Maps': 'Light', 'Google Dark': 'Dark' };
  let savedLayer = localStorage.getItem('mapLayer');
  if (LAYER_RENAMES[savedLayer]) {
    savedLayer = LAYER_RENAMES[savedLayer];
    localStorage.setItem('mapLayer', savedLayer);
  }
  const LAYER_NAMES = ['Light', 'Dark', 'Satellite'];
  let currentBaseLayer = LAYER_NAMES.includes(savedLayer) ? savedLayer : 'Light';

  map = new maplibregl.Map({
    container: 'map',
    center: [10.0, 50.0], // [longitude, latitude]
    zoom: 4,
    maxZoom: 20,
    attributionControl: { compact: false },
    // Keep the route view flat.
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    style: {
      version: 8,
      sources: {
        basemap: {
          type: 'raster',
          tiles: [gmapsUrls()[currentBaseLayer]],
          tileSize: 256,
          maxzoom: 20,
          attribution: '&copy; Google',
        },
        'labels-overlay': {
          type: 'raster',
          tiles: [gmapsLabelOverlayUrl()],
          tileSize: 256,
          maxzoom: 20,
        },
      },
      // The label layer is inserted after route layers load.
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
    },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

  // Swap tiles in place when supported.
  const setRasterTiles = (sourceId, url, beforeLayerId) => whenMapReady(() => {
    const src = map.getSource(sourceId);
    if (src && typeof src.setTiles === 'function') {
      src.setTiles([url]);
      return;
    }
    // Older MapLibre builds require rebuilding the raster source.
    if (map.getLayer(sourceId)) map.removeLayer(sourceId);
    if (src) map.removeSource(sourceId);
    map.addSource(sourceId, {
      type: 'raster', tiles: [url], tileSize: 256, maxzoom: 20,
      ...(sourceId === 'basemap' ? { attribution: '&copy; Google' } : {}),
    });
    // Use the anchor only when it exists.
    const before = beforeLayerId && map.getLayer(beforeLayerId) ? beforeLayerId : undefined;
    map.addLayer({ id: sourceId, type: 'raster', source: sourceId }, before);
  });
  // Preserve basemap → routes → zones → labels → charging paint order.
  const applyMapTiles = () => {
    setRasterTiles('basemap', gmapsUrls()[currentBaseLayer], 'overview-dim');
    setRasterTiles('labels-overlay', gmapsLabelOverlayUrl(), 'charging-site-pills');
  };

  applyMapLabelsSetting = applyMapTiles;

  // CSS-driven base-layer switcher.
  const layersCtrl = document.createElement('div');
  layersCtrl.id = 'map-layers-control';
  const layersToggle = document.createElement('span');
  layersToggle.className = 'map-layers-toggle material-icons';
  layersToggle.textContent = 'layers';
  layersCtrl.appendChild(layersToggle);
  for (const name of LAYER_NAMES) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'map-base-layer';
    input.value = name;
    input.checked = name === currentBaseLayer;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      currentBaseLayer = name;
      localStorage.setItem('mapLayer', name);
      applyMapTiles();
    });
    const span = document.createElement('span');
    span.textContent = name;
    label.append(input, span);
    layersCtrl.appendChild(label);
  }
  document.getElementById('map').appendChild(layersCtrl);

  // Install route sources after style load; queued data then flows through.
  map.on('load', () => {
    map.addSource('overview', { type: 'geojson', data: EMPTY_FC });
    map.addSource('selected-route', { type: 'geojson', data: EMPTY_FC });
    map.addSource('selected-traveled', { type: 'geojson', data: EMPTY_FC });
    map.addSource('charging-sites', window.ChargingView.buildChargingSourceOptions(EMPTY_FC));
    map.addLayer({
      id: 'overview-dim', type: 'line', source: 'overview',
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
      paint: { 'line-color': '#555566', 'line-opacity': 1, 'line-width': OVERVIEW_LINE_WIDTH },
    });
    // Paint faint imported routes below native dashcam routes.
    map.addLayer({
      id: 'overview-imported', type: 'line', source: 'overview',
      filter: ['==', ['get', 'imported'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': driveLineColors.imported, 'line-opacity': 0.25, 'line-width': OVERVIEW_IMPORTED_LINE_WIDTH, 'line-dasharray': [2.4, 1.6] },
    });
    map.addLayer({
      id: 'overview-native', type: 'line', source: 'overview',
      filter: ['!=', ['get', 'imported'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': driveLineColors.overview, 'line-opacity': 0.5, 'line-width': OVERVIEW_LINE_WIDTH },
    });
    // Separate solid/dashed layers because dash patterns are not data-driven.
    // The traveled overlay reveals normal color above the dim base route.
    map.addLayer({
      id: 'selected-solid', type: 'line', source: 'selected-route',
      filter: ['!=', ['get', 'dashed'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'colorDim'], 'line-opacity': 0.95, 'line-width': SELECTED_LINE_WIDTH },
    });
    map.addLayer({
      id: 'selected-dashed', type: 'line', source: 'selected-route',
      filter: ['==', ['get', 'dashed'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'colorDim'], 'line-opacity': 0.95, 'line-width': SELECTED_LINE_WIDTH, 'line-dasharray': [1.6, 1] },
    });
    map.addLayer({
      id: 'traveled-solid', type: 'line', source: 'selected-traveled',
      filter: ['!=', ['get', 'dashed'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.95, 'line-width': SELECTED_LINE_WIDTH },
    });
    map.addLayer({
      id: 'traveled-dashed', type: 'line', source: 'selected-traveled',
      filter: ['==', ['get', 'dashed'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.95, 'line-width': SELECTED_LINE_WIDTH, 'line-dasharray': [1.6, 1] },
    });
    // Privacy zones use a route-distinct amber style.
    map.addSource('privacy-zones', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'privacy-zones-fill', type: 'fill', source: 'privacy-zones',
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 },
    });
    map.addLayer({
      id: 'privacy-zones-line', type: 'line', source: 'privacy-zones',
      paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [2, 1.5], 'line-opacity': 0.8 },
    });
    // Transparent city/street labels above route lines.
    map.addLayer({ id: 'labels-overlay', type: 'raster', source: 'labels-overlay' });
    // Interactive charging pills must paint above label tiles.
    for (const layer of window.ChargingView.buildChargingSiteLayers()) map.addLayer(layer);
    for (const layer of window.ChargingView.buildChargingClusterLayers()) map.addLayer(layer);
    mapReady = true;
    for (const fn of pendingMapTasks.splice(0)) fn();
  });

  const mapStatsEl = document.getElementById('map-stats');
  if (mapStatsEl) {
    mapStatsEl.addEventListener('click', (e) => {
      // Tag-editor clicks must not collapse the panel.
      if (e.target.closest('.map-stats-tags')) return;
      mapStatsEl.classList.toggle('expanded');
    });
  }

  window.addEventListener('resize', () => map.resize());

  // MapLibre owns marker transforms during map motion, so suspend CSS easing.
  map.on('movestart', () => {
    mapInteracting = true;
    const el = replayMarker?.getElement();
    if (el) el.style.transition = 'none';
  });
  map.on('moveend', () => { mapInteracting = false; });

  // Zone ring drags resize; other drags keep normal map panning.
  map.on('mousemove', (e) => {
    const p = zonePlacement;
    if (!p || !mapReady) return;
    if (p.stage === 'aim') {
      p.center = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      zonePlacementPreview();
    } else if (p.stage === 'confirm') {
      if (p.ringDrag) {
        const gm = window.driveCalc?.geodesicM;
        if (gm) {
          p.radiusM = Math.min(5000, Math.max(10, gm(p.center.lat, p.center.lng, e.lngLat.lat, e.lngLat.lng)));
        }
        zoneConfirmHint();
        zonePlacementPreview();
      } else {
        map.getCanvas().style.cursor = zoneNearRing(e) ? 'ew-resize' : '';
      }
    }
  });
  map.on('mousedown', (e) => {
    const p = zonePlacement;
    if (!p || p.stage !== 'confirm' || !p.center) return;
    if (zoneNearRing(e)) {
      p.ringDrag = true;
      e.preventDefault(); // Keep the map still while resizing.
    }
  });
  map.on('mouseup', () => {
    if (zonePlacement?.ringDrag) zonePlacement.ringDrag = false;
  });
  document.getElementById('btn-zone-save').addEventListener('click', () => endZonePlacement(true));
  document.getElementById('btn-zone-cancel').addEventListener('click', () => endZonePlacement(false));

  map.on('click', (e) => {
    if (!mapReady) return;
    // Placement clicks must not select routes underneath the preview.
    if (zonePlacement) {
      if (zonePlacement.stage === 'aim') {
        zonePlacement.center = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        zonePlacementPreview();
        enterZoneConfirm();
      }
      return;
    }
    if (activeMainTab === 'charging') {
      const features = map.queryRenderedFeatures(e.point, {
        layers: CHARGING_MAP_LAYER_IDS,
      });
      const feature = features[0];
      if (feature?.properties?.cluster) {
        const clusterId = Number(feature.properties.cluster_id);
        const coordinates = feature.geometry?.coordinates;
        if (Number.isFinite(clusterId) && Array.isArray(coordinates)) {
          expandChargingCluster(clusterId, coordinates);
        }
        return;
      }
      const siteId = feature?.properties?.siteId;
      if (siteId) selectChargingSite(siteId, { fromMap: true });
      return;
    }
    const TOL_PX = 10;
    const box = [
      [e.point.x - TOL_PX, e.point.y - TOL_PX],
      [e.point.x + TOL_PX, e.point.y + TOL_PX],
    ];
    const feats = map.queryRenderedFeatures(box, {
      layers: ['selected-solid', 'selected-dashed', 'overview-native', 'overview-imported', 'overview-dim'],
    });
    for (const f of feats) {
      const drive = drives.find((d) => d.id === f.properties.driveId);
      if (drive) {
        selectDrive(drive);
        return;
      }
    }
  });

  // Physical-scale vehicle markers must resize on zoom.
  map.on('zoom', resizeVehicleMarkerToZoom);

  document.getElementById('btn-back-overview').addEventListener('click', (e) => {
    e.stopPropagation();
    deselectDrive();
  });
}

// Resize without replacing the inner image transform that holds bearing.
function resizeVehicleMarkerToZoom() {
  if (!replayMarker || !(markerType in VEHICLE_MODELS)) return;
  const { w, h } = getMarkerSize();
  const el = replayMarker.getElement();
  if (el.style.width === `${w}px`) return;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  const img = el.querySelector('#replay-arrow');
  if (img) {
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchMainTab(btn.dataset.tab));
  });
}

function switchMainTab(tab) {
  if (!document.getElementById(`tab-${tab}`)) return;
  const wasCharging = activeMainTab === 'charging';
  activeMainTab = tab;
  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  if (tab === 'charging') enterChargingMapMode();
  else if (wasCharging) leaveChargingMapMode();
  setTimeout(() => map.resize(), 50);
}

// ─── Footer & Settings ───────────────────────────────────────────────────────
let updateState = 'idle';
let updateSkipped = false;
let pendingRemoveDrive = null;

async function loadGeocodeSettings() {
  const api = window.electronAPI;
  if (!api?.getGeocodeSettings) return;
  try {
    const current = await api.getGeocodeSettings();
    if (!current) return;
    document.getElementById('inp-geocoder-endpoint').value = current.endpoint || current.defaultEndpoint || '';
    document.getElementById('inp-geocoder-language').value = current.language || '';
    document.getElementById('geocoder-settings-status').textContent = '';
  } catch { /* Keep settings usable when the provider service is unavailable. */ }
}

async function saveGeocodeSettings() {
  const api = window.electronAPI;
  const status = document.getElementById('geocoder-settings-status');
  if (!api?.setGeocodeSettings) return;
  status.textContent = 'Saving…';
  try {
    const saved = await api.setGeocodeSettings({
      endpoint: document.getElementById('inp-geocoder-endpoint').value,
      language: document.getElementById('inp-geocoder-language').value,
    });
    if (!saved) throw new Error('Settings could not be saved');
    document.getElementById('inp-geocoder-endpoint').value = saved.endpoint;
    document.getElementById('inp-geocoder-language').value = saved.language || '';
    status.textContent = 'Saved';
    for (const drive of drives) {
      delete drive._startName;
      delete drive._startNameMeta;
      delete drive._endName;
      delete drive._endNameMeta;
    }
    if (drives.length) renderDriveList(drives);
  } catch {
    status.textContent = 'Could not save';
  }
}

function initFooter() {
  document.getElementById('link-github').addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://github.com/Sentry-Six/Sentry-Drive');
  });
  document.getElementById('link-discord').addEventListener('click', () => {
    window.electronAPI.openExternal('https://discord.gg/9QZEzVwdnt');
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.remove('hidden');
    refreshTessieStatus();
    loadGeocodeSettings();
    renderPrivacyZones();
    setPrivacyZonesVisible(document.querySelector('.settings-tab-btn.active')?.dataset.stab === 'privacy');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.add('hidden');
    setPrivacyZonesVisible(false);
  });
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('settings-overlay').classList.add('hidden');
      setPrivacyZonesVisible(false);
    }
  });

  // Scoped tab classes avoid colliding with the main tab bar.
  document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stab = btn.dataset.stab;
      document.querySelectorAll('.settings-tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.settings-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`stab-${stab}`).classList.add('active');
      setPrivacyZonesVisible(stab === 'privacy');
    });
  });

  document.getElementById('btn-add-zone').addEventListener('click', () => {
    privacyZones.push({ id: `zone-${Date.now()}`, kind: 'custom', name: 'Custom location', lat: null, lng: null, radiusM: 150 });
    savePrivacyZones();
    renderPrivacyZones();
  });
  renderPrivacyZones();
  syncKnownPlaceZones();

  document.getElementById('btn-save-geocoder').addEventListener('click', saveGeocodeSettings);
  document.getElementById('btn-reset-geocoder').addEventListener('click', async () => {
    const current = await window.electronAPI?.getGeocodeSettings?.();
    document.getElementById('inp-geocoder-endpoint').value = current?.defaultEndpoint || 'https://nominatim.openstreetmap.org';
    await saveGeocodeSettings();
  });

  // Build one shared zone-icon picker.
  const zoneIconGrid = document.querySelector('#zone-icon-popup .zone-icon-grid');
  zoneIconGrid.innerHTML = ZONE_ICON_CHOICES.map((n) =>
    `<button class="zone-icon-choice" data-icon="${n}" type="button" title="${n.replace(/_/g, ' ')}"><span class="material-icons">${n}</span></button>`
  ).join('');
  zoneIconGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.zone-icon-choice');
    if (!btn || !zoneIconPickerTarget) return;
    zoneIconPickerTarget.icon = btn.dataset.icon;
    savePrivacyZones();
    renderPrivacyZones();
    updatePrivacyZoneLayer();
    closeZoneIconPicker();
  });
  document.addEventListener('click', (e) => {
    if (zoneIconPickerTarget && !e.target.closest('#zone-icon-popup') && !e.target.closest('.zone-icon-btn')) {
      closeZoneIconPicker();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && zoneIconPickerTarget) closeZoneIconPicker();
  });

  // Tessie integration
  const tessieConnectForm = document.getElementById('tessie-connect-form');
  const tessieConnectedView = document.getElementById('tessie-connected');
  const tessieTokenInput = document.getElementById('tessie-token-input');
  const tessieTokenMask = document.getElementById('tessie-token-mask');
  const tessieConnectErr = document.getElementById('tessie-connect-error');
  const tessieStatusPill = document.getElementById('tessie-conn-status');
  const tessieConnectBtn = document.getElementById('btn-tessie-connect');

  const maskToken = (t) => (t && t.length > 4 ? '••••••' + t.slice(-4) : '••••');

  function showTessieError(msg) {
    if (!tessieConnectErr) return;
    tessieConnectErr.textContent = msg;
    tessieConnectErr.classList.remove('hidden');
  }

  // Synchronize the connection card and status pill.
  function renderTessieState(token) {
    const connected = !!token;
    if (tessieStatusPill) {
      tessieStatusPill.textContent = connected ? 'Connected' : 'Not connected';
      tessieStatusPill.classList.toggle('pill-connected', connected);
      tessieStatusPill.classList.toggle('pill-idle', !connected);
    }
    if (tessieConnectForm) tessieConnectForm.classList.toggle('hidden', connected);
    if (tessieConnectedView) tessieConnectedView.classList.toggle('hidden', !connected);
    if (connected && tessieTokenMask) tessieTokenMask.textContent = maskToken(token);
  }

  function refreshTessieStatus() {
    if (!tessieStatusPill) return;
    Promise.resolve(window.electronAPI && window.electronAPI.tessieApiGetToken())
      .then((res) => renderTessieState(res && res.token))
      .catch(() => {});
  }

  if (tessieConnectBtn) {
    tessieConnectBtn.addEventListener('click', async () => {
      const token = (tessieTokenInput.value || '').trim();
      tessieConnectErr.classList.add('hidden');
      if (!token) { showTessieError('Paste your Tessie access token first.'); return; }
      const orig = tessieConnectBtn.textContent;
      tessieConnectBtn.disabled = true;
      tessieConnectBtn.textContent = 'Connecting…';
      try {
        const result = await window.electronAPI.tessieApiValidate({ token });
        if (!result || !result.success) {
          showTessieError(result && result.error ? `Couldn't validate: ${result.error}` : "Couldn't validate that token.");
          return;
        }
        await window.electronAPI.tessieApiSaveToken({ token });
        tessieTokenInput.value = '';
        renderTessieState(token);
      } catch {
        showTessieError('Connection failed. Check your network and try again.');
      } finally {
        tessieConnectBtn.disabled = false;
        tessieConnectBtn.textContent = orig;
      }
    });
  }

  const tessieDisconnectBtn = document.getElementById('btn-tessie-disconnect');
  if (tessieDisconnectBtn) {
    tessieDisconnectBtn.addEventListener('click', async () => {
      try { await window.electronAPI.tessieApiSaveToken({ token: '' }); } catch {}
      renderTessieState('');
    });
  }

  const tessieGetTokenLink = document.getElementById('tessie-get-token-link');
  if (tessieGetTokenLink) {
    tessieGetTokenLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.electronAPI) window.electronAPI.openExternal('https://dash.tessie.com/settings/api');
    });
  }

  // Imports launch from the service-aware View Drives modal.

  refreshTessieStatus();

  // Teslascope integration
  const teslascopeConnectForm = document.getElementById('teslascope-connect-form');
  const teslascopeConnectedView = document.getElementById('teslascope-connected');
  const teslascopeTokenInput = document.getElementById('teslascope-token-input');
  const teslascopeTokenMask = document.getElementById('teslascope-token-mask');
  const teslascopeConnectErr = document.getElementById('teslascope-connect-error');
  const teslascopeStatusPill = document.getElementById('teslascope-conn-status');
  const teslascopeConnectBtn = document.getElementById('btn-teslascope-connect');

  function showTeslascopeError(msg) {
    if (!teslascopeConnectErr) return;
    teslascopeConnectErr.textContent = msg;
    teslascopeConnectErr.classList.remove('hidden');
  }

  function renderTeslascopeState(token) {
    const connected = !!token;
    if (teslascopeStatusPill) {
      teslascopeStatusPill.textContent = connected ? 'Connected' : 'Not connected';
      teslascopeStatusPill.classList.toggle('pill-connected', connected);
      teslascopeStatusPill.classList.toggle('pill-idle', !connected);
    }
    if (teslascopeConnectForm) teslascopeConnectForm.classList.toggle('hidden', connected);
    if (teslascopeConnectedView) teslascopeConnectedView.classList.toggle('hidden', !connected);
    if (connected && teslascopeTokenMask) teslascopeTokenMask.textContent = maskToken(token);
  }

  function refreshTeslascopeStatus() {
    if (!teslascopeStatusPill) return;
    Promise.resolve(window.electronAPI && window.electronAPI.teslascopeApiGetToken())
      .then((res) => renderTeslascopeState(res && res.token))
      .catch(() => {});
  }

  if (teslascopeConnectBtn) {
    teslascopeConnectBtn.addEventListener('click', async () => {
      const token = (teslascopeTokenInput.value || '').trim();
      teslascopeConnectErr.classList.add('hidden');
      if (!token) { showTeslascopeError('Paste your Teslascope API token first.'); return; }
      const orig = teslascopeConnectBtn.textContent;
      teslascopeConnectBtn.disabled = true;
      teslascopeConnectBtn.textContent = 'Connecting…';
      try {
        const result = await window.electronAPI.teslascopeApiValidate({ token });
        if (!result || !result.success) {
          showTeslascopeError(result && result.error ? `Couldn't validate: ${result.error}` : "Couldn't validate that token.");
          return;
        }
        await window.electronAPI.teslascopeApiSaveToken({ token });
        teslascopeTokenInput.value = '';
        renderTeslascopeState(token);
      } catch {
        showTeslascopeError('Connection failed. Check your network and try again.');
      } finally {
        teslascopeConnectBtn.disabled = false;
        teslascopeConnectBtn.textContent = orig;
      }
    });
  }

  const teslascopeDisconnectBtn = document.getElementById('btn-teslascope-disconnect');
  if (teslascopeDisconnectBtn) {
    teslascopeDisconnectBtn.addEventListener('click', async () => {
      try { await window.electronAPI.teslascopeApiSaveToken({ token: '' }); } catch {}
      renderTeslascopeState('');
    });
  }

  const teslascopeGetTokenLink = document.getElementById('teslascope-get-token-link');
  if (teslascopeGetTokenLink) {
    teslascopeGetTokenLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.electronAPI) window.electronAPI.openExternal('https://teslascope.com/account/security');
    });
  }

  refreshTeslascopeStatus();

  window.electronAPI.getAppVersion().then(async (v) => {
    document.getElementById('settings-version-number').textContent = `v${v}`;
    document.querySelector('.footer-version').textContent = `v${v}`;
    if (/beta/i.test(v)) {
      const result = await window.electronAPI.getChangelog();
      const stableVersion = result.success
        ? (result.versions.find((e) => !/beta/i.test(e.version))?.version ?? '')
        : '';
      if (stableVersion) {
        document.getElementById('stable-version-label').textContent = `v${stableVersion}`;
      }
      document.getElementById('revert-stable-pill').classList.remove('hidden');
    }
  });

  document.getElementById('btn-revert-stable').addEventListener('click', () => {
    const betaCheckbox = document.getElementById('chk-beta');
    betaCheckbox.checked = false;
    localStorage.setItem('enrollBeta', 'false');
    document.getElementById('beta-warning').classList.add('hidden');
    document.getElementById('revert-stable-pill').classList.add('hidden');
    window.electronAPI.revertToStable();
  });

  window.electronAPI.onUpdateStatus(onUpdateStatus);

  document.getElementById('btn-check-update').addEventListener('click', () => {
    if (updateState === 'available') {
      window.electronAPI.downloadUpdate();
    } else if (updateState === 'ready') {
      window.electronAPI.installUpdate();
    } else if (updateState === 'idle' || updateState === 'error') {
      // Show immediate feedback while the main process checks.
      beginUpdateCheckUI();
      window.electronAPI.checkForUpdate();
    }
  });

  document.getElementById('btn-update-now').addEventListener('click', () => {
    document.getElementById('update-overlay').classList.add('hidden');
    window.electronAPI.downloadUpdate();
  });
  document.getElementById('btn-update-skip').addEventListener('click', () => {
    updateSkipped = true;
    document.getElementById('update-overlay').classList.add('hidden');
  });

  document.getElementById('btn-footer-update').addEventListener('click', () => {
    if (updateState === 'available') {
      window.electronAPI.downloadUpdate();
    } else if (updateState === 'ready') {
      window.electronAPI.installUpdate();
    }
  });

  const betaCheckbox = document.getElementById('chk-beta');
  const betaWarning = document.getElementById('beta-warning');
  const savedBeta = localStorage.getItem('enrollBeta') === 'true';
  betaCheckbox.checked = savedBeta;
  if (savedBeta) betaWarning.classList.remove('hidden');
  window.electronAPI.setAllowPrerelease(savedBeta);

  betaCheckbox.addEventListener('change', () => {
    const enrolled = betaCheckbox.checked;
    localStorage.setItem('enrollBeta', String(enrolled));
    window.electronAPI.setAllowPrerelease(enrolled);

    if (enrolled) {
      betaWarning.classList.remove('hidden');
    } else {
      betaWarning.classList.add('hidden');
    }

    window.electronAPI.checkForUpdate();
  });

  const selMarkerType   = document.getElementById('sel-marker-type');
  const vehicleColorRow = document.getElementById('vehicle-color-row');
  const vehiclePreview  = document.getElementById('vehicle-preview-wrap');

  const syncVehicleUI = () => {
    const isVehicle = markerType in VEHICLE_MODELS;
    vehicleColorRow.classList.toggle('hidden', !isVehicle);
    vehiclePreview.classList.toggle('hidden', !isVehicle);
  };

  // Remove vehicle options whose texture or mask is unavailable.
  for (const [key, model] of Object.entries(VEHICLE_MODELS)) {
    const prune = (missing) => () => {
      selMarkerType.querySelector(`option[value="${key}"]`)?.remove();
      if (markerType === key) {
        markerType = 'arrow';
        selMarkerType.value = 'arrow';
        syncVehicleUI();
        refreshReplayMarkerIcon();
      }
      logAction(`vehicle marker '${key}' unavailable — artwork missing (${missing})`);
    };
    for (const src of [model.texture, model.mask]) {
      const probe = new Image();
      probe.onerror = prune(src);
      probe.src = src;
    }
  }

  selMarkerType.value = markerType;
  syncVehicleUI();

  // Initialize the shared color wheel once.
  if (!carColorPicker) {
    carColorPicker = new iro.ColorPicker('#car-color-picker', {
      width: 160,
      color: markerColor,
      layout: [
        { component: iro.ui.Wheel },
        { component: iro.ui.Slider, options: { sliderType: 'value' } },
      ],
    });

    const hexInput = document.getElementById('inp-car-hex');
    hexInput.value = markerColor;

    carColorPicker.on('color:change', (color) => {
      hexInput.value = color.hexString;
      if (colorPopupApply) colorPopupApply(color.hexString);
    });

    hexInput.addEventListener('input', () => {
      const val = hexInput.value;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        carColorPicker.color.hexString = val;
      }
    });

    document.getElementById('btn-car-color-close').addEventListener('click', closeColorPopup);
  }

  const swatch = document.getElementById('btn-car-color-swatch');
  swatch.style.background = markerColor;
  swatch.addEventListener('click', () => {
    openColorPopup(swatch, 'Car Color', markerColor, scheduleMarkerColorUpdate);
  });

  const LINE_COLOR_TITLES = { manual: 'Manual', fsd: 'Full Self-Driving', summon: 'Summon', imported: 'Imported', overview: 'All Drives' };
  const lineSwatches = document.querySelectorAll('.line-color-swatch');
  const syncLineSwatches = () => {
    lineSwatches.forEach((b) => { b.style.background = driveLineColors[b.dataset.linecolor]; });
  };
  syncLineSwatches();
  lineSwatches.forEach((btn) => {
    const key = btn.dataset.linecolor;
    btn.addEventListener('click', () => {
      openColorPopup(btn, LINE_COLOR_TITLES[key], driveLineColors[key], (hex) => {
        driveLineColors[key] = hex;
        localStorage.setItem('driveLineColors', JSON.stringify(driveLineColors));
        btn.style.background = hex;
        scheduleDriveLineColorsApply();
      });
    });
  });
  document.getElementById('btn-line-colors-reset').addEventListener('click', () => {
    driveLineColors = { ...DRIVE_LINE_COLOR_DEFAULTS };
    localStorage.removeItem('driveLineColors');
    syncLineSwatches();
    closeColorPopup();
    applyDriveLineColors();
  });

  if (markerType in VEHICLE_MODELS) applyMarkerColor(markerColor);

  selMarkerType.addEventListener('change', async () => {
    markerType = selMarkerType.value;
    localStorage.setItem('markerType', markerType);
    syncVehicleUI();
    // Wait for tinting before rebuilding to avoid an arrow fallback.
    if (markerType in VEHICLE_MODELS) await applyMarkerColor(markerColor);
    refreshReplayMarkerIcon();
  });

  // The UI presents the inverse of the persisted hideOtherDrives flag.
  const showOthersChk = document.getElementById('chk-show-other-drives');
  hideOtherDrives = localStorage.getItem('hideOtherDrives') === 'true';
  showOthersChk.checked = !hideOtherDrives;
  showOthersChk.addEventListener('change', () => {
    hideOtherDrives = !showOthersChk.checked;
    localStorage.setItem('hideOtherDrives', String(hideOtherDrives));
    applyOtherDrivesVisibility();
  });

  const fsdMarkersChk = document.getElementById('chk-show-fsd-markers');
  showFsdMarkers = localStorage.getItem('showFsdMarkers') !== 'false';
  fsdMarkersChk.checked = showFsdMarkers;
  fsdMarkersChk.addEventListener('change', () => {
    showFsdMarkers = fsdMarkersChk.checked;
    localStorage.setItem('showFsdMarkers', String(showFsdMarkers));
    applyFsdMarkerVisibility();
  });

  // Editing sessions override the zone-marker preference.
  const zoneMarkersChk = document.getElementById('chk-show-zone-markers');
  zoneMarkersChk.checked = showZoneMarkers;
  zoneMarkersChk.addEventListener('change', () => {
    showZoneMarkers = zoneMarkersChk.checked;
    localStorage.setItem('showZoneMarkers', String(showZoneMarkers));
    updatePrivacyZoneLayer();
  });

  const logsBtn = document.getElementById('btn-download-logs');
  if (logsBtn) {
    logsBtn.addEventListener('click', async () => {
      try {
        if (typeof window.electronAPI?.downloadLogs !== 'function') {
          alert('Log export requires a full app restart to activate.');
          return;
        }
        const r = await window.electronAPI.downloadLogs();
        if (r && r.success) {
          logsBtn.textContent = 'Saved ✓';
          setTimeout(() => { logsBtn.textContent = 'Save'; }, 2000);
        } else if (r && !r.canceled) {
          alert(`Couldn't save logs: ${r.error ?? 'unknown error'}`);
        }
      } catch (err) {
        // A renderer-only reload may not have the matching main-process handler.
        alert(`Couldn't save logs: ${err.message}`);
      }
    });
  }

  const mapLabelsChk = document.getElementById('chk-show-map-labels');
  showMapLabels = localStorage.getItem('showMapLabels') !== 'false';
  mapLabelsChk.checked = showMapLabels;
  mapLabelsChk.addEventListener('change', () => {
    showMapLabels = mapLabelsChk.checked;
    localStorage.setItem('showMapLabels', String(showMapLabels));
    applyMapLabelsSetting();
  });

  // Unset road-label preferences inherit the city-label choice.
  const roadLabelsChk = document.getElementById('chk-show-road-labels');
  const savedRoadLabelsChoice = localStorage.getItem('showRoadLabels');
  showRoadLabels = savedRoadLabelsChoice != null ? savedRoadLabelsChoice !== 'false' : showMapLabels;
  roadLabelsChk.checked = showRoadLabels;
  roadLabelsChk.addEventListener('change', () => {
    showRoadLabels = roadLabelsChk.checked;
    localStorage.setItem('showRoadLabels', String(showRoadLabels));
    applyMapLabelsSetting();
  });

  const superchargersChk = document.getElementById('chk-show-superchargers');
  const otherChargersChk = document.getElementById('chk-show-other-chargers');
  superchargersChk.checked = showSuperchargers;
  otherChargersChk.checked = showOtherChargers;
  superchargersChk.addEventListener('change', () => {
    showSuperchargers = superchargersChk.checked;
    localStorage.setItem('showSuperchargers', String(showSuperchargers));
    renderChargingSites();
  });
  otherChargersChk.addEventListener('change', () => {
    showOtherChargers = otherChargersChk.checked;
    localStorage.setItem('showOtherChargers', String(showOtherChargers));
    renderChargingSites();
  });
  document.getElementById('btn-refresh-superchargers').addEventListener('click', refreshSuperchargerCatalog);
  updateSuperchargerCatalogStatus();

  const autoLoadChk = document.getElementById('chk-autoload-drive-data');
  autoLoadChk.checked = localStorage.getItem('autoLoadDriveData') !== 'false';
  autoLoadChk.addEventListener('change', () => {
    localStorage.setItem('autoLoadDriveData', String(autoLoadChk.checked));
  });

  const unitToggle = document.getElementById('unit-toggle');
  const syncUnitToggleActive = () => {
    unitToggle.querySelectorAll('.settings-segment-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === unitSystem);
    });
  };
  syncUnitToggleActive();
  unitToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-segment-btn');
    if (!btn) return;
    const next = btn.dataset.value;
    if (next === unitSystem) return;
    unitSystem = next;
    localStorage.setItem('unitSystem', unitSystem);
    syncUnitToggleActive();
    refreshUnitDisplay();
    renderPrivacyZones();
  });

  window.electronAPI.checkForUpdate();
}

// ─── Changelog Modal ─────────────────────────────────────────────────────────
const CHANGELOG_TYPE_ICONS = { feature: '✦', improvement: '↑', fix: '✓', note: '•' };
const CHANGELOG_TYPE_LABELS = { feature: 'Feature', improvement: 'Improvement', fix: 'Fix', note: 'Note' };
let changelogVersions = [];
let pendingChangelogShow = null;

async function initChangelogModal() {
  const overlay = document.getElementById('changelog-overlay');
  const titleEl = document.getElementById('changelog-modal-title');
  const contentEl = document.getElementById('changelog-modal-content');
  const ghBtn = document.getElementById('btn-changelog-github');
  const dismissBtn = document.getElementById('btn-changelog-dismiss');
  const viewAllBtn = document.getElementById('btn-view-changelog');

  const close = () => overlay.classList.add('hidden');
  dismissBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  contentEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-external]');
    if (a) {
      e.preventDefault();
      window.electronAPI.openExternal(a.href);
    }
  });

  ghBtn.addEventListener('click', () => {
    window.electronAPI.openExternal('https://github.com/Sentry-Six/Sentry-Drive/releases');
  });

  const result = await window.electronAPI.getChangelog();
  changelogVersions = result.success ? result.versions : [];

  const currentVersion = await window.electronAPI.getAppVersion();

  const isBetaVersion = (v) => /beta/i.test(v);
  const visibleVersions = () => {
    const onBeta = localStorage.getItem('enrollBeta') === 'true' || isBetaVersion(currentVersion);
    return onBeta ? changelogVersions : changelogVersions.filter((v) => !isBetaVersion(v.version));
  };

  viewAllBtn.addEventListener('click', () => {
    if (!changelogVersions.length) return;
    titleEl.textContent = 'Changelog';
    contentEl.innerHTML = visibleVersions().map(renderChangelogEntry).join('');
    contentEl.scrollTop = 0;
    overlay.classList.remove('hidden');
  });
  const lastSeen = localStorage.getItem('lastSeenVersion');

  if (!lastSeen) {
    localStorage.setItem('lastSeenVersion', currentVersion);
    return;
  }
  if (lastSeen === currentVersion) return;

  localStorage.setItem('lastSeenVersion', currentVersion);

  const entry = changelogVersions.find((v) => v.version === currentVersion);
  if (!entry) return;

  titleEl.textContent = 'What’s New';
  contentEl.innerHTML = renderChangelogEntry(entry);
  pendingChangelogShow = () => overlay.classList.remove('hidden');
}

function renderInline(s) {
  const escaped = String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" data-external>$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function formatChangelogDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderChangelogEntry(entry) {
  const dateHtml = formatChangelogDate(entry.date);
  const titleHtml = entry.title
    ? `<div class="changelog-version-title">${renderInline(entry.title)}</div>`
    : '';
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  const itemsHtml = changes.length
    ? `<div class="changelog-changes">${changes.map((c) => {
        const type = CHANGELOG_TYPE_ICONS[c.type] ? c.type : 'note';
        return `
          <div class="changelog-item">
            <span class="changelog-item-type ${type}">
              <span class="changelog-item-type-icon">${CHANGELOG_TYPE_ICONS[type]}</span>
              <span class="changelog-item-type-label">${CHANGELOG_TYPE_LABELS[type]}</span>
            </span>
            <span class="changelog-item-text">${renderInline(c.description ?? '')}</span>
          </div>
        `;
      }).join('')}</div>`
    : '<div class="changelog-loading">No details for this release.</div>';

  return `
    <div class="changelog-version">
      <div class="changelog-version-header">
        <span class="changelog-version-tag">v${renderInline(entry.version)}</span>
        ${dateHtml ? `<span class="changelog-version-date">${dateHtml}</span>` : ''}
      </div>
      ${titleHtml}
      ${itemsHtml}
    </div>
  `;
}

// Enforce perceptible feedback and a timeout for user-initiated update checks.
let checkStartedMs = 0;
let checkWatchdog = null;

function beginUpdateCheckUI() {
  checkStartedMs = Date.now();
  clearTimeout(checkWatchdog);
  checkWatchdog = setTimeout(() => {
    checkWatchdog = null;
    onUpdateStatus({ status: 'error', message: 'No response from the update server — try again later.' });
  }, 20000);
  onUpdateStatus({ status: 'checking' });
}

function onUpdateStatus(payload) {
  const terminal = payload.status === 'available' || payload.status === 'up-to-date' || payload.status === 'error';
  if (terminal && checkWatchdog) {
    clearTimeout(checkWatchdog);
    checkWatchdog = null;
  }
  // Keep the checking state visible briefly.
  const elapsed = Date.now() - checkStartedMs;
  const MIN_CHECKING_MS = 600;
  if (terminal && checkStartedMs && elapsed < MIN_CHECKING_MS) {
    checkStartedMs = 0;
    setTimeout(() => applyUpdateStatus(payload), MIN_CHECKING_MS - elapsed);
    return;
  }
  if (terminal) checkStartedMs = 0;
  applyUpdateStatus(payload);
}

function applyUpdateStatus({ status, version, percent, message }) {
  const btn = document.getElementById('btn-check-update');
  const msg = document.getElementById('settings-update-msg');
  const footerBtn = document.getElementById('btn-footer-update');

  updateState = status;

  switch (status) {
    case 'checking':
      btn.textContent = 'Checking…';
      btn.disabled = true;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = '';
      msg.className = 'settings-update-msg hidden';
      break;

    case 'available':
      btn.textContent = 'Update';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = `New update available (v${version})`;
      msg.className = 'settings-update-msg update-available';

      if (!updateSkipped) {
        document.getElementById('update-modal-msg').textContent =
          `Version ${version} is ready to install.`;
        document.getElementById('update-overlay').classList.remove('hidden');
        populateUpdateModalChanges(version);
      }

      footerBtn.classList.remove('hidden', 'update-downloading', 'update-ready');
      footerBtn.classList.add('update-attention');
      footerBtn.disabled = false;
      footerBtn.title = `Download v${version}`;
      footerBtn.querySelector('.material-icons').textContent = 'download';
      break;

    case 'up-to-date':
      updateState = 'idle';
      btn.textContent = 'Check for Update';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = 'You are up to date.';
      msg.className = 'settings-update-msg update-current';

      footerBtn.classList.add('hidden');
      footerBtn.classList.remove('update-attention', 'update-downloading', 'update-ready');
      break;

    case 'downloading':
      btn.textContent = `Downloading… ${percent}%`;
      btn.disabled = true;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = `Downloading update…`;
      msg.className = 'settings-update-msg update-available';

      // Put download percentage in the tooltip due to the compact button.
      footerBtn.classList.remove('hidden', 'update-attention', 'update-ready');
      footerBtn.classList.add('update-downloading');
      footerBtn.disabled = true;
      footerBtn.title = `Downloading… ${percent}%`;
      footerBtn.querySelector('.material-icons').textContent = 'download';
      break;

    case 'ready':
      btn.textContent = 'Restart to Update';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = 'Update downloaded. Restart to apply.';
      msg.className = 'settings-update-msg update-available';

      footerBtn.classList.remove('hidden', 'update-attention', 'update-downloading');
      footerBtn.classList.add('update-ready');
      footerBtn.disabled = false;
      footerBtn.title = 'Restart to Update';
      footerBtn.querySelector('.material-icons').textContent = 'restart_alt';
      break;

    case 'error':
      updateState = 'error';
      btn.textContent = 'Retry';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = message ? `Update check failed: ${message}` : 'Update check failed.';
      msg.className = 'settings-update-msg update-error';

      footerBtn.classList.add('hidden');
      footerBtn.classList.remove('update-attention', 'update-downloading', 'update-ready');
      break;
  }
}

// ─── Loading Overlay ─────────────────────────────────────────────────────────
let loadProgressUnsubscribe = null;

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
}

function showLoading(msg = 'Loading drive data...') {
  const overlay = document.getElementById('loading-overlay');
  overlay.querySelector('.loading-text').textContent = msg;
  overlay.classList.remove('hidden');

  // Keep progress hidden until an action emits its first event.
  const progressEl = document.getElementById('load-progress');
  const barEl = document.getElementById('load-bar');
  const detailEl = document.getElementById('load-detail');
  if (progressEl) {
    progressEl.classList.add('hidden');
    if (barEl) barEl.style.width = '0%';
    if (detailEl) detailEl.textContent = '';
  }

  if (loadProgressUnsubscribe) { loadProgressUnsubscribe(); loadProgressUnsubscribe = null; }
  loadProgressUnsubscribe = window.electronAPI.onLoadProgress?.(({ phase, current, total }) => {
    if (progressEl?.classList.contains('hidden')) progressEl.classList.remove('hidden');
    if (phase === 'reading') {
      // Reserve the final 10% for grouping and display preparation.
      const frac = total > 0 ? current / total : 0;
      if (barEl) barEl.style.width = (frac * 90).toFixed(1) + '%';
      overlay.querySelector('.loading-text').textContent = 'Reading drive data…';
      if (detailEl) detailEl.textContent = `${formatMB(current)} / ${formatMB(total)}`;
    } else if (phase === 'grouping') {
      if (barEl) barEl.style.width = '95%';
      overlay.querySelector('.loading-text').textContent = 'Grouping drives…';
      if (detailEl) detailEl.textContent = '';
    } else if (phase === 'preparing') {
      if (barEl) barEl.style.width = '99%';
      overlay.querySelector('.loading-text').textContent = 'Preparing display…';
      if (detailEl) detailEl.textContent = '';
    }
  });
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
  if (loadProgressUnsubscribe) { loadProgressUnsubscribe(); loadProgressUnsubscribe = null; }
}

// ─── Processing Tab ───────────────────────────────────────────────────────────
// Electron app.asar paths are read-only.
const isAsarPath = (p) => /\.asar([\\/]|$)/i.test(p || '');

function initProcessingTab() {
  const clipsDirInput = document.getElementById('clips-dir');

  const savedClipsDir = localStorage.getItem('lastClipsDir');
  if (savedClipsDir) clipsDirInput.value = savedClipsDir;

  // Discard persisted paths that point into app.asar.
  const savedOutputDir = localStorage.getItem('lastOutputDir');
  if (isAsarPath(savedOutputDir)) {
    localStorage.removeItem('lastOutputDir');
  } else if (savedOutputDir) {
    document.getElementById('output-path').value = savedOutputDir;
  }

  document.getElementById('browse-clips').addEventListener('click', async () => {
    const dir = await window.electronAPI.selectDirectory({
      defaultPath: clipsDirInput.value || undefined,
    });
    if (dir) {
      clipsDirInput.value = dir;
      localStorage.setItem('lastClipsDir', dir);
    }
  });

  document.getElementById('browse-output').addEventListener('click', async () => {
    const outputInput = document.getElementById('output-path');
    const dir = await window.electronAPI.selectDirectory({
      defaultPath: outputInput.value || undefined,
    });
    if (dir) {
      outputInput.value = dir;
      localStorage.setItem('lastOutputDir', dir);
    }
  });

  const reprocessOverlay = document.getElementById('reprocess-overlay');
  document.getElementById('btn-reprocess-all').addEventListener('click', () => {
    reprocessOverlay.classList.remove('hidden');
  });
  document.getElementById('btn-reprocess-confirm').addEventListener('click', () => {
    reprocessOverlay.classList.add('hidden');
    startProcessing({ reprocessAll: true });
  });
  document.getElementById('btn-reprocess-cancel').addEventListener('click', () => {
    reprocessOverlay.classList.add('hidden');
  });
  reprocessOverlay.addEventListener('click', (e) => {
    if (e.target === reprocessOverlay) reprocessOverlay.classList.add('hidden');
  });

  document.getElementById('btn-process-new').addEventListener('click', () => startProcessing({ reprocessAll: false }));
  document.getElementById('btn-stop').addEventListener('click', stopProcessing);

  const slider = document.getElementById('worker-count');
  const display = document.getElementById('worker-count-display');
  slider.addEventListener('input', () => { display.textContent = slider.value; });
  document.getElementById('btn-auto-workers').addEventListener('click', () => {
    const optimal = Math.max(1, cpuCount - 1);
    slider.value = optimal;
    display.textContent = optimal;
  });

  window.electronAPI.getCpuCount().then((n) => {
    cpuCount = n;
    const optimal = Math.max(1, n - 1);
    slider.max = n;
    slider.value = optimal;
    display.textContent = optimal;
  });
}

async function loadDefaultPaths() {
  const outputInput = document.getElementById('output-path');
  if (!outputInput.value) {
    const defaultDir = await window.electronAPI.getDefaultOutputDir();
    outputInput.value = defaultDir;
  }

  // Auto-load a saved or discoverable drive-data file.
  if (localStorage.getItem('autoLoadDriveData') !== 'false') {
    const savedDriveData = localStorage.getItem('lastDriveDataPath');
    if (savedDriveData) {
      await autoLoadDriveData(savedDriveData);
    } else {
      const clipsDir = document.getElementById('clips-dir').value;
      if (clipsDir) {
        const found = await window.electronAPI.findDriveData(clipsDir);
        if (found) await autoLoadDriveData(found);
      }
    }
  }
  pendingChangelogShow?.();
  pendingChangelogShow = null;
}

function updateDrivePager() {
  const pager = document.getElementById('drive-pager');
  if (!pager) return;
  const { offset, limit, total } = drivePageState;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(pages, Math.floor(offset / limit) + 1);
  document.getElementById('drive-page-label').textContent =
    `Page ${fmt(page)} of ${fmt(pages)} · ${fmt(total)} drives`;
  document.getElementById('drive-page-prev').disabled = offset <= 0;
  document.getElementById('drive-page-next').disabled = offset + limit >= total;
  pager.classList.toggle('hidden', total <= limit);
}

async function applyDrivePageState(state) {
  for (const drive of drives) {
    delete drive.points;
    delete drive.fsdStates;
    delete drive.gearStates;
    delete drive.fsdEvents;
  }
  if (selectedDriveId !== null) deselectDrive();
  drivePageState = state;
  drives = state.drives;
  updateDrivePager();
  await renderDriveList(drives);
  renderOverviewOnMap();
}

async function changeDrivePage(direction) {
  if (!drivePageModel) return;
  const pager = document.getElementById('drive-pager');
  pager?.classList.add('is-loading');
  try {
    const state = direction === 'previous'
      ? await drivePageModel.previous()
      : await drivePageModel.next();
    await applyDrivePageState(state);
  } catch (error) {
    alert(`Couldn't load that drive page: ${error.message}`);
  } finally {
    pager?.classList.remove('is-loading');
  }
}

// Re-query from page one; subsequent paging retains these filters.
async function applyDriveFilters() {
  if (!drivePageModel || !loadedFilePath) return;
  const pager = document.getElementById('drive-pager');
  pager?.classList.add('is-loading');
  try {
    const state = await drivePageModel.load({ ...driveFilters });
    await applyDrivePageState(state);
    logAction(`drive filter — tag=${driveFilters.tag || '(none)'} range=${driveFilters.startDate || '…'}→${driveFilters.endDate || '…'} → ${state.total} drive(s)`);
  } catch (error) {
    alert(`Couldn't apply the drive filter: ${error.message}`);
  } finally {
    pager?.classList.remove('is-loading');
  }
}

async function applyLoadedDriveData(result, filePath) {
  loadedFilePath = filePath;
  localStorage.setItem('lastDriveDataPath', filePath);
  pendingExternalReload = false;
  window.electronAPI.watchDriveData(filePath);
  driveCacheGen = result.cacheGen;
  // Preserve active filters across automatic reloads.
  const state = await drivePageModel.load({ ...driveFilters });
  drivePageState = state;
  drives = state.drives;
  overviewRoutes = result.overviewRoutes ?? [];
  hasSummonDrives = (result.aggregates?.summonDriveCount ?? 0) > 0;
  refreshAllTags(result.driveTags ?? {});
  renderTagFilter();
  document.getElementById('date-filter').classList.remove('hidden');
  renderDriveStats(drives, result);
  await renderDriveList(drives);
  renderOverviewOnMap();
  await loadChargingSites();
  updateDrivePager();
  document.getElementById('btn-repair-gps').disabled = false;
  updateRevertButton();
  updateTessieButtonStates();
}

async function autoLoadDriveData(filePath) {
  showLoading();
  try {
    const result = await window.electronAPI.loadAndGroupDrives(filePath);
    if (!result.success) { hideLoading(); return; }

    await applyLoadedDriveData(result, filePath);

    switchMainTab('drives');
  } catch {
    // Clear a path that no longer loads.
    localStorage.removeItem('lastDriveDataPath');
  }
  hideLoading();
}

async function startProcessing({ reprocessAll = false } = {}) {
  const clipsDir   = document.getElementById('clips-dir').value.trim();
  let outputDir    = document.getElementById('output-path').value.trim();

  if (!clipsDir)  { alert('Please select a clips directory.'); return; }
  if (!outputDir) { alert('Please select an output directory.'); return; }

  // Reject app.asar paths before the final save can fail.
  if (isAsarPath(outputDir)) {
    alert('The output folder points inside the app installation (app.asar), which is read-only.\nPlease choose a different output folder.');
    outputDir = await window.electronAPI.selectDirectory({});
    if (!outputDir || isAsarPath(outputDir)) return;
    document.getElementById('output-path').value = outputDir;
  }

  localStorage.setItem('lastClipsDir', clipsDir);
  localStorage.setItem('lastOutputDir', outputDir);

  const exists = await window.electronAPI.checkDriveData(outputDir);
  if (reprocessAll) {
    appendLogLine(
      exists
        ? 'Reprocessing all drives — existing routes will be rebuilt from scratch (drive tags preserved).'
        : 'Reprocessing all drives — no existing drive-data.json found, starting fresh.',
      'warn',
    );
  } else if (exists) {
    appendLogLine('Found existing drive-data.json — new clips will be added incrementally.', 'warn');
  } else {
    appendLogLine('No existing drive-data.json — starting fresh.', 'normal');
  }

  const workerCount = parseInt(document.getElementById('worker-count').value, 10);

  document.getElementById('log-output').innerHTML = '';
  document.getElementById('progress-section').classList.remove('hidden');
  document.getElementById('eta-label').textContent = '';
  updateProgressBar(0);
  setProcessingButtons(true);
  processingStartTime = Date.now();

  if (removeOutputListener) removeOutputListener();

  removeOutputListener = window.electronAPI.onProcessingOutput((data) => {
    if (data.type === 'done') {
      onProcessingDone(data.code);
    } else if (data.type === 'error') {
      appendLogLine(`Error: ${data.text}`, 'error');
    } else {
      appendOutput(data);
    }
  });

  const result = await window.electronAPI.startProcessing({ clipsDir, outputDir, workerCount, reprocessAll });
  if (!result.success && result.error) {
    appendLogLine(`Failed to start: ${result.error}`, 'error');
    onProcessingDone(-1);
  }
}

async function stopProcessing() {
  await window.electronAPI.stopProcessing();
  onProcessingDone(-2);
}

function onProcessingDone(code) {
  if (removeOutputListener) { removeOutputListener(); removeOutputListener = null; }
  setProcessingButtons(false);
  processingStartTime = null;
  document.getElementById('eta-label').textContent = '';

  // Apply a file change deferred while processing was active.
  if (pendingExternalReload && selectedDriveId === null) {
    pendingExternalReload = false;
    reloadDrivesAfterWrite();
  }

  if (code === 0) {
    document.getElementById('progress-phase').textContent = 'Complete!';
    appendLogLine('✓ Processing complete!', 'success');
    updateProgressBar(100);
  } else if (code === -2) {
    document.getElementById('progress-phase').textContent = 'Stopped';
    appendLogLine('● Processing stopped by user.', 'warn');
  } else if (code !== null && code !== undefined) {
    document.getElementById('progress-phase').textContent = 'Error';
    appendLogLine(`✗ Process exited with code ${code}.`, 'error');
  }
}

function setProcessingButtons(running) {
  document.getElementById('btn-reprocess-all').disabled = running;
  document.getElementById('btn-process-new').disabled = running;
  document.getElementById('btn-stop').disabled = !running;
}

function appendOutput({ type, text }) {
  if (!text) return;

  // Interpret carriage returns like an updating terminal line.
  const lines = text
    .split('\n')
    .map((seg) => seg.split('\r').pop())
    .filter((l) => l.trim() !== '');

  for (const line of lines) {
    if (/^SCAN \d+\/\d+$/.test(line.trim())) continue;
    appendLogLine(line, type === 'stderr' ? 'error' : 'normal');
  }

  // Output protocol: `SCAN N/M` reports directory-scan progress.
  const scanMatch = text.match(/SCAN (\d+)\/(\d+)/);
  if (scanMatch) {
    const pct = Math.round((parseInt(scanMatch[1], 10) / parseInt(scanMatch[2], 10)) * 100);
    document.getElementById('progress-phase').textContent = 'Scanning…';
    updateProgressBar(pct);
  }

  // `(N%)` reports extraction progress and starts a fresh bar.
  const extractMatch = text.match(/\((\d+)%\)/);
  if (extractMatch) {
    document.getElementById('progress-phase').textContent = 'Processing…';
    updateProgressBar(parseInt(extractMatch[1], 10));
  }
}

function appendLogLine(text, cls = 'normal') {
  const log = document.getElementById('log-output');
  const el = document.createElement('div');
  el.className = `log-line log-${cls}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function updateProgressBar(pct) {
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-label').textContent = `${pct}%`;

  if (pct > 0 && pct < 100 && processingStartTime) {
    const elapsedSec = (Date.now() - processingStartTime) / 1000;
    const remainingSec = (elapsedSec / pct) * (100 - pct);
    document.getElementById('eta-label').textContent = `ETA ${fmtDuration(remainingSec)}`;
  }
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}H ${m}M ${s}S`;
  return `${m}M ${s}S`;
}

// ─── View Drives Tab ──────────────────────────────────────────────────────────
function initViewDrivesTab() {
  document.getElementById('btn-load-drives').addEventListener('click', loadDrives);
  drivePageModel = window.DrivePageModel.createDrivePageModel({
    pageSize: 250,
    fetchPage: (query) => window.electronAPI.listDriveSummaries({
      ...query,
      gen: driveCacheGen,
    }),
  });
  document.getElementById('drive-page-prev').addEventListener('click', () => changeDrivePage('previous'));
  document.getElementById('drive-page-next').addEventListener('click', () => changeDrivePage('next'));

  // Date bounds are inclusive and independently optional.
  const dateStart = document.getElementById('filter-date-start');
  const dateEnd = document.getElementById('filter-date-end');
  const dateClear = document.getElementById('btn-clear-dates');
  const syncDateFilter = () => {
    driveFilters.startDate = dateStart.value || '';
    driveFilters.endDate = dateEnd.value || '';
    dateClear.classList.toggle('hidden', !driveFilters.startDate && !driveFilters.endDate);
    applyDriveFilters();
  };
  dateStart.addEventListener('change', syncDateFilter);
  dateEnd.addEventListener('change', syncDateFilter);
  dateClear.addEventListener('click', () => {
    dateStart.value = '';
    dateEnd.value = '';
    syncDateFilter();
  });

  initTessieImport();

  // Defer external file refreshes during replay or processing.
  window.electronAPI.onDriveDataChanged(() => {
    if (!loadedFilePath) return;
    if (selectedDriveId !== null || processingStartTime !== null) {
      pendingExternalReload = true;
    } else {
      reloadDrivesAfterWrite();
    }
  });

  const checkOverlay = document.getElementById('check-drives-overlay');
  document.getElementById('btn-repair-gps').addEventListener('click', () => {
    if (!loadedFilePath) return;
    checkOverlay.classList.remove('hidden');
  });
  document.getElementById('btn-check-bridge').addEventListener('click', () => {
    checkOverlay.classList.add('hidden');
    repairGPS();
  });
  document.getElementById('btn-check-summon').addEventListener('click', () => {
    checkOverlay.classList.add('hidden');
    checkSummon();
  });
  document.getElementById('btn-check-drives-cancel').addEventListener('click', () => {
    checkOverlay.classList.add('hidden');
  });
  checkOverlay.addEventListener('click', (e) => {
    if (e.target === checkOverlay) checkOverlay.classList.add('hidden');
  });

  const resultOverlay = document.getElementById('check-result-overlay');
  document.getElementById('btn-check-result-ok').addEventListener('click', () => {
    resultOverlay.classList.add('hidden');
  });
  resultOverlay.addEventListener('click', (e) => {
    if (e.target === resultOverlay) resultOverlay.classList.add('hidden');
  });

  const revertOverlay = document.getElementById('revert-overlay');
  document.getElementById('btn-revert-gps').addEventListener('click', () => {
    if (!loadedFilePath) return;
    revertOverlay.classList.remove('hidden');
  });
  document.getElementById('btn-revert-confirm').addEventListener('click', () => {
    revertOverlay.classList.add('hidden');
    revertGPS();
  });
  document.getElementById('btn-revert-cancel').addEventListener('click', () => {
    revertOverlay.classList.add('hidden');
  });
  revertOverlay.addEventListener('click', (e) => {
    if (e.target === revertOverlay) revertOverlay.classList.add('hidden');
  });

  const removeDriveOverlay = document.getElementById('remove-drive-overlay');
  document.getElementById('btn-remove-drive-cancel').addEventListener('click', () => {
    removeDriveOverlay.classList.add('hidden');
    pendingRemoveDrive = null;
  });
  removeDriveOverlay.addEventListener('click', (e) => {
    if (e.target === removeDriveOverlay) {
      removeDriveOverlay.classList.add('hidden');
      pendingRemoveDrive = null;
    }
  });
  document.getElementById('btn-remove-drive-confirm').addEventListener('click', async () => {
    if (!pendingRemoveDrive || !loadedFilePath) return;
    removeDriveOverlay.classList.add('hidden');
    const drive = pendingRemoveDrive;
    pendingRemoveDrive = null;
    // Cover the full-file rewrite and synchronous re-render with the overlay.
    showLoading('Removing drive…');
    try {
      const result = await window.electronAPI.removeDrive({ filePath: loadedFilePath, driveStartTime: drive.startTime });
      if (!result.success) return;
      const wasSelected = selectedDriveId === drive.id;
      drives = drives.filter((d) => d.startTime !== drive.startTime);
      if (wasSelected) deselectDrive();
      // Paint the overlay before the synchronous re-render.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      renderDriveList(drives);
      // Rebuild map layers to remove the deleted route.
      renderOverviewOnMap();
      // Retain aggregate metadata across the local removal.
      renderDriveStats(drives, lastDrivesMeta ?? { totalRoutes: 0, processedFileCount: 0 });
      updateTessieButtonStates();
    } finally {
      hideLoading();
    }
  });

  // Shared confirmation for multi-select and privacy-zone removals.
  const removeDrivesOverlay = document.getElementById('remove-drives-overlay');
  document.getElementById('btn-multi-clear').addEventListener('click', clearMultiSelect);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && multiSelected.size) clearMultiSelect();
  });
  document.getElementById('btn-multi-remove').addEventListener('click', () => {
    if (!multiSelected.size || !loadedFilePath) return;
    const byId = new Map(drives.map((d) => [String(d.id), d]));
    const targets = [...multiSelected].map((id) => byId.get(id)).filter(Boolean);
    if (!targets.length) { clearMultiSelect(); return; }
    openBulkRemoveModal(targets,
      `Remove the ${targets.length} selected drive${targets.length === 1 ? '' : 's'}? This cannot be undone.`);
  });
  document.getElementById('btn-remove-drives-cancel').addEventListener('click', () => {
    pendingBulkRemove = null;
    removeDrivesOverlay.classList.add('hidden');
  });
  removeDrivesOverlay.addEventListener('click', (e) => {
    if (e.target === removeDrivesOverlay) {
      pendingBulkRemove = null;
      removeDrivesOverlay.classList.add('hidden');
    }
  });
  document.getElementById('btn-remove-drives-confirm').addEventListener('click', async () => {
    removeDrivesOverlay.classList.add('hidden');
    const targets = pendingBulkRemove ?? [];
    pendingBulkRemove = null;
    if (!targets.length || !loadedFilePath) return;
    // One IPC round-trip performs the batch rewrite.
    showLoading(`Removing ${targets.length} drive${targets.length === 1 ? '' : 's'}…`);
    try {
      const result = await window.electronAPI.removeDrives({
        filePath: loadedFilePath,
        driveStartTimes: targets.map((d) => d.startTime),
      });
      if (!result.success) { alert(`Failed to remove drives:\n${result.error}`); return; }
      if (targets.some((d) => d.id === selectedDriveId)) deselectDrive();
      const removed = new Set(targets.map((d) => d.startTime));
      drives = drives.filter((d) => !removed.has(d.startTime));
      logAction(`removed ${targets.length} drive(s) via bulk remove`);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      renderDriveList(drives);
      renderOverviewOnMap();
      // Retain aggregate metadata across the local removal.
      renderDriveStats(drives, lastDrivesMeta ?? { totalRoutes: 0, processedFileCount: 0 });
      updateTessieButtonStates();
    } finally {
      hideLoading();
    }
  });
}

// ─── Drive Imports ───────────────────────────────────────────────────────────
let tessieProgressListener = null;
let tessieDrivesPath = '';
let tessieStatesPath = '';
let importJsonPath = '';
let tessieImportMode = 'api';

function initTessieImport() {
  const overlay = document.getElementById('tessie-overlay');
  const drivesInput = document.getElementById('tessie-drives-path');
  const statesInput = document.getElementById('tessie-states-path');
  const previewEl = document.getElementById('tessie-preview');
  const progressEl = document.getElementById('tessie-import-progress');
  const confirmBtn = document.getElementById('btn-tessie-confirm');
  const closeBtn = document.getElementById('btn-tessie-cancel');

  const tokenInput = document.getElementById('tessie-api-token');
  const vinSelect = document.getElementById('tessie-api-vin');
  const fromInput = document.getElementById('tessie-api-from');
  const toInput = document.getElementById('tessie-api-to');
  const serviceSelect = document.getElementById('import-service');

  // Route modal actions through connected services; tokens remain in Settings.
  const SERVICES = {
    tessie: {
      label: 'Tessie', idField: 'vin',
      getToken: () => window.electronAPI.tessieApiGetToken(),
      validate: (token) => window.electronAPI.tessieApiValidate({ token }),
      preview: (a) => window.electronAPI.tessieApiPreview(a),
      runImport: (a) => window.electronAPI.tessieApiImport(a),
      cancel: () => window.electronAPI.tessieApiCancel(),
      onProgress: (cb) => window.electronAPI.onTessieProgress(cb),
      removeHidden: () => window.electronAPI.tessieRemoveHidden({ driveDataPath: loadedFilePath }),
      csv: true,
      csvPreview: (a) => window.electronAPI.tessiePreview(a),
      csvImport: (a) => window.electronAPI.tessieImport(a),
      csvCancel: () => window.electronAPI.tessieImportCancel(),
    },
    teslascope: {
      label: 'Teslascope', idField: 'publicId',
      getToken: () => window.electronAPI.teslascopeApiGetToken(),
      validate: (token) => window.electronAPI.teslascopeApiValidate({ token }),
      preview: (a) => window.electronAPI.teslascopeApiPreview(a),
      runImport: (a) => window.electronAPI.teslascopeApiImport(a),
      cancel: () => window.electronAPI.teslascopeApiCancel(),
      onProgress: (cb) => window.electronAPI.onTeslascopeProgress(cb),
      removeHidden: () => window.electronAPI.teslascopeRemoveHidden({ driveDataPath: loadedFilePath }),
      csv: false,
    },
  };
  let selectedService = 'tessie';
  const svc = () => SERVICES[selectedService] || SERVICES.tessie;

  // List only connected services.
  async function populateServices() {
    const entries = Object.entries(SERVICES);
    const tokens = await Promise.all(entries.map(([, s]) => s.getToken().catch(() => null)));
    const opts = entries
      .filter((_, i) => tokens[i] && tokens[i].token)
      .map(([key, s]) => ({ key, label: s.label }));
    if (opts.length === 0) {
      serviceSelect.innerHTML = '<option value="">No connected services</option>';
      serviceSelect.disabled = true;
      return false;
    }
    serviceSelect.innerHTML = opts.map((o) => `<option value="${o.key}">${o.label}</option>`).join('');
    serviceSelect.disabled = false;
    if (!opts.some((o) => o.key === selectedService)) selectedService = opts[0].key;
    serviceSelect.value = selectedService;
    return true;
  }

  // Show CSV mode only for supporting services.
  function applyServiceUI() {
    const csvBtn = document.querySelector('.tessie-mode-btn[data-mode="csv"]');
    if (csvBtn) csvBtn.classList.toggle('hidden', !svc().csv);
    if (!svc().csv && tessieImportMode === 'csv') {
      tessieImportMode = 'api';
      document.querySelectorAll('.tessie-mode-btn').forEach((x) => x.classList.toggle('active', x.dataset.mode === 'api'));
      document.getElementById('tessie-mode-api').classList.remove('hidden');
      document.getElementById('tessie-mode-csv').classList.add('hidden');
    }
  }

  if (serviceSelect) {
    serviceSelect.addEventListener('change', async () => {
      selectedService = serviceSelect.value || 'tessie';
      applyServiceUI();
      refreshConfirmReady();
      try {
        const r = await svc().getToken();
        tokenInput.value = (r && r.token) || '';
        // Refresh vehicles without delaying cached content.
        if (tokenInput.value) validateApiToken(true);
      } catch {}
    });
  }

  const jsonPathInput = document.getElementById('import-json-path');

  const resetModal = () => {
    tessieDrivesPath = '';
    tessieStatesPath = '';
    importJsonPath = '';
    drivesInput.value = '';
    statesInput.value = '';
    if (jsonPathInput) jsonPathInput.value = '';
    previewEl.classList.add('hidden');
    previewEl.innerHTML = '';
    progressEl.classList.add('hidden');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Import';
    closeBtn.title = 'Close';
  };

  document.querySelectorAll('.tessie-mode-btn').forEach((b) => {
    b.addEventListener('click', () => {
      // Ignore re-selection of the active mode.
      if (b.dataset.mode === tessieImportMode) return;
      tessieImportMode = b.dataset.mode;
      document.querySelectorAll('.tessie-mode-btn').forEach((x) => x.classList.toggle('active', x === b));
      document.getElementById('tessie-mode-api').classList.toggle('hidden', tessieImportMode !== 'api');
      document.getElementById('tessie-mode-csv').classList.toggle('hidden', tessieImportMode !== 'csv');
      document.getElementById('tessie-mode-json').classList.toggle('hidden', tessieImportMode !== 'json');
      previewEl.classList.add('hidden');
      previewEl.innerHTML = '';
      refreshConfirmReady();
    });
  });

  document.getElementById('browse-import-json').addEventListener('click', async () => {
    const p = await window.electronAPI.selectFile({ filters: [{ name: 'Drive data', extensions: ['json'] }] });
    if (!p) return;
    importJsonPath = p;
    jsonPathInput.value = p;
    previewEl.classList.add('hidden');
    previewEl.innerHTML = '';
    refreshConfirmReady();
  });

  const today = new Date();
  const ninetyAgo = new Date(today.getTime() - 90 * 24 * 3600 * 1000);
  const fmtDate = (d) => d.toISOString().slice(0, 10);
  fromInput.value = fmtDate(ninetyAgo);
  toInput.value = fmtDate(today);

  document.getElementById('tessie-token-link').addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://dash.tessie.com/settings/api');
  });

  document.getElementById('btn-import-tessie').addEventListener('click', async () => {
    if (!loadedFilePath) {
      alert('Load a drive-data.json first.');
      return;
    }
    resetModal();
    const hasConnected = await populateServices();
    applyServiceUI();
    if (!hasConnected) {
      previewEl.classList.remove('hidden');
      previewEl.innerHTML = 'Connect a service in <strong>Settings → Integrations</strong> first.';
    } else {
      try {
        const { token } = await svc().getToken();
        if (token) { tokenInput.value = token; validateApiToken(true); }
      } catch {}
    }
    overlay.classList.remove('hidden');
  });

  closeBtn.addEventListener('click', () => {
    if (confirmBtn.textContent === 'Importing…') {
      if (tessieImportMode === 'api') svc().cancel();
      else if (svc().csvCancel) svc().csvCancel();
      return;
    }
    overlay.classList.add('hidden');
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && confirmBtn.textContent !== 'Importing…') {
      overlay.classList.add('hidden');
    }
  });

  document.getElementById('browse-tessie-drives').addEventListener('click', async () => {
    const p = await window.electronAPI.selectFile({ filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!p) return;
    tessieDrivesPath = p;
    drivesInput.value = p;
    refreshConfirmReady();
  });
  document.getElementById('browse-tessie-states').addEventListener('click', async () => {
    const p = await window.electronAPI.selectFile({ filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!p) return;
    tessieStatesPath = p;
    statesInput.value = p;
    refreshConfirmReady();
  });

  document.getElementById('tessie-api-validate').addEventListener('click', () => validateApiToken(false));
  tokenInput.addEventListener('change', () => validateApiToken(false));
  // Date and vehicle changes validate inputs without querying the service.
  [fromInput, toInput, vinSelect].forEach((el) => el.addEventListener('change', refreshConfirmReady));

  // Prefer the native calendar while retaining typed input.
  [fromInput, toInput].forEach((el) => {
    el.addEventListener('click', () => {
      if (typeof el.showPicker === 'function') {
        try { el.showPicker(); } catch { /* Typed input remains available. */ }
      }
    });
  });

  // Render cached vehicles immediately; sequence numbers discard stale refreshes.
  const vehicleCache = {};
  let validateSeq = 0;

  async function validateApiToken(silent) {
    const token = tokenInput.value.trim();
    if (!token) {
      if (!silent) alert(`Connect ${svc().label} in Settings → Integrations first.`);
      return;
    }
    const service = selectedService;
    const idField = svc().idField;
    const seq = ++validateSeq;

    const fill = (vehicles) => {
      const prev = vinSelect.value;
      vinSelect.innerHTML = vehicles
        .map((v) => `<option value="${escapeHtml(v[idField] ?? v.vin ?? '')}">${escapeHtml(v.displayName || v.vin || v[idField])}</option>`)
        .join('');
      vinSelect.disabled = false;
      if ([...vinSelect.options].some((o) => o.value === prev)) vinSelect.value = prev;
    };

    const cached = vehicleCache[service];
    if (cached && cached.length) {
      // Refresh after rendering cached values.
      fill(cached);
      refreshConfirmReady();
      svc().validate(token).then((result) => {
        if (seq !== validateSeq || selectedService !== service) return;
        if (result.success && result.vehicles && result.vehicles.length) {
          // Avoid closing an open dropdown when values are unchanged.
          const changed = JSON.stringify(result.vehicles) !== JSON.stringify(vehicleCache[service]);
          vehicleCache[service] = result.vehicles;
          if (changed) {
            fill(result.vehicles);
            refreshConfirmReady();
          }
        }
      }).catch(() => {});
      return;
    }

    vinSelect.disabled = true;
    vinSelect.innerHTML = '<option>Loading vehicles…</option>';
    refreshConfirmReady();
    const result = await svc().validate(token);
    if (seq !== validateSeq || selectedService !== service) return;
    if (!result.success) {
      vinSelect.innerHTML = '<option>Validation failed</option>';
      if (!silent) alert(`Token validation failed:\n${result.error}`);
      return;
    }
    if (!result.vehicles || result.vehicles.length === 0) {
      vinSelect.innerHTML = '<option>No vehicles on account</option>';
      return;
    }
    vehicleCache[service] = result.vehicles;
    fill(result.vehicles);
    refreshConfirmReady();
  }

  // Query only after Import is clicked; valid inputs enable the button.
  function refreshConfirmReady() {
    if (tessieImportMode === 'api') {
      confirmBtn.disabled = !(tokenInput.value.trim() && vinSelect.value && !vinSelect.disabled);
    } else if (tessieImportMode === 'json') {
      confirmBtn.disabled = !importJsonPath;
    } else {
      confirmBtn.disabled = !(tessieDrivesPath && tessieStatesPath);
    }
  }

  // Sequence numbers invalidate superseded queries.
  let previewSeq = 0;

  // Run and render a drive query only after explicit import action.
  async function runImportQuery(args) {
    const seq = ++previewSeq;
    previewEl.classList.remove('hidden');
    let result;
    if (tessieImportMode === 'api') {
      previewEl.innerHTML = `<em>Querying ${escapeHtml(svc().label)} API…</em>`;
      result = await svc().preview(args);
    } else if (tessieImportMode === 'json') {
      previewEl.innerHTML = '<em>Scanning file…</em>';
      result = await window.electronAPI.importDriveDataFilePreview(args);
    } else {
      previewEl.innerHTML = '<em>Scanning CSVs…</em>';
      result = await svc().csvPreview(args);
    }
    if (seq !== previewSeq) return null;
    if (!result.success) {
      previewEl.innerHTML = `<span style="color:#f87171">Query failed: ${escapeHtml(result.error)}</span>`;
      return null;
    }
    renderPreview(result);
    return result;
  }

  function renderPreview(result) {
    const parts = [];
    if (tessieImportMode === 'json') {
      parts.push(`Found <span class="tessie-preview-count">${fmt(result.totalDrives)}</span> drive(s) in the file.`);
      parts.push(`<span class="tessie-preview-count">${fmt(result.toImport)}</span> new drive(s) will be imported.`);
      if (result.toImport === 0 && result.totalDrives > 0) {
        parts.push('<em>Nothing new — every drive in that file is already in your data.</em>');
      }
      previewEl.innerHTML = parts.join('<br>');
      return;
    }
    parts.push(`Found <span class="tessie-preview-count">${fmt(result.totalDrives)}</span> drive(s) on ${escapeHtml(svc().label)}.`);
    parts.push(`<span class="tessie-preview-count">${fmt(result.toImport)}</span> will be imported.`);
    if (result.overlapSkipped > 0) parts.push(`${fmt(result.overlapSkipped)} skipped (overlaps existing SEI data).`);
    if (result.duplicateSkipped > 0) parts.push(`${fmt(result.duplicateSkipped)} skipped (already imported).`);
    if (result.badTimestamps > 0) parts.push(`${fmt(result.badTimestamps)} skipped (couldn't be read — export logs from Settings → Support).`);
    if (result.toImport === 0 && result.totalDrives > 0) {
      parts.push('<em>Nothing new to import — every drive in this range is already covered above.</em>');
    }
    previewEl.innerHTML = parts.join('<br>');
  }

  confirmBtn.addEventListener('click', async () => {
    if (!loadedFilePath) return;

    // Snapshot inputs so query and import use the same request.
    const modeAtClick = tessieImportMode;
    const serviceAtClick = selectedService;
    let args;
    if (modeAtClick === 'api') {
      if (!tokenInput.value.trim() || !vinSelect.value || vinSelect.disabled) return;
      const fromSec = Math.floor(new Date(fromInput.value + 'T00:00:00').getTime() / 1000);
      const toSec = Math.floor(new Date(toInput.value + 'T23:59:59').getTime() / 1000);
      args = {
        token: tokenInput.value.trim(),
        [svc().idField]: vinSelect.value,
        fromSec, toSec,
        driveDataPath: loadedFilePath,
      };
    } else if (modeAtClick === 'json') {
      if (!importJsonPath) return;
      args = { driveDataPath: loadedFilePath, sourcePath: importJsonPath };
    } else {
      if (!tessieDrivesPath || !tessieStatesPath) return;
      args = {
        driveDataPath: loadedFilePath,
        drivesCsvPath: tessieDrivesPath,
        statesCsvPath: tessieStatesPath,
      };
    }

    // Abort on query failure, no results, or superseding modal changes.
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Checking…';
    const preview = await runImportQuery(args);
    const interrupted = overlay.classList.contains('hidden') ||
      tessieImportMode !== modeAtClick || selectedService !== serviceAtClick;
    if (!preview || preview.toImport === 0 || interrupted) {
      confirmBtn.textContent = 'Import';
      refreshConfirmReady();
      return;
    }

    // Confirm before imported FSD data changes aggregate scores.
    if (modeAtClick === 'json') {
      const proceed = await confirmMergeDriveData();
      if (proceed !== true || overlay.classList.contains('hidden')) {
        confirmBtn.textContent = 'Import';
        refreshConfirmReady();
        return;
      }
    }

    const beforeCount = drives.length;

    confirmBtn.textContent = 'Importing…';
    logAction(`import started (${modeAtClick === 'api' ? selectedService + ' API' : modeAtClick === 'json' ? 'drive-data file' : 'CSV'})`);
    closeBtn.title = 'Cancel import';
    progressEl.classList.remove('hidden');

    const phaseEl = document.getElementById('tessie-phase');
    const pctEl = document.getElementById('tessie-pct');
    const etaEl = document.getElementById('tessie-eta');
    const barEl = document.getElementById('tessie-bar');
    phaseEl.textContent = 'Starting…';
    pctEl.textContent = '';
    etaEl.textContent = '';
    barEl.style.width = '0%';

    if (tessieProgressListener) tessieProgressListener();
    const onProgress = modeAtClick === 'json' ? window.electronAPI.onImportJsonProgress : svc().onProgress;
    tessieProgressListener = onProgress(({ phase, current, total, etaSec }) => {
      phaseEl.textContent = phase;
      if (total > 0) {
        const pct = Math.round((current / total) * 100);
        pctEl.textContent = `${pct}%`;
        barEl.style.width = `${pct}%`;
        if (etaSec && etaSec > 0) {
          const m = Math.floor(etaSec / 60);
          const s = etaSec % 60;
          etaEl.textContent = m > 0 ? `${m}m ${s}s left` : `${s}s left`;
        } else {
          etaEl.textContent = '';
        }
      } else {
        pctEl.textContent = '';
        barEl.style.width = '0%';
      }
    });

    // Rejected IPC must still restore the modal and remove listeners.
    let result;
    try {
      if (modeAtClick === 'api') {
        result = await svc().runImport(args);
      } else if (modeAtClick === 'json') {
        result = await window.electronAPI.importDriveDataFile(args);
      } else {
        result = await svc().csvImport(args);
      }
    } catch (err) {
      result = { success: false, error: err?.message || String(err) };
    }

    if (tessieProgressListener) { tessieProgressListener(); tessieProgressListener = null; }
    closeBtn.title = 'Close';

    if (!result.success) {
      alert(`Import failed:\n${result.error}`);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Import';
      return;
    }

    overlay.classList.add('hidden');
    await reloadDrivesAfterWrite();

    const afterCount = drives.length;
    const visibleAdded = afterCount - beforeCount;
    const hiddenList = lastDrivesMeta?.hiddenTessieDrives ?? [];
    const hiddenBySei = hiddenList.length;

    const reasonLabel = {
      'no-coords': 'no GPS samples and no start/end coords',
      'no-points': 'API returned no path points',
      'no-clips': 'no valid time windows',
      'fetch-error': 'Tessie API request failed',
      'unknown': 'other',
    };
    const sourceLabel = modeAtClick === 'json' ? 'imported' : escapeHtml(svc().label);
    const lines = [];
    lines.push(result.canceled
      ? `Import canceled. ${fmt(result.imported)} drive(s) written before cancel.`
      : `Imported ${fmt(result.imported)} ${sourceLabel} drive(s).`);
    lines.push('');
    lines.push(`Drive count: ${fmt(beforeCount)} → ${fmt(afterCount)} (+${fmt(visibleAdded)})`);
    if (modeAtClick === 'json' && result.tagged > 0) {
      lines.push(`${fmt(result.tagged)} imported drive(s) brought their tags along.`);
    }
    if (hiddenBySei > 0) {
      lines.push('');
      lines.push(`${fmt(hiddenBySei)} drive(s) hidden because they overlap dashcam drives:`);
      const sample = hiddenList.slice(0, 8);
      for (const h of sample) {
        const date = (h.startTime || '').slice(0, 10);
        const start = (h.startTime || '').slice(11, 16);
        const end = (h.endTime || '').slice(11, 16);
        lines.push(`  • ${date} ${start}–${end}  (${(h.distanceMi ?? 0).toFixed(1)} mi)`);
      }
      if (hiddenList.length > sample.length) {
        lines.push(`  • …and ${fmt(hiddenList.length - sample.length)} more`);
      }
    }
    const skipped = result.skipReasons || {};
    const totalSkipped = Object.values(skipped).reduce((a, b) => a + b, 0);
    if (totalSkipped > 0) {
      lines.push('');
      lines.push(`${fmt(totalSkipped)} drive(s) skipped during import:`);
      for (const [reason, count] of Object.entries(skipped)) {
        lines.push(`  • ${fmt(count)} — ${reasonLabel[reason] || reason}`);
      }
    }
    if (hiddenBySei > 0) {
      lines.push('');
      lines.push('Click OK to delete these hidden drives from the file (recoverable from .bak).');
      lines.push('Click Cancel to keep them stored (they will stay hidden as long as SEI covers the same time).');
      if (confirm(lines.join('\n'))) {
        // Cover the full-file rewrite with the spinner.
        showLoading('Removing hidden imported drives…');
        const cleanupResult = await svc().removeHidden();
        if (cleanupResult.success) {
          await reloadDrivesAfterWrite();
          alert(`Removed ${fmt(cleanupResult.removed)} hidden imported drive(s) from the file.`);
        } else {
          hideLoading();
          alert(`Cleanup failed: ${cleanupResult.error}`);
        }
      }
    } else {
      alert(lines.join('\n'));
    }
  });

  const removeOverlay = document.getElementById('remove-tessie-overlay');
  const srcTessie = document.getElementById('remove-src-tessie');
  const srcTeslascope = document.getElementById('remove-src-teslascope');
  const removeConfirmBtn = document.getElementById('btn-remove-tessie-confirm');
  const syncRemoveConfirm = () => {
    removeConfirmBtn.disabled = !srcTessie.checked && !srcTeslascope.checked;
  };
  srcTessie.addEventListener('change', syncRemoveConfirm);
  srcTeslascope.addEventListener('change', syncRemoveConfirm);
  document.getElementById('btn-remove-tessie').addEventListener('click', () => {
    if (!loadedFilePath) return;
    // Reset the destructive modal to both sources selected.
    srcTessie.checked = true;
    srcTeslascope.checked = true;
    syncRemoveConfirm();
    removeOverlay.classList.remove('hidden');
  });
  document.getElementById('btn-remove-tessie-cancel').addEventListener('click', () => {
    removeOverlay.classList.add('hidden');
  });
  removeOverlay.addEventListener('click', (e) => {
    if (e.target === removeOverlay) removeOverlay.classList.add('hidden');
  });
  removeConfirmBtn.addEventListener('click', async () => {
    const wantTessie = srcTessie.checked;
    const wantTeslascope = srcTeslascope.checked;
    removeOverlay.classList.add('hidden');
    if (!loadedFilePath || (!wantTessie && !wantTeslascope)) return;
    const beforeCount = drives.length;

    // Keep the overlay through consecutive full-file rewrites and reload.
    showLoading('Removing imported drives…');
    let removed = 0;
    const failures = [];
    if (wantTessie) {
      const r = await window.electronAPI.tessieRemoveAll({ driveDataPath: loadedFilePath });
      if (r.success) removed += r.removed ?? 0;
      else failures.push(`Tessie: ${r.error}`);
    }
    if (wantTeslascope) {
      const r = await window.electronAPI.teslascopeRemoveAll({ driveDataPath: loadedFilePath });
      if (r.success) removed += r.removed ?? 0;
      else failures.push(`Teslascope: ${r.error}`);
    }
    if (failures.length === (wantTessie ? 1 : 0) + (wantTeslascope ? 1 : 0)) {
      hideLoading();
      alert(`Failed to remove imported drives:\n${failures.join('\n')}`);
      return;
    }

    await reloadDrivesAfterWrite();
    const afterCount = drives.length;
    const sourceLabel = wantTessie && wantTeslascope ? 'imported' : (wantTessie ? 'Tessie' : 'Teslascope');
    const lines = [
      `Removed ${fmt(removed)} ${sourceLabel} drive(s).`,
      '',
      `Drive count: ${fmt(beforeCount)} → ${fmt(afterCount)} (${fmt(afterCount - beforeCount)})`,
    ];
    // Overlapping native drives may make the visible delta smaller.
    if (removed > beforeCount - afterCount) {
      lines.push('', `${fmt(removed - (beforeCount - afterCount))} of them were hidden behind dashcam drives and not shown in the list.`);
    }
    for (const f of failures) lines.push('', `Cleanup failed — ${f}`);
    alert(lines.join('\n'));
  });
}

// Coalesce overlapping full parses into one shared promise plus one queued pass.
let _reloadPromise = null;
let _reloadQueued = false;

function reloadDrivesAfterWrite() {
  if (!loadedFilePath) return Promise.resolve();
  if (_reloadPromise) { _reloadQueued = true; return _reloadPromise; }
  _reloadPromise = (async () => {
    try {
      do {
        _reloadQueued = false;
        showLoading();
        try {
          const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
          if (reloaded.success) {
            // Paint the overlay before the synchronous list and map rebuild.
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            await applyLoadedDriveData(reloaded, loadedFilePath);
          }
        } finally {
          hideLoading();
        }
      } while (_reloadQueued);
    } finally {
      _reloadPromise = null;
    }
  })();
  return _reloadPromise;
}

// Imported (non-dashcam) drives from Tessie, Teslascope, and other services.
const isImportedSource = (s) => !!s && s !== 'sei';
const SOURCE_LABELS = { tessie: 'Tessie', teslascope: 'Teslascope' };

function updateTessieButtonStates() {
  const hasFile = !!loadedFilePath;
  const hasImported = drives.some((d) => isImportedSource(d.source));
  document.getElementById('btn-import-tessie').disabled = !hasFile;
  document.getElementById('btn-remove-tessie').disabled = !hasFile || !hasImported;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function updateRevertButton() {
  const btn = document.getElementById('btn-revert-gps');
  if (loadedFilePath) {
    const hasBackup = await window.electronAPI.hasGPSBackup(loadedFilePath);
    btn.disabled = !hasBackup;
  } else {
    btn.disabled = true;
  }
}

async function revertGPS() {
  if (!loadedFilePath) return;

  // Cover backup restoration and reload with the spinner.
  showLoading('Reverting to backup…');
  const result = await window.electronAPI.revertGPS(loadedFilePath);
  if (!result.success) {
    hideLoading();
    alert(`Failed to revert:\n${result.error}`);
    return;
  }

  showLoading();
  const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
  if (reloaded.success) {
    await applyLoadedDriveData(reloaded, loadedFilePath);
  }
  hideLoading();
  alert('Reverted to backup successfully.');
}

// Display Check Drives completion reports in-app.
function showCheckResult(title, message) {
  document.getElementById('check-result-title').textContent = title;
  document.getElementById('check-result-msg').textContent = message;
  document.getElementById('check-result-overlay').classList.remove('hidden');
}

async function repairGPS() {
  if (!loadedFilePath) return;

  const btn = document.getElementById('btn-repair-gps');
  btn.textContent = 'Checking…';
  btn.disabled = true;

  const progressEl = document.getElementById('repair-progress');
  const phaseEl = document.getElementById('repair-phase');
  const pctEl = document.getElementById('repair-pct');
  const barEl = document.getElementById('repair-bar');

  let removeProgressListener = null;
  try {
    // Road-snapped bridging depends on connectivity.
    const isOnline = await window.electronAPI.checkOnline();
    let useRouting = isOnline;

    if (!isOnline) {
      const proceed = confirm(
        'You are offline. Gap bridging will use straight lines instead of road-following routes.\n\n' +
        'You can re-run Check Drives later when online to replace straight lines with road routes.\n\n' +
        'Continue?'
      );
      if (!proceed) return;
    }

    progressEl.classList.remove('hidden');
    phaseEl.textContent = 'Starting…';
    pctEl.textContent = '';
    document.getElementById('repair-eta').textContent = '';
    barEl.style.width = '0%';

    const etaEl = document.getElementById('repair-eta');
    if (removeProgressListener) removeProgressListener();
    removeProgressListener = window.electronAPI.onRepairProgress(({ phase, current, total, etaSec }) => {
      phaseEl.textContent = phase;
      if (total > 0) {
        const pct = Math.round((current / total) * 100);
        pctEl.textContent = `${pct}%`;
        barEl.style.width = `${pct}%`;
        if (etaSec > 0) {
          const m = Math.floor(etaSec / 60);
          const s = etaSec % 60;
          etaEl.textContent = m > 0 ? `${m}m ${s}s left` : `${s}s left`;
        } else {
          etaEl.textContent = '';
        }
      }
    });

    btn.textContent = useRouting ? 'Routing…' : 'Checking…';

    const result = await window.electronAPI.repairGPS({ filePath: loadedFilePath, useRouting });

    if (!result.success) {
      showCheckResult('Bridge Gaps failed', result.error);
      return;
    }

    const msgs = [];
    if (result.removedBridges > 0) msgs.push(`Removed ${result.removedBridges} old bridge route(s)`);
    if (result.routedGaps > 0) msgs.push(`Bridged ${result.routedGaps} gap(s) with road routes`);
    const straightGaps = result.bridgedGaps - (result.routedGaps ?? 0);
    if (straightGaps > 0) msgs.push(`Bridged ${straightGaps} gap(s) with straight lines`);

    // Reload before deriving the bridged-drive summary.
    showLoading();
    const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
    if (reloaded.success) {
      await applyLoadedDriveData(reloaded, loadedFilePath);
    }
    hideLoading();

    const bridgedDrives = drives.filter((d) => d.bridged);
    if (result.bridgedGaps > 0 && bridgedDrives.length > 0) {
      msgs.push('');
      msgs.push(`${bridgedDrives.length} drive(s) contain bridges — marked with a "Bridged" chip in the list:`);
      const sample = bridgedDrives.slice(0, 8);
      for (const d of sample) {
        msgs.push(`  • ${new Date(d.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
      }
      if (bridgedDrives.length > sample.length) {
        msgs.push(`  • …and ${bridgedDrives.length - sample.length} more`);
      }
    }
    showCheckResult('Bridge Gaps complete', msgs.length > 0 ? msgs.join('\n') : 'No issues found.');
  } finally {
    if (removeProgressListener) removeProgressListener();
    btn.textContent = 'Check Drives';
    btn.disabled = false;
    progressEl.classList.add('hidden');
    updateRevertButton();
  }
}

// Backfill missing blinker/brake evidence on candidate parking-speed drives.
async function checkSummon() {
  if (!loadedFilePath) {
    showCheckResult('Check for Summon', 'Load a drive-data.json first — Check for Summon works on the loaded drive data.');
    return;
  }
  // A renderer-only reload may not have the matching main-process handler.
  if (typeof window.electronAPI.checkSummon !== 'function') {
    showCheckResult('Check for Summon', 'Check for Summon needs a full app restart to finish installing.\n\nQuit Sentry Drive completely and relaunch it, then run the check again.');
    return;
  }

  const clipsDir = (document.getElementById('clips-dir').value ||
    localStorage.getItem('lastClipsDir') || '').trim();
  if (!clipsDir) {
    showCheckResult('Check for Summon', 'Check for Summon needs the Clips Directory (set it on the Process tab) so the original clips can be re-read.');
    return;
  }

  const btn = document.getElementById('btn-repair-gps');
  btn.textContent = 'Checking…';
  btn.disabled = true;

  const progressEl = document.getElementById('repair-progress');
  const phaseEl = document.getElementById('repair-phase');
  const pctEl = document.getElementById('repair-pct');
  const barEl = document.getElementById('repair-bar');
  const etaEl = document.getElementById('repair-eta');

  let removeProgressListener = null;
  try {
    progressEl.classList.remove('hidden');
    phaseEl.textContent = 'Starting…';
    pctEl.textContent = '';
    etaEl.textContent = '';
    barEl.style.width = '0%';

    removeProgressListener = window.electronAPI.onRepairProgress(({ phase, current, total, etaSec }) => {
      phaseEl.textContent = phase;
      if (total > 0) {
        const pct = Math.round((current / total) * 100);
        pctEl.textContent = `${pct}%`;
        barEl.style.width = `${pct}%`;
        if (etaSec > 0) {
          const m = Math.floor(etaSec / 60);
          const s = etaSec % 60;
          etaEl.textContent = m > 0 ? `${m}m ${s}s left` : `${s}s left`;
        } else {
          etaEl.textContent = '';
        }
      }
    });

    const result = await window.electronAPI.checkSummon({ filePath: loadedFilePath, clipsDir });
    if (!result.success) {
      showCheckResult('Check for Summon failed', result.error);
      return;
    }

    const summonBefore = drives.filter((d) => d.summon).length;
    let summonTotal = null;
    if (result.updatedRoutes > 0) {
      showLoading();
      const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
      if (reloaded.success) {
        await applyLoadedDriveData(reloaded, loadedFilePath);
        summonTotal = reloaded.aggregates?.summonDriveCount ?? null;
      }
      hideLoading();
    }

    const msgs = [];
    msgs.push(`Checked ${result.candidateDrives} candidate drive(s), read ${result.clipsScanned} clip(s).`);
    if (result.missingClips > 0) {
      msgs.push(`${result.missingClips} clip(s) were missing from the clips directory (moved or deleted) and were skipped.`);
    }
    const summonDrives = drives.filter((d) => d.summon);
    const summonCount = summonTotal ?? summonDrives.length;
    if (result.updatedRoutes === 0) {
      msgs.push('No drives needed new evidence — anything detectable was already tagged.');
    } else if (summonCount > 0) {
      msgs.push('');
      msgs.push(`${summonCount} drive(s) carry the Summon tag${summonCount > summonBefore ? ` (${summonCount - summonBefore} new)` : ''}:`);
      const sample = summonDrives.slice(0, 8);
      for (const d of sample) {
        msgs.push(`  • ${new Date(d.startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
      }
      if (summonCount > sample.length) {
        msgs.push(`  • …and ${summonCount - sample.length} more`);
      }
    } else {
      msgs.push('Evidence was added, but none of the candidates matched a summon signature (hazard bookends or Self Driving, with no pedal input).');
    }
    showCheckResult('Check for Summon complete', msgs.join('\n'));
  } catch (err) {
    // Surface failures that would otherwise appear as a no-op.
    showCheckResult('Check for Summon failed', String(err?.message ?? err));
  } finally {
    if (removeProgressListener) removeProgressListener();
    btn.textContent = 'Check Drives';
    btn.disabled = false;
    progressEl.classList.add('hidden');
    updateRevertButton();
  }
}

async function loadDrives() {
  const lastPath = localStorage.getItem('lastDriveDataPath');
  const filePath = await window.electronAPI.selectFile({
    filters: [{ name: 'JSON', extensions: ['json'] }],
    defaultPath: lastPath || undefined,
  });
  if (!filePath) return;

  const btn = document.getElementById('btn-load-drives');
  btn.textContent = 'Loading…';
  btn.disabled = true;
  showLoading();

  try {
    const result = await window.electronAPI.loadAndGroupDrives(filePath);

    if (!result.success) {
      alert(`Failed to load drives:\n${result.error}`);
      return;
    }

    await applyLoadedDriveData(result, filePath);
  } finally {
    btn.textContent = 'Load Drives';
    btn.disabled = false;
    hideLoading();
  }
}

function refreshUnitDisplay() {
  if (!drives.length) return;
  renderDriveList(drives);
  if (selectedDriveId !== null) {
    const d = drives.find((x) => x.id === selectedDriveId);
    if (d) {
      // Avoid flashing aggregate stats while refreshing a selected drive.
      renderSelectedDriveStats(d);
    }
  } else if (lastDrivesMeta) {
    renderDriveStats(drives, lastDrivesMeta);
  }
}

function buildDriveTagsHtml(drive) {
  const tags = drive.tags ?? [];
  let html = `<div class="info-tags-list" id="info-tags-list">`;
  for (const t of tags) {
    html += `<span class="tag-pill tag-removable" data-tag="${escapeHtml(t)}">${escapeHtml(t)}<button class="tag-remove" data-tag="${escapeHtml(t)}">&times;</button></span>`;
  }
  html += `<button class="tag-add-btn" id="btn-add-tag" title="Add tag">+</button>`;
  html += `</div>`;
  html += `<div class="tag-input-row hidden" id="tag-input-row">`;
  html += `<input type="text" class="tag-input" id="tag-input" placeholder="New tag…" />`;
  html += `<div class="tag-suggestions hidden" id="tag-suggestions"></div>`;
  html += `</div>`;
  return html;
}

function wireDriveTagInteractions(root, drive) {
  root.querySelectorAll('.tag-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(drive, btn.dataset.tag);
    });
  });
  const addBtn = root.querySelector('#btn-add-tag');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = root.querySelector('#tag-input-row');
      const opened = !row.classList.toggle('hidden');
      if (opened) {
        root.querySelector('#tag-input').focus();
        showTagSuggestions(drive, '');
      } else {
        const sug = root.querySelector('#tag-suggestions');
        if (sug) { sug.classList.add('hidden'); sug.innerHTML = ''; }
      }
    });
  }
  const tagInput = root.querySelector('#tag-input');
  if (tagInput) {
    tagInput.addEventListener('input', () => showTagSuggestions(drive, tagInput.value));
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = tagInput.value.trim();
        if (val) addTag(drive, val);
      } else if (e.key === 'Escape') {
        root.querySelector('#tag-input-row').classList.add('hidden');
      }
    });
  }
}

// Refresh the open panel's tag editor independently from list cards.
function refreshSelectedDriveTags(drive) {
  const panel = document.getElementById('map-stats');
  const tagsEl = panel && panel.querySelector('.map-stats-tags');
  if (!tagsEl) return;
  tagsEl.innerHTML = buildDriveTagsHtml(drive);
  wireDriveTagInteractions(panel, drive);
}

function renderSelectedDriveStats(drive) {
  const isTessie = isImportedSource(drive.source);
  const totalMi = drive.distanceMi ?? 0;
  const totalMs = drive.durationMs ?? 0;
  const totalHrs = Math.floor(totalMs / 3_600_000);
  const totalMin = Math.floor((totalMs % 3_600_000) / 60_000);
  const durStr = totalHrs > 0 ? `${totalHrs}H ${totalMin}M` : `${totalMin}M`;

  const totalDistM = (drive.distanceKm ?? (drive.distanceMi ?? 0) * MI_TO_KM) * 1000;
  const fsdDistM = (drive.fsdDistanceKm ?? (drive.fsdDistanceMi ?? 0) * MI_TO_KM) * 1000;
  const apDistM = (drive.autosteerDistanceKm ?? (drive.autosteerDistanceMi ?? 0) * MI_TO_KM) * 1000;
  const taccDistM = (drive.taccDistanceKm ?? (drive.taccDistanceMi ?? 0) * MI_TO_KM) * 1000;
  const fsdPct   = Math.round(drive.fsdPercent        ?? (totalDistM > 0 ? (fsdDistM  / totalDistM) * 100 : 0));
  const fsdScore = floorPct1(drive.fsdPercent         ?? (totalDistM > 0 ? (fsdDistM  / totalDistM) * 100 : 0));
  const apPct    = Math.round(drive.autosteerPercent  ?? (totalDistM > 0 ? (apDistM   / totalDistM) * 100 : 0));
  const taccPct  = Math.round(drive.taccPercent       ?? (totalDistM > 0 ? (taccDistM / totalDistM) * 100 : 0));
  const manualDistM = Math.max(0, totalDistM - fsdDistM - apDistM - taccDistM);
  const manualPct = Math.max(0, 100 - fsdPct - apPct - taccPct);

  const disengagements = drive.fsdDisengagements ?? 0;
  const accelOverrides = drive.fsdAccelPushes ?? 0;
  const fsdTimeMs = drive.fsdEngagedMs ?? 0;

  const metersToDistStr = (m) => fmt(distVal(m / M_PER_MILE, 0));

  let summary = `
    <div class="map-stat"><span class="map-stat-val">${fmt(distVal(totalMi, 1))}</span><span class="map-stat-lbl">${distLong()}</span></div>
    <div class="map-stat"><span class="map-stat-val">${durStr}</span><span class="map-stat-lbl">Duration</span></div>
    <div class="map-stat"><span class="map-stat-val">${speedVal(drive.avgSpeedMph ?? 0)}</span><span class="map-stat-lbl">Avg ${speedShort().toUpperCase()}</span></div>
    <div class="map-stat"><span class="map-stat-val">${speedVal(drive.maxSpeedMph ?? 0)}</span><span class="map-stat-lbl">Max ${speedShort().toUpperCase()}</span></div>
    ${drive.summon
      ? `<div class="map-stat"><span class="map-stat-val" style="color:var(--text-dim)">N/A<span class="map-stat-info material-icons" tabindex="0" role="img" aria-label="Summon does not affect your FSD stats." title="Summon does not affect your FSD stats.">info</span></span><span class="map-stat-lbl">FSD Usage</span></div>`
      : `<div class="map-stat"><span class="map-stat-val" style="color:${fsdScoreColor(fsdScore)}">${fsdScore}%</span><span class="map-stat-lbl">${isTessie ? 'FSD*' : 'FSD Usage'}</span></div>`}
  `;
  if (apPct > 0 && !isTessie) {
    summary += `<div class="map-stat"><span class="map-stat-val">${apPct}%</span><span class="map-stat-lbl">Autopilot</span></div>`;
  }

  const detailsRow = (label, cls, miles, pct) => `
    <div class="map-stats-row">
      <span class="map-stats-row-label ${cls}">${label}</span>
      <span class="map-stats-row-dist">${miles} ${distShort()}</span>
      <span class="map-stats-row-pct">${pct}%</span>
    </div>
  `;

  // Summon is driverless start to finish, so present it as one mode rather
  // than as whatever the firmware reported in autopilot_state.
  const isSummon = !!drive.summon;
  const slices = [];
  if (isSummon) {
    slices.push({ color: 'var(--line-summon, #facc15)', pct: 100 });
  } else {
    if (fsdDistM > 0)    slices.push({ color: 'var(--line-fsd, #22cc55)',   pct: (fsdDistM / totalDistM) * 100 });
    if (apDistM > 0)     slices.push({ color: 'var(--ap-blue, #3e6ae1)', pct: (apDistM / totalDistM) * 100 });
    if (taccDistM > 0)   slices.push({ color: '#f59e0b',                    pct: (taccDistM / totalDistM) * 100 });
    if (manualDistM > 0) slices.push({ color: 'rgba(148, 163, 184, 0.55)',  pct: (manualDistM / totalDistM) * 100 });
  }

  let cursor = 0;
  const gradientStops = slices.map((s) => {
    const start = cursor;
    cursor += s.pct;
    return `${s.color} ${start}% ${cursor}%`;
  }).join(', ');

  let details = '<div class="map-stats-details-title">Drive Breakdown</div>';
  if (isTessie && slices.length === 0) {
    details += `
      <div class="map-stats-tessie-note" style="margin-top:0;padding:10px 0;">
        Imported from Tessie. No per-point self-driving data available for
        this drive. Excluded from aggregate FSD statistics.
      </div>
    `;
  } else if (isTessie) {
    details += `
      <div class="map-stats-chart-wrap">
        <div class="map-stats-chart" style="--donut-bg: conic-gradient(${gradientStops});">
          <div class="map-stats-chart-center">
            <span class="map-stats-chart-val" style="color:${fsdScoreColor(fsdScore)}">${fsdScoreLabel(fsdScore)}</span>
            <span class="map-stats-chart-lbl" style="color:${fsdScoreColor(fsdScore)}">${fsdScore}%</span>
          </div>
        </div>
        <div class="map-stats-legend">
          ${fsdDistM > 0    ? detailsRow('Full Self-Driving', 'mode-fsd',    metersToDistStr(fsdDistM),    fsdScore)    : ''}
          ${manualDistM > 0 ? detailsRow('Manual',            'mode-manual', metersToDistStr(manualDistM), manualPct) : ''}
        </div>
      </div>
      <div class="map-stats-tessie-note">
        *Imported from Tessie. Excluded from aggregate FSD score and
        disengagement counts (those use dashcam telemetry only).
      </div>
    `;
  } else if (isSummon) {
    details += `
      <div class="map-stats-chart-wrap">
        <div class="map-stats-chart" style="--donut-bg: conic-gradient(${gradientStops});">
          <div class="map-stats-chart-center">
            <span class="map-stats-chart-val" style="color:var(--line-summon, #facc15)">Summon</span>
            <span class="map-stats-chart-lbl" style="color:var(--text-dim)">N/A</span>
          </div>
        </div>
        <div class="map-stats-legend">
          ${detailsRow('Summon', 'mode-summon', metersToDistStr(totalDistM), 100)}
        </div>
      </div>
    `;
  } else if (slices.length > 0) {
    details += `
      <div class="map-stats-chart-wrap">
        <div class="map-stats-chart" style="--donut-bg: conic-gradient(${gradientStops});">
          <div class="map-stats-chart-center">
            <span class="map-stats-chart-val" style="color:${fsdScoreColor(fsdScore)}">${fsdScoreLabel(fsdScore)}</span>
            <span class="map-stats-chart-lbl" style="color:${fsdScoreColor(fsdScore)}">${fsdScore}%</span>
          </div>
        </div>
        <div class="map-stats-legend">
          ${fsdDistM > 0    ? detailsRow('Full Self-Driving', 'mode-fsd',    metersToDistStr(fsdDistM),    fsdScore)    : ''}
          ${apDistM > 0     ? detailsRow('Autopilot',         'mode-ap',     metersToDistStr(apDistM),     apPct)     : ''}
          ${taccDistM > 0   ? detailsRow('TACC',              'mode-tacc',   metersToDistStr(taccDistM),   taccPct)   : ''}
          ${manualDistM > 0 ? detailsRow('Manual',            'mode-manual', metersToDistStr(manualDistM), manualPct) : ''}
          ${fsdTimeMs > 0 ? `
          <hr class="map-stats-legend-divider">
          <div class="map-stats-legend-stat">
            <span class="map-stats-extra-val">${formatDuration(fsdTimeMs)}</span>
            <span class="map-stats-extra-lbl">Time with FSD</span>
          </div>` : ''}
        </div>
      </div>
    `;
  }
  if (!isTessie && (disengagements > 0 || accelOverrides > 0)) {
    details += `
      <div class="map-stats-extras">
        <div><span class="map-stats-extra-val">${fmt(disengagements)}</span><span class="map-stats-extra-lbl">Disengagements</span></div>
        <div><span class="map-stats-extra-val">${fmt(accelOverrides)}</span><span class="map-stats-extra-lbl">Accelerator Overrides</span></div>
      </div>
    `;
  }

  const telemetrySections = window.driveTelemetryView
    ?.buildDriveTelemetrySections(drive, unitSystem) ?? [];
  for (const section of telemetrySections) {
    details += `
      <section class="drive-telemetry-section">
        <div class="map-stats-details-title">${section.title}</div>
        <div class="drive-telemetry-grid">
          ${section.items.map((item) => `
            <div class="drive-telemetry-stat">
              <span class="map-stats-extra-val">${item.value}</span>
              <span class="map-stats-extra-lbl">${item.label}</span>
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }

  const date   = drive.startTime.slice(0, 10);
  const startT = drive.startTime.slice(11, 16);
  const endT   = drive.endTime.slice(11, 16);

  const header = `
    <div class="map-stats-header">
      <div class="map-stats-header-when">
        <span class="map-stats-date">${date}</span>
        <span class="map-stats-time">${startT} – ${endT}</span>
      </div>
      <div class="map-stats-tags">${buildDriveTagsHtml(drive)}</div>
    </div>
  `;

  const panel = document.getElementById('map-stats');
  panel.innerHTML = `
    ${header}
    <div class="map-stats-summary">${summary}<span class="map-stats-chevron material-icons">expand_less</span></div>
    <div class="map-stats-details">${details}</div>
  `;
  panel.classList.remove('hidden');
  panel.classList.remove('expanded');

  wireDriveTagInteractions(panel, drive);
}

// Floor display scores to one decimal; keep integer shares for donut totals.
const floorPct1 = (p) => Math.floor((Number(p) || 0) * 10) / 10;

function fsdScoreColor(pct) {
  const hue = Math.max(0, Math.min(120, (pct / 100) * 120));
  return `hsl(${hue}, 70%, 55%)`;
}

function fsdScoreLabel(pct) {
  if (pct >= 90) return 'Great';
  if (pct >= 70) return 'Good';
  if (pct >= 40) return 'Okay';
  return 'Bad';
}

async function populateUpdateModalChanges(version) {
  const box = document.getElementById('update-modal-changes');
  box.innerHTML = '';
  box.classList.add('hidden');
  try {
    const remote = await window.electronAPI.fetchRemoteChangelog();
    if (!remote?.success) return;
    const entry = (remote.versions ?? []).find((v) => v.version === version);
    if (!entry) return;
    box.innerHTML = renderChangelogEntry(entry);
    box.classList.remove('hidden');
  } catch {
    /* Changelog details are optional. */
  }
}

function renderDriveStats(drives, meta) {
  lastDrivesMeta = meta;
  // Totals include imports; FSD analytics use SEI-only data and exclude Summon.
  const seiDrives = drives.filter((d) => !isImportedSource(d.source) && !d.summon);
  const aggregate = meta?.aggregates;
  const driveCount = aggregate?.totalDriveCount ?? drives.length;
  const seiDriveCount = aggregate?.seiDriveCount ?? seiDrives.length;
  const tessieCount = aggregate?.importedDriveCount ?? (drives.length - seiDrives.length);

  const totalMi = aggregate?.totalDistanceMi ?? drives.reduce((s, d) => s + d.distanceMi, 0);
  const totalMs = aggregate?.totalDurationMs ?? drives.reduce((s, d) => s + d.durationMs, 0);
  const totalDays = Math.floor(totalMs / 86_400_000);
  const totalHrs = Math.floor((totalMs % 86_400_000) / 3_600_000);
  const totalMin = Math.floor((totalMs % 3_600_000) / 60_000);
  const durStr = totalDays > 0
    ? `${totalDays}D ${totalHrs}H ${totalMin}M`
    : (totalHrs > 0 ? `${totalHrs}H ${totalMin}M` : `${totalMin}M`);

  // FSD analytics use SEI-only distance.
  const seiDistM = aggregate?.seiDistanceM ?? seiDrives.reduce((s, d) => s + (d.distanceKm ?? d.distanceMi * MI_TO_KM) * 1000, 0);
  const fsdDistM = aggregate?.fsdDistanceM ?? seiDrives.reduce((s, d) => s + (d.fsdDistanceKm ?? d.fsdDistanceMi * MI_TO_KM) * 1000, 0);
  const apDistM = aggregate?.autosteerDistanceM ?? seiDrives.reduce((s, d) => s + (d.autosteerDistanceKm ?? (d.autosteerDistanceMi ?? 0) * MI_TO_KM) * 1000, 0);
  const taccDistM = aggregate?.taccDistanceM ?? seiDrives.reduce((s, d) => s + (d.taccDistanceKm ?? (d.taccDistanceMi ?? 0) * MI_TO_KM) * 1000, 0);
  const fsdPct = seiDistM > 0 ? Math.round((fsdDistM / seiDistM) * 100) : 0;
  const fsdScore = seiDistM > 0 ? floorPct1((fsdDistM / seiDistM) * 100) : 0;
  const apPct = seiDistM > 0 ? Math.round((apDistM / seiDistM) * 100) : 0;
  const taccPct = seiDistM > 0 ? Math.round((taccDistM / seiDistM) * 100) : 0;
  const manualDistM = Math.max(0, seiDistM - fsdDistM - apDistM - taccDistM);
  const manualPct = Math.max(0, 100 - fsdPct - apPct - taccPct);

  const totalDistM = seiDistM;

  const disengagements = aggregate?.fsdDisengagements ?? seiDrives.reduce((s, d) => s + (d.fsdDisengagements ?? 0), 0);
  const accelOverrides = aggregate?.fsdAccelPushes ?? seiDrives.reduce((s, d) => s + (d.fsdAccelPushes ?? 0), 0);
  const fsdTimeMs = aggregate?.fsdEngagedMs ?? seiDrives.reduce((s, d) => s + (d.fsdEngagedMs ?? 0), 0);
  const avgDisengagements = seiDriveCount > 0 ? (disengagements / seiDriveCount).toFixed(1) : '—';
  const avgAccelOverrides = seiDriveCount > 0 ? (accelOverrides / seiDriveCount).toFixed(1) : '—';

  const metersToDistStr = (m) => fmt(distVal(m / M_PER_MILE, 0));

  let summary = `
    <div class="map-stat"><span class="map-stat-val">${fmt(driveCount)}</span><span class="map-stat-lbl">Drives</span></div>
    <div class="map-stat"><span class="map-stat-val">${fmt(distVal(totalMi, 0))}</span><span class="map-stat-lbl">${distLong()} Driven</span></div>
    <div class="map-stat"><span class="map-stat-val">${durStr}</span><span class="map-stat-lbl">Time Driving</span></div>
    <div class="map-stat"><span class="map-stat-val" style="color:${seiDistM > 0 ? fsdScoreColor(fsdScore) : 'var(--text-dim)'}">${seiDistM > 0 ? `${fsdScore}%` : '—'}</span><span class="map-stat-lbl">FSD Score</span></div>
  `;
  if (apPct > 0) summary += `<div class="map-stat"><span class="map-stat-val">${apPct}%</span><span class="map-stat-lbl">Autopilot</span></div>`;

  const detailsRow = (label, cls, miles, pct) => `
    <div class="map-stats-row">
      <span class="map-stats-row-label ${cls}">${label}</span>
      <span class="map-stats-row-dist">${miles} ${distShort()}</span>
      <span class="map-stats-row-pct">${pct}%</span>
    </div>
  `;

  // Build cumulative conic-gradient stops from exact shares.
  const slices = [];
  if (fsdDistM > 0)    slices.push({ color: 'var(--line-fsd, #22cc55)',   pct: (fsdDistM / totalDistM) * 100 });
  if (apDistM > 0)     slices.push({ color: 'var(--ap-blue, #3e6ae1)', pct: (apDistM / totalDistM) * 100 });
  if (taccDistM > 0)   slices.push({ color: '#f59e0b',                    pct: (taccDistM / totalDistM) * 100 });
  if (manualDistM > 0) slices.push({ color: 'rgba(148, 163, 184, 0.55)',  pct: (manualDistM / totalDistM) * 100 });

  let cursor = 0;
  const gradientStops = slices.map((s) => {
    const start = cursor;
    cursor += s.pct;
    return `${s.color} ${start}% ${cursor}%`;
  }).join(', ');

  let details = '<div class="map-stats-section-header">Self Driving Analytics</div>';
  if (slices.length > 0) {
    details += `
      <div class="map-stats-chart-wrap">
        <div class="map-stats-chart" style="--donut-bg: conic-gradient(${gradientStops});">
          <div class="map-stats-chart-center">
            <span class="map-stats-chart-val" style="color:${fsdScoreColor(fsdScore)}">${fsdScoreLabel(fsdScore)}</span>
            <span class="map-stats-chart-lbl" style="color:${fsdScoreColor(fsdScore)}">${fsdScore}%</span>
          </div>
        </div>
        <div class="map-stats-legend">
          ${fsdDistM > 0    ? detailsRow('Full Self-Driving', 'mode-fsd',    metersToDistStr(fsdDistM),    fsdScore)    : ''}
          ${apDistM > 0     ? detailsRow('Autopilot',         'mode-ap',     metersToDistStr(apDistM),     apPct)     : ''}
          ${taccDistM > 0   ? detailsRow('TACC',              'mode-tacc',   metersToDistStr(taccDistM),   taccPct)   : ''}
          ${manualDistM > 0 ? detailsRow('Manual',            'mode-manual', metersToDistStr(manualDistM), manualPct) : ''}
          <hr class="map-stats-legend-divider">
          <div class="map-stats-legend-stats-row">
            <div class="map-stats-legend-stat">
              <span class="map-stats-extra-val">${formatDuration(fsdTimeMs)}</span>
              <span class="map-stats-extra-lbl">Time with FSD</span>
            </div>
            <div class="map-stats-legend-stat">
              <span class="map-stats-extra-val">${avgDisengagements}</span>
              <span class="map-stats-extra-lbl">Avg Disengagements</span>
            </div>
            <div class="map-stats-legend-stat">
              <span class="map-stats-extra-val">${avgAccelOverrides}</span>
              <span class="map-stats-extra-lbl">Avg Overrides</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  const avgFsdPct = seiDriveCount > 0
    ? floorPct1((aggregate?.fsdPercentSum ?? seiDrives.reduce((s, d) => s + (d.fsdPercent ?? 0), 0)) / seiDriveCount)
    : 0;
  if (disengagements > 0 || accelOverrides > 0) {
    details += `
      <div class="map-stats-extras">
        <div><span class="map-stats-extra-val">${fmt(disengagements)}</span><span class="map-stats-extra-lbl">Disengagements</span></div>
        <div><span class="map-stats-extra-val">${fmt(accelOverrides)}</span><span class="map-stats-extra-lbl">Accelerator Overrides</span></div>
        <div><span class="map-stats-extra-val">${avgFsdPct}%</span><span class="map-stats-extra-lbl">Avg FSD Usage</span></div>
      </div>
    `;
  }

  if (tessieCount > 0) {
    details += `<div class="map-stats-tessie-note">${fmt(tessieCount)} of these are imported drive${tessieCount === 1 ? '' : 's'} (counted in totals; FSD analytics are dashcam-only)</div>`;
  }
  const summonCount = aggregate?.summonDriveCount ?? drives.filter((d) => d.summon).length;
  if (summonCount > 0) {
    details += `<div class="map-stats-tessie-note">${fmt(summonCount)} Summon drive${summonCount === 1 ? '' : 's'} (counted in totals; excluded from FSD analytics)</div>`;
  }

  const panel = document.getElementById('map-stats');
  panel.innerHTML = `
    <div class="map-stats-summary">${summary}<span class="map-stats-chevron material-icons">expand_less</span></div>
    <div class="map-stats-details">${details}</div>
  `;
  panel.classList.remove('hidden');
}

// A sequence number prevents overlapping chunked renders from interleaving.
let _driveListRenderSeq = 0;

// Yield between large card batches; small lists remain synchronous.
// ─── Privacy zones ───────────────────────────────────────────────────────────
// Keep zone coordinates in localStorage, never exported drive-data.json.
const ZONE_ICONS = { home: 'home', work: 'work', custom: 'place' };
// Curated Material Symbols that remain legible at 15px.
const ZONE_ICON_CHOICES = [
  'home', 'work', 'place', 'school', 'fitness_center', 'restaurant',
  'local_cafe', 'shopping_cart', 'storefront', 'local_hospital', 'church',
  'park', 'sports_soccer', 'apartment', 'factory', 'star', 'favorite',
  'pets', 'directions_car', 'flight',
];
const M_PER_FT = 0.3048;

function zoneIcon(zone) {
  return zone.icon ?? ZONE_ICONS[zone.kind] ?? 'place';
}
let privacyZones = loadPrivacyZones();
let privacyZonesVisible = false;
// Editing overrides the permanent-landmark preference.
let showZoneMarkers = localStorage.getItem('showZoneMarkers') !== 'false';
const zoneMarkers = [];
// Placement stages: aim, drag radius, then confirm.
let zonePlacement = null;
// Shared queue for multi-select and privacy-zone removals.
let pendingBulkRemove = null;

function loadPrivacyZones() {
  let zones = [];
  try {
    const saved = JSON.parse(localStorage.getItem('privacyZones') || '[]');
    if (Array.isArray(saved)) {
      zones = saved.filter((z) => z && z.id && z.kind && typeof z.radiusM === 'number');
    }
  } catch { /* Invalid settings start clean. */ }
  // Ligature names enter innerHTML and must pass the allowlist.
  for (const z of zones) {
    if (typeof z.icon !== 'string' || !/^[a-z0-9_]{1,40}$/.test(z.icon)) delete z.icon;
  }
  for (const kind of ['home', 'work']) {
    if (!zones.some((z) => z.kind === kind)) {
      zones.push({ id: kind, kind, name: kind === 'home' ? 'Home' : 'Work', lat: null, lng: null, radiusM: 150 });
    }
  }
  const rank = (z) => (z.kind === 'home' ? 0 : z.kind === 'work' ? 1 : 2);
  zones.sort((a, b) => rank(a) - rank(b));
  return zones;
}

function savePrivacyZones() {
  localStorage.setItem('privacyZones', JSON.stringify(privacyZones));
  syncKnownPlaceZones();
}

function syncKnownPlaceZones() {
  const zones = privacyZones
    .filter((z) => Number.isFinite(z.lat) && Number.isFinite(z.lng) && z.name)
    .map((z) => ({ id: z.id, label: z.name, lat: z.lat, lng: z.lng, radiusM: z.radiusM }));
  Promise.resolve(window.electronAPI?.syncKnownPlaceZones?.({ zones })).catch(() => {});
}

function openBulkRemoveModal(targets, msg) {
  if (!targets.length) return;
  pendingBulkRemove = targets;
  document.getElementById('remove-drives-modal-msg').textContent = msg;
  document.getElementById('remove-drives-overlay').classList.remove('hidden');
}

// Approximate the circle as a 64-gon.
function zoneCircleFeature(z) {
  const latR = z.radiusM / 111320;
  const lngR = z.radiusM / (111320 * Math.max(0.2, Math.cos((z.lat * Math.PI) / 180)));
  const ring = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    ring.push([z.lng + lngR * Math.sin(t), z.lat + latR * Math.cos(t)]);
  }
  return { type: 'Feature', properties: { zoneId: z.id }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function setPrivacyZonesVisible(v) {
  privacyZonesVisible = v;
  updatePrivacyZoneLayer();
}

function makeZoneMarkerEl(zone) {
  const el = document.createElement('div');
  el.className = 'zone-marker';
  el.innerHTML = `<span class="material-icons">${zoneIcon(zone)}</span>`;
  return el;
}

function updatePrivacyZoneLayer() {
  whenMapReady(() => {
    for (const m of zoneMarkers) m.remove();
    zoneMarkers.length = 0;
    const zones = privacyZones.filter((z) => z.lat != null && z !== zonePlacement?.zone);
    // Dashed circles appear only during privacy editing.
    map.getSource('privacy-zones').setData({
      type: 'FeatureCollection',
      features: privacyZonesVisible ? zones.map(zoneCircleFeature) : [],
    });
    // Charging mode hides landmarks unless an active privacy editor needs them.
    const chargingOwnsMap = activeMainTab === 'charging';
    if ((showZoneMarkers && !chargingOwnsMap) || privacyZonesVisible) {
      for (const z of zones) {
        zoneMarkers.push(new maplibregl.Marker({ element: makeZoneMarkerEl(z), anchor: 'center' })
          .setLngLat([z.lng, z.lat])
          .addTo(map));
      }
    }
  });
}

function renderPrivacyZones() {
  const listEl = document.getElementById('privacy-zones-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const imperial = unitSystem === 'imperial';
  const unitLbl = imperial ? 'ft' : 'm';
  for (const z of privacyZones) {
    const set = z.lat != null && z.lng != null;
    const radiusDisplay = imperial ? Math.round(z.radiusM / M_PER_FT) : Math.round(z.radiusM);
    const row = document.createElement('div');
    row.className = 'zone-row';
    row.innerHTML = `
      <div class="zone-row-main">
        <button class="zone-icon-btn" type="button" title="Change icon"><span class="material-icons">${zoneIcon(z)}</span></button>
        ${z.kind === 'custom'
          ? `<input class="zone-name-input" type="text" maxlength="24" value="${escapeHtml(z.name)}" />`
          : `<span class="zone-name">${escapeHtml(z.name)}</span>`}
        <span class="zone-coords">${set ? `${z.lat.toFixed(5)}, ${z.lng.toFixed(5)}` : 'Not set'}</span>
      </div>
      <div class="zone-row-actions">
        ${set ? `<span class="zone-radius-text">Radius ${radiusDisplay} ${unitLbl}</span>` : ''}
        <button class="zone-btn zone-set" type="button">${set ? 'Edit on map' : 'Set on map'}</button>
        <button class="zone-btn zone-cull" type="button" ${set ? '' : 'disabled'}>Cull drives</button>
        <button class="zone-btn zone-remove" type="button" title="${z.kind === 'custom' ? 'Delete zone' : 'Clear location'}">
          <span class="material-icons">${z.kind === 'custom' ? 'delete' : 'backspace'}</span>
        </button>
      </div>`;

    const nameInput = row.querySelector('.zone-name-input');
    if (nameInput) {
      nameInput.addEventListener('change', () => {
        z.name = nameInput.value.trim() || 'Custom location';
        nameInput.value = z.name;
        savePrivacyZones();
      });
    }
    row.querySelector('.zone-icon-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openZoneIconPicker(e.currentTarget, z);
    });
    row.querySelector('.zone-set').addEventListener('click', () => beginZoneMapPick(z));
    row.querySelector('.zone-cull').addEventListener('click', () => cullZoneDrives(z));
    row.querySelector('.zone-remove').addEventListener('click', () => {
      if (z.kind === 'custom') privacyZones = privacyZones.filter((x) => x.id !== z.id);
      else { z.lat = null; z.lng = null; }
      savePrivacyZones();
      renderPrivacyZones();
      updatePrivacyZoneLayer();
    });
    listEl.appendChild(row);
  }
}

function zoneRadiusLabel(radiusM) {
  return unitSystem === 'imperial' ? `${Math.round(radiusM / M_PER_FT)} ft` : `${Math.round(radiusM)} m`;
}

// Shared Material Symbols picker for settings rows and map markers.
let zoneIconPickerTarget = null;

function openZoneIconPicker(anchor, zone) {
  const popup = document.getElementById('zone-icon-popup');
  if (!popup.classList.contains('hidden') && zoneIconPickerTarget === zone) {
    closeZoneIconPicker();
    return;
  }
  zoneIconPickerTarget = zone;
  popup.querySelectorAll('.zone-icon-choice').forEach((b) => {
    b.classList.toggle('active', b.dataset.icon === zoneIcon(zone));
  });
  const rect = anchor.getBoundingClientRect();
  popup.style.top = `${rect.bottom + 6}px`;
  popup.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
  popup.classList.remove('hidden');
}

function closeZoneIconPicker() {
  document.getElementById('zone-icon-popup').classList.add('hidden');
  zoneIconPickerTarget = null;
}

function setPickHint(text, confirm) {
  const hint = document.getElementById('map-pick-hint');
  document.getElementById('map-pick-hint-text').textContent = text;
  document.getElementById('map-pick-actions').classList.toggle('hidden', !confirm);
  hint.classList.toggle('confirm', confirm);
  hint.classList.remove('hidden');
}

// Map placement supports pan while aiming, then center and radius adjustment.
function beginZoneMapPick(zone) {
  document.getElementById('settings-overlay').classList.add('hidden');
  const isSet = zone.lat != null && zone.lng != null;
  zonePlacement = {
    zone,
    stage: isSet ? 'confirm' : 'aim',
    center: isSet ? { lat: zone.lat, lng: zone.lng } : null,
    radiusM: Math.max(10, zone.radiusM),
    marker: null,
    ringDrag: false,
  };
  setPrivacyZonesVisible(true);
  whenMapReady(() => {
    if (isSet) {
      // Fit the zone before enabling its move and resize handles.
      const latPad = (zone.radiusM * 1.8) / 111320;
      const lngPad = (zone.radiusM * 1.8) / (111320 * Math.max(0.2, Math.cos((zone.lat * Math.PI) / 180)));
      map.fitBounds(
        [[zone.lng - lngPad, zone.lat - latPad], [zone.lng + lngPad, zone.lat + latPad]],
        { duration: 500 },
      );
      zonePlacementPreview();
      enterZoneConfirm();
    } else {
      map.getCanvas().style.cursor = 'crosshair';
      setPickHint(`Click to place "${zone.name}" — drag to pan the map. Esc to cancel`, false);
    }
  });
}

// Eastern edge point for measuring the ring in screen pixels.
function zoneEdgeLngLat(center, radiusM) {
  const lngR = radiusM / (111320 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  return [center.lng + lngR, center.lat];
}

// Test the ring against a screen-pixel grab tolerance.
function zoneNearRing(e) {
  const p = zonePlacement;
  if (!p?.center) return false;
  const c = map.project([p.center.lng, p.center.lat]);
  const edge = map.project(zoneEdgeLngLat(p.center, p.radiusM));
  const radiusPx = Math.hypot(edge.x - c.x, edge.y - c.y);
  const distPx = Math.hypot(e.point.x - c.x, e.point.y - c.y);
  return Math.abs(distPx - radiusPx) <= 8;
}

function zoneConfirmHint() {
  const p = zonePlacement;
  if (!p) return;
  setPickHint(`"${p.zone.name}" — Radius ${zoneRadiusLabel(p.radiusM)}. Drag the pin to move it, or drag the circle's edge to resize.`, true);
}

// Confirm stage: drag the center or the radius ring.
function enterZoneConfirm() {
  const p = zonePlacement;
  if (!p || !p.center) return;
  p.stage = 'confirm';
  map.getCanvas().style.cursor = '';

  if (!p.marker) zonePlacementPreview();
  p.marker.getElement().classList.add('zone-marker--live');
  p.marker.setDraggable(true);
  p.marker.on('drag', () => {
    const ll = p.marker.getLngLat();
    p.center = { lat: ll.lat, lng: ll.lng };
    zonePlacementPreview();
  });

  zoneConfirmHint();
}

// Redraw the staged circle and center marker.
function zonePlacementPreview() {
  const p = zonePlacement;
  if (!p || !mapReady || !p.center) return;
  const others = privacyZones
    .filter((z) => z.lat != null && z !== p.zone)
    .map(zoneCircleFeature);
  others.push(zoneCircleFeature({ radiusM: p.radiusM, lat: p.center.lat, lng: p.center.lng, id: p.zone.id }));
  map.getSource('privacy-zones').setData({ type: 'FeatureCollection', features: others });
  if (!p.marker) {
    const el = makeZoneMarkerEl(p.zone);
    p.marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([p.center.lng, p.center.lat])
      .addTo(map);
  } else {
    p.marker.setLngLat([p.center.lng, p.center.lat]);
  }
}

function endZonePlacement(save) {
  const p = zonePlacement;
  if (!p) return;
  if (save && p.center) {
    p.zone.lat = p.center.lat;
    p.zone.lng = p.center.lng;
    p.zone.radiusM = Math.round(p.radiusM);
    savePrivacyZones();
    logAction(`privacy zone "${p.zone.name}" placed (radius ${Math.round(p.zone.radiusM)} m)`);
  }
  if (p.marker) p.marker.remove();
  zonePlacement = null;
  document.getElementById('map-pick-hint').classList.add('hidden');
  if (mapReady) map.getCanvas().style.cursor = '';
  renderPrivacyZones();
  updatePrivacyZoneLayer();
  document.getElementById('settings-overlay').classList.remove('hidden');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && zonePlacement) endZonePlacement(false);
});

// Queue drives whose snapped endpoint falls inside the WGS-84 zone.
function cullZoneDrives(zone) {
  if (zone.lat == null || zone.lng == null) return;
  if (!loadedFilePath || !drives.length) {
    alert('Load a drive data file first.');
    return;
  }
  const gm = window.driveCalc?.geodesicM;
  if (!gm) { alert('Distance helper unavailable.'); return; }
  const matches = drives.filter((d) => ['origin', 'dest'].some((role) => {
    const c = endpointCoord(d, role);
    return c && gm(zone.lat, zone.lng, c.lat, c.lng) <= zone.radiusM;
  }));
  if (!matches.length) {
    alert(`No drives start or end inside "${zone.name}".`);
    return;
  }
  document.getElementById('settings-overlay').classList.add('hidden');
  setPrivacyZonesVisible(false);
  openBulkRemoveModal(matches,
    `Remove ${matches.length} drive${matches.length === 1 ? '' : 's'} that start or end within "${zone.name}"? This cannot be undone.`);
}

// ─── Drive list multi-select ─────────────────────────────────────────────────
// Clear selection on list re-render so it cannot retain stale card IDs.
const multiSelected = new Set();
let multiAnchorId = null;
let lastRenderedOrder = [];

function toggleMultiSelect(id) {
  if (multiSelected.has(id)) multiSelected.delete(id);
  else multiSelected.add(id);
  multiAnchorId = id;
  syncMultiSelectUI();
}

function rangeMultiSelect(id) {
  const a = multiAnchorId == null ? -1 : lastRenderedOrder.indexOf(multiAnchorId);
  const b = lastRenderedOrder.indexOf(id);
  if (a === -1 || b === -1) { toggleMultiSelect(id); return; }
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) multiSelected.add(lastRenderedOrder[i]);
  syncMultiSelectUI();
}

function clearMultiSelect() {
  multiSelected.clear();
  multiAnchorId = null;
  syncMultiSelectUI();
}

function syncMultiSelectUI() {
  document.querySelectorAll('.drive-item').forEach((el) => {
    el.classList.toggle('multi-selected', multiSelected.has(el.dataset.driveId));
  });
  const bar = document.getElementById('multi-select-bar');
  if (!bar) return;
  if (multiSelected.size) {
    document.getElementById('multi-select-count').textContent =
      `${multiSelected.size} drive${multiSelected.size === 1 ? '' : 's'} selected`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

async function renderDriveList(drives) {
  const seq = ++_driveListRenderSeq;
  const list = document.getElementById('drives-list');
  list.innerHTML = '';
  lastRenderedOrder = [];
  clearMultiSelect();

  if (drives.length === 0) {
    list.innerHTML = driveFiltersActive()
      ? '<div class="empty-state">No drives match the current filters.</div>'
      : '<div class="empty-state">No drives found in this file.</div>';
    return;
  }

  // This page is already filtered by the loader.
  const sorted = [...drives].sort((a, b) => b.startTime.localeCompare(a.startTime));
  lastRenderedOrder = sorted.map((d) => String(d.id));

  const BATCH = 100;
  let currentDate = '';
  let frag = document.createDocumentFragment();
  for (let i = 0; i < sorted.length; i++) {
    const drive = sorted[i];
    const driveDate = drive.startTime.slice(0, 10);
    if (driveDate !== currentDate) {
      currentDate = driveDate;
      const header = document.createElement('div');
      header.className = 'drive-date-header';
      header.textContent = formatDateHeader(driveDate);
      frag.appendChild(header);
    }
    frag.appendChild(buildDriveItem(drive));

    // Yield between batches so the renderer can paint.
    if ((i + 1) % BATCH === 0 && i + 1 < sorted.length) {
      list.appendChild(frag);
      frag = document.createDocumentFragment();
      await new Promise((r) => requestAnimationFrame(r));
      if (seq !== _driveListRenderSeq) return;
    }
  }
  if (frag.childNodes.length) list.appendChild(frag);
}

function formatDateHeader(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function formatTime12h(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function assistedChip(drive) {
  const fsd      = drive.fsdPercent      ?? 0;
  const ap       = drive.autosteerPercent ?? 0;
  const tacc     = drive.taccPercent      ?? 0;
  const assisted = drive.assistedPercent  ?? 0;
  if (!assisted) return '';
  const modeCount = (fsd > 0) + (ap > 0) + (tacc > 0);
  let label, pct;
  if (modeCount > 1) { label = 'Assisted'; pct = assisted; }
  else if (fsd)  { label = 'FSD'; pct = fsd; }
  else if (ap)   { label = 'AP'; pct = ap; }
  else if (tacc) { label = 'TACC'; pct = tacc; }
  else return '';

  const tone = fsd >= 95 ? 'drive-chip--green' : fsd >= 50 ? 'drive-chip--blue' : 'drive-chip--slate';
  return `<span class="drive-chip ${tone}"><span class="material-icons">auto_awesome</span>${label} ${pct}%</span>`;
}

function buildDriveItem(drive) {
  const item = document.createElement('div');
  item.className = 'drive-item';
  item.dataset.driveId = String(drive.id);

  const startTime = formatTime12h(drive.startTime);
  const endTime = formatTime12h(drive.endTime);
  const durStr = formatDuration(drive.durationMs);
  const fsdChip = assistedChip(drive);

  const disengagements = drive.fsdDisengagements ?? 0;
  const disengageHtml = disengagements > 0
    ? `<div class="drive-diseng"><span class="material-icons">warning</span>${disengagements} disengagement${disengagements !== 1 ? 's' : ''}</div>`
    : '';

  const tagPills = (drive.tags ?? []).map((t) =>
    `<span class="tag-pill tag-removable" data-tag="${escapeHtml(t)}">${escapeHtml(t)}<button class="tag-remove" data-tag="${escapeHtml(t)}">&times;</button></span>`
  ).join('');

  const sourceLabel = SOURCE_LABELS[drive.source];
  const sourceChip = sourceLabel
    ? `<span class="drive-source-chip">${sourceLabel}</span>`
    : '';

  // Map endpoint battery values onto the seven available icon frames.
  const battBadge = (pct) => {
    if (pct == null) return '';
    const lvl = Math.round((pct / 100) * 6);
    const icon = lvl >= 6 ? 'battery_android_frame_full' : `battery_android_frame_${Math.max(1, lvl)}`;
    const tone = pct < 10 ? ' jt-batt--red' : pct < 20 ? ' jt-batt--amber' : '';
    return `<span class="jt-batt${tone}"><span class="material-icons">${icon}</span>${pct}%</span>`;
  };
  const battStart = battBadge(drive.batteryPctStart);
  const battEnd = battBadge(drive.batteryPctEnd);

  // Escape external place names; coordinates remain the unresolved fallback.
  const startPlace = escapeHtml(drive._startName || gpsLabel(drive, 'origin'));
  const endPlace = escapeHtml(drive._endName || gpsLabel(drive, 'dest'));

  item.innerHTML = `
    <div class="drive-journey">
      <div class="journey-times">
        <span class="jt-time">${startTime}</span>
        <span class="journey-track"><span class="jt-pin jt-pin--origin"></span><span class="jt-dash"></span><span class="jt-pin jt-pin--dest"></span></span>
        <span class="jt-time">${endTime}</span>
      </div>
      <div class="journey-labels">
        <span class="jt-label">Departed${sourceChip}${battStart}</span>
        <span class="jt-label">Arrived${battEnd}</span>
      </div>
      <div class="journey-locs">
        <span class="ep-place-group">
          <span class="ep-place ep-place--start" data-ep="origin">${startPlace}</span>
          <button class="ep-place-edit" data-ep-edit="origin" type="button" title="Save or correct this location name"><span class="material-icons">edit</span></button>
        </span>
        <span class="ep-place-group ep-place-group--end">
          <button class="ep-place-edit" data-ep-edit="dest" type="button" title="Save or correct this location name"><span class="material-icons">edit</span></button>
          <span class="ep-place ep-place--end" data-ep="dest">${endPlace}</span>
        </span>
      </div>
    </div>
    ${disengageHtml}
    <div class="drive-chips">
      <span class="drive-chip"><span class="material-icons">straighten</span>${distVal(drive.distanceMi)} ${distShort()}</span>
      <span class="drive-chip"><span class="material-icons">schedule</span>${durStr}</span>
      ${fsdChip}
      ${drive.summon ? '<span class="drive-chip drive-chip--summon" title="Detected Summon: no pedal input and parking-lot speed throughout, with hazard lights bookending the drive or Self Driving reported for it"><span class="material-icons">settings_remote</span>Summon</span>' : ''}
      ${drive.bridged ? '<span class="drive-chip drive-chip--bridged" title="A GPS gap in this drive was bridged by Check Drives"><span class="material-icons">route</span>Bridged</span>' : ''}
    </div>
    <div class="drive-item-tags">
      ${tagPills}
      <button class="tag-add-btn list-tag-add" title="Add tag">+</button>
      <button class="drive-remove-btn" title="Remove drive"><span class="material-icons">delete</span></button>
    </div>
    <div class="list-tag-input-row hidden">
      <input type="text" class="tag-input list-tag-input" placeholder="New tag…" />
      <div class="tag-suggestions list-tag-suggestions hidden"></div>
    </div>
  `;

  item.querySelector('.drive-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    pendingRemoveDrive = drive;
    const dateStr = new Date(drive.startTime).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    document.getElementById('remove-drive-modal-msg').textContent =
      `Remove the drive on ${dateStr} (${startTime} — ${endTime})? This cannot be undone.`;
    document.getElementById('remove-drive-overlay').classList.remove('hidden');
  });

  item.querySelectorAll('.ep-place-edit').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      editEndpointLocation(item, drive, button.dataset.epEdit);
    });
  });

  item.querySelectorAll('.tag-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(drive, btn.dataset.tag);
    });
  });

  item.querySelector('.list-tag-add').addEventListener('click', (e) => {
    e.stopPropagation();
    const row = item.querySelector('.list-tag-input-row');
    const opened = !row.classList.toggle('hidden');
    if (opened) {
      const input = item.querySelector('.list-tag-input');
      input.value = '';
      input.focus();
      showListTagSuggestions(drive, item, '');
    } else {
      const sug = item.querySelector('.list-tag-suggestions');
      if (sug) { sug.classList.add('hidden'); sug.innerHTML = ''; }
    }
  });

  const tagInput = item.querySelector('.list-tag-input');
  tagInput.addEventListener('click', (e) => e.stopPropagation());
  tagInput.addEventListener('input', () => {
    showListTagSuggestions(drive, item, tagInput.value);
  });
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const val = tagInput.value.trim();
      if (val) addTag(drive, val);
      item.querySelector('.list-tag-input-row').classList.add('hidden');
    } else if (e.key === 'Escape') {
      item.querySelector('.list-tag-input-row').classList.add('hidden');
    }
  });

  // Prevent text selection during Shift+click range selection.
  item.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });
  item.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) { toggleMultiSelect(String(drive.id)); return; }
    if (e.shiftKey) { rangeMultiSelect(String(drive.id)); return; }
    if (multiSelected.size) clearMultiSelect();
    selectDrive(drive);
  });

  // Cache resolved names on the drive; the main process caches across sessions.
  applyDriveLocations(item, drive);

  return item;
}

function endpointCoord(drive, which) {
  // Prefer full-resolution stationary endpoint medoids over single GPS fixes.
  const snapped = which === 'origin' ? drive.geocodeStartPoint : drive.geocodeEndPoint;
  if (Array.isArray(snapped) && typeof snapped[0] === 'number' && typeof snapped[1] === 'number') {
    const accuracyM = which === 'origin' ? drive.geocodeStartAccuracyM : drive.geocodeEndAccuracyM;
    return { lat: snapped[0], lng: snapped[1], accuracyM: Number(accuracyM) || 35 };
  }
  // Downsampled overview data preserves exact endpoints.
  const pts = Array.isArray(drive.points) && drive.points.length ? drive.points : drive.overviewPoints;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const p = which === 'origin' ? pts[0] : pts[pts.length - 1];
  if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number') return null;
  return { lat: p[0], lng: p[1], accuracyM: 35 };
}

// Coordinate placeholder shown until reverse geocoding resolves a name.
function gpsLabel(drive, role) {
  const c = endpointCoord(drive, role);
  return c ? `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}` : '';
}

function setEndpointLabel(item, role, name, match = null) {
  const place = item.querySelector(`.ep-place[data-ep="${role}"]`);
  if (place) {
    place.textContent = name;
    place.title = match?.confidence
      ? `${match.confidence[0].toUpperCase()}${match.confidence.slice(1)} confidence · ${Math.round(match.queryAccuracyM || 0)} m endpoint uncertainty`
      : name;
  }
}

async function resolveDriveLocation(item, drive, role, force = false) {
  const api = window.electronAPI;
  const cacheKey = role === 'origin' ? '_startName' : '_endName';
  if (!force && drive[cacheKey]) {
    setEndpointLabel(item, role, drive[cacheKey], drive[`${cacheKey}Meta`]);
    return;
  }
  const teslaLabel = role === 'origin' ? drive.locationNameStart : drive.locationNameEnd;
  if (teslaLabel) setEndpointLabel(item, role, teslaLabel);
  const c = endpointCoord(drive, role);
  if (!c || !api?.reverseGeocode) {
    if (teslaLabel) drive[cacheKey] = teslaLabel;
    return;
  }
  try {
    const result = await api.reverseGeocode({ ...c, teslaLabel: teslaLabel || null });
    const name = result?.label || teslaLabel;
    if (!name) return;
    drive[cacheKey] = name;
    drive[`${cacheKey}Meta`] = result || null;
    if (item.isConnected) setEndpointLabel(item, role, name, result);
  } catch {
    if (teslaLabel) drive[cacheKey] = teslaLabel;
  }
}

function applyDriveLocations(item, drive) {
  resolveDriveLocation(item, drive, 'origin');
  resolveDriveLocation(item, drive, 'dest');
}

async function editEndpointLocation(item, drive, role) {
  const c = endpointCoord(drive, role);
  const api = window.electronAPI;
  if (!c || !api?.rememberKnownPlace) return;
  const cacheKey = role === 'origin' ? '_startName' : '_endName';
  const proposed = window.prompt(
    'Name this location. Leave it blank to remove a saved manual correction.',
    drive[cacheKey] || '',
  );
  if (proposed == null) return;
  const label = proposed.trim();
  try {
    if (label) {
      const saved = await api.rememberKnownPlace({ ...c, label, source: 'manual', radiusM: 40 });
      if (!saved) return;
      drive[cacheKey] = saved.label;
      drive[`${cacheKey}Meta`] = { ...saved, featureType: 'known-place', confidence: 'high', queryAccuracyM: c.accuracyM };
      setEndpointLabel(item, role, saved.label, drive[`${cacheKey}Meta`]);
    } else {
      await api.removeKnownPlace({ ...c, source: 'manual', maxDistanceM: 100 });
      delete drive[cacheKey];
      delete drive[`${cacheKey}Meta`];
      setEndpointLabel(item, role, gpsLabel(drive, role));
      await resolveDriveLocation(item, drive, role, true);
    }
  } catch { /* A failed local save leaves the current label untouched. */ }
}

function showListTagSuggestions(drive, item, query) {
  const container = item.querySelector('.list-tag-suggestions');
  const existing = drive.tags ?? [];
  const filtered = allTags.filter((t) => !existing.includes(t) && t.toLowerCase().includes(query.toLowerCase()));

  if (filtered.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = filtered.map((t) => `<div class="tag-suggestion" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`).join('');

  container.querySelectorAll('.tag-suggestion').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      addTag(drive, el.dataset.tag);
      item.querySelector('.list-tag-input-row').classList.add('hidden');
    });
  });
}

// Release lazy detail fields; the main-process cache retains them.
function freeDriveDetail(driveId) {
  if (driveId == null) return;
  const d = drives.find((x) => x.id === driveId);
  if (!d) return;
  delete d.points;
  delete d.fsdStates;
  delete d.gearStates;
  delete d.fsdEvents;
}

async function selectDrive(drive) {
  if (selectedDriveId === drive.id) {
    deselectDrive();
    return;
  }

  // Stop replay before releasing the points read by replayTick.
  cleanupReplay();
  freeDriveDetail(selectedDriveId);

  document.querySelectorAll('.drive-item').forEach((el) => el.classList.remove('selected'));
  const selectedEl = document.querySelector(`[data-drive-id="${drive.id}"]`);
  if (selectedEl) {
    selectedEl.classList.add('selected');
    selectedEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  selectedDriveId = drive.id;
  logAction(`opened drive ${drive.startTime}${drive.source && drive.source !== 'sei' ? ` (${drive.source})` : ''}`);

  // Apply context-line state after selectedDriveId changes.
  updateOverviewStyleState();

  document.getElementById('btn-back-overview').classList.remove('hidden');
  if (!drive.points) {
    const requestedId = drive.id;
    const detail = await window.electronAPI.getDriveDetail(drive.id, driveCacheGen);
    // Discard detail that arrives after selection changed.
    if (selectedDriveId !== requestedId) return;
    if (detail.success) {
      drive.points = detail.points;
      drive.fsdStates = detail.fsdStates;
      drive.gearStates = detail.gearStates;
      drive.fsdEvents = detail.fsdEvents;
    }
  }
  drawSelectedDrive(drive);
  renderSelectedDriveStats(drive);
}

function applyFsdMarkerVisibility() {
  for (const m of fsdEventMarkers) {
    m.getElement().style.display = showFsdMarkers ? '' : 'none';
  }
}

function applyOtherDrivesVisibility() {
  if (selectedDriveId === null) return;
  updateOverviewStyleState();
}

function deselectDrive() {
  cleanupReplay();
  freeDriveDetail(selectedDriveId);
  selectedDriveId = null;
  document.querySelectorAll('.drive-item').forEach((el) => el.classList.remove('selected'));
  removeMarkers(selectedMarkers);
  removeMarkers(fsdEventMarkers);
  whenMapReady(() => map.getSource('selected-route').setData(EMPTY_FC));
  document.getElementById('map-legend').classList.add('hidden');
  document.getElementById('btn-back-overview').classList.add('hidden');

  if (drives.length > 0 && lastDrivesMeta) renderDriveStats(drives, lastDrivesMeta);

  // Restore overview styling after selectedDriveId clears.
  updateOverviewStyleState();

  // Reuse bounds computed from every overview point.
  if (overviewBounds) map.fitBounds(overviewBounds, { padding: 30 });

  // Apply a file change deferred while the drive was open.
  if (pendingExternalReload) {
    pendingExternalReload = false;
    reloadDrivesAfterWrite();
  }
}

// ─── Map Drawing ──────────────────────────────────────────────────────────────
function removeMarkers(arr) {
  arr.forEach((m) => m.remove());
  arr.length = 0;
  // Removed markers cannot emit mouseleave; clear their tooltips explicitly.
  document.querySelectorAll('#map .map-tooltip').forEach((t) => t.remove());
}

// Bake badge text into a supersampled sprite because DOM glyph origins snap to
// device pixels while MapLibre positions markers on whole pixels.
function renderBadgeSprite({ label, fill, radius, strokeW, labelColor }) {
  const dpr = Math.ceil(window.devicePixelRatio || 1);
  const cache = (renderBadgeSprite._cache ??= new Map());
  const key = `${label}|${fill}|${radius}|${strokeW}|${labelColor}|${dpr}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const px = Math.round(radius * 1.7);
  const font = `800 ${px}px 'Noto Sans', sans-serif`;
  const S = dpr * 2;
  // Keep the ring outside the 2R fill.
  const size = radius * 2 + strokeW * 2;
  const canvas = document.createElement('canvas');
  canvas.width = size * S;
  canvas.height = size * S;
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);

  const c = size / 2;
  ctx.beginPath();
  ctx.arc(c, c, radius + strokeW / 2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill(); // Fill under the ring to avoid a seam.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = strokeW;
  ctx.stroke();

  // Alpha-scan glyph ink, then center its painted pixels on the disc.
  const scratch = document.createElement('canvas');
  scratch.width = px * 4 * S;
  scratch.height = px * 4 * S;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  sctx.scale(S, S);
  sctx.font = font;
  const originX = px;
  const baselineY = px * 2;
  sctx.fillStyle = '#fff';
  sctx.fillText(label, originX, baselineY);
  const img = sctx.getImageData(0, 0, scratch.width, scratch.height).data;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = 0; y < scratch.height; y++) {
    for (let x = 0; x < scratch.width; x++) {
      if (img[(y * scratch.width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX >= 0) {
    const inkCx = (minX + maxX + 1) / 2 / S - originX;
    const inkCy = (minY + maxY + 1) / 2 / S - baselineY;
    const BADGE_OPTICAL_DX = 0;
    ctx.font = font;
    ctx.fillStyle = labelColor;
    // Canvas shadows use device pixels and must scale with supersampling.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 2 * S;
    ctx.shadowOffsetY = 1 * S;
    ctx.fillText(label, c - inkCx + BADGE_OPTICAL_DX, c - inkCy);
    ctx.shadowColor = 'transparent';
  }

  // Do not cache fallback-font sprites created before fonts.ready.
  if (document.fonts?.check?.(font)) cache.set(key, canvas);
  return canvas;
}

// Center-anchored event marker with an optional pre-rendered label.
function makeDotMarker(latLng, { fill, radius = 7, strokeW = 2, opacity = 1, tooltip, label, labelColor = '#fff' }) {
  const el = document.createElement('div');
  el.className = 'map-dot-marker';
  if (opacity !== 1) el.style.opacity = String(opacity);
  if (label) {
    // Keep a plain round wrapper as the tooltip and visibility hit target.
    const sprite = renderBadgeSprite({ label, fill, radius, strokeW, labelColor });
    const cssSize = radius * 2 + strokeW * 2;
    el.style.width = `${cssSize}px`;
    el.style.height = `${cssSize}px`;
    const view = document.createElement('canvas');
    view.width = sprite.width;
    view.height = sprite.height;
    view.style.width = `${cssSize}px`;
    view.style.height = `${cssSize}px`;
    view.style.display = 'block';
    view.style.pointerEvents = 'none';
    view.getContext('2d').drawImage(sprite, 0, 0);
    el.appendChild(view);
  } else {
    el.style.width = `${radius * 2}px`;
    el.style.height = `${radius * 2}px`;
    el.style.background = fill;
    el.style.border = `${strokeW}px solid #fff`;
  }
  if (tooltip) attachMapTooltip(el, tooltip);
  return new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([latLng[1], latLng[0]])
    .addTo(map);
}

// Minimal hover tooltip for DOM markers.
function attachMapTooltip(el, text) {
  let tip = null;
  el.addEventListener('mouseenter', () => {
    const mapEl = document.getElementById('map');
    tip = document.createElement('div');
    tip.className = 'map-tooltip';
    tip.textContent = text;
    mapEl.appendChild(tip);
    const r = el.getBoundingClientRect();
    const m = mapEl.getBoundingClientRect();
    tip.style.left = `${r.left - m.left + r.width / 2}px`;
    tip.style.top = `${r.top - m.top - 6}px`;
  });
  el.addEventListener('mouseleave', () => {
    if (tip) { tip.remove(); tip = null; }
  });
}

// Smooth sparse imported breadcrumbs for display only; preserve endpoints and
// keep calculations/replay on raw points. Overview uses fewer iterations.
function smoothLatLngsForDisplay(latLngs, iterations = 2) {
  if (!Array.isArray(latLngs) || latLngs.length < 3) return latLngs;
  let pts = latLngs;
  // Dense input needs less rounding and point expansion.
  const iters = pts.length > 100 ? 1 : iterations;
  for (let it = 0; it < iters; it++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

// ─── Overview routes ─────────────────────────────────────────────────────────
// One GPU-backed GeoJSON source holds every overview route.

// Cache bounds over every overview point for deselection.
let overviewBounds = null;

// Derive overview visibility and filters from selection state in one place.
function updateOverviewStyleState() {
  if (!mapReady) {
    whenMapReady(updateOverviewStyleState);
    return;
  }
  if (activeMainTab === 'charging') {
    map.setLayoutProperty('overview-native', 'visibility', 'none');
    map.setLayoutProperty('overview-imported', 'visibility', 'none');
    map.setLayoutProperty('overview-dim', 'visibility', 'none');
    return;
  }
  const selected = selectedDriveId != null;
  const overviewVis = selected ? 'none' : 'visible';
  const dimVis = selected && !hideOtherDrives ? 'visible' : 'none';
  map.setLayoutProperty('overview-native', 'visibility', overviewVis);
  map.setLayoutProperty('overview-imported', 'visibility', overviewVis);
  map.setLayoutProperty('overview-dim', 'visibility', dimVis);
  map.setFilter('overview-dim', selected ? ['!=', ['get', 'driveId'], selectedDriveId] : null);
}

function renderOverviewOnMap() {
  // Stop replay and release selected-drive detail before rebuilding.
  cleanupReplay();
  freeDriveDetail(selectedDriveId);
  removeMarkers(selectedMarkers);
  removeMarkers(fsdEventMarkers);
  selectedDriveId = null;
  document.getElementById('map-legend').classList.add('hidden');
  // Reload paths may enter while a drive is still open.
  document.getElementById('btn-back-overview').classList.add('hidden');

  // Smooth sparse imported routes once in overview mode.
  const bounds = new maplibregl.LngLatBounds();
  const features = [];
  let anyTessie = false;
  for (const drive of drives) {
    if (!drive.overviewPoints || drive.overviewPoints.length < 2) continue;
    const imported = isImportedSource(drive.source);
    if (imported) anyTessie = true;
    const lls = imported ? smoothLatLngsForDisplay(drive.overviewPoints, 1) : drive.overviewPoints;
    const coords = new Array(lls.length);
    for (let i = 0; i < lls.length; i++) {
      coords[i] = [lls[i][1], lls[i][0]];
      bounds.extend(coords[i]);
    }
    features.push({
      type: 'Feature',
      properties: { driveId: drive.id, imported },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  whenMapReady(() => {
    map.getSource('overview').setData({ type: 'FeatureCollection', features });
    map.getSource('selected-route').setData(EMPTY_FC);
    map.getSource('selected-traveled').setData(EMPTY_FC);
    updateOverviewStyleState();
  });

  const tessieLegend = document.querySelector('.legend-tessie');
  if (tessieLegend) tessieLegend.classList.toggle('hidden', !anyTessie);

  // Preserve full-route bounds so loops remain in view after deselection.
  overviewBounds = features.length > 0 ? bounds : null;
  if (features.length > 0) {
    map.fitBounds(bounds, { padding: 30 });
  }
}

// Darken untraveled routes while preserving hue on both basemaps.
function dimColor(hex, factor = 0.45) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => Math.round(((n >> shift) & 255) * factor)
    .toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

// Apply the palette without redrawing, refitting, or resetting replay.
function applyDriveLineColors() {
  const c = driveLineColors;
  const root = document.documentElement.style;
  root.setProperty('--line-manual', c.manual);
  root.setProperty('--line-fsd', c.fsd);
  root.setProperty('--line-summon', c.summon);
  root.setProperty('--line-imported', c.imported);
  root.setProperty('--line-overview', c.overview);
  whenMapReady(() => {
    map.setPaintProperty('overview-native', 'line-color', c.overview);
    map.setPaintProperty('overview-imported', 'line-color', c.imported);
    if (!replayTrailCtx) return;
    const { runs, latLngs, smooth, driveId } = replayTrailCtx;
    for (const run of runs) run.color = c[run.role] || run.color;
    const features = runs.map((run) => {
      let seg = latLngs.slice(run.from, run.to + 1);
      if (smooth) seg = smoothLatLngsForDisplay(seg);
      return {
        type: 'Feature',
        properties: { driveId, color: run.color, colorDim: dimColor(run.color), dashed: run.dashed, w: run.w },
        geometry: { type: 'LineString', coordinates: seg.map((p) => [p[1], p[0]]) },
      };
    });
    map.getSource('selected-route').setData({ type: 'FeatureCollection', features });
    updateReplayTrail(replayIdx);
  });
  logAction(`drive line colors — manual=${c.manual} fsd=${c.fsd} imported=${c.imported} overview=${c.overview}`);
}

// Paint the traveled prefix above the dim route on every tick or scrub.
function updateReplayTrail(idx) {
  if (!mapReady || !replayTrailCtx) return;
  const { runs, latLngs, smooth } = replayTrailCtx;
  const features = [];
  for (const run of runs) {
    if (run.from >= idx) break;
    const to = Math.min(run.to, idx);
    let seg = latLngs.slice(run.from, to + 1);
    if (seg.length < 2) continue;
    // Chaikin preserves the partial run's endpoint at the marker.
    if (smooth) seg = smoothLatLngsForDisplay(seg);
    features.push({
      type: 'Feature',
      properties: { color: run.color, dashed: run.dashed, w: run.w },
      geometry: { type: 'LineString', coordinates: seg.map((p) => [p[1], p[0]]) },
    });
    if (run.to >= idx) break;
  }
  map.getSource('selected-traveled').setData({ type: 'FeatureCollection', features });
}

function drawSelectedDrive(drive) {
  removeMarkers(selectedMarkers);
  removeMarkers(fsdEventMarkers);

  const pts = drive.points;
  if (!pts || pts.length < 2) {
    // Empty drives must still clear route sources and replay state.
    cleanupReplay();
    whenMapReady(() => {
      map.getSource('selected-route').setData(EMPTY_FC);
      map.getSource('selected-traveled').setData(EMPTY_FC);
    });
    return;
  }

  const fsd = drive.fsdStates;
  const isTessie = isImportedSource(drive.source);
  // Segment imported per-point AP data, but distinguish it with dashes.
  const hasFSD = Array.isArray(fsd) && fsd.length === pts.length && fsd.some((s) => s !== 0);
  const latLngs = pts.map((p) => [p[0], p[1]]);

  // Store one GeoJSON feature per styling run for route and replay layers.
  const features = [];
  const trailRuns = [];
  // Retain palette roles so color changes can re-bake without resetting replay.
  const pushSeg = (from, to, role, dashed, w) => {
    if (to - from < 1) return;
    let seg = latLngs.slice(from, to + 1);
    if (isTessie) seg = smoothLatLngsForDisplay(seg);
    const color = driveLineColors[role];
    features.push({
      type: 'Feature',
      properties: { driveId: drive.id, color, colorDim: dimColor(color), dashed, w },
      geometry: { type: 'LineString', coordinates: seg.map((p) => [p[1], p[0]]) },
    });
    trailRuns.push({ from, to, role, color, dashed, w });
  };

  if (drive.summon) {
    // The whole route was driverless, so color it uniformly instead of by the
    // reported AP state.
    pushSeg(0, latLngs.length - 1, 'summon', false, 5);
  } else if (hasFSD) {
    let i = 0;
    while (i < pts.length) {
      const engaged = fsd[i] !== 0;
      let j = i + 1;
      while (j < pts.length && (fsd[j] !== 0) === engaged) j++;

      pushSeg(
        i,
        Math.min(j, pts.length - 1),
        engaged ? 'fsd' : (isTessie ? 'imported' : 'manual'),
        isTessie,
        5
      );
      i = j;
    }
  } else if (isTessie) {
    // Imported drive without per-point FSD data.
    pushSeg(0, latLngs.length - 1, 'imported', true, 5);
  } else {
    pushSeg(0, latLngs.length - 1, 'manual', false, 4);
  }

  replayTrailCtx = { runs: trailRuns, latLngs, smooth: isTessie, driveId: drive.id };
  whenMapReady(() => {
    map.getSource('selected-route').setData({ type: 'FeatureCollection', features });
    map.getSource('selected-traveled').setData(EMPTY_FC);
  });

  selectedMarkers.push(makeDotMarker(latLngs[0], { fill: '#22cc55', tooltip: 'Start' }));
  selectedMarkers.push(makeDotMarker(latLngs[latLngs.length - 1], { fill: '#ff3344', tooltip: 'End' }));

  if (Array.isArray(drive.fsdEvents)) {
    for (const ev of drive.fsdEvents) {
      const disengage = ev.type === 'disengagement';
      fsdEventMarkers.push(makeDotMarker([ev.lat, ev.lng], {
        fill: disengage ? '#ef4444' : '#f59e0b',
        radius: 9,
        strokeW: 1.5,
        opacity: 0.95,
        label: disengage ? 'D' : 'A',
        labelColor: '#fff',
        tooltip: disengage ? 'FSD Disengagement' : 'Accelerator Override',
      }));
    }
  }
  applyFsdMarkerVisibility();

  const bounds = new maplibregl.LngLatBounds();
  for (const p of latLngs) bounds.extend([p[1], p[0]]);
  map.fitBounds(bounds, { padding: 50 });

  const legend = document.getElementById('map-legend');
  if (hasFSD || isTessie) {
    legend.classList.remove('hidden');
  } else {
    legend.classList.add('hidden');
  }

  // Initialize orientation from confident motion, not parked GPS noise.
  const initBearing = computeInitBearing(drive.points, drive.gearStates);
  const { w: mW, h: mH } = getMarkerSize();
  const wrap = document.createElement('div');
  wrap.style.width = `${mW}px`;
  wrap.style.height = `${mH}px`;
  wrap.style.zIndex = '1000';
  wrap.innerHTML = buildMarkerHtml(initBearing);
  replayMarker = new maplibregl.Marker({ element: wrap, anchor: 'center' })
    .setLngLat([latLngs[0][1], latLngs[0][0]])
    .addTo(map);
  selectedMarkers.push(replayMarker);

  initReplay(drive);
}

// ─── Drive Replay ────────────────────────────────────────────────────────────
const GEAR_LABELS = { 0: 'P', 1: 'D', 2: 'R', 3: 'N' };
const GEAR_CLASSES = { 0: 'gear-p', 1: 'gear-d', 2: 'gear-r', 3: 'gear-n' };
let replayCurrentBearing = 0;

function initReplay(drive) {
  // Stop the previous interval before replacing replay state.
  stopReplay();
  replayDrive = drive;
  replayIdx = 0;
  replaySpeed = 1;
  replayPlaying = false;
  // Match the marker's confident initial heading.
  replayCurrentBearing = computeInitBearing(drive.points, drive.gearStates);

  const slider = document.getElementById('replay-slider');
  slider.max = String(drive.points.length - 1);
  slider.value = '0';

  document.getElementById('replay-play-icon').textContent = 'play_arrow';
  document.getElementById('btn-replay-speed').textContent = '1x';

  // Missing point timestamps retain the placeholder.
  if (drive.points.length > 0) {
    const t0 = drive.points[0][2];
    const t1 = drive.points[drive.points.length - 1][2];
    document.getElementById('replay-time-start').textContent = t0 !== undefined ? formatReplayTime(t0) : '--:--';
    document.getElementById('replay-time-end').textContent = t1 !== undefined ? formatReplayTime(t1) : '--:--';
  }

  updateReplayData(0);
  document.getElementById('replay-bar').classList.remove('hidden');

  slider.oninput = (e) => {
    if (replayPlaying) stopReplay();
    replayIdx = parseInt(e.target.value);
    updateReplayPosition(replayIdx, true);
  };

  document.getElementById('btn-replay-play').onclick = toggleReplay;
  document.getElementById('btn-replay-speed').onclick = (e) => { e.stopPropagation(); toggleSpeedMenu(); };
  document.querySelectorAll('.replay-speed-item').forEach((item) => {
    item.onclick = (e) => { e.stopPropagation(); setReplaySpeed(Number(item.dataset.speed)); closeSpeedMenu(); };
  });
}

function formatReplayTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function toggleReplay() {
  if (replayPlaying) {
    stopReplay();
  } else {
    startReplay();
  }
}

function replayTick() {
  if (!replayDrive) { stopReplay(); return; }
  const next = replayIdx + 1;
  if (next >= replayDrive.points.length) {
    stopReplay();
    return;
  }
  replayIdx = next;
  updateReplayPosition(next);
}

function startReplay() {
  if (!replayDrive) return;

  // Restart completed playback at the departure position and heading.
  if (replayIdx >= replayDrive.points.length - 1) {
    replayIdx = 0;
    updateReplayPosition(0, true);
  }

  replayPlaying = true;
  document.getElementById('replay-play-icon').textContent = 'pause';

  replayInterval = setInterval(replayTick, REPLAY_BASE_MS / replaySpeed);
}

function stopReplay() {
  replayPlaying = false;
  if (replayInterval) { clearInterval(replayInterval); replayInterval = null; }
  document.getElementById('replay-play-icon').textContent = 'play_arrow';
}

function setReplaySpeed(speed) {
  replaySpeed = speed;
  document.getElementById('btn-replay-speed').textContent = `${replaySpeed}x`;
  if (replayPlaying) {
    clearInterval(replayInterval);
    replayInterval = setInterval(replayTick, REPLAY_BASE_MS / replaySpeed);
  }
}

// Playback-speed pop-up list.
let _closeSpeedMenuOutside = null;
function toggleSpeedMenu() {
  const menu = document.getElementById('replay-speed-menu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) openSpeedMenu(); else closeSpeedMenu();
}
function openSpeedMenu() {
  const menu = document.getElementById('replay-speed-menu');
  if (!menu) return;
  menu.querySelectorAll('.replay-speed-item').forEach((item) => {
    item.classList.toggle('active', Number(item.dataset.speed) === replaySpeed);
  });
  menu.classList.remove('hidden');
  // Defer outside-click binding until after the opening click.
  _closeSpeedMenuOutside = (e) => { if (!e.target.closest('.replay-speed-wrap')) closeSpeedMenu(); };
  setTimeout(() => document.addEventListener('click', _closeSpeedMenuOutside), 0);
}
function closeSpeedMenu() {
  const menu = document.getElementById('replay-speed-menu');
  if (menu) menu.classList.add('hidden');
  if (_closeSpeedMenuOutside) {
    document.removeEventListener('click', _closeSpeedMenuOutside);
    _closeSpeedMenuOutside = null;
  }
}

function updateReplayPosition(idx, snap = false) {
  if (!replayDrive) return;
  const pts = replayDrive.points;
  const pt = pts[idx];

  // Ease marker transforms only while MapLibre is not moving the map.
  if (replayMarker) {
    const el = replayMarker.getElement();
    if (el && replayPlaying && !mapInteracting) {
      el.style.transition = `transform ${REPLAY_BASE_MS / replaySpeed}ms linear`;
    } else if (el) {
      el.style.transition = 'none';
    }
    replayMarker.setLngLat([pt[1], pt[0]]);
  }

  updateReplayTrail(idx);

  const arrow = document.getElementById('replay-arrow');
  if (arrow) {
    // Gear-transition windows do not provide a reliable bearing.
    const gears = replayDrive.gearStates;
    const gearNow = gears?.[idx];
    const gearPrev = idx > 0 ? gears?.[idx - 1] : gearNow;
    const gearNext = idx + 1 < gears?.length ? gears?.[idx + 1] : gearNow;
    const gearTransition = (gearNow !== gearPrev) || (gearNow !== gearNext);

    // Playback holds through stationary noise; scrubbing inherits stop-entry heading.
    let bearing;
    if (snap) {
      bearing = findBearingNear(pts, idx, 7, gears);
    } else {
      bearing = gearTransition ? null : smoothBearing(pts, idx, 7, gears);
      if (bearing != null && gearNow === 2) bearing = (bearing + 180) % 360;
    }

    if (bearing != null) {
      if (snap) {
        // Reset accumulated winding after a scrub.
        replayCurrentBearing = bearing;
        arrow.style.transition = 'none';
      } else {
        // Use the shortest angular delta without accumulating 360° drift.
        let delta = bearing - (replayCurrentBearing % 360 + 360) % 360;
        if (delta > 180) delta -= 360;
        else if (delta < -180) delta += 360;
        replayCurrentBearing += delta;

        const transMs = Math.max(30, 150 / replaySpeed);
        arrow.style.transition = `transform ${transMs}ms linear`;
      }
      arrow.style.transform = `rotate(${replayCurrentBearing}deg)`;
    }
  }

  document.getElementById('replay-slider').value = String(idx);
  if (pt && pt[2] !== undefined) {
    const label = document.getElementById('replay-time-current');
    label.textContent = formatReplayTime(pt[2]);
    const max = pts.length - 1;
    const pct = max > 0 ? (idx / max) * 100 : 0;
    const thumbW = 14;
    label.style.left = `calc(${pct}% + ${(thumbW / 2) - (pct / 100) * thumbW}px)`;
  }

  updateReplayData(idx);
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ─── Marker helpers ──────────────────────────────────────────────────────────

const ARROW_MARKER_SIZE = { w: 128, h: 128 };

// Measure Mercator scale at the marker latitude.
function pixelsPerMetreAt(lat) {
  const EARTH_CIRCUMFERENCE_M = 40075016.686;
  const metresPerPixel = (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180))
    / (512 * Math.pow(2, map.getZoom()));
  return metresPerPixel > 0 ? 1 / metresPerPixel : 0;
}

// Draw vehicles at physical map scale, clamped to a readable minimum.
function vehicleMarkerSize(model) {
  const lat = replayMarker?.getLngLat()?.lat ?? map?.getCenter()?.lat ?? 0;
  const ppm = mapReady ? pixelsPerMetreAt(lat) : 0;
  const h = Math.max(VEHICLE_MIN_PX, model.lengthM * ppm);
  return { w: Math.round(h * (model.w / model.h)), h: Math.round(h) };
}

function getMarkerSize() {
  const model = VEHICLE_MODELS[markerType];
  if (!model) return ARROW_MARKER_SIZE;
  return vehicleMarkerSize(model);
}

function buildMarkerHtml(bearing) {
  const shadow = 'filter:drop-shadow(0 0 4px rgba(0,0,0,0.5))';
  const { w, h } = getMarkerSize();
  if (markerType in VEHICLE_MODELS && vehicleColoredUrl) {
    return `<img id="replay-arrow" src="${vehicleColoredUrl}" style="width:${w}px;height:${h}px;transform:rotate(${bearing}deg);transition:transform 60ms linear;${shadow};" />`;
  }
  return `<img id="replay-arrow" src="../../assets/map-ui/arrow.png" style="width:${w}px;height:${h}px;transform:rotate(${bearing}deg);transition:transform 60ms linear;${shadow};" />`;
}

// Rebuild the live marker without changing position or bearing.
function refreshReplayMarkerIcon() {
  if (!replayMarker) return;
  let bearing = 0;
  const arrowEl = document.getElementById('replay-arrow');
  if (arrowEl) {
    const m = /rotate\((-?[0-9.]+)deg\)/.exec(arrowEl.style.transform || '');
    if (m) bearing = parseFloat(m[1]) || 0;
  }
  const { w: mW, h: mH } = getMarkerSize();
  const el = replayMarker.getElement();
  el.style.width = `${mW}px`;
  el.style.height = `${mH}px`;
  el.innerHTML = buildMarkerHtml(bearing);
}

function renderVehicleColor(color, model) {
  return new Promise((resolve) => {
    const imgT = new Image();
    const imgC = new Image();
    let loaded = 0;

    // Resolve missing artwork so the caller can fall back to the arrow.
    imgT.onerror = imgC.onerror = () => resolve(null);

    const onLoad = () => {
      if (++loaded < 2) return;

      const canvas = document.createElement('canvas');
      canvas.width  = imgT.naturalWidth;
      canvas.height = imgT.naturalHeight;
      const ctx = canvas.getContext('2d');

      ctx.drawImage(imgT, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;

      // Scale the color mask to the texture dimensions.
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width  = imgT.naturalWidth;
      maskCanvas.height = imgT.naturalHeight;
      const maskCtx = maskCanvas.getContext('2d');
      maskCtx.drawImage(imgC, 0, 0, imgT.naturalWidth, imgT.naturalHeight);
      const maskD = maskCtx.getImageData(0, 0, canvas.width, canvas.height).data;

      const tr = parseInt(color.slice(1, 3), 16);
      const tg = parseInt(color.slice(3, 5), 16);
      const tb = parseInt(color.slice(5, 7), 16);

      // Infer base luminance across paintable pixels and discard source hue.
      let lumSum = 0;
      let lumCount = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 10) continue;
        const maskLum = (maskD[i] * 0.299 + maskD[i + 1] * 0.587 + maskD[i + 2] * 0.114) / 255;
        if (maskLum < 0.5) continue;
        lumSum += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
        lumCount++;
      }
      const avgLum = lumCount > 0 ? lumSum / lumCount : 0.5;
      // Dark, light, and mid-tone bases require different shading transforms.
      const regime = avgLum < 0.2 ? 'dark' : avgLum > 0.65 ? 'light' : 'mid';

      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 10) continue;
        const maskLum = (maskD[i] * 0.299 + maskD[i + 1] * 0.587 + maskD[i + 2] * 0.114) / 255;
        if (maskLum < 0.5) continue;
        const baseLum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
        let s;
        let h;
        if (regime === 'dark') {
          s = 1;
          h = baseLum;
        } else if (regime === 'light') {
          s = baseLum;
          h = 0;
        } else if (baseLum <= avgLum) {
          s = baseLum / avgLum;
          h = 0;
        } else {
          s = 1;
          h = (baseLum - avgLum) / (1 - avgLum);
        }
        d[i]     = Math.round(tr * s + (255 - tr * s) * h);
        d[i + 1] = Math.round(tg * s + (255 - tg * s) * h);
        d[i + 2] = Math.round(tb * s + (255 - tb * s) * h);
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL());
    };

    imgT.onload = onLoad;
    imgC.onload = onLoad;
    imgT.src = model.texture;
    imgC.src = model.mask;
  });
}

async function applyMarkerColor(color) {
  markerColor = color;
  localStorage.setItem('markerColor', color);
  const model = VEHICLE_MODELS[markerType];
  vehicleColoredUrl = model ? await renderVehicleColor(color, model) : null;

  const swatch = document.getElementById('btn-car-color-swatch');
  if (swatch) swatch.style.background = color;

  const previewCanvas = document.getElementById('vehicle-preview-canvas');
  if (previewCanvas && vehicleColoredUrl) {
    const img = new Image();
    img.onload = () => {
      previewCanvas.width  = img.naturalWidth;
      previewCanvas.height = img.naturalHeight;
      previewCanvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = vehicleColoredUrl;
  }

  const arrowEl = document.getElementById('replay-arrow');
  if (arrowEl && model && vehicleColoredUrl) arrowEl.src = vehicleColoredUrl;
}

// Derive initial orientation through the same motion gates used by scrubbing.
function computeInitBearing(pts, gearStates) {
  if (!pts || pts.length < 2) return 0;
  return findBearingNear(pts, 0, 7, gearStates) ?? 0;
}

// Bearing trust combines displacement, recorded speed, and net/gross coherence.
const MIN_BEARING_PAIR_M = 1.5;
const MIN_BEARING_SPEED_MPS = 0.5;
// Maximum expansion is ±3.2 seconds at SEI's typical 10 Hz cadence.
const MAX_BEARING_HALF_SPAN = 32;
// Stopped samples inherit the last confident heading; only pre-departure
// samples look ahead. Reverse uses the gear of the heading source sample.
function findBearingNear(pts, idx, window, gearStates) {
  // smoothBearing confines evidence to j's contiguous gear run.
  const headingAt = (j) => {
    const b = smoothBearing(pts, j, window, gearStates);
    if (b == null) return null;
    return gearStates?.[j] === 2 ? (b + 180) % 360 : b;
  };
  const direct = headingAt(idx);
  if (direct != null) return direct;
  // Overlap search windows so short movement bursts remain discoverable.
  const stride = Math.max(1, Math.floor(window / 2));
  for (let j = Math.max(0, idx - stride); ; j = Math.max(0, j - stride)) {
    const b = headingAt(j);
    if (b != null) return b;
    if (j === 0) break;
  }
  for (let j = idx + stride; j < pts.length; j += stride) {
    const b = headingAt(j);
    if (b != null) return b;
  }
  return null;
}

function smoothBearing(pts, idx, window, gearStates) {
  // Use a displacement-weighted circular mean within one contiguous gear run.
  // Return null when the window cannot distinguish motion from GPS noise.
  let lo = Math.max(0, idx - MAX_BEARING_HALF_SPAN);
  let hi = Math.min(pts.length - 1, idx + MAX_BEARING_HALF_SPAN);
  const gear = gearStates ? gearStates[idx] : null;
  if (gearStates) {
    let rs = idx; while (rs > lo && gearStates[rs - 1] === gear) rs--;
    let re = idx; while (re < hi && gearStates[re + 1] === gear) re++;
    lo = rs; hi = re;
  }
  let start = Math.max(lo, idx - Math.floor(window / 2));
  let end = Math.min(hi, idx + Math.ceil(window / 2));
  if (end <= start) return null;

  // Recorded speed can prove motion but never veto GPS-only evidence.
  let speedSaysMoving = false;
  for (let i = start; i <= end; i++) {
    const v = pts[i][3];
    if (Number.isFinite(v) && Math.abs(v) >= MIN_BEARING_SPEED_MPS) { speedSaysMoving = true; break; }
  }

  let net = geodesicM(pts[start][0], pts[start][1], pts[end][0], pts[end][1]);
  if (speedSaysMoving) {
    // Expand when speed proves motion but net displacement remains below the floor.
    let half = Math.ceil(window / 2);
    while (net < MIN_BEARING_PAIR_M && (start > lo || end < hi)) {
      half *= 2;
      start = Math.max(lo, idx - half);
      end = Math.min(hi, idx + half);
      net = geodesicM(pts[start][0], pts[start][1], pts[end][0], pts[end][1]);
    }
    if (net < MIN_BEARING_PAIR_M) return null;
  } else {
    // GPS-only evidence requires both net distance and path coherence.
    const minNet = Math.max(MIN_BEARING_PAIR_M, (end - start) * 0.4);
    if (net < minNet) return null;
    let gross = 0;
    for (let i = start; i < end; i++) {
      gross += geodesicM(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    }
    if (gross > 0 && net / gross < 0.5) return null;
  }
  // From here, pair filters choose evidence but cannot veto the update.

  // Prefer speed-confirmed pairs, then fall back when the channel is absent.
  const collect = (filterByGear, requireSpeed) => {
    let sinSum = 0, cosSum = 0, weight = 0;
    for (let i = start; i < end; i++) {
      if (filterByGear && (gearStates[i] !== gear || gearStates[i + 1] !== gear)) continue;
      const d = geodesicM(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < MIN_BEARING_PAIR_M) continue;
      if (requireSpeed) {
        const v0 = pts[i][3];
        const v1 = pts[i + 1][3];
        if (!Number.isFinite(v0) || !Number.isFinite(v1) || Math.max(Math.abs(v0), Math.abs(v1)) < MIN_BEARING_SPEED_MPS) continue;
      }
      const b = calcBearing(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      const rad = (b * Math.PI) / 180;
      // Let longer confident segments dominate the circular mean.
      sinSum += Math.sin(rad) * d;
      cosSum += Math.cos(rad) * d;
      weight += d;
    }
    return { sinSum, cosSum, weight };
  };

  // Use the first trust tier with usable pairs.
  let r = gearStates ? collect(true, true) : collect(false, true);
  if (r.weight === 0 && gearStates) r = collect(true, false);
  if (r.weight === 0) r = collect(false, false);
  if (r.weight > 0) {
    return ((Math.atan2(r.sinSum, r.cosSum) * 180) / Math.PI + 360) % 360;
  }
  // Use the net vector when only the full window clears the jitter floor.
  return calcBearing(pts[start][0], pts[start][1], pts[end][0], pts[end][1]);
}

function updateReplayData(idx) {
  if (!replayDrive) return;
  const drive = replayDrive;
  const pt = drive.points[idx];

  // Display speed magnitude; the separate gear readout conveys reverse.
  document.getElementById('replay-speed-val').textContent =
    Number.isFinite(pt[3]) ? `${speedVal(Math.abs(pt[3]) * MPS_TO_MPH)} ${speedShort()}` : '--';

  const gearSpan = document.getElementById('replay-gear-span');
  const gearEl = document.getElementById('replay-gear-val');
  if (gearSpan && gearEl) {
    const gear = drive.gearStates?.[idx];
    if (GEAR_LABELS[gear] !== undefined) {
      gearSpan.style.display = '';
      gearEl.textContent = GEAR_LABELS[gear];
      gearEl.className = GEAR_CLASSES[gear];
    } else {
      gearSpan.style.display = 'none';
    }
  }

  // Name the mode for Summon instead of echoing the reported AP state, which
  // is Off on older firmware and Self Driving on newer.
  const fsdEl = document.getElementById('replay-fsd-val');
  const fsdSpan = document.getElementById('replay-fsd-span');
  if (drive.summon) {
    fsdSpan.style.display = '';
    fsdEl.textContent = 'Summon';
    fsdEl.className = 'fsd-summon';
  } else if (drive.fsdStates && drive.fsdStates[idx] !== undefined) {
    fsdSpan.style.display = '';
    const engaged = drive.fsdStates[idx] !== 0;
    fsdEl.textContent = engaged ? 'Active' : 'Off';
    fsdEl.className = engaged ? 'fsd-on' : 'fsd-off';
  } else {
    fsdSpan.style.display = 'none';
  }
}

function cleanupReplay() {
  stopReplay();
  closeSpeedMenu();
  replayDrive = null;
  replayMarker = null;
  replayTrailCtx = null;
  whenMapReady(() => map.getSource('selected-traveled').setData(EMPTY_FC));
  document.getElementById('replay-bar').classList.add('hidden');
}

// ─── Drive Info Panel ─────────────────────────────────────────────────────────
// ─── Drive Tags ──────────────────────────────────────────────────────────────

function refreshAllTags(driveTags) {
  const set = new Set();
  for (const tags of Object.values(driveTags)) {
    for (const t of tags) set.add(t);
  }
  allTags = [...set].sort();
}

function renderTagFilter() {
  const container = document.getElementById('tag-filter');
  // Avoid duplicating a user-created tag that matches the synthetic Summon filter.
  const pinSummon = hasSummonDrives && !allTags.includes('summon');
  if (allTags.length === 0 && !pinSummon) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  let html = `<button class="tag-filter-btn${driveFilters.tag === '' ? ' active' : ''}" data-tag="">All</button>`;
  if (pinSummon) {
    html += `<button class="tag-filter-btn${driveFilters.tag === 'summon' ? ' active' : ''}" data-tag="summon">Summon</button>`;
  }
  for (const t of allTags) {
    html += `<button class="tag-filter-btn${driveFilters.tag === t ? ' active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.tag-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      driveFilters.tag = (driveFilters.tag === tag && tag !== '') ? '' : tag;
      renderTagFilter();
      applyDriveFilters();
    });
  });
}

function rebuildAllTagsFromDrives() {
  const set = new Set();
  for (const d of drives) for (const t of (d.tags ?? [])) set.add(t);
  allTags = [...set].sort();
}

async function addTag(drive, tagName) {
  if (!loadedFilePath) return;
  const tags = [...(drive.tags ?? [])];
  if (tags.includes(tagName)) return;
  tags.push(tagName);
  drive.tags = tags;
  logAction(`tag added: "${tagName}"`);

  // Update optimistically before the full-file tag write completes.
  if (!allTags.includes(tagName)) {
    allTags.push(tagName);
    allTags.sort();
    renderTagFilter();
  }
  renderDriveList(drives);
  if (selectedDriveId === drive.id) refreshSelectedDriveTags(drive);

  // Roll back the optimistic update if persistence fails.
  const res = await window.electronAPI.setDriveTags({ filePath: loadedFilePath, driveKey: drive.startTime, tags });
  if (res && res.success === false) {
    drive.tags = (drive.tags ?? []).filter((t) => t !== tagName);
    rebuildAllTagsFromDrives();
    renderTagFilter();
    renderDriveList(drives);
    if (selectedDriveId === drive.id) refreshSelectedDriveTags(drive);
    alert(`Couldn't save tag: ${res.error || 'write failed'}`);
  }
}

async function removeTag(drive, tagName) {
  if (!loadedFilePath) return;
  const prev = [...(drive.tags ?? [])];
  drive.tags = prev.filter((t) => t !== tagName);
  logAction(`tag removed: "${tagName}"`);

  // Drop an active loader-side filter when its last matching tag is removed.
  rebuildAllTagsFromDrives();
  if (driveFilters.tag === tagName && !allTags.includes(tagName)) {
    driveFilters.tag = '';
    renderTagFilter();
    applyDriveFilters();
  } else {
    renderTagFilter();
    renderDriveList(drives);
  }
  if (selectedDriveId === drive.id) refreshSelectedDriveTags(drive);

  const res = await window.electronAPI.setDriveTags({ filePath: loadedFilePath, driveKey: drive.startTime, tags: drive.tags });
  if (res && res.success === false) {
    drive.tags = prev;
    rebuildAllTagsFromDrives();
    renderTagFilter();
    renderDriveList(drives);
    if (selectedDriveId === drive.id) refreshSelectedDriveTags(drive);
    alert(`Couldn't remove tag: ${res.error || 'write failed'}`);
  }
}

function showTagSuggestions(drive, query) {
  const container = document.getElementById('tag-suggestions');
  const existing = drive.tags ?? [];
  const filtered = allTags.filter((t) => !existing.includes(t) && t.toLowerCase().includes(query.toLowerCase()));

  if (filtered.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = filtered.map((t) => `<div class="tag-suggestion" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`).join('');

  container.querySelectorAll('.tag-suggestion').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      addTag(drive, el.dataset.tag);
    });
  });
}
