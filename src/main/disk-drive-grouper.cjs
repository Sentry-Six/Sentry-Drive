'use strict';

function downsampleOverview(points, maxPoints = 120) {
  if (!points || points.length === 0) return [];
  if (points.length <= maxPoints) return points.map((point) => [point[0], point[1]]);
  const result = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index++) {
    const point = points[Math.round(index * step)];
    result.push([point[0], point[1]]);
  }
  return result;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error('Drive grouping canceled');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  throw err;
}

async function groupIndexedDrives(index, options = {}) {
  const { onProgress, signal } = options;
  const { groupIntoDrives } = await import('../processing/grouper.js');
  const counts = index.getMeta();
  const driveTags = index.getDriveTags();
  index.clearDrives();

  let nextDriveId = 0;
  let timeGroupCount = 0;
  let routeCount = 0;
  let grouperDroppedCount = 0;

  for (const routes of index.iterateTimeWindows()) {
    throwIfAborted(signal);
    const grouped = groupIntoDrives(routes);
    timeGroupCount += grouped.timeGroupCount;
    routeCount += grouped.routeCount;
    grouperDroppedCount += grouped.droppedCount;

    for (const groupedDrive of grouped.drives) {
      const id = nextDriveId++;
      const detail = {
        points: groupedDrive.points,
        fsdStates: groupedDrive.fsdStates,
        gearStates: groupedDrive.gearStates,
        fsdEvents: groupedDrive.fsdEvents,
      };
      const summary = {
        ...groupedDrive,
        id,
        tags: driveTags[groupedDrive.startTime] ?? [],
        bridged: (groupedDrive.routeFiles ?? []).some((file) => file.includes('-front-bridge.mp4')),
        overviewPoints: downsampleOverview(groupedDrive.points),
      };
      delete summary.points;
      delete summary.fsdStates;
      delete summary.gearStates;
      delete summary.fsdEvents;
      index.putDrive(summary, detail);
    }

    onProgress?.({
      phase: 'grouping',
      current: routeCount,
      total: counts.routeCount,
    });
  }

  const aggregates = {
    totalDriveCount: nextDriveId,
    totalDistanceMi: 0,
    totalDurationMs: 0,
    seiDistanceM: 0,
    fsdDistanceM: 0,
    autosteerDistanceM: 0,
    taccDistanceM: 0,
    fsdDisengagements: 0,
    fsdAccelPushes: 0,
    fsdEngagedMs: 0,
    fsdPercentSum: 0,
    seiDriveCount: 0,
    importedDriveCount: 0,
  };
  let offset = 0;
  while (offset < nextDriveId) {
    const page = index.listDriveSummaries({ offset, limit: 1000 });
    for (const drive of page.drives) {
      aggregates.totalDistanceMi += drive.distanceMi ?? 0;
      aggregates.totalDurationMs += drive.durationMs ?? 0;
      if (drive.source === 'sei') {
        aggregates.seiDriveCount++;
        aggregates.seiDistanceM += (drive.distanceKm ?? 0) * 1000;
        aggregates.fsdDistanceM += (drive.fsdDistanceKm ?? 0) * 1000;
        aggregates.autosteerDistanceM += (drive.autosteerDistanceKm ?? 0) * 1000;
        aggregates.taccDistanceM += (drive.taccDistanceKm ?? 0) * 1000;
        aggregates.fsdDisengagements += drive.fsdDisengagements ?? 0;
        aggregates.fsdAccelPushes += drive.fsdAccelPushes ?? 0;
        aggregates.fsdEngagedMs += drive.fsdEngagedMs ?? 0;
        aggregates.fsdPercentSum += drive.fsdPercent ?? 0;
      } else {
        aggregates.importedDriveCount++;
      }
    }
    offset += page.drives.length;
    if (page.drives.length === 0) break;
  }
  index.setMeta('aggregates', aggregates);

  return {
    ...counts,
    totalRoutes: counts.routeCount,
    totalDriveCount: nextDriveId,
    timeGroupCount,
    routeCount,
    droppedCount: counts.droppedCount + grouperDroppedCount,
    driveTags,
    aggregates,
  };
}

module.exports = {
  downsampleOverview,
  groupIndexedDrives,
};
