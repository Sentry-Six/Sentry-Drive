'use strict';

const fs = require('fs');
const path = require('path');
const { geodesicM } = require('../shared/drive-calc.cjs');

const STORE_VERSION = 1;
const MAX_ENTRIES = 1000;
const SOURCE_PRIORITY = Object.freeze({ manual: 3, zone: 2, tesla: 1 });

function finiteCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function cleanLabel(label) {
  return typeof label === 'string' ? label.trim().slice(0, 160) : '';
}

function defaultRadius(source) {
  if (source === 'zone') return 150;
  if (source === 'manual') return 40;
  return 25;
}

function cleanEntry(entry) {
  const lat = Number(entry?.lat);
  const lng = Number(entry?.lng);
  const label = cleanLabel(entry?.label);
  const source = SOURCE_PRIORITY[entry?.source] ? entry.source : null;
  if (!finiteCoordinate(lat, lng) || !label || !source) return null;
  const maxRadius = source === 'zone' ? 1000 : 100;
  const radiusM = Math.min(maxRadius, Math.max(5, Number(entry.radiusM) || defaultRadius(source)));
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    label,
    lat,
    lng,
    radiusM,
    source,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
  };
}

function atomicWriteJson(filePath, value) {
  if (!filePath) return;
  const tempPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(value));
    fs.renameSync(tempPath, filePath);
  } catch {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function createKnownPlaceStore(filePath) {
  let entries = [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw?.__v === STORE_VERSION && Array.isArray(raw.entries)) {
      entries = raw.entries.map(cleanEntry).filter(Boolean);
    }
  } catch {}

  const save = () => atomicWriteJson(filePath, { __v: STORE_VERSION, entries });

  function trimLearnedEntries() {
    if (entries.length <= MAX_ENTRIES) return;
    const protectedEntries = entries.filter((entry) => entry.source !== 'tesla');
    const learned = entries
      .filter((entry) => entry.source === 'tesla')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, MAX_ENTRIES - protectedEntries.length));
    entries = [...protectedEntries, ...learned];
  }

  return {
    find(lat, lng) {
      if (!finiteCoordinate(lat, lng)) return null;
      let best = null;
      for (const entry of entries) {
        const distanceM = geodesicM(lat, lng, entry.lat, entry.lng);
        if (distanceM > entry.radiusM) continue;
        const candidate = { ...entry, distanceM: Math.round(distanceM * 10) / 10 };
        if (!best
            || SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[best.source]
            || (SOURCE_PRIORITY[candidate.source] === SOURCE_PRIORITY[best.source]
                && candidate.distanceM < best.distanceM)) best = candidate;
      }
      return best;
    },

    upsert(input) {
      const next = cleanEntry(input);
      if (!next) return null;
      let existing = input?.id ? entries.find((entry) => entry.id === input.id) : null;
      if (!existing) {
        existing = entries.find((entry) => entry.source === next.source
          && entry.label.toLocaleLowerCase() === next.label.toLocaleLowerCase()
          && geodesicM(entry.lat, entry.lng, next.lat, next.lng) <= Math.max(entry.radiusM, next.radiusM));
      }
      if (existing) Object.assign(existing, next, { id: existing.id, updatedAt: Date.now() });
      else entries.push(next);
      trimLearnedEntries();
      save();
      return { ...(existing || next) };
    },

    removeNear(lat, lng, source = 'manual', maxDistanceM = 100) {
      if (!finiteCoordinate(lat, lng)) return false;
      let bestIndex = -1;
      let bestDistance = Infinity;
      for (let i = 0; i < entries.length; i++) {
        if (source && entries[i].source !== source) continue;
        const distanceM = geodesicM(lat, lng, entries[i].lat, entries[i].lng);
        if (distanceM <= maxDistanceM && distanceM < bestDistance) {
          bestIndex = i;
          bestDistance = distanceM;
        }
      }
      if (bestIndex < 0) return false;
      entries.splice(bestIndex, 1);
      save();
      return true;
    },

    replaceZones(zones) {
      entries = entries.filter((entry) => entry.source !== 'zone');
      for (const zone of Array.isArray(zones) ? zones : []) {
        const entry = cleanEntry({ ...zone, id: `zone-${zone.id}`, source: 'zone' });
        if (entry) entries.push(entry);
      }
      trimLearnedEntries();
      save();
      return entries.filter((entry) => entry.source === 'zone').length;
    },

    list() {
      return entries.map((entry) => ({ ...entry }));
    },
  };
}

module.exports = { createKnownPlaceStore };
