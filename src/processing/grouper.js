// Drive grouping, FSD analytics, and metrics calculation.

import { GEAR_PARK, AUTOPILOT_OFF, AUTOPILOT_FSD, AUTOPILOT_AUTOSTEER, AUTOPILOT_TACC } from "./extract.js";
import {
  geodesicM,
  round2,
  detectSummon,
  DRIVE_GAP_MS,
  PARK_GAP_SECONDS,
  CLIP_DURATION_MS,
  GAP_FILL_MIN_MS,
  GAP_FILL_MAX_MS,
  GAP_FILL_ADJ_MS,
  GAP_FILL_DUP_MS,
  GAP_FILL_MIN_SPEED_MPS,
  NULL_ISLAND_DEG,
  MAX_FROM_MEDIAN_M,
  MAX_JUMP_M,
  SEI_SPEED_MAX_MPS,
  DERIVED_SPEED_MAX_MPS,
  M_PER_MILE,
  M_PER_KM,
  MPS_TO_MPH,
  MPS_TO_KMH,
} from "../shared/drive-calc.cjs";
import eventGapFill from "../shared/event-gap-fill.cjs";
import clipPath from "../shared/clip-path.cjs";
import driveTelemetry from "../shared/drive-telemetry.cjs";

const {
  isEventFolderPath,
  parseClipTimestampMs,
  telemetryHasDriving,
  selectGapFill: selectGapFillCanonical,
} = eventGapFill;
const { normalizeClipPath } = clipPath;
const { rollUpDriveTelemetry } = driveTelemetry;

export { isEventFolderPath, telemetryHasDriving };

// Go serializes `[]uint8` fields as base64. Normalize them to Uint8Array in
// memory and encode them again for the shared disk format.
export function decodeByteField(field) {
  if (field == null) return field;
  if (typeof field === "string") {
    return Uint8Array.from(Buffer.from(field, "base64"));
  }
  return field;
}

export function encodeByteField(field) {
  if (field == null) return field;
  if (typeof field === "string") return field;
  return Buffer.from(field).toString("base64");
}

function parseFileTimestamp(filePath) {
  const timestampMs = parseClipTimestampMs(filePath);
  return timestampMs == null ? null : new Date(timestampMs);
}

// Compatibility exports around the shared gap-fill implementation.
export function parseClipTimestamp(filePath) {
  return parseFileTimestamp(filePath);
}

export function fillableHoles(sortedTsMs) {
  const holes = [];
  for (let index = 1; index < sortedTsMs.length; index++) {
    const gap = sortedTsMs[index] - sortedTsMs[index - 1];
    if (gap > GAP_FILL_MIN_MS && gap <= GAP_FILL_MAX_MS) {
      holes.push([sortedTsMs[index - 1], sortedTsMs[index]]);
    }
  }
  return holes;
}

export function tsInHoles(holes, timestampMs) {
  for (const [start, end] of holes) {
    if (timestampMs > start && timestampMs < end) return true;
    if (start >= timestampMs) break;
  }
  return false;
}

export function selectGapFill(recentSortedTsMs, candidates) {
  return selectGapFillCanonical(
    recentSortedTsMs,
    candidates.map((candidate) => ({
      ...candidate,
      timestampMs: candidate.timestampMs ?? candidate.ts,
    })),
  );
}

export function selectGapFillEvents(recentSortedTsMs, candidates) {
  return selectGapFill(
    recentSortedTsMs,
    candidates.map((candidate) => ({ ...candidate, driving: null })),
  );
}

// WGS-84 distance, rounding, and grouping constants come from the shared
// calculation contract and remain aligned with Sentry-USB-Rusty.

/**
 * Group routes into logical drives based on time gaps and gear state.
 */
export function groupIntoDrives(routes) {
  // Deduplicate normalized paths and partition event-folder routes before
  // admission. Event paths may duplicate RecentClips under another name or
  // contain parked recordings that are not drives.
  const seen = new Set();
  const unique = [];
  const eventCandidates = [];
  for (const r of routes) {
    const norm = normalizeClipPath(r?.file);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (isEventFolderPath(norm)) {
      eventCandidates.push({ ...r, file: norm });
      continue;
    }
    unique.push({
      ...r,
      file: norm,
      source: r.source ?? "sei",
      autopilotStates: decodeByteField(r.autopilotStates),
      gearStates: decodeByteField(r.gearStates),
    });
  }

  // Parse the clip basename, not an event folder's earlier timestamp. Routes
  // are already local clones, so attach timestamps without another full copy.
  const timed = [];
  for (const r of unique) {
    const t = parseClipTimestamp(r.file);
    if (t) {
      r.timestamp = t;
      timed.push(r);
    }
  }

  if (timed.length === 0) {
    return { drives: [], timeGroupCount: 0, routeCount: 0, droppedCount: routes.length };
  }

  timed.sort((a, b) => a.timestamp - b.timestamp);

  // Admit event routes only when driving telemetry and canonical gap-fill rules
  // identify a missing RecentClips interval or anchored edge chain.
  if (eventCandidates.length > 0) {
    const candidates = [];
    for (const route of eventCandidates) {
      const timestampMs = parseClipTimestampMs(route.file);
      if (timestampMs == null) continue;
      candidates.push({
        timestampMs,
        file: route.file,
        driving: telemetryHasDriving(route),
        route,
      });
    }
    const recentSortedMs = timed.map((route) => route.timestamp.getTime());
    for (const candidateIndex of selectGapFill(recentSortedMs, candidates)) {
      const candidate = candidates[candidateIndex];
      timed.push({
        ...candidate.route,
        source: candidate.route.source ?? "sei",
        autopilotStates: decodeByteField(candidate.route.autopilotStates),
        gearStates: decodeByteField(candidate.route.gearStates),
        timestamp: new Date(candidate.timestampMs),
      });
    }
    timed.sort((a, b) => a.timestamp - b.timestamp);
  }

  annotateClipSpans(timed);

  const timeGroups = [];
  let current = [timed[0]];

  for (let i = 1; i < timed.length; i++) {
    const gap = timed[i].timestamp - current[current.length - 1].timestamp;
    if (gap > DRIVE_GAP_MS) {
      timeGroups.push(current);
      current = [timed[i]];
    } else {
      current.push(timed[i]);
    }
  }
  timeGroups.push(current);

  // Imported-drive signatures refine the normal time/gear grouping.
  const groups = [];
  for (const tg of timeGroups) {
    for (const gearGroup of splitByGearState(tg)) {
      groups.push(...splitByExternalSignature(gearGroup));
    }
  }

  const drives = groups.map((group, idx) => buildDriveStats(group, idx));
  return {
    drives,
    timeGroupCount: timeGroups.length,
    routeCount: timed.length,
    droppedCount: routes.length - timed.length,
  };
}

/**
 * Split imported clips by externalSignature. Native SEI clips remain one
 * group; signatures disambiguate back-to-back provider drives.
 */
/**
 * A clip's real wall-clock span. Clips are nominally a minute, but a recording
 * that stops early — the last clip of a session, or one interrupted by an
 * event — keeps its frames and loses its duration. The next clip's start is
 * the ground truth for when this one ended; measured across 17 days of real
 * clips, a full minute carries ~2160 SEI frames and short clips scale with it.
 * Falls back to the nominal minute for the last clip of a series.
 */
function clipSpanOf(clip) {
  const span = clip?.clipSpanMs;
  return span > 0 && span <= CLIP_DURATION_MS ? span : CLIP_DURATION_MS;
}

/**
 * Annotate each route with the gap to the next one, which is that route's real
 * span. Done once over the whole sorted series so every consumer — the park
 * splitter, drive duration, and per-point timestamps — agrees on how long a
 * clip lasted. Gaps beyond a minute mean the next clip is not contiguous, so
 * the nominal minute stands.
 */
function annotateClipSpans(sortedRoutes) {
  // Only a native dashcam clip can bound another one. Imported providers
  // synthesise clips on an exact minute grid and gap-fill invents bridge
  // routes, so an import interleaved with real footage would otherwise
  // declare a full minute of dashcam video to have lasted seconds.
  const native = sortedRoutes.filter((r) =>
    (r.source ?? 'sei') === 'sei' && !String(r.file ?? '').includes('-front-bridge.mp4'));
  for (let i = 0; i < native.length - 1; i++) {
    const gap = native[i + 1].timestamp.getTime() - native[i].timestamp.getTime();
    if (gap > 0 && gap <= CLIP_DURATION_MS) native[i].clipSpanMs = gap;
  }
}

function splitByExternalSignature(group) {
  if (group.length <= 1) return [group];
  const hasAnySignature = group.some((c) => c.externalSignature);
  if (!hasAnySignature) return [group];

  // Bucket regardless of order because tied timestamps may interleave.
  const buckets = new Map();
  const noSig = [];
  for (const clip of group) {
    const sig = clip.externalSignature;
    if (!sig) { noSig.push(clip); continue; }
    if (!buckets.has(sig)) buckets.set(sig, []);
    buckets.get(sig).push(clip);
  }
  const result = [];
  if (noSig.length > 0) result.push(noSig);
  for (const bucket of buckets.values()) result.push(bucket);
  return result;
}

function splitByGearState(group) {
  if (group.length === 0) return [];

  const hasGearRuns = group.some((clip) => clip.gearRuns && clip.gearRuns.length > 0);
  if (!hasGearRuns) return splitByGearStateLegacy(group);

  const result = [];
  let current = [];

  for (const clip of group) {
    if (!clip.gearRuns || clip.gearRuns.length === 0) {
      current.push(clip);
      continue;
    }

    const segments = splitClipAtParkGaps(clip);
    for (const seg of segments) {
      if (seg.parked) {
        if (current.length > 0) {
          result.push(current);
          current = [];
        }
      } else if (seg.route.points.length > 0) {
        current.push(seg.route);
      }
    }
  }
  if (current.length > 0) result.push(current);
  // All-Park groups are stationary recordings, not drives.
  if (result.length === 0) return [];
  return result;
}

function splitClipAtParkGaps(clip) {
  let totalRawFrames = 0;
  for (const run of clip.gearRuns) totalRawFrames += run.frames;
  if (totalRawFrames === 0) return [{ route: clip, parked: false }];

  const clipSpanMs = clipSpanOf(clip);
  const nPoints = clip.points.length;
  // The park-gap test deliberately keeps the NOMINAL minute rather than the
  // clip's real span. A Park run touching a clip edge does not end there — it
  // continues into the neighbouring clip — so measuring only the frames on
  // this side understates it. Stretching to a minute compensates for that,
  // and it is load-bearing: switching this to the real span drops a trailing
  // 1.3 s park run below the threshold, which re-fuses a completed Summon onto
  // the drive that follows it (measured: 2 of 10 maneuvers lost across 17 days
  // of real clips). Timing below uses the real span; only the threshold test
  // uses the nominal one.
  const secondsPerFrame = 60.0 / totalRawFrames;

  const rawSegs = [];
  let frame = 0;
  for (const run of clip.gearRuns) {
    const duration = run.frames * secondsPerFrame;
    const isParkGap = run.gear === GEAR_PARK && duration >= PARK_GAP_SECONDS;
    rawSegs.push({ startFrame: frame, endFrame: frame + run.frames, parked: isParkGap });
    frame += run.frames;
  }

  const merged = [];
  for (const seg of rawSegs) {
    if (merged.length > 0 && !merged[merged.length - 1].parked && !seg.parked) {
      merged[merged.length - 1].endFrame = seg.endFrame;
    } else {
      merged.push({ ...seg });
    }
  }

  if (!merged.some((s) => s.parked)) return [{ route: clip, parked: false }];

  const result = [];
  for (const seg of merged) {
    if (seg.parked) {
      result.push({ route: null, parked: true });
      continue;
    }

    const startFrac = seg.startFrame / totalRawFrames;
    const endFrac = seg.endFrame / totalRawFrames;
    let startIdx = Math.round(startFrac * nPoints);
    let endIdx = Math.round(endFrac * nPoints);
    if (startIdx >= nPoints) startIdx = nPoints - 1;
    if (endIdx > nPoints) endIdx = nPoints;
    if (startIdx < 0) startIdx = 0;
    // A non-empty frame span always keeps at least one point. Both fractions
    // round to the same index when a segment is short in frames and GPS dedup
    // left few points, which used to delete the segment outright — along with
    // the flagRuns/gearRuns evidence Summon detection reads from it. Only the
    // trailing segment escaped, rescued by the startIdx clamp above; leading
    // and middle segments vanished, so whether a maneuver was detected
    // depended on how much the car had moved. Frame bounds below carry the
    // real duration, so a one-point segment still measures its true length.
    if (endIdx <= startIdx) endIdx = startIdx + 1;
    if (endIdx > nPoints) continue; // no points at all — nothing to slice

    const segPoints = clip.points.slice(startIdx, endIdx);
    const segGears = clip.gearStates ? clip.gearStates.slice(startIdx, endIdx) : [];
    const segAP = clip.autopilotStates ? clip.autopilotStates.slice(startIdx, endIdx) : [];
    const segSpeeds = clip.speeds ? clip.speeds.slice(startIdx, endIdx) : [];
    const segAccel = clip.accelPositions ? clip.accelPositions.slice(startIdx, endIdx) : [];

    // Deliberately the NOMINAL minute, not the clip's real span. This offset
    // lands in the segment's timestamp, which becomes the drive's startTime —
    // and startTime is the key user drive tags are stored under, with no
    // fallback and no migration. Using the real span here moves 17 of 76
    // drives on the measured library, silently orphaning every tag on them at
    // the next index rebuild. An imprecise label is worth less than the user's
    // own data, so the segment keeps its historical position; the point
    // timestamps and end time below still use the real span.
    const offsetMs = startFrac * CLIP_DURATION_MS;
    result.push({
      route: {
        ...clip,
        points: segPoints,
        gearStates: segGears,
        autopilotStates: segAP,
        speeds: segSpeeds,
        accelPositions: segAccel,
        timestamp: new Date(clip.timestamp.getTime() + offsetMs),
        // Preserve raw-frame bounds for duration and Summon evidence.
        subClipFrames: { startFrame: seg.startFrame, endFrame: seg.endFrame, totalFrames: totalRawFrames },
      },
      parked: false,
    });
  }

  return result;
}

function splitByGearStateLegacy(group) {
  if (group.length <= 1) return [group];
  if (!group.some((clip) => clip.gearStates && clip.gearStates.length > 0)) return [group];

  const result = [];
  let current = [];

  for (const clip of group) {
    if (clipIsMostlyParkedLegacy(clip)) {
      if (current.length > 0) {
        result.push(current);
        current = [];
      }
    } else {
      current.push(clip);
    }
  }
  if (current.length > 0) result.push(current);
  // Drop multi-clip groups when every legacy clip is mostly parked.
  if (result.length === 0) return [];
  return result;
}

function clipIsMostlyParkedLegacy(clip) {
  if (clip.rawFrameCount > 0) {
    return clip.rawParkCount / clip.rawFrameCount > 0.5;
  }
  if (!clip.gearStates || clip.gearStates.length === 0) return false;
  let parkCount = 0;
  for (const g of clip.gearStates) {
    if (g === GEAR_PARK) parkCount++;
  }
  return parkCount > clip.gearStates.length / 2;
}

function buildDriveStats(clips, idx) {
  const firstClip = clips[0];
  const lastClip = clips[clips.length - 1];
  const startTime = firstClip.timestamp;
  // A park-split drive ends at the segment boundary; an unsplit clip runs to
  // the end of its own span, which is a minute only when the recording ran
  // that long.
  let lastSegmentLenMs = clipSpanOf(lastClip);
  const lf = lastClip.subClipFrames;
  if (lf && lf.totalFrames > 0) {
    lastSegmentLenMs = Math.round(((lf.endFrame - lf.startFrame) * clipSpanOf(lastClip)) / lf.totalFrames);
  }
  const endTime = new Date(lastClip.timestamp.getTime() + lastSegmentLenMs);

  const allPoints = [];
  for (const clip of clips) {
    const clipStart = clip.timestamp.getTime();
    const n = clip.points.length;
    // Spread this clip's points across the span they actually cover. A
    // park-split segment covers its own fraction of the clip, not the whole
    // clip — stamping its points across a full minute pushes them past the
    // drive's own end and makes the next clip's first point step backwards,
    // which inflates every duration-weighted statistic built from them.
    const sf = clip.subClipFrames;
    const clipDurationMs = sf && sf.totalFrames > 0
      ? ((sf.endFrame - sf.startFrame) * clipSpanOf(clip)) / sf.totalFrames
      : clipSpanOf(clip);
    const hasAP = clip.autopilotStates && clip.autopilotStates.length === n;
    const hasGears = clip.gearStates && clip.gearStates.length === n;
    const hasSpeeds = clip.speeds && clip.speeds.length === n;
    const hasAccel = clip.accelPositions && clip.accelPositions.length === n;

    for (let i = 0; i < n; i++) {
      let t;
      if (n > 1) {
        t = clipStart + (clipDurationMs * i) / (n - 1);
      } else {
        t = clipStart;
      }
      allPoints.push({
        lat: clip.points[i][0],
        lng: clip.points[i][1],
        timeMs: t,
        apState: hasAP ? clip.autopilotStates[i] : 0,
        gear: hasGears ? clip.gearStates[i] : 0,
        seiSpeed: hasSpeeds ? clip.speeds[i] : 0,
        accelPos: hasAccel ? clip.accelPositions[i] : 0,
      });
    }
  }

  // Remove null-island points, then apply group-level outlier filtering —
  // matches Sentry-USB-Rusty's collect→filter→compute approach.
  let w = 0;
  for (let i = 0; i < allPoints.length; i++) {
    if (Math.abs(allPoints[i].lat) >= NULL_ISLAND_DEG || Math.abs(allPoints[i].lng) >= NULL_ISLAND_DEG) allPoints[w++] = allPoints[i];
  }
  allPoints.length = w;
  filterGPSOutliers(allPoints);

  let totalDistanceM = 0;
  let maxSpeedMps = 0;
  const speedSamples = [];

  // SEI speed is signed in Reverse; Drive display stats use its magnitude.
  const hasSEISpeeds = allPoints.some((p) => p.seiSpeed !== 0);

  for (let i = 1; i < allPoints.length; i++) {
    const p0 = allPoints[i - 1];
    const p1 = allPoints[i];
    const d = geodesicM(p0.lat, p0.lng, p1.lat, p1.lng);
    const dt = (p1.timeMs - p0.timeMs) / 1000.0;
    totalDistanceM += d;

    if (hasSEISpeeds) {
      const speed = Math.abs(p1.seiSpeed);
      if (speed < SEI_SPEED_MAX_MPS) {
        speedSamples.push(speed);
        if (speed > maxSpeedMps) maxSpeedMps = speed;
      }
    } else {
      if (dt > 0) {
        const speed = d / dt;
        if (speed < DERIVED_SPEED_MAX_MPS) {
          speedSamples.push(speed);
          if (speed > maxSpeedMps) maxSpeedMps = speed;
        }
      }
    }
  }

  let avgSpeedMps = 0;
  if (speedSamples.length > 0) {
    avgSpeedMps = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
  }

  const pointData = [];
  const fsdStates = [];
  const gearStates = [];
  let hasAssistedData = false;
  let hasGearData = false;

  for (let i = 0; i < allPoints.length; i++) {
    const p = allPoints[i];
    let speed;
    if (hasSEISpeeds) {
      speed = p.seiSpeed;
    } else if (i > 0) {
      const d = geodesicM(allPoints[i - 1].lat, allPoints[i - 1].lng, p.lat, p.lng);
      const dt = (p.timeMs - allPoints[i - 1].timeMs) / 1000.0;
      speed = dt > 0 ? Math.min(d / dt, DERIVED_SPEED_MAX_MPS) : 0;
    } else {
      speed = 0;
    }
    pointData.push([p.lat, p.lng, p.timeMs, Math.round(speed * 100) / 100]);
    fsdStates.push(p.apState);
    gearStates.push(p.gear);
    if (p.apState !== AUTOPILOT_OFF) hasAssistedData = true;
    if (p.gear !== GEAR_PARK) hasGearData = true;
  }

  // Only FSD tracks disengagement and pedal events; other assisted modes track
  // time and distance.
  let fsdEngagedMs = 0, fsdDisengagements = 0, fsdAccelPushes = 0, fsdDistanceM = 0;
  let autosteerEngagedMs = 0, autosteerDistanceM = 0;
  let taccEngagedMs = 0, taccDistanceM = 0;
  let assistedDistanceM = 0;
  const fsdEvents = [];

  if (hasAssistedData && allPoints.length > 1) {
    let inAccelPress = false;
    let accelPressLat = 0, accelPressLng = 0;
    let fsdEngageTimeMs = 0;
    let pendingDisengage = false;
    let pendingDisengageTimeMs = 0;
    let pendingDisengageLat = 0, pendingDisengageLng = 0;

    for (let i = 1; i < allPoints.length; i++) {
      const prev = allPoints[i - 1];
      const cur = allPoints[i];
      const dt = cur.timeMs - prev.timeMs;
      const d = geodesicM(prev.lat, prev.lng, cur.lat, cur.lng);

      const prevFSD = prev.apState === AUTOPILOT_FSD;
      const curFSD  = cur.apState  === AUTOPILOT_FSD;
      const curEngaged = cur.apState !== AUTOPILOT_OFF;

      // Resolve pending FSD disengagement (2-second Park grace window)
      if (pendingDisengage) {
        const timeSince = cur.timeMs - pendingDisengageTimeMs;
        if (cur.gear === GEAR_PARK && timeSince <= 2000.0) {
          // FSD parked the car — not a driver disengagement
          pendingDisengage = false;
        } else if (timeSince > 2000.0 || curFSD) {
          fsdDisengagements++;
          fsdEvents.push({ lat: pendingDisengageLat, lng: pendingDisengageLng, type: "disengagement" });
          pendingDisengage = false;
        }
      }

      if (!prevFSD && curFSD) {
        inAccelPress = false;
        fsdEngageTimeMs = cur.timeMs;
      }

      if (curEngaged) {
        assistedDistanceM += d;
        switch (cur.apState) {
          case AUTOPILOT_FSD:
            fsdEngagedMs += dt;
            fsdDistanceM += d;
            break;
          case AUTOPILOT_AUTOSTEER:
            autosteerEngagedMs += dt;
            autosteerDistanceM += d;
            break;
          case AUTOPILOT_TACC:
            taccEngagedMs += dt;
            taccDistanceM += d;
            break;
        }
      }

      if (prevFSD && !curFSD) {
        pendingDisengage = true;
        pendingDisengageTimeMs = cur.timeMs;
        pendingDisengageLat = cur.lat;
        pendingDisengageLng = cur.lng;
        inAccelPress = false;
      }

      let accelPct = cur.accelPos;
      if (accelPct <= 1.0) accelPct *= 100.0;

      // Ignore the first three seconds after FSD engagement.
      if (curFSD && !inAccelPress && accelPct > 1.0 && cur.timeMs - fsdEngageTimeMs >= 3000.0) {
        inAccelPress = true;
        accelPressLat = cur.lat;
        accelPressLng = cur.lng;
      }

      if (inAccelPress && accelPct <= 0.0) {
        fsdAccelPushes++;
        fsdEvents.push({ lat: accelPressLat, lng: accelPressLng, type: "accel_push" });
        inAccelPress = false;
      }
    }

    if (pendingDisengage && allPoints.length > 0) {
      if (allPoints[allPoints.length - 1].gear !== GEAR_PARK) {
        fsdDisengagements++;
        fsdEvents.push({ lat: pendingDisengageLat, lng: pendingDisengageLng, type: "disengagement" });
      }
    }
  }

  const durationMs = endTime.getTime() - startTime.getTime();
  const r2 = round2;
  const pct = (part) => totalDistanceM > 0 ? Math.round((part / totalDistanceM) * 1000) / 10 : 0;

  // Summon uses raw-frame flag/autopilot/gear/speed evidence so GPS dedup and
  // point slicing cannot shift its bounds. Missing flagRuns are unverifiable;
  // apRuns and gearRuns are optional (only the Self Driving signature needs
  // them); GPS-derived speeds are excluded at parking-lot scale.
  const summonEvidence = clips.map((clip) => {
    const runs = clip.flagRuns;
    let totalFrames = clip.subClipFrames?.totalFrames ?? clip.rawFrameCount ?? 0;
    if (!(totalFrames > 0) && Array.isArray(runs)) {
      totalFrames = runs.reduce((sum, r) => sum + (r.frames ?? 0), 0);
    }
    return {
      flagRuns: runs,
      apRuns: clip.apRuns,
      gearRuns: clip.gearRuns,
      startFrame: clip.subClipFrames?.startFrame ?? 0,
      endFrame: clip.subClipFrames?.endFrame ?? totalFrames,
      totalFrames,
    };
  });
  const summon = detectSummon(summonEvidence, {
    maxSpeedMps: hasSEISpeeds ? maxSpeedMps : 0,
    durationMs,
    hasSeiSpeeds: hasSEISpeeds,
  });

  // A Summon drive is driverless, so assistance analytics do not apply to it.
  // Firmware that reports Summon as Self Driving would otherwise book the
  // maneuver as FSD engagement and mark a phantom disengagement where the car
  // parked itself. Zeroing here keeps every consumer honest without checking
  // the summon flag; per-point fsdStates stay as raw evidence.
  if (summon) {
    fsdEngagedMs = 0;
    fsdDisengagements = 0;
    fsdAccelPushes = 0;
    fsdDistanceM = 0;
    autosteerEngagedMs = 0;
    autosteerDistanceM = 0;
    taccEngagedMs = 0;
    taccDistanceM = 0;
    assistedDistanceM = 0;
    fsdEvents.length = 0;
  }

  // Median stationary endpoint clusters improve geocode labels only; they do
  // not affect distance or speed statistics.
  const geocodeStartPoint = snapGeocodeEndpoint(allPoints, false);
  const geocodeEndPoint = snapGeocodeEndpoint(allPoints, true);

  // Release the heavy intermediate before constructing the result.
  const pointCount = allPoints.length;
  allPoints.length = 0;

  // BLE telemetry uses the first start and last end values across unique parent
  // clips. Labels remain verbatim; older and imported data may omit them.
  const telemetry = rollUpDriveTelemetry(clips);

  return {
    id: idx,
    date: firstClip.date,
    startTime: formatISO(startTime),
    endTime: formatISO(endTime),
    durationMs,
    distanceMi: r2(totalDistanceM / M_PER_MILE),
    distanceKm: r2(totalDistanceM / M_PER_KM),
    avgSpeedMph: r2(avgSpeedMps * MPS_TO_MPH),
    maxSpeedMph: r2(maxSpeedMps * MPS_TO_MPH),
    avgSpeedKmh: r2(avgSpeedMps * MPS_TO_KMH),
    maxSpeedKmh: r2(maxSpeedMps * MPS_TO_KMH),
    clipCount: clips.length,
    pointCount,
    points: pointData,
    gearStates: hasGearData ? gearStates : undefined,
    fsdStates: hasAssistedData ? fsdStates : undefined,
    fsdEvents: fsdEvents.length > 0 ? fsdEvents : undefined,
    // FSD
    fsdEngagedMs: Math.round(fsdEngagedMs),
    fsdDisengagements,
    fsdAccelPushes,
    fsdPercent: pct(fsdDistanceM),
    fsdDistanceKm: r2(fsdDistanceM / M_PER_KM),
    fsdDistanceMi: r2(fsdDistanceM / M_PER_MILE),
    // Autosteer
    autosteerEngagedMs: Math.round(autosteerEngagedMs),
    autosteerPercent: pct(autosteerDistanceM),
    autosteerDistanceKm: r2(autosteerDistanceM / M_PER_KM),
    autosteerDistanceMi: r2(autosteerDistanceM / M_PER_MILE),
    // TACC
    taccEngagedMs: Math.round(taccEngagedMs),
    taccPercent: pct(taccDistanceM),
    taccDistanceKm: r2(taccDistanceM / M_PER_KM),
    taccDistanceMi: r2(taccDistanceM / M_PER_MILE),
    // Any assisted mode
    assistedPercent: pct(assistedDistanceM),
    routeFiles: clips.map((c) => c.file),
    // Missing provenance defaults to native SEI.
    source: firstClip.source ?? "sei",
    ...(summon ? { summon: true } : {}),
    ...(firstClip.externalSignature ? { externalSignature: firstClip.externalSignature } : {}),
    ...(firstClip.tessieAutopilotPercent != null ? { tessieAutopilotPercent: firstClip.tessieAutopilotPercent } : {}),
    ...telemetry,
    ...(geocodeStartPoint ? { geocodeStartPoint } : {}),
    ...(geocodeEndPoint ? { geocodeEndPoint } : {}),
  };
}

/**
 * Use the median stationary endpoint cluster for geocoding, or the terminal
 * point when fewer than three nearby samples exist. Displacement works with
 * or without SEI speed data.
 */
function snapGeocodeEndpoint(pts, fromEnd) {
  const n = pts.length;
  if (n === 0) return null;
  const anchor = fromEnd ? pts[n - 1] : pts[0];
  const MAX_CLUSTER = 30; // ~30 s at the 1 Hz dashcam sample rate
  const RADIUS_M = 15;    // within GPS noise of the anchor = "still parked"
  const lats = [];
  const lngs = [];
  for (let k = 0; k < Math.min(MAX_CLUSTER, n); k++) {
    const p = fromEnd ? pts[n - 1 - k] : pts[k];
    if (geodesicM(anchor.lat, anchor.lng, p.lat, p.lng) > RADIUS_M) break;
    lats.push(p.lat);
    lngs.push(p.lng);
  }
  if (lats.length < 3) return [anchor.lat, anchor.lng];
  lats.sort((a, b) => a - b);
  lngs.sort((a, b) => a - b);
  const med = (arr) => (arr.length % 2
    ? arr[(arr.length - 1) / 2]
    : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2);
  return [med(lats), med(lngs)];
}

/**
 * Remove GPS outlier points that are impossibly far from both neighbors,
 * and strip leading/trailing bogus GPS readings (pre-lock junk).
 * Mutates the array in place.
 */
function filterGPSOutliers(points) {
  if (points.length <= 2) return;

  // Estimate the drive's center from the middle half of its samples.
  const q1 = Math.floor(points.length * 0.25);
  const q3 = Math.floor(points.length * 0.75);
  let medLat = 0, medLng = 0, count = 0;
  for (let i = q1; i <= q3; i++) {
    medLat += points[i].lat;
    medLng += points[i].lng;
    count++;
  }
  medLat /= count;
  medLng /= count;

  // Remove points farther than MAX_FROM_MEDIAN_M from the central cluster.
  let mw = 0;
  for (let i = 0; i < points.length; i++) {
    if (geodesicM(points[i].lat, points[i].lng, medLat, medLng) <= MAX_FROM_MEDIAN_M) points[mw++] = points[i];
  }
  points.length = mw;

  // Mark from the end so `prev` is the original lower neighbor and `next` is
  // the surviving higher neighbor, then compact in O(n).
  const removed = new Uint8Array(points.length);
  let nextSurvivor = null;
  for (let i = points.length - 1; i >= 0; i--) {
    const prev = i > 0 ? points[i - 1] : null;
    const next = nextSurvivor;

    const farFromPrev = prev
      ? geodesicM(prev.lat, prev.lng, points[i].lat, points[i].lng) > MAX_JUMP_M
      : false;
    const farFromNext = next
      ? geodesicM(points[i].lat, points[i].lng, next.lat, next.lng) > MAX_JUMP_M
      : false;

    if ((prev && next && farFromPrev && farFromNext) ||
        (!prev && farFromNext) ||
        (!next && farFromPrev)) {
      removed[i] = 1;
    } else {
      nextSurvivor = points[i];
    }
  }
  let kw = 0;
  for (let i = 0; i < points.length; i++) {
    if (!removed[i]) points[kw++] = points[i];
  }
  points.length = kw;
}

function formatISO(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
