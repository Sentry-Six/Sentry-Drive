'use strict';

const SESSION_GAP_SECONDS = 30 * 60;
const LOCATION_FALLBACK_SECONDS = 15 * 60;
const SUSTAINED_POWER_SECONDS = 60;
const SITE_GROUPING_METRES = 150;
const TERMINAL_STATES = new Set(['complete', 'stopped', 'disconnected', 'nopower']);
const ACTIVE_STATES = new Set(['starting', 'charging']);

// A case-insensitive Home tag marks the site's map pill with a house.
const HOME_TAG = 'home';

// Exported placeholders let consumers distinguish absent and reported names.
const UNKNOWN_SITE_LABEL = 'Unknown location';
const UNNAMED_SITE_LABEL = 'Charging location';
const PLACEHOLDER_SITE_LABELS = new Set([UNKNOWN_SITE_LABEL, UNNAMED_SITE_LABEL]);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTimestamp(value) {
  const numeric = finiteNumber(value);
  if (numeric == null || numeric < 0) return null;
  return numeric > 10_000_000_000 ? numeric / 1_000 : numeric;
}

function isoTimestamp(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

function normalizedState(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    : null;
}

function createChargingSessionBuilder(options = {}) {
  const gapSeconds = options.gapSeconds ?? SESSION_GAP_SECONDS;
  const fallbackSeconds = options.locationFallbackSeconds ?? LOCATION_FALLBACK_SECONDS;
  const sustainedPowerSeconds = options.sustainedPowerSeconds ?? SUSTAINED_POWER_SECONDS;
  const completed = [];
  let sequence = 0;
  let active = null;
  let lastTimestamp = null;
  const sparse = {
    batteryPct: null,
    batteryTimestamp: null,
    latitude: null,
    longitude: null,
    coordinateTimestamp: null,
    locationName: null,
    locationNameTimestamp: null,
  };

  function updateSparse(sample, timestamp) {
    const batteryPct = finiteNumber(sample.batteryPct);
    if (batteryPct != null) {
      sparse.batteryPct = batteryPct;
      sparse.batteryTimestamp = timestamp;
    }
    const latitude = finiteNumber(sample.lat ?? sample.latitude);
    const longitude = finiteNumber(sample.lng ?? sample.longitude);
    if (latitude != null && longitude != null) {
      sparse.latitude = latitude;
      sparse.longitude = longitude;
      sparse.coordinateTimestamp = timestamp;
    }
    if (typeof sample.locationName === 'string' && sample.locationName.trim()) {
      sparse.locationName = sample.locationName.trim();
      sparse.locationNameTimestamp = timestamp;
    }
  }

  function begin(timestamp, costKey) {
    const hasFreshCoordinates = sparse.coordinateTimestamp != null
      && timestamp - sparse.coordinateTimestamp <= fallbackSeconds;
    const hasFreshName = sparse.locationNameTimestamp != null
      && timestamp - sparse.locationNameTimestamp <= fallbackSeconds;
    sequence++;
    active = {
      sessionId: `charge-${timestamp}-${sequence}`,
      costKey: String(costKey),
      startTimestamp: timestamp,
      lastTimestamp: timestamp,
      startBatteryPct: sparse.batteryPct,
      endBatteryPct: sparse.batteryPct,
      energyAddedKwh: null,
      peakPowerKw: null,
      poweredStreakStartTimestamp: null,
      maxPoweredDurationSeconds: 0,
      latitude: hasFreshCoordinates ? sparse.latitude : null,
      longitude: hasFreshCoordinates ? sparse.longitude : null,
      coordinateDuringSession: false,
      locationName: hasFreshName ? sparse.locationName : null,
      chargeRateSamples: [],
    };
  }

  function isMeaningful(session) {
    if (session.energyAddedKwh != null && session.energyAddedKwh > 0) return true;
    return session.maxPoweredDurationSeconds >= sustainedPowerSeconds;
  }

  function close(endTimestamp, endReason) {
    if (!active) return;
    const session = active;
    active = null;
    if (!isMeaningful(session)) return;
    completed.push({
      sessionId: session.sessionId,
      startTimestamp: session.startTimestamp,
      endTimestamp,
      startTime: isoTimestamp(session.startTimestamp),
      endTime: isoTimestamp(endTimestamp),
      durationSeconds: Math.max(0, endTimestamp - session.startTimestamp),
      startBatteryPct: session.startBatteryPct,
      endBatteryPct: session.endBatteryPct,
      energyAddedKwh: session.energyAddedKwh,
      peakPowerKw: session.peakPowerKw,
      latitude: session.latitude,
      longitude: session.longitude,
      locationName: session.locationName,
      endReason,
      cost: null,
      costKey: session.costKey,
      chargeRateSamples: session.chargeRateSamples,
    });
  }

  function add(sample) {
    if (!sample || typeof sample !== 'object') return;
    const rawTimestamp = sample.ts ?? sample.timestamp;
    const timestamp = normalizeTimestamp(rawTimestamp);
    if (timestamp == null) return;
    if (active && lastTimestamp != null && timestamp - lastTimestamp > gapSeconds) {
      close(lastTimestamp, 'data-gap');
    }

    updateSparse(sample, timestamp);
    const state = normalizedState(sample.chargingState);
    if (!active && ACTIVE_STATES.has(state)) begin(timestamp, rawTimestamp);

    if (active) {
      active.lastTimestamp = timestamp;
      if (sparse.batteryPct != null) active.endBatteryPct = sparse.batteryPct;

      const latitude = finiteNumber(sample.lat ?? sample.latitude);
      const longitude = finiteNumber(sample.lng ?? sample.longitude);
      if (latitude != null && longitude != null) {
        active.latitude = latitude;
        active.longitude = longitude;
        active.coordinateDuringSession = true;
      }
      if (typeof sample.locationName === 'string' && sample.locationName.trim()) {
        active.locationName = sample.locationName.trim();
      }

      const energyAddedKwh = finiteNumber(sample.chargeEnergyAddedKwh);
      if (energyAddedKwh != null) {
        active.energyAddedKwh = Math.max(active.energyAddedKwh ?? 0, energyAddedKwh);
      }
      const powerKw = finiteNumber(sample.chargerPowerKw);
      if (powerKw != null) {
        active.peakPowerKw = Math.max(active.peakPowerKw ?? powerKw, powerKw);
        if (powerKw > 0) {
          if (active.poweredStreakStartTimestamp == null) {
            active.poweredStreakStartTimestamp = timestamp;
          }
          active.maxPoweredDurationSeconds = Math.max(
            active.maxPoweredDurationSeconds,
            timestamp - active.poweredStreakStartTimestamp,
          );
        } else {
          active.poweredStreakStartTimestamp = null;
        }
      }
      const chargeRateMph = finiteNumber(sample.chargeRateMph);
      if (powerKw != null || energyAddedKwh != null || chargeRateMph != null) {
        const curveSample = { timestamp };
        if (powerKw != null) curveSample.powerKw = powerKw;
        if (chargeRateMph != null) curveSample.chargeRateMph = chargeRateMph;
        if (energyAddedKwh != null) curveSample.energyAddedKwh = energyAddedKwh;
        if (sparse.batteryPct != null) curveSample.batteryPct = sparse.batteryPct;
        active.chargeRateSamples.push(curveSample);
      }
      if (TERMINAL_STATES.has(state)) close(timestamp, state);
    }
    lastTimestamp = timestamp;
  }

  // chargeTags and chargeCosts share the opening sample's raw timestamp key.
  function finish(chargeCosts = {}, chargeTags = {}) {
    if (active) close(active.lastTimestamp, 'end-of-file');
    return completed.map((session) => {
      const { costKey, ...output } = session;
      const tags = Object.prototype.hasOwnProperty.call(chargeTags, costKey)
        ? chargeTags[costKey]
        : null;
      return {
        ...output,
        cost: Object.prototype.hasOwnProperty.call(chargeCosts, costKey)
          ? chargeCosts[costKey]
          : null,
        tags: Array.isArray(tags) ? tags : (tags == null ? [] : [tags]),
      };
    });
  }

  return { add, finish };
}

function haversineMetres(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusMetres = 6_371_000;
  const deltaLatitude = radians(latitudeB - latitudeA);
  const deltaLongitude = radians(longitudeB - longitudeA);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB))
      * Math.sin(deltaLongitude / 2) ** 2;
  return earthRadiusMetres * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function groupChargingSites(inputSessions, radiusMetres = SITE_GROUPING_METRES) {
  const sessions = [...inputSessions].sort((a, b) => a.startTimestamp - b.startTimestamp);
  const sites = [];
  let unknownSite = null;

  for (const session of sessions) {
    const latitude = finiteNumber(session.latitude);
    const longitude = finiteNumber(session.longitude);
    let site;
    if (latitude == null || longitude == null) {
      if (!unknownSite) {
        unknownSite = {
          siteId: 'unknown',
          latitude: null,
          longitude: null,
          displayName: UNKNOWN_SITE_LABEL,
          sessions: [],
          coordinateCount: 0,
        };
        sites.push(unknownSite);
      }
      site = unknownSite;
    } else {
      site = sites.find((candidate) => candidate.latitude != null
        && haversineMetres(latitude, longitude, candidate.latitude, candidate.longitude)
          <= radiusMetres);
      if (!site) {
        site = {
          siteId: `site-${session.sessionId}`,
          latitude,
          longitude,
          displayName: session.locationName || UNNAMED_SITE_LABEL,
          sessions: [],
          coordinateCount: 0,
        };
        sites.push(site);
      }
      const nextCount = site.coordinateCount + 1;
      site.latitude = ((site.latitude * site.coordinateCount) + latitude) / nextCount;
      site.longitude = ((site.longitude * site.coordinateCount) + longitude) / nextCount;
      site.coordinateCount = nextCount;
      if (session.locationName) site.displayName = session.locationName;
    }
    session.siteId = site.siteId;
    site.sessions.push(session);
  }

  const summaries = sites.map((site) => {
    site.sessions.sort((a, b) => b.startTimestamp - a.startTimestamp);
    // Union session tags in first-seen order; any Home visit marks the site.
    const tags = [];
    for (const session of site.sessions) {
      for (const tag of session.tags ?? []) {
        if (!tags.includes(tag)) tags.push(tag);
      }
    }
    // Observed peak is a lower bound on charger capacity, not its rating.
    let peakPowerKw = null;
    for (const session of site.sessions) {
      const peak = finiteNumber(session.peakPowerKw);
      if (peak != null && peak > (peakPowerKw ?? -Infinity)) peakPowerKw = peak;
    }
    return {
      siteId: site.siteId,
      latitude: site.latitude,
      longitude: site.longitude,
      displayName: site.displayName,
      visitCount: site.sessions.length,
      latestVisit: site.sessions[0]?.startTime ?? null,
      peakPowerKw,
      tags,
      isHome: tags.some((tag) => String(tag).trim().toLowerCase() === HOME_TAG),
    };
  }).sort((a, b) => b.visitCount - a.visitCount
    || String(b.latestVisit).localeCompare(String(a.latestVisit)));

  return {
    sites: summaries,
    sessions: sessions.sort((a, b) => b.startTimestamp - a.startTimestamp),
  };
}

module.exports = {
  ACTIVE_STATES,
  HOME_TAG,
  LOCATION_FALLBACK_SECONDS,
  PLACEHOLDER_SITE_LABELS,
  SESSION_GAP_SECONDS,
  SITE_GROUPING_METRES,
  TERMINAL_STATES,
  UNKNOWN_SITE_LABEL,
  UNNAMED_SITE_LABEL,
  createChargingSessionBuilder,
  groupChargingSites,
  haversineMetres,
};
