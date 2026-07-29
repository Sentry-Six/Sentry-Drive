'use strict';

const { round2 } = require('./drive-calc.cjs');

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function rollUpDriveTelemetry(clips) {
  const result = {};
  const seenFiles = new Set();
  let interiorMin;
  let interiorMax;
  let exteriorSum = 0;
  let exteriorCount = 0;
  let hvacSum = 0;
  let hasHvac = false;

  for (const clip of clips) {
    if (seenFiles.has(clip.file)) continue;
    seenFiles.add(clip.file);

    if (!finiteNumber(result.batteryPctStart) && finiteNumber(clip.batteryPctStart)) {
      result.batteryPctStart = round2(clip.batteryPctStart);
    }
    if (finiteNumber(clip.batteryPctEnd)) result.batteryPctEnd = round2(clip.batteryPctEnd);

    if (finiteNumber(clip.interiorTempMin)) {
      interiorMin = interiorMin == null ? clip.interiorTempMin : Math.min(interiorMin, clip.interiorTempMin);
    }
    if (finiteNumber(clip.interiorTempMax)) {
      interiorMax = interiorMax == null ? clip.interiorTempMax : Math.max(interiorMax, clip.interiorTempMax);
    }
    if (finiteNumber(clip.exteriorTempAvg)) {
      exteriorSum += clip.exteriorTempAvg;
      exteriorCount += 1;
    }
    if (finiteNumber(clip.hvacRuntimeS)) {
      hvacSum += clip.hvacRuntimeS;
      hasHvac = true;
    }

    for (const key of ['tireFlPsi', 'tireFrPsi', 'tireRlPsi', 'tireRrPsi']) {
      if (finiteNumber(clip[key])) result[key] = round2(clip[key]);
    }

    if (!finiteNumber(result.odometerMiStart) && finiteNumber(clip.odometerMiStart)) {
      result.odometerMiStart = round2(clip.odometerMiStart);
    }
    if (finiteNumber(clip.odometerMiEnd)) result.odometerMiEnd = round2(clip.odometerMiEnd);

    if (result.locationNameStart == null && clip.locationNameStart != null) {
      result.locationNameStart = clip.locationNameStart;
    }
    if (clip.locationNameEnd != null) result.locationNameEnd = clip.locationNameEnd;
  }

  if (finiteNumber(result.batteryPctStart) && finiteNumber(result.batteryPctEnd)) {
    result.batteryPctUsed = round2(result.batteryPctStart - result.batteryPctEnd);
  }
  if (interiorMin != null) result.interiorTempMinC = round2(interiorMin);
  if (interiorMax != null) result.interiorTempMaxC = round2(interiorMax);
  if (exteriorCount > 0) result.exteriorTempAvgC = round2(exteriorSum / exteriorCount);
  if (hasHvac) result.hvacRuntimeS = Math.round(hvacSum);
  if (
    finiteNumber(result.odometerMiStart)
    && finiteNumber(result.odometerMiEnd)
    && result.odometerMiEnd >= result.odometerMiStart
  ) {
    result.odometerMiDriven = round2(result.odometerMiEnd - result.odometerMiStart);
  }

  return result;
}

module.exports = Object.freeze({
  rollUpDriveTelemetry,
});
