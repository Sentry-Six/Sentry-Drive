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
      // Raw-frame Summon evidence: hazard/pedal bits and autopilot states.
      // Without these on the route, a drive can only be tagged after Check
      // for Summon re-reads its clips.
      flagRuns: result.flagRuns,
      apRuns: result.apRuns,
    },
  };
}

// Checkpoints are written while workers continue producing results. Snapshot
// both collections together so a later processedFiles push cannot get ahead of
// the fixed route list and permanently mark an unwritten route as processed.
function snapshotProcessingState(processedFiles, routeMap) {
  return {
    processedFiles: [...processedFiles],
    routes: Array.from(routeMap.values()),
  };
}

module.exports = Object.freeze({ buildProcessedRoute, snapshotProcessingState });
