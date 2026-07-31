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
    summonDriveCount: 0,
  };
  const seiRanges = [];
  let offset = 0;
  while (offset < nextDriveId) {
    const page = index.listDriveSummaries({ offset, limit: 1000 });
    for (const drive of page.drives) {
      aggregates.totalDistanceMi += drive.distanceMi ?? 0;
      aggregates.totalDurationMs += drive.durationMs ?? 0;
      if (drive.summon) {
        // Summon drives count toward totals but are EXCLUDED from FSD
        // analytics: the car drives itself with autopilot_state unset, so
        // folding them in as "0% FSD" drives would dilute the score and the
        // per-drive averages with trips no human (or FSD) ever drove.
        aggregates.summonDriveCount++;
      } else if (drive.source === 'sei') {
        const start = Date.parse(drive.startTime);
        const end = Date.parse(drive.endTime);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          seiRanges.push({ start, end });
        }
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
  seiRanges.sort((a, b) => a.start - b.start);
  index.setMeta('aggregates', aggregates);

  const hiddenIds = [];
  const hiddenTessieDrives = [];
  offset = 0;
  while (offset < nextDriveId) {
    const page = index.listDriveSummaries({ offset, limit: 1000 });
    for (const drive of page.drives) {
      if (drive.source === 'sei') continue;
      const importedStart = Date.parse(drive.startTime);
      const importedEnd = Date.parse(drive.endTime);
      if (
        !Number.isFinite(importedStart)
        || !Number.isFinite(importedEnd)
        || importedEnd <= importedStart
      ) {
        continue;
      }
      let overlaps = false;
      for (const range of seiRanges) {
        if (range.end <= importedStart) continue;
        if (range.start >= importedEnd) break;
        overlaps = true;
        break;
      }
      if (!overlaps) continue;
      hiddenIds.push(drive.id);
      hiddenTessieDrives.push({
        startTime: drive.startTime,
        endTime: drive.endTime,
        distanceMi: drive.distanceMi,
        source: drive.source,
      });
    }
    offset += page.drives.length;
    if (page.drives.length === 0) break;
  }
  for (const id of hiddenIds) index.deleteDrive(id);

  const groupedDriveCount = nextDriveId;
  return {
    ...counts,
    totalRoutes: counts.routeCount,
    totalDriveCount: groupedDriveCount - hiddenIds.length,
    groupedDriveCount,
    timeGroupCount,
    routeCount,
    droppedCount: counts.droppedCount + grouperDroppedCount,
    driveTags,
    hiddenTessieCount: hiddenIds.length,
    hiddenTessieDrives,
    aggregates,
  };
}

module.exports = {
  downsampleOverview,
  groupIndexedDrives,
};
