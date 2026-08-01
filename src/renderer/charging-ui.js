'use strict';

var DRIVE_MAP_LAYER_IDS_FOR_CHARGING = [
  'overview-dim',
  'overview-imported',
  'overview-native',
  'selected-solid',
  'selected-dashed',
  'traveled-solid',
  'traveled-dashed',
];
var CHARGING_MAP_LAYER_IDS = [
  'charging-site-pills',
  'charging-cluster-pills',
];

function initChargingTab() {
  document.getElementById('charging-osm-attribution').addEventListener('click', () => {
    window.electronAPI.openExternal('https://www.openstreetmap.org/copyright');
  });
  // Cluster pills are only known once clustering runs, so mint whatever the
  // style asks for on demand.
  map.on('styleimagemissing', (event) => addChargingPillImage(event.id));
  // Pull both icon faces in now so the first home pill draws the solid glyph
  // rather than a fallback it would then cache for the session.
  document.fonts?.load?.(`24px ${ICON_FONT}`).catch(() => {});
  ensureFilledIconFont();
  renderChargingSites();
}

async function loadChargingSites() {
  selectedChargingSiteId = null;
  selectedChargingSessionId = null;
  if (driveCacheGen == null) {
    chargingSites = [];
    renderChargingSites();
    return;
  }
  try {
    const result = await window.electronAPI.listChargingSites({ gen: driveCacheGen });
    if (!result.success) {
      if (result.code !== 'STALE_DRIVE_DATA') console.warn('Charging sites:', result.error);
      return;
    }
    chargingSites = result.sites ?? [];
    chargingCatalogStatus = result.catalog ?? chargingCatalogStatus;
    renderChargingSites();
    renderSuperchargerCatalogStatus();
  } catch (error) {
    console.warn('Charging sites:', error);
  }
}

function visibleChargingSites() {
  return window.ChargingView.filterAndSortChargingSites(chargingSites, {
    showSuperchargers,
    showOther: showOtherChargers,
  });
}

function formatChargingDate(value, includeTime = true) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return date.toLocaleString(undefined, includeTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' });
}

function renderChargingSites(options = {}) {
  const list = document.getElementById('charging-sites-list');
  const empty = document.getElementById('charging-empty');
  const summary = document.getElementById('charging-summary');
  const attribution = document.getElementById('charging-osm-attribution');
  list.replaceChildren();

  if (!loadedFilePath) {
    empty.classList.remove('hidden');
    empty.lastElementChild.textContent = 'Load drive data to view charging history.';
    summary.textContent = '';
    attribution.classList.add('hidden');
    updateChargingMap([]);
    return;
  }

  attribution.classList.remove('hidden');
  const visible = visibleChargingSites();
  const totalVisits = visible.reduce((total, site) => total + Number(site.visitCount ?? 0), 0);
  summary.textContent = `${fmt(totalVisits)} visit${totalVisits === 1 ? '' : 's'} · ${fmt(visible.length)} location${visible.length === 1 ? '' : 's'}`;

  if (chargingSites.length === 0) {
    empty.classList.remove('hidden');
    empty.lastElementChild.textContent = 'No charging sessions found.';
  } else if (!showSuperchargers && !showOtherChargers) {
    empty.classList.remove('hidden');
    empty.lastElementChild.textContent = 'Turn on a charging-location filter in Settings → Map UI.';
  } else if (visible.length === 0) {
    empty.classList.remove('hidden');
    empty.lastElementChild.textContent = 'No charging locations match the current Map UI filters.';
  } else {
    empty.classList.add('hidden');
  }

  for (const site of visible) {
    const card = document.createElement('section');
    card.className = `charging-site${site.isSupercharger ? ' is-supercharger' : ''}`;
    card.dataset.siteId = site.siteId;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'charging-site-button';
    button.setAttribute('aria-expanded', String(selectedChargingSiteId === site.siteId));

    const count = document.createElement('span');
    count.className = 'charging-visit-count';
    count.textContent = String(site.visitCount);
    count.title = `${site.visitCount} charging visit${site.visitCount === 1 ? '' : 's'}`;
    const copy = document.createElement('span');
    copy.className = 'charging-site-copy';
    const name = document.createElement('span');
    name.className = 'charging-site-name';
    name.textContent = site.displayName || 'Charging location';
    const meta = document.createElement('span');
    meta.className = 'charging-site-meta';
    const type = document.createElement('span');
    type.className = 'charging-type';
    type.textContent = site.isSupercharger ? 'Supercharger' : 'Other charger';
    const latest = document.createElement('span');
    // The "Latest" prefix is dropped so the power fits on the same line; a
    // bare date under a visit count already reads as the most recent one,
    // and the tooltip spells it out.
    latest.textContent = formatChargingDate(site.latestVisit, false);
    latest.title = `Latest visit: ${formatChargingDate(site.latestVisit, false)}`;
    const power = chargingPowerLabel(site);
    if (power) {
      const kw = document.createElement('span');
      kw.className = 'charging-power';
      kw.textContent = power.text;
      kw.title = power.title;
      meta.append(type, ' · ', kw, ' · ', latest);
    } else {
      meta.append(type, ' · ', latest);
    }
    copy.append(name, meta);
    const chevron = document.createElement('span');
    chevron.className = 'material-icons charging-site-chevron';
    chevron.textContent = 'expand_more';
    button.append(count, copy, chevron);
    button.addEventListener('click', () => selectChargingSite(site.siteId));
    card.appendChild(button);

    if (selectedChargingSiteId === site.siteId) {
      card.classList.add('selected');
      const sessions = document.createElement('div');
      sessions.className = 'charging-sessions';
      card.appendChild(sessions);
      renderChargingSessions(site, sessions);
    }
    list.appendChild(card);
  }
  updateChargingMap(visible, { fit: options.fitMap !== false });
}

async function selectChargingSite(siteId, options = {}) {
  selectedChargingSiteId = selectedChargingSiteId === siteId && !options.fromMap ? null : siteId;
  selectedChargingSessionId = null;
  renderChargingSites({ fitMap: false });
  if (!selectedChargingSiteId) return;
  const site = chargingSites.find((candidate) => candidate.siteId === siteId);
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(siteId)
    : siteId.replace(/"/g, '\\"');
  document.querySelector(`.charging-site[data-site-id="${escaped}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (site && Number.isFinite(site.latitude) && Number.isFinite(site.longitude) && activeMainTab === 'charging') {
    map.easeTo({ center: [site.longitude, site.latitude], zoom: Math.max(map.getZoom(), 12) });
  }
}

// The kW shown on a site row. Two different quantities can fill it, so the
// tooltip says which: the catalog's per-stall rating when the site is a
// known Supercharger, otherwise the fastest charge actually recorded there
// — which is all we can know for an AC charger, and is a floor rather than
// a rating, since the car's own curve and state of charge cap it.
function chargingPowerLabel(site) {
  const rated = Number(site.powerKw);
  if (Number.isFinite(rated) && rated > 0) {
    return {
      text: `${Math.round(rated)} kW`,
      title: `Rated ${Math.round(rated)} kW per stall (OpenStreetMap Supercharger catalog)`,
    };
  }
  const observed = Number(site.peakPowerKw);
  if (Number.isFinite(observed) && observed > 0) {
    return {
      text: `${Math.round(observed)} kW`,
      title: `Fastest charge recorded here: ${Math.round(observed)} kW`,
    };
  }
  return null;
}

function renderChargingSessions(site, container) {
  if (!site._sessions) {
    container.textContent = 'Loading sessions…';
    if (site._loadingSessions) return;
    site._loadingSessions = true;
    window.electronAPI.listChargingSessions({ gen: driveCacheGen, siteId: site.siteId })
      .then((result) => {
        site._sessions = result.success ? (result.sessions ?? []) : [];
        site._sessionsError = result.success ? null : (result.error || 'Sessions could not be loaded.');
      })
      .catch((error) => {
        site._sessions = [];
        site._sessionsError = error.message;
        console.warn('Charging sessions:', error);
      })
      .finally(() => {
        site._loadingSessions = false;
        if (selectedChargingSiteId === site.siteId) renderChargingSites({ fitMap: false });
      });
    return;
  }

  container.replaceChildren();
  if (site._sessionsError) {
    container.textContent = site._sessionsError;
    return;
  }
  for (const session of site._sessions) {
    const row = document.createElement('div');
    row.className = 'charging-session';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'charging-session-button';
    const date = document.createElement('span');
    date.className = 'charging-session-date';
    date.textContent = formatChargingDate(session.startTime);
    const energy = document.createElement('span');
    energy.className = 'charging-session-energy';
    energy.textContent = Number.isFinite(session.energyAddedKwh)
      ? `${session.energyAddedKwh.toFixed(1)} kWh`
      : fmtDuration(session.durationSeconds ?? 0);
    button.append(date, energy);
    button.addEventListener('click', () => selectChargingSession(site, session.sessionId));
    row.appendChild(button);
    if (selectedChargingSessionId === session.sessionId) {
      const detail = document.createElement('div');
      detail.className = 'charging-session-detail';
      row.appendChild(detail);
      renderChargingSessionDetail(session, detail);
    }
    container.appendChild(row);
  }
}

async function selectChargingSession(site, sessionId) {
  selectedChargingSessionId = selectedChargingSessionId === sessionId ? null : sessionId;
  renderChargingSites({ fitMap: false });
  if (!selectedChargingSessionId) return;
  const summary = site._sessions?.find((session) => session.sessionId === sessionId);
  if (summary?._detail) return;
  try {
    const result = await window.electronAPI.getChargingSession({ gen: driveCacheGen, sessionId });
    if (selectedChargingSessionId !== sessionId) return;
    if (result.success) {
      Object.defineProperty(summary, '_detail', { value: result, configurable: true });
    } else {
      summary._detailError = result.error || 'Charging details could not be loaded.';
    }
    renderChargingSites({ fitMap: false });
  } catch (error) {
    if (summary) summary._detailError = error.message;
    console.warn('Charging session detail:', error);
    renderChargingSites({ fitMap: false });
  }
}

function appendChargingMetric(container, value, label) {
  const metric = document.createElement('div');
  metric.className = 'charging-metric';
  const valueEl = document.createElement('span');
  valueEl.className = 'charging-metric-value';
  valueEl.textContent = value;
  const labelEl = document.createElement('span');
  labelEl.className = 'charging-metric-label';
  labelEl.textContent = label;
  metric.append(valueEl, labelEl);
  container.appendChild(metric);
}

function renderChargingSessionDetail(summary, container) {
  const detail = summary._detail;
  if (!detail) {
    container.textContent = summary._detailError || 'Loading charging details…';
    return;
  }
  const metrics = document.createElement('div');
  metrics.className = 'charging-metrics';
  const battery = Number.isFinite(detail.startBatteryPct) || Number.isFinite(detail.endBatteryPct)
    ? `${Number.isFinite(detail.startBatteryPct) ? `${detail.startBatteryPct}%` : '—'} → ${Number.isFinite(detail.endBatteryPct) ? `${detail.endBatteryPct}%` : '—'}`
    : '—';
  appendChargingMetric(metrics, battery, 'Battery');
  appendChargingMetric(metrics, Number.isFinite(detail.energyAddedKwh) ? `${detail.energyAddedKwh.toFixed(2)} kWh` : '—', 'Energy added');
  appendChargingMetric(metrics, Number.isFinite(detail.peakPowerKw) ? `${detail.peakPowerKw.toFixed(0)} kW` : '—', 'Peak power');
  const cost = detail.cost && Number.isFinite(Number(detail.cost.amount))
    ? `${detail.cost.currency ?? '$'}${Number(detail.cost.amount).toFixed(2)}`
    : '—';
  appendChargingMetric(metrics, cost, 'Cost');
  appendChargingMetric(metrics, fmtDuration(detail.durationSeconds ?? 0), 'Duration');
  appendChargingMetric(metrics, formatChargingDate(detail.endTime), 'Ended');
  container.appendChild(metrics);

  const curve = window.ChargingView.buildChargingCurve(detail.chargeRateSamples ?? [], 260, 80);
  if (!curve) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'charging-curve');
  svg.setAttribute('viewBox', '0 0 260 80');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Charging power curve, peak ${curve.peakPowerKw} kilowatts`);
  for (const y of [24, 48, 72]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'charging-curve-grid');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', '260');
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    svg.appendChild(line);
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'charging-curve-line');
  path.setAttribute('d', curve.path);
  svg.appendChild(path);
  const caption = document.createElement('div');
  caption.className = 'charging-curve-caption';
  for (const label of ['0 min', `${curve.peakPowerKw.toFixed(0)} kW peak`, `${Math.round(curve.durationSeconds / 60)} min`]) {
    const span = document.createElement('span');
    span.textContent = label;
    caption.appendChild(span);
  }
  container.append(svg, caption);
}

const CHARGING_PILL_FILL = { sc: '#e82127', other: '#22c55e', mixed: '#8b5cf6' };

// One lightning bolt, drawn in a unit box so it scales with the pill.
function traceBolt(context, x, y, w, h) {
  context.beginPath();
  context.moveTo(x + w * 0.62, y);
  context.lineTo(x + w * 0.10, y + h * 0.56);
  context.lineTo(x + w * 0.44, y + h * 0.56);
  context.lineTo(x + w * 0.34, y + h);
  context.lineTo(x + w * 0.90, y + h * 0.40);
  context.lineTo(x + w * 0.54, y + h * 0.40);
  context.closePath();
  context.fill();
}

// The house is Material Symbols' `other_houses`, matching the icon set the
// rest of the app draws from. Canvas resolves the ligature, but only once
// the bundled font is in — before that the same call would paint the literal
// string "other_houses" across the pill, so an unloaded font falls back to
// the traced house below rather than risking that.
const HOUSE_ICON = 'other_houses';
const ICON_FONT = '"Material Symbols Outlined"';
// Material Symbols is a variable font whose FILL axis switches the icons
// between outlined and solid. Canvas has no way to set a variation axis on
// ctx.font, so the axis is baked into a private family registered through
// the Font Loading API — the one route that survives into canvas.
const FILLED_ICON_FAMILY = 'Sentry Drive Icons Filled';
const FILLED_ICON_FONT = `"${FILLED_ICON_FAMILY}"`;

function fontReady(font) {
  try {
    return document.fonts.check(`24px ${font}`);
  } catch {
    return false;
  }
}

// The vendored icon font has a content-hashed filename, so read its URL back
// out of the stylesheet that declares it instead of hard-coding one that a
// re-vendor would silently break.
function materialSymbolsFontUrl() {
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet, not ours
    }
    for (const rule of rules ?? []) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
      const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
      if (family !== 'Material Symbols Outlined') continue;
      const match = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue('src'));
      if (match) return new URL(match[1], sheet.href || document.baseURI).href;
    }
  }
  return null;
}

let filledIconFontPromise = null;
function ensureFilledIconFont() {
  if (filledIconFontPromise) return filledIconFontPromise;
  filledIconFontPromise = (async () => {
    const url = materialSymbolsFontUrl();
    if (!url || typeof FontFace !== 'function') return false;
    const face = new FontFace(FILLED_ICON_FAMILY, `url(${url})`, {
      variationSettings: "'FILL' 1",
    });
    await face.load();
    document.fonts.add(face);
    return true;
  })().catch(() => false); // outlined glyph still renders; see drawHouse
  return filledIconFontPromise;
}

function drawHouse(context, x, y, w, h) {
  // Solid first, outlined if the FILL-axis family didn't register, and the
  // traced house only if the icon font itself is missing — never the literal
  // ligature text.
  const family = fontReady(FILLED_ICON_FONT) ? FILLED_ICON_FONT
    : fontReady(ICON_FONT) ? ICON_FONT
      : null;
  if (!family) {
    // The fallback draws a single house, so keep it square and centred in
    // the wider box the two-house icon reserves.
    traceHouse(context, x + (w - h) / 2, y, h, h);
    return;
  }
  context.save();
  context.font = `${h * 1.3}px ${family}`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  const m = context.measureText(HOUSE_ICON);
  // Centre the painted ink in the box, exactly as the marker letters do:
  // the glyph's advance is square and larger than the icon inside it.
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  context.fillText(
    HOUSE_ICON,
    x + (w - inkW) / 2 + m.actualBoundingBoxLeft,
    y + (h - inkH) / 2 + m.actualBoundingBoxAscent,
  );
  context.restore();
}

// Geometric fallback: gabled roof over a body, with a punched-out doorway.
// Drawn in a unit box like the bolt so both sit on the same baseline.
function traceHouse(context, x, y, w, h) {
  const eaves = h * 0.44;   // where the roof meets the walls
  const wallInset = w * 0.14;
  context.beginPath();
  context.moveTo(x + w / 2, y);                    // ridge
  context.lineTo(x + w, y + eaves);                // right eave
  context.lineTo(x + w - wallInset, y + eaves);
  context.lineTo(x + w - wallInset, y + h);        // right wall
  context.lineTo(x + wallInset, y + h);            // floor
  context.lineTo(x + wallInset, y + eaves);        // left wall
  context.lineTo(x, y + eaves);                    // left eave
  context.closePath();
  // Doorway, cut out so the pill's fill shows through.
  const doorW = w * 0.24;
  const doorH = h * 0.34;
  context.moveTo(x + w / 2 - doorW / 2, y + h);
  context.lineTo(x + w / 2 - doorW / 2, y + h - doorH);
  context.lineTo(x + w / 2 + doorW / 2, y + h - doorH);
  context.lineTo(x + w / 2 + doorW / 2, y + h);
  context.closePath();
  context.fill('evenodd');
}

// Draws one map marker: a rounded pill with the visit count on the left and,
// on the right, `bolts` lightning bolts plus a house when the site is tagged
// Home. Sized to its contents, so a 3-visit V4 site is wider than a 1-visit
// AC charger. Rendered at devicePixelRatio so it stays crisp, and handed to
// MapLibre with a matching pixelRatio.
function renderChargingPill({ type, count, bolts, home }) {
  const dpr = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
  const label = String(count);
  const H = 26;                              // pill height, CSS px
  const padX = 9;
  const boltW = 8;
  const boltH = 13;
  const boltGap = 1;
  // other_houses is two houses side by side — measured ink is 4:3, not
  // square like the bolts, so the pill reserves the wider box.
  const houseW = 16;
  const houseH = 12;
  const glyphGap = 5;                        // text -> first glyph
  const font = '800 14px "Noto Sans Mono", monospace';

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const textW = measure.measureText(label).width;
  const boltsW = bolts > 0 ? bolts * boltW + (bolts - 1) * boltGap : 0;
  const houseSpace = home ? houseW + (bolts > 0 ? glyphGap : 0) : 0;
  const gap = (bolts > 0 || home) ? glyphGap : 0;
  const W = Math.ceil(padX * 2 + textW + gap + boltsW + houseSpace);

  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const stroke = 2;
  const r = (H - stroke) / 2;
  ctx.beginPath();
  ctx.roundRect(stroke / 2, stroke / 2, W - stroke, H - stroke, r);
  ctx.fillStyle = CHARGING_PILL_FILL[type] ?? CHARGING_PILL_FILL.other;
  ctx.fill();
  ctx.lineWidth = stroke;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, padX, H / 2 + 0.5);

  let glyphX = padX + textW + gap;
  for (let index = 0; index < bolts; index++) {
    traceBolt(ctx, glyphX, (H - boltH) / 2, boltW, boltH);
    glyphX += boltW + boltGap;
  }
  if (home) {
    if (bolts > 0) glyphX += glyphGap - boltGap;
    drawHouse(ctx, glyphX, (H - houseH) / 2, houseW, houseH);
  }

  return { canvas, dpr };
}

function addChargingPillImage(imageId) {
  const spec = window.ChargingView.chargingPillFromImageId(imageId);
  if (!spec || map.hasImage(imageId)) return;
  const { canvas, dpr } = renderChargingPill(spec);
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  map.addImage(imageId, data, { pixelRatio: dpr });
}

function addChargingPillImages(sites) {
  for (const site of sites) {
    addChargingPillImage(window.ChargingView.chargingPillImageId({
      type: site.isSupercharger ? 'sc' : 'other',
      count: Number(site.visitCount) || 0,
      bolts: Number(site.speedTier) || 0,
      home: Boolean(site.isHome),
    }));
  }
}

async function expandChargingCluster(clusterId, coordinates) {
  const source = map?.getSource('charging-sites');
  if (!source || activeMainTab !== 'charging') return;
  try {
    const zoom = await source.getClusterExpansionZoom(clusterId);
    if (activeMainTab !== 'charging') return;
    map.easeTo({ center: coordinates, zoom, duration: 450 });
  } catch (error) {
    console.warn('Charging cluster expansion:', error);
  }
}

function updateChargingMap(sites, options = {}) {
  const fit = options.fit !== false;
  whenMapReady(() => {
    const geojson = window.ChargingView.toChargingGeoJSON(sites);
    addChargingPillImages(sites);
    map.getSource('charging-sites').setData(geojson);
    const visibility = activeMainTab === 'charging' && geojson.features.length > 0 ? 'visible' : 'none';
    for (const layerId of CHARGING_MAP_LAYER_IDS) map.setLayoutProperty(layerId, 'visibility', visibility);
    document.getElementById('charging-map-legend').classList.toggle('hidden', visibility === 'none');
    if (!fit || activeMainTab !== 'charging' || geojson.features.length === 0) return;
    if (geojson.features.length === 1) {
      map.easeTo({ center: geojson.features[0].geometry.coordinates, zoom: 12 });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const feature of geojson.features) bounds.extend(feature.geometry.coordinates);
    map.fitBounds(bounds, { padding: 50, maxZoom: 13 });
  });
}

function setChargingMarkerGroupVisible(markers, visible) {
  for (const marker of markers) {
    const element = marker?.getElement?.();
    if (element) element.style.display = visible ? '' : 'none';
  }
}

function enterChargingMapMode() {
  document.body.classList.add('charging-mode');
  if (map && !driveCameraBeforeCharging) {
    const center = map.getCenter();
    driveCameraBeforeCharging = {
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };
  }
  stopReplay();
  setChargingMarkerGroupVisible(selectedMarkers, false);
  setChargingMarkerGroupVisible(fsdEventMarkers, false);
  updatePrivacyZoneLayer(); // drops the zone markers for the charging map
  whenMapReady(() => {
    for (const layerId of DRIVE_MAP_LAYER_IDS_FOR_CHARGING) {
      map.setLayoutProperty(layerId, 'visibility', 'none');
    }
  });
  renderChargingSites();
}

function leaveChargingMapMode() {
  document.body.classList.remove('charging-mode');
  whenMapReady(() => {
    for (const layerId of CHARGING_MAP_LAYER_IDS) map.setLayoutProperty(layerId, 'visibility', 'none');
    for (const layerId of ['selected-solid', 'selected-dashed', 'traveled-solid', 'traveled-dashed']) {
      map.setLayoutProperty(layerId, 'visibility', 'visible');
    }
    updateOverviewStyleState();
  });
  document.getElementById('charging-map-legend').classList.add('hidden');
  setChargingMarkerGroupVisible(selectedMarkers, true);
  setChargingMarkerGroupVisible(fsdEventMarkers, showFsdMarkers);
  updatePrivacyZoneLayer(); // restores them for the drive map
  if (driveCameraBeforeCharging) {
    map.jumpTo(driveCameraBeforeCharging);
    driveCameraBeforeCharging = null;
  }
}

function renderSuperchargerCatalogStatus() {
  const status = document.getElementById('supercharger-catalog-status');
  if (!status || !chargingCatalogStatus) return;
  const source = chargingCatalogStatus.source === 'refreshed' ? 'Refreshed' : 'Bundled';
  status.textContent = `${source} · ${fmt(chargingCatalogStatus.stationCount ?? 0)} locations`;
  status.title = chargingCatalogStatus.lastError || chargingCatalogStatus.generatedAt || '';
}

async function updateSuperchargerCatalogStatus() {
  try {
    const result = await window.electronAPI.getSuperchargerCatalogStatus();
    if (result.success) {
      chargingCatalogStatus = result;
      renderSuperchargerCatalogStatus();
    }
  } catch (error) {
    console.warn('Supercharger catalog status:', error);
  }
}

async function refreshSuperchargerCatalog() {
  const button = document.getElementById('btn-refresh-superchargers');
  const status = document.getElementById('supercharger-catalog-status');
  button.disabled = true;
  button.textContent = 'Refreshing…';
  status.textContent = 'Downloading from OpenStreetMap…';
  try {
    const result = await window.electronAPI.refreshSuperchargerCatalog();
    chargingCatalogStatus = result;
    renderSuperchargerCatalogStatus();
    if (!result.success) {
      alert(`Supercharger refresh failed. The previous catalog is still active.\n\n${result.error}`);
    }
    await loadChargingSites();
  } catch (error) {
    alert(`Supercharger refresh failed. The previous catalog is still active.\n\n${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh locations';
  }
}
