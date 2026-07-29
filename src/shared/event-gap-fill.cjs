'use strict';

// Rust-parity event-folder gap-fill selection. Shared as CommonJS so both the
// ESM processing pipeline and CommonJS disk-backed loader use one decision.

const {
  isEventFolderPath,
  parseClipTimestampMs,
} = require('./clip-path.cjs');

const GEAR_PARK = 0;
const GAP_FILL_MIN_MS = 90 * 1000;
const GAP_FILL_MAX_MS = 30 * 60 * 1000;
const GAP_FILL_ADJ_MS = 3 * 60 * 1000;
const GAP_FILL_DUP_MS = 30 * 1000;
const GAP_FILL_MIN_SPEED_MPS = 0.5;
function decodeGearStates(field) {
  if (typeof field === 'string') return Buffer.from(field, 'base64');
  return field ?? [];
}

function telemetryHasDriving(route) {
  const gearRuns = Array.isArray(route?.gearRuns) ? route.gearRuns : [];
  if (gearRuns.some((run) => Number(run?.gear) !== GEAR_PARK)) return true;

  const gearStates = decodeGearStates(route?.gearStates);
  for (const gear of gearStates) {
    if (Number(gear) !== GEAR_PARK) return true;
  }

  if (
    gearRuns.length === 0
    && gearStates.length === 0
    && Number(route?.rawFrameCount) > 0
    && Number(route?.rawParkCount) < Number(route.rawFrameCount)
  ) {
    return true;
  }

  const speeds = route?.speeds ?? [];
  for (const speed of speeds) {
    if (Math.abs(Number(speed) || 0) > GAP_FILL_MIN_SPEED_MPS) return true;
  }
  return false;
}

function partitionPoint(values, predicate) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (predicate(values[mid])) low = mid + 1;
    else high = mid;
  }
  return low;
}

function fillableHoles(recentSortedMs) {
  const holes = [];
  for (let index = 1; index < recentSortedMs.length; index++) {
    const start = recentSortedMs[index - 1];
    const end = recentSortedMs[index];
    const gap = end - start;
    if (gap > GAP_FILL_MIN_MS && gap <= GAP_FILL_MAX_MS) holes.push([start, end]);
  }
  return holes;
}

function timestampInHoles(holes, timestampMs) {
  return holes.some(([start, end]) => start < timestampMs && timestampMs < end);
}

function deduplicateCandidates(recentSortedMs, candidates, eligible) {
  const notOccupied = eligible.filter((candidateIndex) => {
    const timestampMs = candidates[candidateIndex].timestampMs;
    const insertion = partitionPoint(recentSortedMs, (recent) => recent <= timestampMs);
    return insertion === 0
      || timestampMs - recentSortedMs[insertion - 1] > GAP_FILL_DUP_MS;
  });

  notOccupied.sort((leftIndex, rightIndex) => {
    const left = candidates[leftIndex];
    const right = candidates[rightIndex];
    if (left.timestampMs !== right.timestampMs) return left.timestampMs - right.timestampMs;
    if (left.file < right.file) return -1;
    if (left.file > right.file) return 1;
    return 0;
  });

  const kept = [];
  for (const candidateIndex of notOccupied) {
    const previousIndex = kept.at(-1);
    if (
      previousIndex !== undefined
      && candidates[candidateIndex].timestampMs - candidates[previousIndex].timestampMs
        <= GAP_FILL_DUP_MS
    ) {
      continue;
    }
    kept.push(candidateIndex);
  }
  return kept;
}

function selectGapFill(recentSortedMs, candidates) {
  if (!recentSortedMs.length || !candidates.length) return [];

  const holes = fillableHoles(recentSortedMs);
  const eligible = [];
  for (let index = 0; index < candidates.length; index++) {
    if (candidates[index].driving !== false) eligible.push(index);
  }
  const kept = deduplicateCandidates(recentSortedMs, candidates, eligible);

  const nearestRecentMs = (timestampMs) => {
    const insertion = partitionPoint(recentSortedMs, (recent) => recent < timestampMs);
    let best = Number.POSITIVE_INFINITY;
    if (insertion > 0) best = Math.min(best, timestampMs - recentSortedMs[insertion - 1]);
    if (insertion < recentSortedMs.length) {
      best = Math.min(best, recentSortedMs[insertion] - timestampMs);
    }
    return best;
  };

  const merged = recentSortedMs
    .map((timestampMs) => ({ timestampMs, keptIndex: null }))
    .concat(kept.map((candidateIndex, keptIndex) => ({
      timestampMs: candidates[candidateIndex].timestampMs,
      keptIndex,
    })))
    .sort((left, right) => left.timestampMs - right.timestampMs);

  const chained = new Array(kept.length).fill(false);
  let clusterStart = 0;
  for (let index = 0; index <= merged.length; index++) {
    const clusterEnds = index === merged.length
      || (
        index > 0
        && merged[index].timestampMs - merged[index - 1].timestampMs > GAP_FILL_ADJ_MS
      );
    if (!clusterEnds) continue;

    const cluster = merged.slice(clusterStart, index);
    if (cluster.some((entry) => entry.keptIndex === null)) {
      for (const entry of cluster) {
        if (
          entry.keptIndex !== null
          && nearestRecentMs(entry.timestampMs) <= GAP_FILL_MAX_MS
        ) {
          chained[entry.keptIndex] = true;
        }
      }
    }
    clusterStart = index;
  }

  return kept.filter((candidateIndex, keptIndex) => (
    timestampInHoles(holes, candidates[candidateIndex].timestampMs)
    || chained[keptIndex]
  ));
}

module.exports = Object.freeze({
  isEventFolderPath,
  parseClipTimestampMs,
  telemetryHasDriving,
  selectGapFill,
});
