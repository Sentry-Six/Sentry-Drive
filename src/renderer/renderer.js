'use strict';

const fmt = (n) => Number(n).toLocaleString('en-US');

// ─── State ────────────────────────────────────────────────────────────────────
let map = null;                // maplibregl.Map
let mapReady = false;          // style 'load' fired — sources/layers exist
let pendingMapTasks = [];      // deferred until style load (source data, filters)
let selectedMarkers = [];      // DOM markers for the selected drive (start/end/replay)
let drives = [];
let overviewRoutes = [];   // raw route points for overview map (one per clip)
let loadedFilePath = null;
let selectedDriveId = null;
let removeOutputListener = null;
let processingStartTime = null;
let cpuCount = 1;
let allTags = [];          // deduplicated, sorted list of all tag names
let activeTagFilter = '';  // currently active tag filter (empty = show all)
let hideOtherDrives = false;
let showFsdMarkers = true;
let fsdEventMarkers = [];  // DOM markers for FSD events (toggleable in Settings)
let showMapLabels = true;               // city/neighborhood labels on base maps
let showRoadLabels = true;              // street/highway names on base maps
let applyMapLabelsSetting = () => {};   // bound to the real basemap at map init

// Replay state
let replayMarker = null;
let mapInteracting = false; // pan/zoom in progress — suspend marker easing
let replayTrailCtx = null;  // {runs, latLngs, smooth} — traveled-route overlay data
let replayInterval = null;
let replayPlaying = false;
let replayIdx = 0;
let replayDrive = null;
let replaySpeed = 1;        // 1x, 2x, 5x, 10x
const REPLAY_BASE_MS = 100; // base interval per point at 1x

// Drive-calc constants come from the shared single-source module, exposed by
// the preload bridge (see src/shared/drive-calc.cjs). Using them here keeps the
// renderer's display conversions identical to the processing pipeline.
const { MI_TO_KM, M_PER_MILE, MPS_TO_MPH, geodesicM } = window.driveCalc;

// ─── Error forwarding ────────────────────────────────────────────────────────
// Renderer errors, unhandled rejections, and console.error/warn all flow to
// the main-process log (terminal under `npm start`; exportable from
// Settings → Support → Logs). Defensive throughout — logging must never break
// the app it's logging.
(() => {
  const send = (level, scope, text) => {
    try { window.electronAPI?.appLog({ level, scope, text }); } catch { /* never throw from logging */ }
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

// Units
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
let model3ColoredUrl = null;
let carColorPicker   = null;
let markerColorDebounceTimer = null;

function scheduleMarkerColorUpdate(color) {
  clearTimeout(markerColorDebounceTimer);
  markerColorDebounceTimer = setTimeout(() => applyMarkerColor(color), 250);
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
  initFooter();
  initChangelogModal();
  loadDefaultPaths();
});

// ─── Map ──────────────────────────────────────────────────────────────────────
// MapLibre GL JS (vendored under assets/vendor/maplibre). The basemap is a
// raster source fed by Google's tile endpoint restyled via the legacy
// apistyle parameter — the exact same tile URLs the old Leaflet stack used.
// All drive routes render as GeoJSON line layers on the GPU: the per-layer
// CPU overhead that made thousands of overview lines lag under Leaflet
// (and then under a hand-rolled canvas overlay) is gone entirely.
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Zoom-scaled line widths, replicating the old Leaflet behavior of
// max(2, base * zoom / 10) as piecewise-linear interpolation stops.
const OVERVIEW_LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 0, 3, 8, 3, 10, 3.5, 20, 6];
// Imported overview lines run ~1px thinner. The difference is baked into
// the stops because zoom expressions are only legal as the TOP-LEVEL
// interpolate — wrapping OVERVIEW_LINE_WIDTH in ['*', factor, …] is
// rejected by the style spec and would abort layer setup.
const OVERVIEW_IMPORTED_LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 0, 2.5, 8, 2.5, 10, 2.9, 20, 4.75];
const SELECTED_LINE_WIDTH = ['interpolate', ['linear'], ['zoom'],
  0, 2, 4, 2, 10, ['max', 2, ['get', 'w']], 20, ['max', 2, ['*', ['get', 'w'], 2]]];

// Sources/layers only exist after the style's 'load' event; anything that
// touches them (route data, filters, tile swaps) queues until then.
function whenMapReady(fn) {
  if (mapReady) fn();
  else pendingMapTasks.push(fn);
}

function initMap() {
  // All base maps come from Google's tile endpoint, restyled via the legacy
  // apistyle parameter. Both Light and Dark strip every label except the
  // administrative ones (cities, neighborhoods) and road labels (street
  // names): all labels off, then s.t:1 + s.t:3/49 labels back on — or every
  // label off when the labels setting is off. Dark additionally
  // applies Google's own night-mode palette (#242f3e base / #17263c water /
  // #38414e roads / muted tan labels) — verified live at ~49 avg tile
  // brightness vs ~214 for the standard roadmap.
  showMapLabels = localStorage.getItem('showMapLabels') !== 'false';
  // Road labels follow the city-labels setting until the user chooses
  // explicitly — anyone who hid all labels before this toggle existed
  // keeps a fully clean map.
  const savedRoadLabels = localStorage.getItem('showRoadLabels');
  showRoadLabels = savedRoadLabels != null ? savedRoadLabels !== 'false' : showMapLabels;
  // Google night-mode palette (every color verified pixel-by-pixel on live
  // tiles): base #242f3e, parks #263c3f (s.t:37), built-up/building lots
  // #2b3645 (81), water #17263c (6), roads #38414e + stroke #212a37 (3),
  // transit #2f3948 (4), all labels white with the dark base as halo (the
  // muted-tan and warm-accent label colors were both tried and reverted).
  // Highways (49) diverge from Google's tan on purpose: light grey #5f6b7c,
  // clearly lighter than local roads — and the fill (g.f) is set explicitly
  // because the high-zoom highway rendering ignores the generic g rule
  // (verified at z15: without g.f the color vanished when zoomed in).
  const GMAPS_NIGHT_RULES = 's.e%3Ag%7Cp.c%3A%23242f3e,s.e%3Al.t.f%7Cp.c%3A%23ffffff,s.e%3Al.t.s%7Cp.c%3A%23242f3e,s.t%3A37%7Cs.e%3Ag%7Cp.c%3A%23263c3f,s.t%3A81%7Cs.e%3Ag%7Cp.c%3A%232b3645,s.t%3A6%7Cs.e%3Ag%7Cp.c%3A%2317263c,s.t%3A3%7Cs.e%3Ag%7Cp.c%3A%2338414e,s.t%3A3%7Cs.e%3Ag.s%7Cp.c%3A%23212a37,s.t%3A49%7Cs.e%3Ag%7Cp.c%3A%235f6b7c,s.t%3A49%7Cs.e%3Ag.f%7Cp.c%3A%235f6b7c,s.t%3A49%7Cs.e%3Ag.s%7Cp.c%3A%232a3340,s.t%3A4%7Cs.e%3Ag%7Cp.c%3A%232f3948';
  // Everything off, then each label class the user wants back on:
  // administrative (s.t:1, cities/neighborhoods) and roads (s.t:3, plus
  // highways s.t:49 for names/shields at high zoom) — independently
  // toggled in Settings → Map UI, applied to every base layer.
  const gmapsLabelRules = () => {
    const rules = ['s.e%3Al%7Cp.v%3Aoff'];
    if (showMapLabels) rules.push('s.t%3A1%7Cs.e%3Al%7Cp.v%3Aon');
    if (showRoadLabels) rules.push('s.t%3A3%7Cs.e%3Al%7Cp.v%3Aon', 's.t%3A49%7Cs.e%3Al%7Cp.v%3Aon');
    return rules.join(',');
  };
  // Labels are NOT baked into the basemap tiles: they render on a separate
  // transparent overlay (lyrs=h with all geometry hidden) layered ABOVE the
  // drive lines, so city and street names stay readable over dense route
  // areas. The base tiles get every label stripped instead.
  const ALL_LABELS_OFF = 's.e%3Al%7Cp.v%3Aoff';
  const gmapsUrls = () => ({
    'Dark': `https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&apistyle=${GMAPS_NIGHT_RULES},${ALL_LABELS_OFF}`,
    'Light': `https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&apistyle=${ALL_LABELS_OFF}`,
    'Satellite': `https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}`,
  });
  // Dark re-applies the night label colors on the overlay (white text with
  // a dark halo); Light/Satellite keep lyrs=h's default label styling.
  const NIGHT_LABEL_TEXT = 's.e%3Al.t.f%7Cp.c%3A%23ffffff,s.e%3Al.t.s%7Cp.c%3A%23242f3e';
  const gmapsLabelOverlayUrl = () => {
    const rules = [];
    if (currentBaseLayer === 'Dark') rules.push(NIGHT_LABEL_TEXT);
    rules.push('s.e%3Ag%7Cp.v%3Aoff', gmapsLabelRules());
    return `https://mt1.google.com/vt/lyrs=h&x={x}&y={y}&z={z}&apistyle=${rules.join(',')}`;
  };
  // Migrate layer choices saved under the old names.
  const LAYER_RENAMES = { 'Google Maps': 'Light', 'Google Dark': 'Dark' };
  let savedLayer = localStorage.getItem('mapLayer');
  if (LAYER_RENAMES[savedLayer]) {
    savedLayer = LAYER_RENAMES[savedLayer];
    localStorage.setItem('mapLayer', savedLayer);
  }
  // Display order in the layer control: Light, Dark, Satellite.
  const LAYER_NAMES = ['Light', 'Dark', 'Satellite'];
  let currentBaseLayer = LAYER_NAMES.includes(savedLayer) ? savedLayer : 'Light';

  map = new maplibregl.Map({
    container: 'map',
    center: [10.0, 50.0], // central Europe until drive data loads ([lng, lat])
    zoom: 4,
    maxZoom: 20,
    attributionControl: { compact: false },
    // The old map was flat — keep it that way (no right-drag rotate/pitch).
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
      // The labels-overlay LAYER is added in the 'load' handler, after the
      // route layers, so labels draw above the drive lines.
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
    },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

  // Swap raster tiles in place (layer switch / labels toggle).
  const setRasterTiles = (sourceId, url, beforeLayerId) => whenMapReady(() => {
    const src = map.getSource(sourceId);
    if (src && typeof src.setTiles === 'function') {
      src.setTiles([url]);
      return;
    }
    // Fallback for older MapLibre builds: rebuild the raster source at its
    // place in the layer order.
    if (map.getLayer(sourceId)) map.removeLayer(sourceId);
    if (src) map.removeSource(sourceId);
    map.addSource(sourceId, {
      type: 'raster', tiles: [url], tileSize: 256, maxzoom: 20,
      ...(sourceId === 'basemap' ? { attribution: '&copy; Google' } : {}),
    });
    map.addLayer({ id: sourceId, type: 'raster', source: sourceId }, beforeLayerId);
  });
  // Basemap sits under the route layers; the label overlay above them.
  const applyMapTiles = () => {
    setRasterTiles('basemap', gmapsUrls()[currentBaseLayer], 'overview-dim');
    setRasterTiles('labels-overlay', gmapsLabelOverlayUrl());
  };

  // Re-point both rasters when the label settings change.
  applyMapLabelsSetting = applyMapTiles;

  // Base-layer switcher: custom control replacing L.control.layers with the
  // same behavior (top right, collapsed to a layers icon, expands to the
  // radio list on hover — CSS-driven). Styled in styles.css.
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

  // Route sources/layers go in once the style is ready; route data flows
  // through whenMapReady so a drive file that loads faster than the style
  // isn't lost.
  map.on('load', () => {
    map.addSource('overview', { type: 'geojson', data: EMPTY_FC });
    map.addSource('selected-route', { type: 'geojson', data: EMPTY_FC });
    map.addSource('selected-traveled', { type: 'geojson', data: EMPTY_FC });
    // Dim-grey context lines under a selected drive (hidden in overview mode).
    map.addLayer({
      id: 'overview-dim', type: 'line', source: 'overview',
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
      paint: { 'line-color': '#555566', 'line-opacity': 1, 'line-width': OVERVIEW_LINE_WIDTH },
    });
    // Imported drives: purple dashed (dasharray is in line-width units).
    // Added BEFORE the native layer so dashcam lines paint on top, and kept
    // faint/thin — a dense imported history was drowning out the real
    // drive-data lines.
    map.addLayer({
      id: 'overview-imported', type: 'line', source: 'overview',
      filter: ['==', ['get', 'imported'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#a855f7', 'line-opacity': 0.25, 'line-width': OVERVIEW_IMPORTED_LINE_WIDTH, 'line-dasharray': [2.4, 1.6] },
    });
    map.addLayer({
      id: 'overview-native', type: 'line', source: 'overview',
      filter: ['!=', ['get', 'imported'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#3b82f6', 'line-opacity': 0.5, 'line-width': OVERVIEW_LINE_WIDTH },
    });
    // Selected drive on top: per-segment colors via feature properties;
    // dashes can't be data-driven, hence the solid/dashed layer pair.
    // The base route renders DIMMED (colorDim) — the not-yet-traveled state.
    // The 'selected-traveled' overlay above it grows behind the replay marker
    // in the normal colors, revealing the route as it's driven (or scrubbed).
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
    // City/street labels above every drive line (transparent overlay tiles).
    map.addLayer({ id: 'labels-overlay', type: 'raster', source: 'labels-overlay' });
    mapReady = true;
    for (const fn of pendingMapTasks.splice(0)) fn();
  });

  const mapStatsEl = document.getElementById('map-stats');
  if (mapStatsEl) {
    mapStatsEl.addEventListener('click', (e) => {
      // Don't toggle when interacting with the tag editor inside the panel.
      if (e.target.closest('.map-stats-tags')) return;
      mapStatsEl.classList.toggle('expanded');
    });
  }

  window.addEventListener('resize', () => map.resize());

  // The replay marker's CSS transition smooths its point-to-point steps,
  // but MapLibre repositions markers through the same transform on every
  // map frame — while the user pans/zooms, the eased marker visibly slides
  // off the route and catches up afterwards. Suspend the easing for the
  // whole gesture (movestart→moveend covers drags incl. inertia, zooms,
  // and programmatic fitBounds animations alike).
  map.on('movestart', () => {
    mapInteracting = true;
    const el = replayMarker?.getElement();
    if (el) el.style.transition = 'none';
  });
  map.on('moveend', () => { mapInteracting = false; });

  // Drive selection: GPU hit-test the route layers within a 10px box around
  // the click (replaces the old delegated nearest-segment search). Hidden
  // layers return no features, so "Hide other drives" needs no special case;
  // features come back topmost-first, so the selected drive's own line wins
  // over dimmed context lines (clicking it toggles the selection off, same
  // as clicking the drive in the list).
  map.on('click', (e) => {
    if (!mapReady) return;
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

  document.getElementById('btn-back-overview').addEventListener('click', (e) => {
    e.stopPropagation();
    deselectDrive();
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      setTimeout(() => map.resize(), 50);
    });
  });
}

// ─── Footer & Settings ───────────────────────────────────────────────────────
let updateState = 'idle'; // idle | checking | available | downloading | ready | error
let updateSkipped = false; // true after user dismisses the update modal this session
let pendingVersion = '';   // version string from the 'available' event
let pendingRemoveDrive = null;

function initFooter() {
  // GitHub link opens in external browser
  document.getElementById('link-github').addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://github.com/JeffFromTheIRS/Sentry-Drive');
  });

  // Settings modal
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.remove('hidden');
    refreshTessieStatus();
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.add('hidden');
  });
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('settings-overlay').classList.add('hidden');
    }
  });

  // Settings tabs (scoped classes so they don't collide with the main tab bar).
  // The last-active tab persists across opens (no reset on open).
  document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stab = btn.dataset.stab;
      document.querySelectorAll('.settings-tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.settings-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`stab-${stab}`).classList.add('active');
    });
  });

  // ── Integrations tab: Tessie (inline connect/auth) ─────────────────────
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

  // Paint the card for the current connection state (connected → token + import,
  // disconnected → connect form). Drives the header status pill too.
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

  // Import is launched from the View Drives tab → "Import Drives" (which opens
  // the service-aware import modal). Integrations is token management only.

  refreshTessieStatus();

  // ── Integrations tab: Teslascope (connect-only for now) ────────────────
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
      // API keys live under Account → Security.
      if (window.electronAPI) window.electronAPI.openExternal('https://teslascope.com/account/security');
    });
  }

  refreshTeslascopeStatus();

  // Version display
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

  // Listen for update events from main process
  window.electronAPI.onUpdateStatus(onUpdateStatus);

  // Settings "Check for Update" button
  document.getElementById('btn-check-update').addEventListener('click', () => {
    if (updateState === 'available') {
      window.electronAPI.downloadUpdate();
    } else if (updateState === 'ready') {
      window.electronAPI.installUpdate();
    } else if (updateState === 'idle' || updateState === 'error') {
      // Show "Checking…" immediately (not when main answers) so the click
      // always visibly does something, and arm the no-answer watchdog.
      beginUpdateCheckUI();
      window.electronAPI.checkForUpdate();
    }
  });

  // Update modal buttons
  document.getElementById('btn-update-now').addEventListener('click', () => {
    document.getElementById('update-overlay').classList.add('hidden');
    window.electronAPI.downloadUpdate();
  });
  document.getElementById('btn-update-skip').addEventListener('click', () => {
    updateSkipped = true;
    document.getElementById('update-overlay').classList.add('hidden');
  });

  // Footer download button
  document.getElementById('btn-footer-update').addEventListener('click', () => {
    if (updateState === 'available') {
      window.electronAPI.downloadUpdate();
    } else if (updateState === 'ready') {
      window.electronAPI.installUpdate();
    }
  });

  // Beta checkbox
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

    // Re-check for updates with new prerelease setting
    window.electronAPI.checkForUpdate();
  });

  // Vehicle marker type + color
  const selMarkerType   = document.getElementById('sel-marker-type');
  const vehicleColorRow = document.getElementById('vehicle-color-row');
  const vehiclePreview  = document.getElementById('vehicle-preview-wrap');

  const syncVehicleUI = () => {
    const isModel3 = markerType === 'model3';
    vehicleColorRow.classList.toggle('hidden', !isModel3);
    vehiclePreview.classList.toggle('hidden', !isModel3);
  };

  selMarkerType.value = markerType;
  syncVehicleUI();

  // Lazy-init iro color wheel — only once
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
      scheduleMarkerColorUpdate(color.hexString);
    });

    hexInput.addEventListener('input', () => {
      const val = hexInput.value;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        carColorPicker.color.hexString = val;
        scheduleMarkerColorUpdate(val);
      }
    });

    document.getElementById('btn-car-color-close').addEventListener('click', () => {
      document.getElementById('car-color-popup').classList.add('hidden');
    });
  }

  const swatch = document.getElementById('btn-car-color-swatch');
  swatch.style.background = markerColor;
  swatch.addEventListener('click', () => {
    const popup = document.getElementById('car-color-popup');
    const rect  = swatch.getBoundingClientRect();
    popup.style.top  = `${rect.bottom + 8}px`;
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
    popup.classList.toggle('hidden');
  });

  if (markerType === 'model3') applyMarkerColor(markerColor);

  selMarkerType.addEventListener('change', async () => {
    markerType = selMarkerType.value;
    localStorage.setItem('markerType', markerType);
    syncVehicleUI();
    // Ensure the model3 texture is ready before rebuilding the icon — otherwise
    // buildMarkerHtml falls back to the arrow.
    if (markerType === 'model3') await applyMarkerColor(markerColor);
    refreshReplayMarkerIcon();
  });

  // "Show other drives when viewing a drive" — inverted presentation of the
  // stored hideOtherDrives flag, so existing preferences carry over as-is.
  const showOthersChk = document.getElementById('chk-show-other-drives');
  hideOtherDrives = localStorage.getItem('hideOtherDrives') === 'true';
  showOthersChk.checked = !hideOtherDrives;
  showOthersChk.addEventListener('change', () => {
    hideOtherDrives = !showOthersChk.checked;
    localStorage.setItem('hideOtherDrives', String(hideOtherDrives));
    applyOtherDrivesVisibility();
  });

  // FSD markers setting (default: on)
  const fsdMarkersChk = document.getElementById('chk-show-fsd-markers');
  showFsdMarkers = localStorage.getItem('showFsdMarkers') !== 'false';
  fsdMarkersChk.checked = showFsdMarkers;
  fsdMarkersChk.addEventListener('change', () => {
    showFsdMarkers = fsdMarkersChk.checked;
    localStorage.setItem('showFsdMarkers', String(showFsdMarkers));
    applyFsdMarkerVisibility();
  });

  // Support → Logs: save the main-process log buffer as a .txt via save dialog.
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
        // e.g. the main process predates the download-logs handler
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

  // Same default-follow logic as initMap: unset road labels mirror the
  // city-labels choice so pre-toggle opt-outs keep a label-free map.
  const roadLabelsChk = document.getElementById('chk-show-road-labels');
  const savedRoadLabelsChoice = localStorage.getItem('showRoadLabels');
  showRoadLabels = savedRoadLabelsChoice != null ? savedRoadLabelsChoice !== 'false' : showMapLabels;
  roadLabelsChk.checked = showRoadLabels;
  roadLabelsChk.addEventListener('change', () => {
    showRoadLabels = roadLabelsChk.checked;
    localStorage.setItem('showRoadLabels', String(showRoadLabels));
    applyMapLabelsSetting();
  });

  // Auto-load drive data setting (default: true, preserve existing behavior for existing users)
  const autoLoadChk = document.getElementById('chk-autoload-drive-data');
  autoLoadChk.checked = localStorage.getItem('autoLoadDriveData') !== 'false';
  autoLoadChk.addEventListener('change', () => {
    localStorage.setItem('autoLoadDriveData', String(autoLoadChk.checked));
  });

  // Unit system toggle
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
  });

  // Auto-check on launch
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
    window.electronAPI.openExternal('https://github.com/JeffFromTheIRS/Sentry-Drive/releases');
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

// User-initiated checks: remember when the check started so the result can be
// held back until "Checking…" was visible long enough to register (a fast
// server answers in ~200 ms — an imperceptible flicker), and arm a watchdog so
// a hung network can't leave the button stuck on "Checking…" forever.
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
  // Hold a too-fast answer so the Checking… state is perceptible.
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
      pendingVersion = version;

      // Settings panel
      btn.textContent = 'Update';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = `New update available (v${version})`;
      msg.className = 'settings-update-msg update-available';

      // Show update modal if user hasn't skipped this session
      if (!updateSkipped) {
        document.getElementById('update-modal-msg').textContent =
          `Version ${version} is ready to install.`;
        document.getElementById('update-overlay').classList.remove('hidden');
        populateUpdateModalChanges(version);
      }

      // Show footer download button, flashing yellow until acted on
      footerBtn.classList.remove('hidden');
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
      break;

    case 'downloading':
      btn.textContent = `Downloading… ${percent}%`;
      btn.disabled = true;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = `Downloading update…`;
      msg.className = 'settings-update-msg update-available';

      footerBtn.classList.remove('update-attention');
      footerBtn.disabled = true;
      footerBtn.title = `Downloading… ${percent}%`;
      break;

    case 'ready':
      btn.textContent = 'Restart to Update';
      btn.disabled = false;
      btn.className = 'btn-primary btn-update-full';
      msg.textContent = 'Update downloaded. Restart to apply.';
      msg.className = 'settings-update-msg update-available';

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

  // Reset and arm the progress bar. It stays hidden until the first
  // load-progress event arrives (avoids flashing an empty bar for actions
  // that don't emit progress, like tag edits that re-render but don't load).
  const progressEl = document.getElementById('load-progress');
  const barEl = document.getElementById('load-bar');
  const detailEl = document.getElementById('load-detail');
  if (progressEl) {
    progressEl.classList.add('hidden');
    if (barEl) barEl.style.width = '0%';
    if (detailEl) detailEl.textContent = '';
  }

  // Subscribe to load progress; auto-unsubscribed in hideLoading.
  if (loadProgressUnsubscribe) { loadProgressUnsubscribe(); loadProgressUnsubscribe = null; }
  loadProgressUnsubscribe = window.electronAPI.onLoadProgress?.(({ phase, current, total }) => {
    if (progressEl?.classList.contains('hidden')) progressEl.classList.remove('hidden');
    if (phase === 'reading') {
      // Map bytes 0..total to bar width 0..90% so grouping/preparing have
      // visible headroom for the final push.
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
function initProcessingTab() {
  const clipsDirInput = document.getElementById('clips-dir');

  // Restore last used folders
  const savedClipsDir = localStorage.getItem('lastClipsDir');
  if (savedClipsDir) clipsDirInput.value = savedClipsDir;

  const savedOutputDir = localStorage.getItem('lastOutputDir');
  if (savedOutputDir) document.getElementById('output-path').value = savedOutputDir;

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

  // Worker slider
  const slider = document.getElementById('worker-count');
  const display = document.getElementById('worker-count-display');
  slider.addEventListener('input', () => { display.textContent = slider.value; });
  document.getElementById('btn-auto-workers').addEventListener('click', () => {
    const optimal = Math.max(1, cpuCount - 1);
    slider.value = optimal;
    display.textContent = optimal;
  });

  // Load CPU count and set slider defaults
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

  // Auto-load drive-data if enabled (default: true) and we have a saved path or can find one in the output dir
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

async function autoLoadDriveData(filePath) {
  showLoading();
  try {
    const result = await window.electronAPI.loadAndGroupDrives(filePath);
    if (!result.success) { hideLoading(); return; }

    loadedFilePath = filePath;
    localStorage.setItem('lastDriveDataPath', filePath);
    drives = result.drives;
    overviewRoutes = result.overviewRoutes ?? [];
    refreshAllTags(result.driveTags ?? {});
    renderTagFilter();
    renderDriveStats(drives, result);
    renderDriveList(drives);
    renderOverviewOnMap();
    document.getElementById('btn-repair-gps').disabled = false;
    updateRevertButton();
    updateTessieButtonStates();

    // Switch to drives tab
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    document.querySelector('[data-tab="drives"]').classList.add('active');
    document.getElementById('tab-drives').classList.add('active');
    setTimeout(() => map.resize(), 50);
  } catch {
    // File may no longer exist — clear saved path
    localStorage.removeItem('lastDriveDataPath');
  }
  hideLoading();
}

async function startProcessing({ reprocessAll = false } = {}) {
  const clipsDir   = document.getElementById('clips-dir').value.trim();
  const outputDir  = document.getElementById('output-path').value.trim();

  if (!clipsDir)  { alert('Please select a clips directory.'); return; }
  if (!outputDir) { alert('Please select an output directory.'); return; }
  localStorage.setItem('lastClipsDir', clipsDir);
  localStorage.setItem('lastOutputDir', outputDir);

  // Check whether drive-data.json already exists in the output directory
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

  // Reset UI
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

  // Simulate terminal \r: take last segment after each \r per line
  const lines = text
    .split('\n')
    .map((seg) => seg.split('\r').pop())
    .filter((l) => l.trim() !== '');

  for (const line of lines) {
    if (/^SCAN \d+\/\d+$/.test(line.trim())) continue;
    appendLogLine(line, type === 'stderr' ? 'error' : 'normal');
  }

  // Phase 1 — directory scan: "SCAN N/M" → 0–100%
  const scanMatch = text.match(/SCAN (\d+)\/(\d+)/);
  if (scanMatch) {
    const pct = Math.round((parseInt(scanMatch[1], 10) / parseInt(scanMatch[2], 10)) * 100);
    document.getElementById('progress-phase').textContent = 'Scanning…';
    updateProgressBar(pct);
  }

  // Phase 2 — GPS extraction: "(N%)" → 0–100% (resets bar)
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
  initTessieImport();

  const checkOverlay = document.getElementById('check-drives-overlay');
  document.getElementById('btn-repair-gps').addEventListener('click', () => {
    if (!loadedFilePath) return;
    checkOverlay.classList.remove('hidden');
  });
  document.getElementById('btn-check-drives-confirm').addEventListener('click', () => {
    checkOverlay.classList.add('hidden');
    repairGPS();
  });
  document.getElementById('btn-check-drives-cancel').addEventListener('click', () => {
    checkOverlay.classList.add('hidden');
  });
  checkOverlay.addEventListener('click', (e) => {
    if (e.target === checkOverlay) checkOverlay.classList.add('hidden');
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
    const result = await window.electronAPI.removeDrive({ filePath: loadedFilePath, driveStartTime: drive.startTime });
    if (!result.success) return;
    const wasSelected = selectedDriveId === drive.id;
    drives = drives.filter((d) => d.startTime !== drive.startTime);
    if (wasSelected) deselectDrive();
    renderDriveList(drives);
    // Redraw the map so the deleted drive's polyline is removed immediately —
    // renderOverviewOnMap() clears all layers and rebuilds from `drives`.
    // Without this the line lingered until the next map render (e.g. selecting
    // another drive).
    renderOverviewOnMap();
    renderDriveStats(drives, { totalRoutes: 0, processedFileCount: 0 });
    updateTessieButtonStates();
  });
}

// ─── Tessie Import ───────────────────────────────────────────────────────────
let tessieProgressListener = null;
let tessieDrivesPath = '';
let tessieStatesPath = '';
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

  // Connected-service registry. The modal routes every call through the
  // selected service; tokens live in Settings → Integrations (not entered here).
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

  // Populate the dropdown with CONNECTED services (token saved in Integrations).
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

  // CSV tab only shows for services that support it (Tessie today).
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
        const r = await svc().getToken(); // local IPC — fast
        tokenInput.value = (r && r.token) || '';
        // Not awaited: cached vehicles render instantly; fresh ones stream in.
        if (tokenInput.value) validateApiToken(true);
      } catch {}
    });
  }

  const resetModal = () => {
    tessieDrivesPath = '';
    tessieStatesPath = '';
    drivesInput.value = '';
    statesInput.value = '';
    previewEl.classList.add('hidden');
    previewEl.innerHTML = '';
    progressEl.classList.add('hidden');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Import';
    closeBtn.title = 'Close';
  };

  // Mode toggle
  document.querySelectorAll('.tessie-mode-btn').forEach((b) => {
    b.addEventListener('click', () => {
      // Re-clicking the active tab is a no-op (CSS also disables pointer
      // events on the active tab).
      if (b.dataset.mode === tessieImportMode) return;
      tessieImportMode = b.dataset.mode;
      document.querySelectorAll('.tessie-mode-btn').forEach((x) => x.classList.toggle('active', x === b));
      document.getElementById('tessie-mode-api').classList.toggle('hidden', tessieImportMode !== 'api');
      document.getElementById('tessie-mode-csv').classList.toggle('hidden', tessieImportMode !== 'csv');
      previewEl.classList.add('hidden');
      previewEl.innerHTML = '';
      refreshConfirmReady();
    });
  });

  // Default date range: last 90 days
  const today = new Date();
  const ninetyAgo = new Date(today.getTime() - 90 * 24 * 3600 * 1000);
  const fmtDate = (d) => d.toISOString().slice(0, 10);
  fromInput.value = fmtDate(ninetyAgo);
  toInput.value = fmtDate(today);

  // Open link in external browser
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

  // Validate API token (load vehicles + save token)
  document.getElementById('tessie-api-validate').addEventListener('click', () => validateApiToken(false));
  tokenInput.addEventListener('change', () => validateApiToken(false));
  // No background querying: changing dates or the vehicle only re-evaluates
  // whether Import can be clicked — the service API is contacted when the
  // user clicks Import, not before.
  [fromInput, toInput, vinSelect].forEach((el) => el.addEventListener('change', refreshConfirmReady));

  // Clicking a date field opens the native calendar picker (typing still
  // works — keyboard edits update the segments as before).
  [fromInput, toInput].forEach((el) => {
    el.addEventListener('click', () => {
      if (typeof el.showPicker === 'function') {
        try { el.showPicker(); } catch { /* non-gesture or unsupported — typing still works */ }
      }
    });
  });

  // Vehicles per service, cached for the session: switching services renders
  // the dropdown instantly from cache while a background refresh runs. The
  // sequence counter discards stale responses when the user switches faster
  // than the network answers.
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
      // Instant path — then quietly refresh the cache.
      fill(cached);
      refreshConfirmReady();
      svc().validate(token).then((result) => {
        if (seq !== validateSeq || selectedService !== service) return;
        if (result.success && result.vehicles && result.vehicles.length) {
          // Refill only when the list actually changed — rebuilding the
          // options closes the dropdown if the user has it open right then.
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
    if (seq !== validateSeq || selectedService !== service) return; // superseded
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

  // Import enables as soon as the inputs are valid. The query that used to
  // gate it runs on the Import click itself — a "nothing to import" result
  // aborts the import with the explanation on screen.
  function refreshConfirmReady() {
    if (tessieImportMode === 'api') {
      confirmBtn.disabled = !(tokenInput.value.trim() && vinSelect.value && !vinSelect.disabled);
    } else {
      confirmBtn.disabled = !(tessieDrivesPath && tessieStatesPath);
    }
  }

  // Stale-response guard: each query claims a sequence number; a newer click
  // supersedes any still-in-flight result.
  let previewSeq = 0;

  // Runs the drives query and renders the result lines. Called ONLY from the
  // Import click — the modal never contacts the service API in the background
  // (vehicles load once on open; everything else waits for the user).
  async function runImportQuery(args) {
    const seq = ++previewSeq;
    previewEl.classList.remove('hidden');
    let result;
    if (tessieImportMode === 'api') {
      previewEl.innerHTML = `<em>Querying ${escapeHtml(svc().label)} API…</em>`;
      result = await svc().preview(args);
    } else {
      previewEl.innerHTML = '<em>Scanning CSVs…</em>';
      result = await svc().csvPreview(args);
    }
    if (seq !== previewSeq) return null; // superseded by a newer click
    if (!result.success) {
      previewEl.innerHTML = `<span style="color:#f87171">Query failed: ${escapeHtml(result.error)}</span>`;
      return null;
    }
    renderPreview(result);
    return result;
  }

  function renderPreview(result) {
    const parts = [];
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

    // Snapshot the inputs once so the query and the import describe the same
    // request even if fields change while the query runs.
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
    } else {
      if (!tessieDrivesPath || !tessieStatesPath) return;
      args = {
        driveDataPath: loadedFilePath,
        drivesCsvPath: tessieDrivesPath,
        statesCsvPath: tessieStatesPath,
      };
    }

    // The drives query runs now — on the click, never in the background.
    // A failed query or "nothing to import" stops here with the explanation
    // on screen; so does closing the modal or switching service/mode mid-check.
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

    const beforeCount = drives.length;

    confirmBtn.textContent = 'Importing…';
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
    tessieProgressListener = svc().onProgress(({ phase, current, total, etaSec }) => {
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
      }
    });

    let result;
    if (modeAtClick === 'api') {
      result = await svc().runImport(args);
    } else {
      result = await svc().csvImport(args);
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
    const lines = [];
    lines.push(result.canceled
      ? `Import canceled. ${fmt(result.imported)} drive(s) written before cancel.`
      : `Imported ${fmt(result.imported)} ${escapeHtml(svc().label)} drive(s).`);
    lines.push('');
    lines.push(`Drive count: ${fmt(beforeCount)} → ${fmt(afterCount)} (+${fmt(visibleAdded)})`);
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
        const cleanupResult = await svc().removeHidden();
        if (cleanupResult.success) {
          await reloadDrivesAfterWrite();
          alert(`Removed ${fmt(cleanupResult.removed)} hidden imported drive(s) from the file.`);
        } else {
          alert(`Cleanup failed: ${cleanupResult.error}`);
        }
      }
    } else {
      alert(lines.join('\n'));
    }
  });

  // Remove imported drives handlers
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
    // Destructive modal always opens in a predictable state: both selected.
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
    // The visible delta is smaller when some removed drives were already
    // hidden behind overlapping dashcam (SEI) drives.
    if (removed > beforeCount - afterCount) {
      lines.push('', `${fmt(removed - (beforeCount - afterCount))} of them were hidden behind dashcam drives and not shown in the list.`);
    }
    for (const f of failures) lines.push('', `Cleanup failed — ${f}`);
    alert(lines.join('\n'));
  });
}

async function reloadDrivesAfterWrite() {
  if (!loadedFilePath) return;
  showLoading();
  try {
    const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
    if (reloaded.success) {
      drives = reloaded.drives;
      overviewRoutes = reloaded.overviewRoutes ?? [];
      refreshAllTags(reloaded.driveTags ?? {});
      renderTagFilter();
      renderDriveStats(drives, reloaded);
      renderDriveList(drives);
      renderOverviewOnMap();
      updateRevertButton();
      updateTessieButtonStates();
    }
  } finally {
    hideLoading();
  }
}

// Imported (non-dashcam) drives — Tessie, Teslascope, and future services.
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

  const result = await window.electronAPI.revertGPS(loadedFilePath);
  if (!result.success) {
    alert(`Failed to revert:\n${result.error}`);
    return;
  }

  // Reload
  showLoading();
  const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
  if (reloaded.success) {
    drives = reloaded.drives;
    overviewRoutes = reloaded.overviewRoutes ?? [];
    refreshAllTags(reloaded.driveTags ?? {});
    renderTagFilter();
    renderDriveStats(drives, reloaded);
    renderDriveList(drives);
    renderOverviewOnMap();
  }
  hideLoading();
  alert('Reverted to backup successfully.');
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
    // Check connectivity for road-snapped bridging
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

    // Show progress bar
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
      alert(`Failed to repair GPS data:\n${result.error}`);
      return;
    }

    const msgs = [];
    if (result.removedBridges > 0) msgs.push(`Removed ${result.removedBridges} old bridge route(s)`);
    if (result.routedGaps > 0) msgs.push(`Bridged ${result.routedGaps} gap(s) with road routes`);
    const straightGaps = result.bridgedGaps - (result.routedGaps ?? 0);
    if (straightGaps > 0) msgs.push(`Bridged ${straightGaps} gap(s) with straight lines`);
    alert(msgs.length > 0 ? `Repair complete:\n${msgs.join('\n')}` : 'No issues found.');

    // Reload the repaired file
    showLoading();
    const reloaded = await window.electronAPI.loadAndGroupDrives(loadedFilePath);
    if (reloaded.success) {
      drives = reloaded.drives;
      overviewRoutes = reloaded.overviewRoutes ?? [];
      refreshAllTags(reloaded.driveTags ?? {});
      renderTagFilter();
      renderDriveStats(drives, reloaded);
      renderDriveList(drives);
      renderOverviewOnMap();
    }
    hideLoading();
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

    loadedFilePath = filePath;
    localStorage.setItem('lastDriveDataPath', filePath);
    drives = result.drives;
    overviewRoutes = result.overviewRoutes ?? [];
    refreshAllTags(result.driveTags ?? {});
    renderTagFilter();
    renderDriveStats(drives, result);
    renderDriveList(drives);
    renderOverviewOnMap();
    document.getElementById('btn-repair-gps').disabled = false;
    updateRevertButton();
    updateTessieButtonStates();
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
      // Re-render the selected drive directly — skip the aggregate render
      // so the panel doesn't flash overview stats on the way through.
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
        showTagSuggestions(drive, '');   // show all available tags as bubbles
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

function renderSelectedDriveStats(drive) {
  const isTessie = isImportedSource(drive.source); // any imported service
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
    <div class="map-stat"><span class="map-stat-val" style="color:${fsdScoreColor(fsdPct)}">${fsdPct}%</span><span class="map-stat-lbl">${isTessie ? 'FSD*' : 'FSD Usage'}</span></div>
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

  const slices = [];
  if (fsdDistM > 0)    slices.push({ color: '#22cc55',                    pct: (fsdDistM / totalDistM) * 100 });
  if (apDistM > 0)     slices.push({ color: 'var(--ap-blue, #3e6ae1)', pct: (apDistM / totalDistM) * 100 });
  if (taccDistM > 0)   slices.push({ color: '#f59e0b',                    pct: (taccDistM / totalDistM) * 100 });
  if (manualDistM > 0) slices.push({ color: 'rgba(148, 163, 184, 0.55)',  pct: (manualDistM / totalDistM) * 100 });

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
            <span class="map-stats-chart-val" style="color:${fsdScoreColor(fsdPct)}">${fsdScoreLabel(fsdPct)}</span>
            <span class="map-stats-chart-lbl" style="color:${fsdScoreColor(fsdPct)}">${fsdPct}%</span>
          </div>
        </div>
        <div class="map-stats-legend">
          ${fsdDistM > 0    ? detailsRow('Full Self-Driving', 'mode-fsd',    metersToDistStr(fsdDistM),    fsdPct)    : ''}
          ${manualDistM > 0 ? detailsRow('Manual',            'mode-manual', metersToDistStr(manualDistM), manualPct) : ''}
        </div>
      </div>
      <div class="map-stats-tessie-note">
        *Imported from Tessie. Excluded from aggregate FSD score and
        disengagement counts (those use dashcam telemetry only).
      </div>
    `;
  } else if (slices.length > 0) {
    details += `
      <div class="map-stats-chart-wrap">
        <div class="map-stats-chart" style="--donut-bg: conic-gradient(${gradientStops});">
          <div class="map-stats-chart-center">
            <span class="map-stats-chart-val" style="color:${fsdScoreColor(fsdPct)}">${fsdScoreLabel(fsdPct)}</span>
            <span class="map-stats-chart-lbl" style="color:${fsdScoreColor(fsdPct)}">${fsdPct}%</span>
          </div>
        </div>
        <div class="map-stats-legend">
          ${fsdDistM > 0    ? detailsRow('Full Self-Driving', 'mode-fsd',    metersToDistStr(fsdDistM),    fsdPct)    : ''}
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

function fsdScoreColor(pct) {
  // Smooth red → amber → green gradient in HSL (0°=red, 120°=green).
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
    /* silent — modal just shows without the changelog section */
  }
}

function renderDriveStats(drives, meta) {
  lastDrivesMeta = meta;
  // Top-line counters (drives / miles / duration) include imported drives —
  // those are ground truth from the service regardless of dashcam coverage.
  // FSD analytics (FSD%, AP%, TACC%, disengagements, accel overrides) use
  // SEI-only data because imported services' per-point autopilot data is
  // fuzzier than the dashcam's SEI telemetry (Teslascope's is often absent
  // entirely) — mixing them would dilute the score.
  const seiDrives = drives.filter((d) => !isImportedSource(d.source));
  const tessieCount = drives.length - seiDrives.length;

  const totalMi = drives.reduce((s, d) => s + d.distanceMi, 0);
  const totalMs = drives.reduce((s, d) => s + d.durationMs, 0);
  // D H M — lifetime totals routinely exceed 24h, so days carry the size.
  const totalDays = Math.floor(totalMs / 86_400_000);
  const totalHrs = Math.floor((totalMs % 86_400_000) / 3_600_000);
  const totalMin = Math.floor((totalMs % 3_600_000) / 60_000);
  const durStr = totalDays > 0
    ? `${totalDays}D ${totalHrs}H ${totalMin}M`
    : (totalHrs > 0 ? `${totalHrs}H ${totalMin}M` : `${totalMin}M`);

  // FSD analytics denominator: SEI-only distance.
  const seiDistM = seiDrives.reduce((s, d) => s + (d.distanceKm ?? d.distanceMi * MI_TO_KM) * 1000, 0);
  const fsdDistM = seiDrives.reduce((s, d) => s + (d.fsdDistanceKm ?? d.fsdDistanceMi * MI_TO_KM) * 1000, 0);
  const apDistM = seiDrives.reduce((s, d) => s + (d.autosteerDistanceKm ?? (d.autosteerDistanceMi ?? 0) * MI_TO_KM) * 1000, 0);
  const taccDistM = seiDrives.reduce((s, d) => s + (d.taccDistanceKm ?? (d.taccDistanceMi ?? 0) * MI_TO_KM) * 1000, 0);
  const fsdPct = seiDistM > 0 ? Math.round((fsdDistM / seiDistM) * 100) : 0;
  const apPct = seiDistM > 0 ? Math.round((apDistM / seiDistM) * 100) : 0;
  const taccPct = seiDistM > 0 ? Math.round((taccDistM / seiDistM) * 100) : 0;
  const manualDistM = Math.max(0, seiDistM - fsdDistM - apDistM - taccDistM);
  const manualPct = Math.max(0, 100 - fsdPct - apPct - taccPct);

  // For the donut chart denominator (locally rebound for clarity below).
  const totalDistM = seiDistM;

  const disengagements = seiDrives.reduce((s, d) => s + (d.fsdDisengagements ?? 0), 0);
  const accelOverrides = seiDrives.reduce((s, d) => s + (d.fsdAccelPushes ?? 0), 0);
  const fsdTimeMs = seiDrives.reduce((s, d) => s + (d.fsdEngagedMs ?? 0), 0);
  const avgDisengagements = seiDrives.length > 0 ? (disengagements / seiDrives.length).toFixed(1) : '—';
  const avgAccelOverrides = seiDrives.length > 0 ? (accelOverrides / seiDrives.length).toFixed(1) : '—';

  const metersToDistStr = (m) => fmt(distVal(m / M_PER_MILE, 0));

  let summary = `
    <div class="map-stat"><span class="map-stat-val">${fmt(drives.length)}</span><span class="map-stat-lbl">Drives</span></div>
    <div class="map-stat"><span class="map-stat-val">${fmt(distVal(totalMi, 0))}</span><span class="map-stat-lbl">${distLong()} Driven</span></div>
    <div class="map-stat"><span class="map-stat-val">${durStr}</span><span class="map-stat-lbl">Time Driving</span></div>
    <div class="map-stat"><span class="map-stat-val" style="color:${fsdScoreColor(fsdPct)}">${fsdPct}%</span><span class="map-stat-lbl">FSD Score</span></div>
  `;
  if (apPct > 0) summary += `<div class="map-stat"><span class="map-stat-val">${apPct}%</span><span class="map-stat-lbl">Autopilot</span></div>`;

  const detailsRow = (label, cls, miles, pct) => `
    <div class="map-stats-row">
      <span class="map-stats-row-label ${cls}">${label}</span>
      <span class="map-stats-row-dist">${miles} ${distShort()}</span>
      <span class="map-stats-row-pct">${pct}%</span>
    </div>
  `;

  // Build the donut chart: cumulative conic-gradient stops using exact percentages.
  const slices = [];
  if (fsdDistM > 0)    slices.push({ color: '#22cc55',                    pct: (fsdDistM / totalDistM) * 100 });
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
            <span class="map-stats-chart-val" style="color:${fsdScoreColor(fsdPct)}">${fsdScoreLabel(fsdPct)}</span>
            <span class="map-stats-chart-lbl" style="color:${fsdScoreColor(fsdPct)}">${fsdPct}%</span>
          </div>
        </div>
        <div class="map-stats-legend">
          ${fsdDistM > 0    ? detailsRow('Full Self-Driving', 'mode-fsd',    metersToDistStr(fsdDistM),    fsdPct)    : ''}
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
  const avgFsdPct = seiDrives.length > 0 ? Math.round(seiDrives.reduce((s, d) => s + (d.fsdPercent ?? 0), 0) / seiDrives.length) : 0;
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

  const panel = document.getElementById('map-stats');
  panel.innerHTML = `
    <div class="map-stats-summary">${summary}<span class="map-stats-chevron material-icons">expand_less</span></div>
    <div class="map-stats-details">${details}</div>
  `;
  panel.classList.remove('hidden');
}

function renderDriveList(drives) {
  const list = document.getElementById('drives-list');
  list.innerHTML = '';

  if (drives.length === 0) {
    list.innerHTML = '<div class="empty-state">No drives found in this file.</div>';
    return;
  }

  // Reverse-chronological, filtered by active tag
  let sorted = [...drives].sort((a, b) => b.startTime.localeCompare(a.startTime));
  if (activeTagFilter) {
    sorted = sorted.filter((d) => (d.tags ?? []).includes(activeTagFilter));
  }

  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty-state">No drives match the selected filter.</div>';
    return;
  }

  let currentDate = '';
  for (const drive of sorted) {
    const driveDate = drive.startTime.slice(0, 10);
    if (driveDate !== currentDate) {
      currentDate = driveDate;
      const header = document.createElement('div');
      header.className = 'drive-date-header';
      header.textContent = formatDateHeader(driveDate);
      list.appendChild(header);
    }
    list.appendChild(buildDriveItem(drive));
  }
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

  // Battery % at each end of the drive (BLE telemetry rolled up by the
  // grouper), shown beside Departed/Arrived. Only drives recorded since the
  // Sentry USB BLE update carry it; older history and imports omit it.
  // Icon fill tracks the charge across the 7 glyphs the vendored font has
  // (battery_android_frame_1..6 + _full; no 0/7 frames), and the color
  // follows the car's convention: green, amber under 20%, red under 10%.
  const battBadge = (pct) => {
    if (pct == null) return '';
    const lvl = Math.round((pct / 100) * 6);
    const icon = lvl >= 6 ? 'battery_android_frame_full' : `battery_android_frame_${Math.max(1, lvl)}`;
    const tone = pct < 10 ? ' jt-batt--red' : pct < 20 ? ' jt-batt--amber' : '';
    return `<span class="jt-batt${tone}"><span class="material-icons">${icon}</span>${pct}%</span>`;
  };
  const battStart = battBadge(drive.batteryPctStart);
  const battEnd = battBadge(drive.batteryPctEnd);

  // Place name if already resolved, else GPS coords as a fallback until
  // reverse-geocoding fills it in (see applyDriveLocations). Escaped: names
  // come from outside the app (Tesla's geocoder via the data file, Nominatim)
  // and must never be interpreted as markup.
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
        <span class="ep-place ep-place--start" data-ep="origin">${startPlace}</span>
        <span class="ep-place ep-place--end" data-ep="dest">${endPlace}</span>
      </div>
    </div>
    ${disengageHtml}
    <div class="drive-chips">
      <span class="drive-chip"><span class="material-icons">straighten</span>${distVal(drive.distanceMi)} ${distShort()}</span>
      <span class="drive-chip"><span class="material-icons">schedule</span>${durStr}</span>
      ${fsdChip}
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

  // Remove drive button
  item.querySelector('.drive-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    pendingRemoveDrive = drive;
    const dateStr = new Date(drive.startTime).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    document.getElementById('remove-drive-modal-msg').textContent =
      `Remove the drive on ${dateStr} (${startTime} — ${endTime})? This cannot be undone.`;
    document.getElementById('remove-drive-overlay').classList.remove('hidden');
  });

  // Tag remove buttons
  item.querySelectorAll('.tag-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(drive, btn.dataset.tag);
    });
  });

  // Tag add button
  item.querySelector('.list-tag-add').addEventListener('click', (e) => {
    e.stopPropagation();
    const row = item.querySelector('.list-tag-input-row');
    const opened = !row.classList.toggle('hidden');
    if (opened) {
      const input = item.querySelector('.list-tag-input');
      input.value = '';
      input.focus();
      showListTagSuggestions(drive, item, '');   // show all available tags as bubbles
    } else {
      const sug = item.querySelector('.list-tag-suggestions');
      if (sug) { sug.classList.add('hidden'); sug.innerHTML = ''; }
    }
  });

  // Tag input
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

  item.addEventListener('click', () => selectDrive(drive));

  // Location pins: resolve start/end place names into the location line under
  // each Departed/Arrived header. Names cache on the drive object so re-renders
  // apply instantly; the main process caches across sessions.
  applyDriveLocations(item, drive);

  return item;
}

function endpointCoord(drive, which) {
  // Prefer the grouper's stationary-median snapped endpoint — computed from
  // the full-resolution filtered points (before they're stripped for IPC).
  // A single raw fix is the noisiest sample of the drive; the snapped point
  // averages the parked cluster at that end.
  const snapped = which === 'origin' ? drive.geocodeStartPoint : drive.geocodeEndPoint;
  if (Array.isArray(snapped) && typeof snapped[0] === 'number' && typeof snapped[1] === 'number') {
    return { lat: snapped[0], lng: snapped[1] };
  }
  // List drives only carry the downsampled overviewPoints (full points stay in
  // the main process); the downsample preserves the exact first/last point.
  const pts = Array.isArray(drive.points) && drive.points.length ? drive.points : drive.overviewPoints;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const p = which === 'origin' ? pts[0] : pts[pts.length - 1];
  if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number') return null;
  return { lat: p[0], lng: p[1] };
}

// GPS coords as a placeholder location until reverse-geocoding resolves a name.
function gpsLabel(drive, role) {
  const c = endpointCoord(drive, role);
  return c ? `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}` : '';
}

function setEndpointLabel(item, role, name) {
  const place = item.querySelector(`.ep-place[data-ep="${role}"]`);
  if (place) place.textContent = name;
}

function applyDriveLocations(item, drive) {
  const api = window.electronAPI;
  const resolve = (role) => {
    const cacheKey = role === 'origin' ? '_startName' : '_endName';
    if (drive[cacheKey]) { setEndpointLabel(item, role, drive[cacheKey]); return; }
    // Prefer the car's own label (Tesla-reverse-geocoded over BLE, rolled up
    // by the grouper exactly as Sentry USB Rusty does) — more accurate than
    // geocoding the noisy dashcam SEI endpoint, and zero network calls.
    // Nominatim below remains the fallback for pre-BLE / imported drives.
    const bleName = role === 'origin' ? drive.locationNameStart : drive.locationNameEnd;
    if (bleName) {
      drive[cacheKey] = bleName;
      setEndpointLabel(item, role, bleName);
      return;
    }
    const c = endpointCoord(drive, role);
    if (!c || !api || !api.reverseGeocode) return;
    api.reverseGeocode(c).then((res) => {
      const name = res && res.label;
      if (!name) return;
      drive[cacheKey] = name;
      if (item.isConnected) setEndpointLabel(item, role, name);
    }).catch(() => {});
  };
  resolve('origin');
  resolve('dest');
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

// Drop the lazy-loaded heavy fields from a drive so renderer memory doesn't
// grow unboundedly as the user clicks through many drives. The full detail
// stays cached in the main process and is refetched on next selection.
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
  // Toggle: clicking the same drive deselects it
  if (selectedDriveId === drive.id) {
    deselectDrive();
    return;
  }

  // Free the previously selected drive's heavy fields before swapping.
  freeDriveDetail(selectedDriveId);

  document.querySelectorAll('.drive-item').forEach((el) => el.classList.remove('selected'));
  const selectedEl = document.querySelector(`[data-drive-id="${drive.id}"]`);
  if (selectedEl) {
    selectedEl.classList.add('selected');
    selectedEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  selectedDriveId = drive.id;

  // Context lines: the overview layers dim everything to grey, hide the
  // selected drive's own line, or clear entirely per hideOtherDrives —
  // selectedDriveId is already set, so one style pass applies the right state.
  updateOverviewStyleState();

  document.getElementById('btn-back-overview').classList.remove('hidden');
  if (!drive.points) {
    const requestedId = drive.id;
    const detail = await window.electronAPI.getDriveDetail(drive.id);
    // Discard if the user navigated away while we were waiting on IPC —
    // otherwise we'd reattach heavy fields to a drive that's no longer selected
    // (and render a stale polyline on top of the current one).
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
  // The overview layers derive hidden/dim state from the globals.
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

  // Restore the aggregate stats in the map overlay.
  if (drives.length > 0 && lastDrivesMeta) renderDriveStats(drives, lastDrivesMeta);

  // Restore overview lines to original style (imports keep purple/dashed) —
  // selectedDriveId is null again, so the style pass renders overview mode.
  updateOverviewStyleState();

  // Fit map to all drives
  const bounds = new maplibregl.LngLatBounds();
  let any = false;
  for (const drive of drives) {
    if (!drive.overviewPoints || drive.overviewPoints.length < 2) continue;
    const a = drive.overviewPoints[0];
    const b = drive.overviewPoints[drive.overviewPoints.length - 1];
    bounds.extend([a[1], a[0]]);
    bounds.extend([b[1], b[0]]);
    any = true;
  }
  if (any) map.fitBounds(bounds, { padding: 30 });
}

// ─── Map Drawing ──────────────────────────────────────────────────────────────
function removeMarkers(arr) {
  arr.forEach((m) => m.remove());
  arr.length = 0;
  // A marker removed mid-hover never fires mouseleave, which would orphan
  // its tooltip on the map forever — sweep any that are showing.
  document.querySelectorAll('#map .map-tooltip').forEach((t) => t.remove());
}

// Circle DOM marker (start/end/FSD events) with a hover tooltip — replaces
// L.circleMarker + bindTooltip. Anchored at its center like the old radius-
// based markers. `label` centers a single letter inside the dot.
function makeDotMarker(latLng, { fill, radius = 7, strokeW = 2, opacity = 1, tooltip, label, labelColor = '#fff' }) {
  const el = document.createElement('div');
  el.className = 'map-dot-marker';
  el.style.width = `${radius * 2}px`;
  el.style.height = `${radius * 2}px`;
  el.style.background = fill;
  el.style.border = `${strokeW}px solid #fff`;
  if (opacity !== 1) el.style.opacity = String(opacity);
  if (label) {
    el.textContent = label;
    el.style.color = labelColor;
    el.style.font = `700 ${Math.round(radius * 1.2)}px/1 'Noto Sans', sans-serif`;
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
  }
  if (tooltip) attachMapTooltip(el, tooltip);
  return new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([latLng[1], latLng[0]])
    .addTo(map);
}

// Minimal hover tooltip for DOM markers, styled like the old Leaflet ones.
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

// Display-only smoothing for imported (non-SEI) drives. Their cloud
// breadcrumbs are 15-60 s apart, so raw segments render angular; Chaikin
// corner-cutting rounds the DISPLAYED polyline only. Endpoints are preserved
// exactly, and drive.points / distance math / the replay never see this —
// rendering and stats are deliberately separate.
// Iterations: the selected drive uses the default 2 (one line on screen —
// full smoothness is free); the overview passes 1, since thousands of lines
// at 4x points each is what made panning sluggish.
function smoothLatLngsForDisplay(latLngs, iterations = 2) {
  if (!Array.isArray(latLngs) || latLngs.length < 3) return latLngs;
  let pts = latLngs;
  // Dense inputs need less rounding and would balloon the point count.
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
// Every overview route lives in ONE GeoJSON source rendered by the GPU.
// History: per-drive L.polyline layers cost ~1 FPS pans on a ~5,400-drive
// history (per-layer overhead, not point count), and a single-pass 2D-canvas
// overlay still redrew ~191k points on the CPU after every move. MapLibre
// keeps the geometry in GPU buffers — pan/zoom no longer touches it at all.
// Display states mirror the old styling: overview (blue solid / purple
// dashed imports), dim-grey context under a selected drive, hidden when
// "Hide other drives" is on.

// One central place derives the overview layers' visibility and filters from
// (selectedDriveId, hideOtherDrives). The selected drive draws its own
// highlighted route, so its grey twin is filtered out of the dim layer.
function updateOverviewStyleState() {
  if (!mapReady) {
    whenMapReady(updateOverviewStyleState);
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
  removeMarkers(selectedMarkers);
  removeMarkers(fsdEventMarkers);
  replayTrailCtx = null; // release the last drive's trail geometry
  selectedDriveId = null;
  document.getElementById('map-legend').classList.add('hidden');

  // Build one LineString feature per drive. Imported drives are sparse cloud
  // breadcrumbs (15-60 s apart), smoothed so poll intervals don't render as
  // hard corners; 1 iteration here vs the selected drive's 2.
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
      coords[i] = [lls[i][1], lls[i][0]]; // [lat,lng] → GeoJSON [lng,lat]
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

  // Toggle the imported legend entry based on whether any imported drives exist.
  const tessieLegend = document.querySelector('.legend-tessie');
  if (tessieLegend) tessieLegend.classList.toggle('hidden', !anyTessie);

  if (features.length > 0) {
    map.fitBounds(bounds, { padding: 30 });
  }
}

function downsample(points, maxPoints) {
  // First pass: remove outlier points that jump >50km from both neighbors
  const clean = [];
  for (let i = 0; i < points.length; i++) {
    const lat = points[i][0], lng = points[i][1];
    if (Math.abs(lat) < 1 && Math.abs(lng) < 1) continue; // null island
    if (i === 0 || i === points.length - 1) { clean.push(points[i]); continue; }
    const prev = points[i - 1], next = points[i + 1];
    const dPrev = Math.abs(lat - prev[0]) + Math.abs(lng - prev[1]);
    const dNext = Math.abs(lat - next[0]) + Math.abs(lng - next[1]);
    // ~0.5 degrees ≈ 50km — if far from both neighbors, skip it
    if (dPrev > 0.5 && dNext > 0.5) continue;
    clean.push(points[i]);
  }
  if (clean.length <= maxPoints) return clean;
  // Second pass: evenly sample
  const step = (clean.length - 1) / (maxPoints - 1);
  const result = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    result.push(clean[Math.round(i * step)]);
  }
  result.push(clean[clean.length - 1]);
  return result;
}

// Darken a #rrggbb color — the not-yet-traveled route state. 0.45 keeps the
// hue readable on both the Light and Dark basemaps while clearly receded.
function dimColor(hex, factor = 0.45) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => Math.round(((n >> shift) & 255) * factor)
    .toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

// Repaint the traveled part of the selected route (everything at or before
// the replay marker) in its normal colors; the base layers underneath stay
// dimmed. Runs every replay tick and scrub — slicing plus one small setData
// is cheap, and scrubbing backwards just shrinks the overlay again.
function updateReplayTrail(idx) {
  if (!mapReady || !replayTrailCtx) return;
  const { runs, latLngs, smooth } = replayTrailCtx;
  const features = [];
  for (const run of runs) {
    if (run.from >= idx) break; // runs are in route order
    const to = Math.min(run.to, idx);
    let seg = latLngs.slice(run.from, to + 1);
    if (seg.length < 2) continue;
    // Chaikin preserves endpoints, so a smoothed partial run still ends
    // exactly at the marker's current point.
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
    // Nothing drawable — still clear the previous drive's highlighted route
    // (the old per-layer code cleared it as a side effect of clearLayers).
    replayTrailCtx = null;
    whenMapReady(() => {
      map.getSource('selected-route').setData(EMPTY_FC);
      map.getSource('selected-traveled').setData(EMPTY_FC);
    });
    return;
  }

  const fsd = drive.fsdStates;
  const isTessie = isImportedSource(drive.source);
  // Tessie API drives have per-point autopilot from the /path endpoint, so
  // we segment them too — just with a dashed line so the lower-fidelity
  // source stays visually distinct from native SEI.
  const hasFSD = Array.isArray(fsd) && fsd.length === pts.length && fsd.some((s) => s !== 0);
  const latLngs = pts.map((p) => [p[0], p[1]]);

  // The route goes into the 'selected-route' GeoJSON source as one feature
  // per styling run; the solid/dashed layer pair reads color/width/dash from
  // the feature properties. driveId lets the map click handler treat clicks
  // on the highlighted route as a toggle. The base route renders DIMMED
  // (colorDim) — updateReplayTrail re-paints the traveled part in the normal
  // color as the replay marker passes, using the index ranges in trailRuns.
  const features = [];
  const trailRuns = [];
  const pushSeg = (from, to, color, dashed, w) => {
    if (to - from < 1) return;
    let seg = latLngs.slice(from, to + 1);
    if (isTessie) seg = smoothLatLngsForDisplay(seg);
    features.push({
      type: 'Feature',
      properties: { driveId: drive.id, color, colorDim: dimColor(color), dashed, w },
      geometry: { type: 'LineString', coordinates: seg.map((p) => [p[1], p[0]]) },
    });
    trailRuns.push({ from, to, color, dashed, w });
  };

  if (hasFSD) {
    // Split into segments by FSD engagement
    let i = 0;
    while (i < pts.length) {
      const engaged = fsd[i] !== 0;
      let j = i + 1;
      while (j < pts.length && (fsd[j] !== 0) === engaged) j++;

      pushSeg(
        i,
        Math.min(j, pts.length - 1),
        engaged ? '#22cc55' : (isTessie ? '#a855f7' : '#2266cc'),
        isTessie,
        5
      );
      i = j;
    }
  } else if (isTessie) {
    // Tessie drive with no per-point FSD data (CSV import or missing path).
    pushSeg(0, latLngs.length - 1, '#a855f7', true, 5);
  } else {
    pushSeg(0, latLngs.length - 1, '#2266cc', false, 4);
  }

  replayTrailCtx = { runs: trailRuns, latLngs, smooth: isTessie };
  whenMapReady(() => {
    map.getSource('selected-route').setData({ type: 'FeatureCollection', features });
    map.getSource('selected-traveled').setData(EMPTY_FC); // nothing traveled yet
  });

  // Start / end markers
  selectedMarkers.push(makeDotMarker(latLngs[0], { fill: '#22cc55', tooltip: 'Start' }));
  selectedMarkers.push(makeDotMarker(latLngs[latLngs.length - 1], { fill: '#ff3344', tooltip: 'End' }));

  // FSD event markers (visibility controlled by Settings toggle)
  if (Array.isArray(drive.fsdEvents)) {
    for (const ev of drive.fsdEvents) {
      const disengage = ev.type === 'disengagement';
      fsdEventMarkers.push(makeDotMarker([ev.lat, ev.lng], {
        fill: disengage ? '#ef4444' : '#ffdd00',
        radius: 8,
        strokeW: 1.5,
        opacity: 0.9,
        label: disengage ? 'D' : 'A',
        labelColor: disengage ? '#fff' : '#1f2937',
        tooltip: disengage ? 'FSD Disengagement' : 'Accelerator Override',
      }));
    }
  }
  applyFsdMarkerVisibility();

  // Fit map to selected drive
  const bounds = new maplibregl.LngLatBounds();
  for (const p of latLngs) bounds.extend([p[1], p[0]]);
  map.fitBounds(bounds, { padding: 50 });

  // Show legend if FSD data present or this is a Tessie drive
  const legend = document.getElementById('map-legend');
  if (hasFSD || isTessie) {
    legend.classList.remove('hidden');
  } else {
    legend.classList.add('hidden');
  }

  // Add replay marker at start (navigation arrow, rotatable image inside a
  // plain wrapper div; the wrapper is the marker element MapLibre positions,
  // the inner #replay-arrow img is what the bearing code rotates).
  // Use the first point where the car is actually moving, not idx 0 — the
  // earliest samples are often stationary parked GPS noise that gives a
  // meaningless bearing.
  const initBearing = computeInitBearing(drive.points, drive.gearStates);
  const { w: mW, h: mH } = getMarkerSize();
  const wrap = document.createElement('div');
  wrap.style.width = `${mW}px`;
  wrap.style.height = `${mH}px`;
  wrap.style.zIndex = '1000'; // above the start/end/FSD dot markers
  wrap.innerHTML = buildMarkerHtml(initBearing);
  replayMarker = new maplibregl.Marker({ element: wrap, anchor: 'center' })
    .setLngLat([latLngs[0][1], latLngs[0][0]])
    .addTo(map);
  selectedMarkers.push(replayMarker);

  // Initialize replay
  initReplay(drive);
}

// ─── Drive Replay ────────────────────────────────────────────────────────────
const GEAR_LABELS = { 0: 'P', 1: 'D', 2: 'R', 3: 'N' };
const GEAR_CLASSES = { 0: 'gear-p', 1: 'gear-d', 2: 'gear-r', 3: 'gear-n' };
const SPEED_FACTORS = [1, 2, 5, 10];
let replayCurrentBearing = 0;

function initReplay(drive) {
  // Stop any in-flight interval from a previous drive so we don't leak ticks
  // into the new one (which would cause playback to continue through pauses).
  stopReplay();
  replayDrive = drive;
  replayIdx = 0;
  replaySpeed = 1;
  replayPlaying = false;
  // Initialize bearing to the first point where the car is actually moving
  // (matching the inline arrow transform set in drawSelectedDrive).
  replayCurrentBearing = computeInitBearing(drive.points, drive.gearStates);

  const slider = document.getElementById('replay-slider');
  slider.max = String(drive.points.length - 1);
  slider.value = '0';

  document.getElementById('replay-play-icon').textContent = 'play_arrow';
  document.getElementById('btn-replay-speed').textContent = '1x';

  // Set start/end times (some clips carry no per-point timestamp — show
  // a placeholder instead of "Invalid Date", matching the slider label).
  if (drive.points.length > 0) {
    const t0 = drive.points[0][2];
    const t1 = drive.points[drive.points.length - 1][2];
    document.getElementById('replay-time-start').textContent = t0 !== undefined ? formatReplayTime(t0) : '--:--';
    document.getElementById('replay-time-end').textContent = t1 !== undefined ? formatReplayTime(t1) : '--:--';
  }

  updateReplayData(0);
  document.getElementById('replay-bar').classList.remove('hidden');

  // Wire events
  slider.oninput = (e) => {
    if (replayPlaying) stopReplay();
    replayIdx = parseInt(e.target.value);
    updateReplayPosition(replayIdx, true);
  };

  document.getElementById('btn-replay-play').onclick = toggleReplay;
  document.getElementById('btn-replay-speed').onclick = cycleReplaySpeed;
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

  // If at end, restart from beginning. Snap so the marker and arrow reset
  // to the departure position/heading instead of holding the final one.
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

function cycleReplaySpeed() {
  const curIdx = SPEED_FACTORS.indexOf(replaySpeed);
  replaySpeed = SPEED_FACTORS[(curIdx + 1) % SPEED_FACTORS.length];
  document.getElementById('btn-replay-speed').textContent = `${replaySpeed}x`;

  // Restart interval at new speed if playing
  if (replayPlaying) {
    clearInterval(replayInterval);
    replayInterval = setInterval(replayTick, REPLAY_BASE_MS / replaySpeed);
  }
}

function updateReplayPosition(idx, snap = false) {
  if (!replayDrive) return;
  const pts = replayDrive.points;
  const pt = pts[idx];

  // Move marker with a smooth transition on the marker element (MapLibre
  // positions it via a CSS transform, same technique Leaflet used) — except
  // while the map itself is moving, when MapLibre drives that transform
  // every frame and easing it would drag the marker off the route.
  if (replayMarker) {
    const el = replayMarker.getElement();
    if (el && replayPlaying && !mapInteracting) {
      el.style.transition = `transform ${REPLAY_BASE_MS / replaySpeed}ms linear`;
    } else if (el) {
      el.style.transition = 'none';
    }
    replayMarker.setLngLat([pt[1], pt[0]]);
  }

  // Reveal the traveled portion of the route up to this point.
  updateReplayTrail(idx);

  // Rotate arrow to face the direction the front of the car points.
  const arrow = document.getElementById('replay-arrow');
  if (arrow) {
    // Skip the bearing update on gear-transition frames — the underlying
    // points span a gear change and the computed bearing isn't reliable.
    const gears = replayDrive.gearStates;
    const gearNow = gears?.[idx];
    const gearPrev = idx > 0 ? gears?.[idx - 1] : gearNow;
    const gearNext = idx + 1 < gears?.length ? gears?.[idx + 1] : gearNow;
    const gearTransition = (gearNow !== gearPrev) || (gearNow !== gearNext);

    // Playback: bearing at idx, or null when the car isn't actually moving
    // there (stationary/jitter window) — hold the current heading rather
    // than rotate to noise. Scrubbing: always orient — a stopped instant
    // inherits the heading the car entered the stop with (its physical
    // facing; flip-for-reverse handled inside, relative to the found sample).
    let bearing;
    if (snap) {
      bearing = findBearingNear(pts, idx, 7, gears);
    } else {
      bearing = gearTransition ? null : smoothBearing(pts, idx, 7, gears);
      if (bearing != null && gearNow === 2) bearing = (bearing + 180) % 360; // reverse → flip to front
    }

    if (bearing != null) {
      if (snap) {
        // Snap directly — reset accumulated winding so subsequent playback
        // starts from the correct angle with no leftover drift.
        replayCurrentBearing = bearing;
        arrow.style.transition = 'none';
      } else {
        // Shortest-path tracking: sign-preserving delta avoids ±180 drift
        // that would accumulate into a full 360° rotation.
        let delta = bearing - (replayCurrentBearing % 360 + 360) % 360;
        if (delta > 180) delta -= 360;
        else if (delta < -180) delta += 360;
        replayCurrentBearing += delta;

        // Adaptive transition: longer at slow playback, shorter at high speeds.
        const transMs = Math.max(30, 150 / replaySpeed);
        arrow.style.transition = `transform ${transMs}ms linear`;
      }
      arrow.style.transform = `rotate(${replayCurrentBearing}deg)`;
    }
  }

  // Update slider and current-time label (label follows the thumb)
  document.getElementById('replay-slider').value = String(idx);
  if (pt && pt[2] !== undefined) {
    const label = document.getElementById('replay-time-current');
    label.textContent = formatReplayTime(pt[2]);
    const max = pts.length - 1;
    const pct = max > 0 ? (idx / max) * 100 : 0;
    const thumbW = 14; // matches .replay-slider::-webkit-slider-thumb width
    label.style.left = `calc(${pct}% + ${(thumbW / 2) - (pct / 100) * thumbW}px)`;
  }

  // Update data display
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

const MARKER_SIZES = {
  arrow:  { w: 128, h: 128 },
  model3: { w: 56,  h: 90  },
};

function getMarkerSize() {
  return MARKER_SIZES[markerType] ?? MARKER_SIZES.arrow;
}

function buildMarkerHtml(bearing) {
  const shadow = 'filter:drop-shadow(0 0 4px rgba(0,0,0,0.5))';
  const { w, h } = getMarkerSize();
  if (markerType === 'model3' && model3ColoredUrl) {
    return `<img id="replay-arrow" src="${model3ColoredUrl}" style="width:${w}px;height:${h}px;transform:rotate(${bearing}deg);transition:transform 60ms linear;${shadow};" />`;
  }
  return `<img id="replay-arrow" src="../../assets/map-ui/arrow.png" style="width:${w}px;height:${h}px;transform:rotate(${bearing}deg);transition:transform 60ms linear;${shadow};" />`;
}

// Rebuild the live replay-marker icon for the current markerType/size, keeping
// its position and current bearing. Called when the marker setting changes
// mid-view so the arrow/car swaps on the map immediately (without this it only
// updated the next time the marker was recreated, e.g. re-selecting a drive).
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

function renderModel3Color(color) {
  return new Promise((resolve) => {
    const imgT = new Image();
    const imgC = new Image();
    let loaded = 0;

    const onLoad = () => {
      if (++loaded < 2) return;

      const canvas = document.createElement('canvas');
      canvas.width  = imgT.naturalWidth;
      canvas.height = imgT.naturalHeight;
      const ctx = canvas.getContext('2d');

      // Base texture
      ctx.drawImage(imgT, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;

      // Color mask (scaled to base dimensions in case they differ)
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width  = imgT.naturalWidth;
      maskCanvas.height = imgT.naturalHeight;
      const maskCtx = maskCanvas.getContext('2d');
      maskCtx.drawImage(imgC, 0, 0, imgT.naturalWidth, imgT.naturalHeight);
      const maskD = maskCtx.getImageData(0, 0, canvas.width, canvas.height).data;

      const tr = parseInt(color.slice(1, 3), 16);
      const tg = parseInt(color.slice(3, 5), 16);
      const tb = parseInt(color.slice(5, 7), 16);

      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 10) continue;
        const maskLum = (maskD[i] * 0.299 + maskD[i + 1] * 0.587 + maskD[i + 2] * 0.114) / 255;
        if (maskLum > 0.5) continue; // window / tire / trim — leave untouched
        // _t has a black body: dark pixels → chosen color, bright specular → white.
        // lerp(color, white, luminance) gives realistic shading on a dark base.
        const baseLum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
        d[i]     = Math.round(tr + (255 - tr) * baseLum);
        d[i + 1] = Math.round(tg + (255 - tg) * baseLum);
        d[i + 2] = Math.round(tb + (255 - tb) * baseLum);
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL());
    };

    imgT.onload = onLoad;
    imgC.onload = onLoad;
    imgT.src = '../../assets/map-ui/Model3_t.png';
    imgC.src = '../../assets/map-ui/Model3_c.png';
  });
}

async function applyMarkerColor(color) {
  markerColor = color;
  localStorage.setItem('markerColor', color);
  model3ColoredUrl = await renderModel3Color(color);

  // Keep swatch button in sync
  const swatch = document.getElementById('btn-car-color-swatch');
  if (swatch) swatch.style.background = color;

  // Update preview canvas in settings
  const previewCanvas = document.getElementById('vehicle-preview-canvas');
  if (previewCanvas && model3ColoredUrl) {
    const img = new Image();
    img.onload = () => {
      previewCanvas.width  = img.naturalWidth;
      previewCanvas.height = img.naturalHeight;
      previewCanvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = model3ColoredUrl;
  }

  // Refresh live replay marker if one is on the map
  const arrowEl = document.getElementById('replay-arrow');
  if (arrowEl && markerType === 'model3') arrowEl.src = model3ColoredUrl;
}

// First confident heading of the drive — where the replay marker points
// before playback starts. Delegates to findBearingNear at index 0: a parked
// start looks ahead to the departure heading through the same trust gates as
// scrubbing (the old hand-rolled walk keyed on a single ~10 cm pair, which
// GPS multipath can fake while parked), and the reverse flip follows the
// samples that supplied the heading (backing out of a spot points the nose
// away from the travel direction).
function computeInitBearing(pts, gearStates) {
  if (!pts || pts.length < 2) return 0;
  return findBearingNear(pts, 0, 7, gearStates) ?? 0;
}

// Bearing trust gates. A pair of GPS fixes only proves a heading when the car
// was really rolling through it:
//   • MIN_BEARING_PAIR_M — single-fix jitter floor (stationary pairs give
//     atan2(0,0) = "north"; near-stationary ones give random directions).
//   • MIN_BEARING_SPEED_MPS — pt[3] is the car's own (CAN/SEI) speed where
//     available, immune to GPS multipath. Parking rows reflect signal and can
//     wander fixes 2-5 m between samples while the car sits still — far above
//     any displacement floor — but the car reports ~0 speed the whole time.
//   • Net-vs-gross displacement — real travel nets out (window start→end
//     distance ≈ sum of steps); stationary multipath wanders metres gross
//     but nets near zero.
const MIN_BEARING_PAIR_M = 1.5;
const MIN_BEARING_SPEED_MPS = 0.5;
// Cap (samples each side) for widening the bearing window when the car's
// speed proves motion but the default window hasn't covered the jitter
// floor yet — ±3.2 s at SEI's ~10 Hz cadence. See smoothBearing.
const MAX_BEARING_HALF_SPAN = 32;
// Heading of the car as it sits at idx — used when scrubbing so the arrow
// matches the direction of travel at the thumb. A moving sample answers
// directly. A stopped one inherits the last confident heading BEFORE the
// stop: the car hasn't moved since, so that's its physical facing (the
// reverse flip comes from the sample the heading was found at, so a car
// that backed in correctly faces away from its travel). Searching forward
// here instead would show the post-stop heading early — at a light before
// a turn the arrow pointed where the car was about to go, not where it
// faced. Only a scrub before the car's first movement looks ahead. Null
// when the whole drive has no confident heading; the caller keeps the
// current rotation.
function findBearingNear(pts, idx, window, gearStates) {
  // smoothBearing clamps its window to j's own gear run, so a non-null
  // heading is always derived from samples sharing gearStates[j] — making
  // it safe to key the reverse flip off j directly. (A parked sample can no
  // longer "borrow" movement from an adjacent leg in a different gear; it
  // returns null and the walk below moves into the leg itself.)
  const headingAt = (j) => {
    const b = smoothBearing(pts, j, window, gearStates);
    if (b == null) return null;
    return gearStates?.[j] === 2 ? (b + 180) % 360 : b;
  };
  const direct = headingAt(idx);
  if (direct != null) return direct;
  // Stride keeps successive smoothBearing windows overlapping, so even a
  // short movement burst between strides still lands inside some window.
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
  // Displacement-weighted circular mean over nearby point pairs.
  // Skip pairs that cross a gear-state boundary (reverse ↔ drive), since
  // raw travel bearing flips 180° there and the circular mean collapses.
  // Returns null when the window doesn't show real movement — the caller
  // holds the arrow's previous heading instead of rotating it to noise.
  // Hard bounds for the window and its expansion below: the clip edges AND
  // the contiguous same-gear run around idx. Travel direction inverts at a
  // D↔R shift, so any mean or chord across that boundary points somewhere
  // the car never faced — the net-vector fallback used to do exactly that
  // during back-in maneuvers, then flip the poisoned chord for reverse.
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

  // Structural gate — THE moving/parked decision.
  //
  // The car's own recorded speed (pt[3], CAN/SEI when present) is checked
  // first: if any sample in the window shows real speed, the car IS moving —
  // skip the GPS-statistics tests below, which under-trigger at low speed
  // where jitter rivals the movement (that under-trigger froze the arrow
  // below a walking pace). Speed can only EXPAND updates here, never veto:
  // zero-filled speed channels (clips without SEI speed) fall through to the
  // GPS tests instead of stranding the heading.
  // Speed is signed (negative in reverse) — magnitude is what proves motion.
  let speedSaysMoving = false;
  for (let i = start; i <= end; i++) {
    const v = pts[i][3];
    if (Number.isFinite(v) && Math.abs(v) >= MIN_BEARING_SPEED_MPS) { speedSaysMoving = true; break; }
  }

  let net = geodesicM(pts[start][0], pts[start][1], pts[end][0], pts[end][1]);
  if (speedSaysMoving) {
    // The window is sample-count based, but cadence differs by source: SEI
    // points arrive ~10/s, so the default window spans only ~±0.35 s and
    // its net displacement falls under the jitter floor below ~5 mph even
    // though the car is genuinely rolling — which froze the arrow through
    // exactly the parking-speed turns where heading changes most. When the
    // car's own speed proves motion, widen the window until the travel
    // clears the floor; only if it still can't (GPS pinned / sub-walking
    // creep) is a bearing truly meaningless — hold the current heading.
    let half = Math.ceil(window / 2);
    while (net < MIN_BEARING_PAIR_M && (start > lo || end < hi)) {
      half *= 2;
      start = Math.max(lo, idx - half);
      end = Math.min(hi, idx + half);
      net = geodesicM(pts[start][0], pts[start][1], pts[end][0], pts[end][1]);
    }
    if (net < MIN_BEARING_PAIR_M) return null;
  } else {
    // No speed evidence — decide from GPS statistics alone:
    //   1. Net displacement ≥ ~0.4 m per 1 Hz sample (slow-walk pace).
    //   2. Coherence (net ÷ gross): real travel moves one way, so the
    //      straight-line distance ≈ the summed steps (≈1.0; ~0.85 through a
    //      90° turn). Stationary multipath wanders back and forth — metres
    //      gross, little net — and can fluke past a net threshold alone,
    //      but not past both. (A U-turn apex can also dip below 0.5 —
    //      holding for those few frames is correct anyway: it's mid-spin.)
    const minNet = Math.max(MIN_BEARING_PAIR_M, (end - start) * 0.4);
    if (net < minNet) return null;
    let gross = 0;
    for (let i = start; i < end; i++) {
      gross += geodesicM(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    }
    if (gross > 0 && net / gross < 0.5) return null;
  }
  // Past this point a bearing is ALWAYS returned: the filters below only
  // pick which pairs to trust, they can no longer veto the update (an
  // over-eager veto strands the arrow on a stale heading for whole legs).

  // requireSpeed: prefer pairs where the car's recorded speed (pt[3], CAN/SEI
  // when available) confirms motion — but fail open below if that channel is
  // zero-filled (clips without SEI speed) or missing.
  const collect = (filterByGear, requireSpeed) => {
    let sinSum = 0, cosSum = 0, weight = 0;
    for (let i = start; i < end; i++) {
      if (filterByGear && (gearStates[i] !== gear || gearStates[i + 1] !== gear)) continue;
      const d = geodesicM(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < MIN_BEARING_PAIR_M) continue;
      if (requireSpeed) {
        const v0 = pts[i][3];
        const v1 = pts[i + 1][3];
        // abs: reverse records negative speed but is just as much motion.
        if (!Number.isFinite(v0) || !Number.isFinite(v1) || Math.max(Math.abs(v0), Math.abs(v1)) < MIN_BEARING_SPEED_MPS) continue;
      }
      const b = calcBearing(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      const rad = (b * Math.PI) / 180;
      // Weight by displacement so long, confident segments dominate over
      // short ones that barely cleared the jitter floor.
      sinSum += Math.sin(rad) * d;
      cosSum += Math.cos(rad) * d;
      weight += d;
    }
    return { sinSum, cosSum, weight };
  };

  // Trust tiers, most to least picky. Whichever yields pairs first wins.
  let r = gearStates ? collect(true, true) : collect(false, true);
  if (r.weight === 0 && gearStates) r = collect(true, false);
  if (r.weight === 0) r = collect(false, false);
  if (r.weight > 0) {
    return ((Math.atan2(r.sinSum, r.cosSum) * 180) / Math.PI + 360) % 360;
  }
  // Every individual pair was under the jitter floor yet the window clearly
  // travelled (e.g. steady creep ~1 m/s) — use the net vector itself.
  return calcBearing(pts[start][0], pts[start][1], pts[end][0], pts[end][1]);
}

function updateReplayData(idx) {
  if (!replayDrive) return;
  const drive = replayDrive;
  const pt = drive.points[idx];

  // Speed (pt[3] is m/s, signed — negative in reverse; missing on clips
  // without a speed channel). Show the magnitude: the gear readout carries R.
  document.getElementById('replay-speed-val').textContent =
    Number.isFinite(pt[3]) ? `${speedVal(Math.abs(pt[3]) * MPS_TO_MPH)} ${speedShort()}` : '--';

  // Gear (P/D/R/N, colored like the rest of the replay data)
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

  // FSD
  const fsdEl = document.getElementById('replay-fsd-val');
  const fsdSpan = document.getElementById('replay-fsd-span');
  if (drive.fsdStates && drive.fsdStates[idx] !== undefined) {
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
  if (allTags.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  let html = `<button class="tag-filter-btn${activeTagFilter === '' ? ' active' : ''}" data-tag="">All</button>`;
  for (const t of allTags) {
    html += `<button class="tag-filter-btn${activeTagFilter === t ? ' active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.tag-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      activeTagFilter = (activeTagFilter === tag && tag !== '') ? '' : tag;
      renderTagFilter();
      renderDriveList(drives);
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

  // Optimistic UI: render immediately so the pill appears without waiting for
  // the (potentially large) drive-data.json write — set-drive-tags rewrites the
  // whole file, which is what made this feel sluggish.
  if (!allTags.includes(tagName)) {
    allTags.push(tagName);
    allTags.sort();
    renderTagFilter();
  }
  renderDriveList(drives);

  // Persist; roll back the UI only if the write fails.
  const res = await window.electronAPI.setDriveTags({ filePath: loadedFilePath, driveKey: drive.startTime, tags });
  if (res && res.success === false) {
    drive.tags = (drive.tags ?? []).filter((t) => t !== tagName);
    rebuildAllTagsFromDrives();
    renderTagFilter();
    renderDriveList(drives);
    alert(`Couldn't save tag: ${res.error || 'write failed'}`);
  }
}

async function removeTag(drive, tagName) {
  if (!loadedFilePath) return;
  const prev = [...(drive.tags ?? [])];
  drive.tags = prev.filter((t) => t !== tagName);

  // Optimistic UI (see addTag).
  rebuildAllTagsFromDrives();
  if (activeTagFilter === tagName && !allTags.includes(tagName)) activeTagFilter = '';
  renderTagFilter();
  renderDriveList(drives);

  const res = await window.electronAPI.setDriveTags({ filePath: loadedFilePath, driveKey: drive.startTime, tags: drive.tags });
  if (res && res.success === false) {
    drive.tags = prev;
    rebuildAllTagsFromDrives();
    renderTagFilter();
    renderDriveList(drives);
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
