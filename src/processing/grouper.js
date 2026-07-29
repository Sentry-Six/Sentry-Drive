// grouper.js - Drive grouping, FSD analytics, metrics calculation
// Faithful port of Sentry-USB server/drives/grouper.go

import { GEAR_PARK, AUTOPILOT_OFF, AUTOPILOT_FSD, AUTOPILOT_AUTOSTEER, AUTOPILOT_TACC } from "./extract.js";
import {
  geodesicM,
  round2,
  DRIVE_GAP_MS,
  PARK_GAP_SECONDS,
  CLIP_DURATION_MS,
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

const {
  isEventFolderPath,
  parseClipTimestampMs,
  telemetryHasDriving,
  selectGapFill,
} = eventGapFill;
const { normalizeClipPath } = clipPath;

export { isEventFolderPath };

// Sentry-USB is Go; its `[]uint8` fields (gearStates, autopilotStates) are
// serialized by encoding/json as base64 strings. We normalize on read so the
// rest of the pipeline always sees a Uint8Array, and encode on write so files
// produced by Sentry-Drive match Sentry-USB's on-disk format.
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

/**
 * Parse a Tesla dashcam filename into a Date object.
 */
function parseFileTimestamp(filePath) {
  const timestampMs = parseClipTimestampMs(filePath);
  return timestampMs == null ? null : new Date(timestampMs);
}

// geodesicM (WGS-84 ellipsoidal distance), round2, and every drive-calc
// constant come from ../shared/drive-calc.cjs (imported above) — the single
// source of truth. Grouping thresholds still mirror Sentry-USB-Rusty; the
// distance formula intentionally leads Rust until the migration in
// docs/RUST-GEODESIC-MIGRATION.md lands there.

/**
 * Group routes into logical drives based on time gaps and gear state.
 */
export function groupIntoDrives(routes) {
  // Deduplicate routes by normalized file path, decoding Go-serialized base64
  // byte fields so downstream code always sees Uint8Array.
  const seen = new Set();
  const unique = [];
  const eventCandidates = [];
  for (const r of routes) {
    // Event paths stay partitioned until the gap-fill selector can distinguish
    // moved driving footage from duplicates and parked Sentry recordings.
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

  // Parse timestamps and sort. The entries in `unique` are already our own
  // clones (built in the dedup loop above, never the caller's objects), so
  // attach the timestamp in place instead of spread-cloning every route a
  // second time — on a large library that second copy was pure peak waste.
  const timed = [];
  for (const r of unique) {
    const t = parseFileTimestamp(r.file);
    if (t) {
      r.timestamp = t;
      timed.push(r);
    }
  }

  if (timed.length === 0) {
    return { drives: [], timeGroupCount: 0, routeCount: 0, droppedCount: routes.length };
  }

  timed.sort((a, b) => a.timestamp - b.timestamp);

  // Tesla moves RecentClips into SavedClips when Save is pressed mid-drive.
  // Admit only event routes selected by the canonical Rust gap-fill rules:
  // positive driving telemetry, no occupied-slot/twin duplicate, and either
  // inside a bounded RecentClips hole or in an anchored leading/trailing chain.
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

  // First pass: group by time gap
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

  // Second pass: split each time group further by gear state,
  // then by externalSignature so imported drives (Tessie) stay
  // one-per-drive regardless of time/gear spacing.
  const groups = [];
  for (const tg of timeGroups) {
    for (const gearGroup of splitByGearState(tg)) {
      groups.push(...splitByExternalSignature(gearGroup));
    }
  }

  // Build drive stats
  const drives = groups.map((group, idx) => buildDriveStats(group, idx));
  return {
    drives,
    timeGroupCount: timeGroups.length,
    routeCount: timed.length,
    droppedCount: routes.length - timed.length,
  };
}

/**
 * Split a group by externalSignature. Clips without a signature (native SEI)
 * stay as one group. Consecutive clips with different signatures become
 * separate groups. This is how we keep Tessie-imported drives from being
 * merged with each other — grouper's time-gap / park-gap heuristics can't
 * reliably tell two back-to-back Tessie drives apart, but the signature
 * (baked into the clip at import time) is unambiguous.
 */
function splitByExternalSignature(group) {
  if (group.length <= 1) return [group];
  const hasAnySignature = group.some((c) => c.externalSignature);
  if (!hasAnySignature) return [group];

  // Bucket by signature regardless of in-group order — adjacent Tessie drives
  // can have tied clip timestamps that interleave when sorted, so a
  // consecutive-run splitter would fragment one drive into multiple pieces.
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
  // Every segment was parked → no driving happened, so emit no drive.
  // Mirrors Rust split_summary_by_gear_state (grouper.rs:1893, "return
  // nothing so drives_count stays 0"). An isolated all-Park clip is a
  // stationary recording, not a trip.
  if (result.length === 0) return [];
  return result;
}

function splitClipAtParkGaps(clip) {
  let totalRawFrames = 0;
  for (const run of clip.gearRuns) totalRawFrames += run.frames;
  if (totalRawFrames === 0) return [{ route: clip, parked: false }];

  const secondsPerFrame = 60.0 / totalRawFrames;
  const nPoints = clip.points.length;

  // Identify raw segments
  const rawSegs = [];
  let frame = 0;
  for (const run of clip.gearRuns) {
    const duration = run.frames * secondsPerFrame;
    const isParkGap = run.gear === GEAR_PARK && duration >= PARK_GAP_SECONDS;
    rawSegs.push({ startFrame: frame, endFrame: frame + run.frames, parked: isParkGap });
    frame += run.frames;
  }

  // Merge consecutive non-parked segments
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
    if (endIdx <= startIdx) continue;

    const segPoints = clip.points.slice(startIdx, endIdx);
    const segGears = clip.gearStates ? clip.gearStates.slice(startIdx, endIdx) : [];
    const segAP = clip.autopilotStates ? clip.autopilotStates.slice(startIdx, endIdx) : [];
    const segSpeeds = clip.speeds ? clip.speeds.slice(startIdx, endIdx) : [];
    const segAccel = clip.accelPositions ? clip.accelPositions.slice(startIdx, endIdx) : [];

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
        // Frame span of this sub-segment within its parent clip — lets
        // buildDriveStats end the drive where driving actually stopped
        // (mirrors Rust SubClipSummary start_frame/end_frame/total_frames).
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
  // All clips were mostly-parked → drop, matching Rust
  // split_summary_by_gear_state_legacy (a single clip is still kept by the
  // group.length <= 1 guard above; only the multi-clip all-park case drops).
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
  // End time mirrors Rust build_summary_from_aggregates (grouper.rs:1992):
  // when the drive's last clip is a park-split sub-segment, the drive ends
  // where that segment's frames end — not a full minute after the clip
  // started. Unsplit clips keep the +60 s convention (full frame span).
  let lastSegmentLenMs = CLIP_DURATION_MS;
  const lf = lastClip.subClipFrames;
  if (lf && lf.totalFrames > 0) {
    lastSegmentLenMs = Math.round(((lf.endFrame - lf.startFrame) * CLIP_DURATION_MS) / lf.totalFrames);
  }
  const endTime = new Date(lastClip.timestamp.getTime() + lastSegmentLenMs);

  // Merge all points with interpolated timestamps
  const allPoints = [];
  for (const clip of clips) {
    const clipStart = clip.timestamp.getTime();
    const n = clip.points.length;
    const clipDurationMs = CLIP_DURATION_MS;
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

  // Compute distance and speeds
  let totalDistanceM = 0;
  let maxSpeedMps = 0;
  const speedSamples = [];

  const hasSEISpeeds = allPoints.some((p) => p.seiSpeed > 0);

  for (let i = 1; i < allPoints.length; i++) {
    const p0 = allPoints[i - 1];
    const p1 = allPoints[i];
    const d = geodesicM(p0.lat, p0.lng, p1.lat, p1.lng);
    const dt = (p1.timeMs - p0.timeMs) / 1000.0;
    totalDistanceM += d;

    if (hasSEISpeeds) {
      const speed = p1.seiSpeed;
      if (speed >= 0 && speed < SEI_SPEED_MAX_MPS) {
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

  // Build point data array: [lat, lng, timeMs, speedMps]
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

  // Compute per-mode analytics.
  // Disengagements and accel pushes are FSD (state=1) only — same as Sentry-USB.
  // Autosteer (state=2) and TACC (state=3) get time/distance tracking only.
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

      // Track FSD engagement start (state=1 only)
      if (!prevFSD && curFSD) {
        inAccelPress = false;
        fsdEngageTimeMs = cur.timeMs;
      }

      // Accumulate time and distance per mode
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

      // Detect FSD disengagement (state=1 only)
      if (prevFSD && !curFSD) {
        pendingDisengage = true;
        pendingDisengageTimeMs = cur.timeMs;
        pendingDisengageLat = cur.lat;
        pendingDisengageLng = cur.lng;
        inAccelPress = false;
      }

      // Normalize pedal position to 0-100%
      let accelPct = cur.accelPos;
      if (accelPct <= 1.0) accelPct *= 100.0;

      // Detect human accel press while FSD active (state=1 only).
      // Skip 3-second grace window after FSD engagement.
      if (curFSD && !inAccelPress && accelPct > 1.0 && cur.timeMs - fsdEngageTimeMs >= 3000.0) {
        inAccelPress = true;
        accelPressLat = cur.lat;
        accelPressLng = cur.lng;
      }

      // Press complete when pedal returns to 0%
      if (inAccelPress && accelPct <= 0.0) {
        fsdAccelPushes++;
        fsdEvents.push({ lat: accelPressLat, lng: accelPressLng, type: "accel_push" });
        inAccelPress = false;
      }
    }

    // Flush any pending disengagement at drive end
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

  // Geocoding-quality endpoints — Drive-leading enhancement (no Rust
  // counterpart; used ONLY for reverse-geocode labels, never for the locked
  // distance/speed stats). A single raw GPS fix carries 3–8 m of noise and
  // the first fix of a drive is usually the worst one. Where the car sat
  // still at either end, the component-wise median of that parked cluster
  // estimates the true spot ~√N better and rejects single-fix outliers.
  const geocodeStartPoint = snapGeocodeEndpoint(allPoints, false);
  const geocodeEndPoint = snapGeocodeEndpoint(allPoints, true);

  // allPoints (seven-field object per GPS sample) is fully consumed at this
  // point — release it before building the return object so the heavy
  // intermediate and the final arrays don't coexist any longer than needed.
  const pointCount = allPoints.length;
  allPoints.length = 0;

  // v10 BLE location names — mirrors Rust roll_up_telemetry (grouper.rs:2785):
  // first non-null locationNameStart / last non-null locationNameEnd across the
  // drive's clips (time-ordered), deduped by parent file so a clip split into
  // sub-segments isn't read twice. Stored verbatim — Tesla's reverse-geocoder
  // picked the label (street address, business name, etc.); no post-processing.
  // Absent on pre-BLE data, non-telemetry Pis, and imported drives.
  // Battery % (BLE, same provenance) follows the identical convention:
  // first non-null batteryPctStart / last non-null batteryPctEnd.
  let locationNameStart = null;
  let locationNameEnd = null;
  let batteryPctStart = null;
  let batteryPctEnd = null;
  const seenTelemetryFiles = new Set();
  for (const clip of clips) {
    if (seenTelemetryFiles.has(clip.file)) continue;
    seenTelemetryFiles.add(clip.file);
    if (locationNameStart == null && clip.locationNameStart != null) {
      locationNameStart = clip.locationNameStart;
    }
    if (clip.locationNameEnd != null) locationNameEnd = clip.locationNameEnd;
    if (batteryPctStart == null && clip.batteryPctStart != null) {
      batteryPctStart = clip.batteryPctStart;
    }
    if (clip.batteryPctEnd != null) batteryPctEnd = clip.batteryPctEnd;
  }

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
    // FSD (state=1) — disengagements and accel pushes tracked here only
    fsdEngagedMs: Math.round(fsdEngagedMs),
    fsdDisengagements,
    fsdAccelPushes,
    fsdPercent: pct(fsdDistanceM),
    fsdDistanceKm: r2(fsdDistanceM / M_PER_KM),
    fsdDistanceMi: r2(fsdDistanceM / M_PER_MILE),
    // Autosteer (state=2)
    autosteerEngagedMs: Math.round(autosteerEngagedMs),
    autosteerPercent: pct(autosteerDistanceM),
    autosteerDistanceKm: r2(autosteerDistanceM / M_PER_KM),
    autosteerDistanceMi: r2(autosteerDistanceM / M_PER_MILE),
    // TACC (state=3)
    taccEngagedMs: Math.round(taccEngagedMs),
    taccPercent: pct(taccDistanceM),
    taccDistanceKm: r2(taccDistanceM / M_PER_KM),
    taccDistanceMi: r2(taccDistanceM / M_PER_MILE),
    // Assisted aggregate (any state > 0 — for map/UI use)
    assistedPercent: pct(assistedDistanceM),
    routeFiles: clips.map((c) => c.file),
    // Provenance: "sei" (native dashcam extraction) or "tessie" (imported).
    // Defaults to "sei" on old files that predate the source field.
    source: firstClip.source ?? "sei",
    ...(firstClip.externalSignature ? { externalSignature: firstClip.externalSignature } : {}),
    ...(firstClip.tessieAutopilotPercent != null ? { tessieAutopilotPercent: firstClip.tessieAutopilotPercent } : {}),
    ...(locationNameStart != null ? { locationNameStart } : {}),
    ...(locationNameEnd != null ? { locationNameEnd } : {}),
    ...(batteryPctStart != null ? { batteryPctStart } : {}),
    ...(batteryPctEnd != null ? { batteryPctEnd } : {}),
    ...(geocodeStartPoint ? { geocodeStartPoint } : {}),
    ...(geocodeEndPoint ? { geocodeEndPoint } : {}),
  };
}

/**
 * Geocoding endpoint for one end of a drive: the component-wise median of the
 * stationary cluster at that end (points within RADIUS_M of the terminal fix,
 * walking inward, capped at ~30 s of samples). Falls back to the terminal fix
 * itself when the car was already rolling (cluster < 3 points) — averaging
 * moving points would drag the location along the path. Displacement-based on
 * purpose: works identically with or without SEI speed data.
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

  // Step 1: Find the median location to identify where the drive actually is.
  // Use the middle 50% of points to avoid being skewed by leading/trailing junk.
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

  // Step 2: Remove any point that is >1,000 km from the median cluster
  // (MAX_FROM_MEDIAN_M, imported from the shared single-source calc module).
  let mw = 0;
  for (let i = 0; i < points.length; i++) {
    if (geodesicM(points[i].lat, points[i].lng, medLat, medLng) <= MAX_FROM_MEDIAN_M) points[mw++] = points[i];
  }
  points.length = mw;

  // Step 3: Remove isolated outliers far from both neighbors.
  // MAX_JUMP_M (5 km — impossible between consecutive ~1s samples) is imported
  // from the shared single-source calc module.
  //
  // Semantics preserved from the old reverse splice loop: "prev" is the
  // original lower neighbor (lower indices were untouched when index i was
  // examined), "next" is the next SURVIVING higher neighbor (higher-index
  // removals had already happened). One mark pass + one compact pass instead
  // of splice-per-removal, which was O(n²) on dirty GPS.
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
