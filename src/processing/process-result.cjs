'use strict';

const { normalizeClipPath, isEventFolderPath } = require('../shared/clip-path.cjs');
const { telemetryHasDriving } = require('../shared/event-gap-fill.cjs');

function buildProcessedRoute(result) {
  const processedPath = normalizeClipPath(result?.relativePath);
  const empty = {
    processedPath,
    route: null,
    parkedEventSkipped: false,
  };
  if (result?.error || !result?.hasGPS) return empty;
  if (isEventFolderPath(processedPath) && !telemetryHasDriving(result)) {
    return {
      ...empty,
      parkedEventSkipped: true,
    };
  }

  return {
    processedPath,
    parkedEventSkipped: false,
    route: {
      file: processedPath,
      date: result.dateDir,
      points: result.points,
      gearStates: result.gearStates,
      autopilotStates: result.autopilotStates,
      speeds: result.speeds,
      accelPositions: result.accelPositions,
      rawParkCount: result.rawParkCount,
      rawFrameCount: result.rawFrameCount,
      gearRuns: result.gearRuns,
    },
  };
}

module.exports = Object.freeze({ buildProcessedRoute });
