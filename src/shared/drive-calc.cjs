'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Shared calculation contract for ESM processing, CommonJS helpers, and the
// sandboxed renderer. Keep parity-bound values aligned with
// Sentry-USB-Rusty's `crates/drives/src/calc.rs` and update the lock tests in
// both projects whenever the contract changes.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Geodesy ─────────────────────────────────────────────────────────────────
// Mean Earth radius retained for the legacy haversine reference.
const R_EARTH_M = 6371000.0;

// WGS-84 ellipsoid — used by geodesicM, the canonical distance function.
const WGS84_A = 6378137.0;           // semi-major axis (m), exact by definition
const WGS84_F = 1 / 298.257223563;   // flattening, exact by definition

// ─── Unit conversions ────────────────────────────────────────────────────────
const M_PER_MILE = 1609.344;            // metres per statute mile
const M_PER_KM = 1000.0;
const MI_TO_KM = M_PER_MILE / M_PER_KM; // 1.609344 — miles→km (display toggle)
const MPS_TO_MPH = 2.23694;             // metres/sec → miles/hour
const MPS_TO_KMH = 3.6;                 // metres/sec → km/hour
const MPH_TO_MPS = 0.44704;             // miles/hour → metres/sec (Tessie import)

// GPS outlier filtering
const MAX_FROM_MEDIAN_M = 1000000; // drop points >1,000 km from the median cluster
const MAX_JUMP_M = 5000;           // drop a point >5 km from BOTH neighbours
const NULL_ISLAND_DEG = 1;         // |lat|<1 && |lon|<1 ⇒ pre-GPS-lock junk

// Trip grouping
const DRIVE_GAP_MS = 5 * 60 * 1000; // >5 min between clips ⇒ separate drives
const PARK_GAP_SECONDS = 2.0;       // ≥2 s in Park ⇒ split the drive
const CLIP_DURATION_MS = 60000;     // each dashcam clip spans ~60 s

// Bounds for filling RecentClips gaps with SavedClips/SentryClips pre-rolls.
const GAP_FILL_MIN_MS = 90 * 1000;        // hole must exceed one missing minute-clip
const GAP_FILL_MAX_MS = 30 * 60 * 1000;   // beyond this a gap is a park/drive boundary
const GAP_FILL_ADJ_MS = 3 * 60 * 1000;    // max hop between chained trailing/leading clips
const GAP_FILL_DUP_MS = 30 * 1000;        // twin-of-occupied-slot / overlap-dup window
const GAP_FILL_MIN_SPEED_MPS = 0.5;       // above this, SEI speed counts as driving

// ─── Speed sanity caps ───────────────────────────────────────────────────────
const SEI_SPEED_MAX_MPS = 100;     // accept SEI speed only if 0 ≤ v < 100 m/s
const DERIVED_SPEED_MAX_MPS = 70;  // GPS-derived speed teleport guard (<70 m/s)

// ─── Gear states (extract.rs / extract.js) ───────────────────────────────────
const GEAR_PARK = 0;
const GEAR_DRIVE = 1;
const GEAR_REVERSE = 2;
const GEAR_NEUTRAL = 3;

// ─── Autopilot states (extract.rs / extract.js) ──────────────────────────────
const AUTOPILOT_OFF = 0;
const AUTOPILOT_FSD = 1;
const AUTOPILOT_AUTOSTEER = 2;
const AUTOPILOT_TACC = 3;

// `flagRuns` is RLE over raw SEI frame indices, matching gearRuns so park-split
// bounds remain exact despite GPS-point deduplication.
const FLAG_BLINKER_LEFT = 1;  // blinker_on_left (steady switch state, not lamp flash)
const FLAG_BLINKER_RIGHT = 2; // blinker_on_right
const FLAG_BRAKE = 4;         // brake_applied (pedal-only; summon's own braking never sets it)
const FLAG_ACCEL = 8;         // accelerator_pedal_position > 0 (human-only input)

// Summon evidence requires no pedal input, parking-lot speed, and one of two
// driverless signatures: hazard bookends, or Self Driving reported for the
// maneuver (see detectSummon). The cap leaves margin above Tesla's 8 mph
// Summon limit.
const SUMMON_MAX_SPEED_MPS = 4.5;
const SUMMON_BOOKEND_SECONDS = 10;      // hazards must appear this close to each end
const SUMMON_MAX_DURATION_MS = 10 * 60 * 1000;
// Share of a drive's frames that must report autopilot_state = FSD for the
// Self Driving signature. Below 1.0 because the frames before the maneuver
// engages and after it parks the car still read Off.
const SUMMON_MIN_FSD_SHARE = 0.5;

// ─── Pure helpers ────────────────────────────────────────────────────────────

// Canonical WGS-84 Andoyer–Lambert distance. Unlike spherical haversine, it
// removes direction-dependent ellipsoid bias. Its closed form also keeps the
// JavaScript and Rust implementations directly comparable.
function geodesicM(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0;
  const toRad = (d) => (d * Math.PI) / 180.0;
  const f = WGS84_F;

  // Reduced (parametric) latitudes.
  const b1 = Math.atan((1 - f) * Math.tan(toRad(lat1)));
  const b2 = Math.atan((1 - f) * Math.tan(toRad(lat2)));
  const P = (b1 + b2) / 2;
  const Q = (b2 - b1) / 2;

  // Central angle σ on the auxiliary sphere via the haversine form:
  // h = sin²(σ/2), numerically stable for the short segments GPS produces.
  const sinHalfDLon = Math.sin(toRad(lon2 - lon1) / 2);
  const sinQ = Math.sin(Q);
  const h = sinQ * sinQ + Math.cos(b1) * Math.cos(b2) * sinHalfDLon * sinHalfDLon;
  const sigma = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  if (sigma === 0) return 0;

  // Andoyer first-order flattening correction. Denominators are clamped: near
  // σ=0 the numerators vanish at least as fast (correction → 0), and near the
  // antipode (where Andoyer is invalid anyway — unreachable for car GPS after
  // the 1,000 km median filter) this keeps the result finite.
  const sinSigma = Math.sin(sigma);
  const cos2Half = Math.max(1 - h, 1e-12); // cos²(σ/2)
  const sin2Half = Math.max(h, 1e-12);     // sin²(σ/2)
  const sinP = Math.sin(P);
  const cosP = Math.cos(P);
  const cosQ = Math.cos(Q);
  const X = (sigma - sinSigma) * (sinP * sinP * cosQ * cosQ) / cos2Half;
  const Y = (sigma + sinSigma) * (cosP * cosP * sinQ * sinQ) / sin2Half;
  return WGS84_A * (sigma - (f / 2) * (X + Y));
}

// Legacy spherical comparison reference; production paths use geodesicM.
function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R_EARTH_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Shared two-decimal rounding rule.
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * RLE per-frame gear states over raw frame indices. The Summon backfill
 * re-derives this evidence for routes missing short trailing Park runs.
 */
function computeGearRuns(gears) {
  if (!gears || gears.length === 0) return [];
  const runs = [];
  let currentGear = gears[0];
  let count = 1;
  for (let i = 1; i < gears.length; i++) {
    if (gears[i] === currentGear) {
      count++;
    } else {
      runs.push({ gear: currentGear, frames: count });
      currentGear = gears[i];
      count = 1;
    }
  }
  runs.push({ gear: currentGear, frames: count });
  return runs;
}

/**
 * RLE per-frame SEI flags before GPS deduplication. Summon detection needs raw
 * hazard/pedal frame evidence even when stationary GPS points collapse.
 */
function computeFlagRuns(flags, speeds) {
  if (!flags || flags.length === 0) return [];
  const runs = [];
  const r1 = (v) => Math.round(v * 10) / 10;
  let currentFlags = flags[0];
  let count = 1;
  // Per-run speed keeps the Summon gate in frame space, avoiding point-slice
  // spillover from an adjacent drive after GPS deduplication.
  let maxAbs = speeds ? Math.abs(speeds[0] ?? 0) : 0;
  for (let i = 1; i < flags.length; i++) {
    if (flags[i] === currentFlags) {
      count++;
      if (speeds) {
        const a = Math.abs(speeds[i] ?? 0);
        if (a > maxAbs) maxAbs = a;
      }
    } else {
      runs.push(speeds
        ? { flags: currentFlags, frames: count, maxMps: r1(maxAbs) }
        : { flags: currentFlags, frames: count });
      currentFlags = flags[i];
      count = 1;
      maxAbs = speeds ? Math.abs(speeds[i] ?? 0) : 0;
    }
  }
  runs.push(speeds
    ? { flags: currentFlags, frames: count, maxMps: r1(maxAbs) }
    : { flags: currentFlags, frames: count });
  return runs;
}

/**
 * RLE per-frame autopilot states before GPS deduplication, in the same raw
 * frame space as gearRuns/flagRuns. Firmware that reports Summon as Self
 * Driving marks the maneuver here, so this is the second Summon signature;
 * routes extracted before it was recorded simply lack the field.
 */
function computeApRuns(apStates) {
  if (!apStates || apStates.length === 0) return [];
  const runs = [];
  let currentAp = apStates[0];
  let count = 1;
  for (let i = 1; i < apStates.length; i++) {
    if (apStates[i] === currentAp) {
      count++;
    } else {
      runs.push({ ap: currentAp, frames: count });
      currentAp = apStates[i];
      count = 1;
    }
  }
  runs.push({ ap: currentAp, frames: count });
  return runs;
}

/**
 * True when an RLE spans exactly `totalFrames` raw frames — the proof that it
 * is in the same index space as the segment bounds.
 *
 * Cross-tool, not merely defensive. Every RLE here must be built before GPS
 * dedup; one built after it is shorter, indexes point space, and reads the
 * wrong frame without failing. The live trap is autopilot state: both Sentry
 * Drive and Sentry USB Rusty keep a per-point `autopilotStates` array that IS
 * deduped, sitting right next to the raw per-frame one, so the wrong source
 * costs one character. See docs/RUST-SUMMON-PORT.md. Runs that fail this are
 * treated as absent — the drive falls back to the hazard signature rather
 * than being judged on misread frames.
 */
function runsSpanFrames(runs, totalFrames) {
  if (!Array.isArray(runs) || runs.length === 0 || !(totalFrames > 0)) return false;
  let sum = 0;
  for (const run of runs) {
    if (!(run.frames > 0)) return false;
    sum += run.frames;
  }
  return sum === totalFrames;
}

/**
 * Gear at a raw frame index — null when gearRuns are absent or end before it.
 */
function gearAtFrame(gearRuns, frame) {
  if (!Array.isArray(gearRuns) || !(frame >= 0)) return null;
  let end = 0;
  for (const run of gearRuns) {
    end += run.frames;
    // `?? null` so a run missing its gear reads as "unknown", not as a value
    // distinct from null — callers test against null, and Rust's Option has
    // no second empty value to reproduce the difference.
    if (frame < end) return run.gear ?? null;
  }
  return null;
}

/**
 * True when a segment's own evidence shows the car at rest in Park on the far
 * side of the given end — the frame before startFrame, or the frame after
 * endFrame, falling back to the boundary frame itself where the segment runs
 * to the edge of its clip.
 *
 * A Summon maneuver is always park-to-park. A drive is not: groupIntoDrives
 * also cuts on DRIVE_GAP_MS, so an unfilled hole in RecentClips leaves a
 * fragment of an ordinary trip that begins and ends mid-motion.
 */
function segmentBoundedByPark(c, atEnd) {
  const gearRuns = c.gearRuns;
  if (atEnd) {
    const after = gearAtFrame(gearRuns, c.endFrame);
    if (after !== null) return after === GEAR_PARK;
    return gearAtFrame(gearRuns, c.endFrame - 1) === GEAR_PARK;
  }
  if (c.startFrame > 0) return gearAtFrame(gearRuns, c.startFrame - 1) === GEAR_PARK;
  return gearAtFrame(gearRuns, 0) === GEAR_PARK;
}

/**
 * Frame counts by autopilot mode over the apRuns overlapping a segment's
 * [startFrame, endFrame) — null when the clip carries no autopilot run
 * evidence. `other` counts Autosteer/TACC, which need a driver and therefore
 * rule Summon out.
 */
function segmentApFrames(c) {
  if (!Array.isArray(c.apRuns) || c.apRuns.length === 0) return null;
  let frame = 0;
  let fsd = 0;
  let other = 0;
  let total = 0;
  for (const run of c.apRuns) {
    const start = frame;
    const end = frame + run.frames;
    frame = end;
    if (end <= c.startFrame) continue;
    if (start >= c.endFrame) break;
    const overlap = Math.min(end, c.endFrame) - Math.max(start, c.startFrame);
    total += overlap;
    if (run.ap === AUTOPILOT_FSD) fsd += overlap;
    else if (run.ap !== AUTOPILOT_OFF) other += overlap;
  }
  if (total === 0) return null;
  return { fsd, other, total };
}

/**
 * Frame-space max |SEI speed| over the flag runs overlapping a segment's
 * [startFrame, endFrame) — null when any overlapping run predates per-run
 * speed evidence (pre-maxMps extraction), so callers can fall back.
 */
function segmentMaxSpeed(c) {
  let frame = 0;
  let max = 0;
  for (const run of c.flagRuns) {
    const start = frame;
    const end = frame + run.frames;
    frame = end;
    if (end <= c.startFrame) continue;
    if (start >= c.endFrame) break;
    if (!Number.isFinite(run.maxMps)) return null;
    if (run.maxMps > max) max = run.maxMps;
  }
  return max;
}

/**
 * True when any flagRuns run overlapping [fromFrame, toFrame) carries `mask`
 * bits: all of them when requireAll (hazards = left AND right in the SAME
 * run), any of them otherwise (pedal input = brake OR accel).
 */
function flagRunsOverlap(flagRuns, fromFrame, toFrame, mask, requireAll) {
  let frame = 0;
  for (const run of flagRuns) {
    const start = frame;
    const end = frame + run.frames;
    frame = end;
    if (end <= fromFrame) continue;
    if (start >= toFrame) break;
    const bits = run.flags & mask;
    if (requireAll ? bits === mask : bits !== 0) return true;
  }
  return false;
}

/**
 * Detect Summon from raw-frame clip evidence. Each entry supplies flagRuns,
 * startFrame, endFrame, totalFrames, and — where the extraction recorded it —
 * apRuns. Every candidate must be pedal-free at parking-lot speed; on top of
 * that either driverless signature qualifies:
 *
 *   hazard bookends — hazards within the opening and closing seconds of the
 *     drive. The only signature older firmware gives: it left autopilot_state
 *     at Off for the whole maneuver. Decisive on its own: no human hazards a
 *     drive at both ends while never touching a pedal.
 *   Self Driving — autopilot_state reports FSD for most of the drive with no
 *     Autosteer/TACC frames, AND the drive is bracketed by Park at both ends.
 *     Newer firmware reports Summon this way (it still flashes the hazards, so
 *     this is the fallback for when that evidence is clipped or pruned).
 *     Autosteer and TACC veto because both require a driver at the wheel.
 *
 * The Park bracketing is what the pedal gate cannot supply here. That gate
 * excludes a human because a driver touches a pedal — but under FSD nobody
 * touches one, so on this path the only thing separating Summon from an
 * ordinary supervised FSD crawl is the shape of the drive: park to park,
 * under the speed cap. A fragment carved out of a longer trip by an unfilled
 * clip gap begins and ends mid-motion and is rejected here.
 *
 * GATE ORDER IS PART OF THE CONTRACT — a second implementation that computes
 * every gate up front and ANDs them will silently tag fewer drives:
 *   1. Shared vetoes (duration, evidence shape, speed, pedals) — any fails,
 *      not Summon.
 *   2. Hazard bookends — pass, RETURN TRUE HERE. Deliberately reached before
 *      the Autosteer/TACC veto, the span checks on apRuns/gearRuns, and the
 *      Park bracketing: none of those existed when the hazard signature was
 *      verified against real footage, and no drive it already tags may lose
 *      its tag to evidence a later firmware started reporting.
 *   3. Self Driving fallback — only when the bookends fail.
 * Within step 3, apRuns and gearRuns are required on EVERY clip even though
 * only the first and last clips' gears are read. That is deliberate: a middle
 * clip whose evidence is missing or in another index space means the drive is
 * not fully accounted for, and this path has no hazard evidence to fall back
 * on. Do not narrow that loop to the endpoints.
 */
function detectSummon(clipEvidence, { maxSpeedMps, durationMs, hasSeiSpeeds }) {
  if (!Array.isArray(clipEvidence) || clipEvidence.length === 0) return false;
  if (!(durationMs > 0) || durationMs > SUMMON_MAX_DURATION_MS) return false;

  // Missing flag evidence makes the complete drive unverifiable. Bounds are
  // validated here rather than trusted: the hazard bookend windows are sized
  // from totalFrames but walked over flagRuns offsets, so runs that index a
  // different space would put the window in the wrong place — and that path
  // returns true, making it the failure-open direction.
  for (const c of clipEvidence) {
    if (!c || !Array.isArray(c.flagRuns) || c.flagRuns.length === 0 ||
        !(c.totalFrames > 0) || !(c.endFrame > c.startFrame) ||
        !(c.startFrame >= 0) || !(c.endFrame <= c.totalFrames) ||
        !runsSpanFrames(c.flagRuns, c.totalFrames)) {
      return false;
    }
  }

  // Prefer frame-space speed. Legacy evidence falls back to drive stats only
  // when genuine SEI speeds are available.
  let speedMps = 0;
  let frameAccurate = true;
  for (const c of clipEvidence) {
    const m = segmentMaxSpeed(c);
    if (m === null) {
      frameAccurate = false;
      break;
    }
    if (m > speedMps) speedMps = m;
  }
  if (!frameAccurate) {
    if (!hasSeiSpeeds) return false;
    speedMps = maxSpeedMps;
  }
  if (!(speedMps > 0) || speedMps > SUMMON_MAX_SPEED_MPS) return false;

  const HAZARD = FLAG_BLINKER_LEFT | FLAG_BLINKER_RIGHT;
  const PEDAL = FLAG_BRAKE | FLAG_ACCEL;

  for (const c of clipEvidence) {
    if (flagRunsOverlap(c.flagRuns, c.startFrame, c.endFrame, PEDAL, false)) return false;
  }

  const bookendFrames = (c) =>
    Math.max(1, Math.ceil((c.totalFrames * SUMMON_BOOKEND_SECONDS * 1000) / CLIP_DURATION_MS));
  const first = clipEvidence[0];
  const last = clipEvidence[clipEvidence.length - 1];
  const hazardAtStart = flagRunsOverlap(
    first.flagRuns,
    first.startFrame,
    Math.min(first.endFrame, first.startFrame + bookendFrames(first)),
    HAZARD,
    true,
  );
  const hazardAtEnd = flagRunsOverlap(
    last.flagRuns,
    Math.max(last.startFrame, last.endFrame - bookendFrames(last)),
    last.endFrame,
    HAZARD,
    true,
  );
  if (hazardAtStart && hazardAtEnd) return true;

  // Self Driving signature. Both extra RLEs must span the clip's raw frames:
  // runs from a producer that indexes a different space would be walked with
  // the wrong bounds, and a wrong answer is worse than no answer.
  for (const c of clipEvidence) {
    if (!runsSpanFrames(c.apRuns, c.totalFrames)) return false;
    if (!runsSpanFrames(c.gearRuns, c.totalFrames)) return false;
  }

  // Park-to-park only, so a slow pedal-free fragment of a longer FSD trip
  // cannot pass as a maneuver. Missing gear evidence reads as not bracketed,
  // which is the safe direction: hazards already covered those drives before
  // autopilot state was recorded at all.
  if (!segmentBoundedByPark(first, false) || !segmentBoundedByPark(last, true)) return false;

  // Needs autopilot evidence on every clip, or the drive's FSD share is
  // measured over an unknown fraction of it.
  let fsdFrames = 0;
  let apFrames = 0;
  for (const c of clipEvidence) {
    const ap = segmentApFrames(c);
    if (ap === null || ap.other > 0) return false;
    fsdFrames += ap.fsd;
    apFrames += ap.total;
  }
  // Multiply rather than divide: the threshold is a power of two, so both
  // sides stay exact integers in any IEEE-754 language.
  return apFrames > 0 && fsdFrames >= apFrames * SUMMON_MIN_FSD_SHARE;
}

// Keep the object literal assignment visible to cjs-module-lexer; freezing it
// inline would hide named exports from ESM importers.
module.exports = {
  R_EARTH_M,
  M_PER_MILE,
  M_PER_KM,
  MI_TO_KM,
  MPS_TO_MPH,
  MPS_TO_KMH,
  MPH_TO_MPS,
  MAX_FROM_MEDIAN_M,
  MAX_JUMP_M,
  NULL_ISLAND_DEG,
  DRIVE_GAP_MS,
  PARK_GAP_SECONDS,
  CLIP_DURATION_MS,
  GAP_FILL_MIN_MS,
  GAP_FILL_MAX_MS,
  GAP_FILL_ADJ_MS,
  GAP_FILL_DUP_MS,
  GAP_FILL_MIN_SPEED_MPS,
  SEI_SPEED_MAX_MPS,
  DERIVED_SPEED_MAX_MPS,
  GEAR_PARK,
  GEAR_DRIVE,
  GEAR_REVERSE,
  GEAR_NEUTRAL,
  AUTOPILOT_OFF,
  AUTOPILOT_FSD,
  AUTOPILOT_AUTOSTEER,
  AUTOPILOT_TACC,
  FLAG_BLINKER_LEFT,
  FLAG_BLINKER_RIGHT,
  FLAG_BRAKE,
  FLAG_ACCEL,
  SUMMON_MAX_SPEED_MPS,
  SUMMON_BOOKEND_SECONDS,
  SUMMON_MAX_DURATION_MS,
  SUMMON_MIN_FSD_SHARE,
  WGS84_A,
  WGS84_F,
  geodesicM,
  haversineM,
  round2,
  computeGearRuns,
  computeFlagRuns,
  computeApRuns,
  flagRunsOverlap,
  segmentMaxSpeed,
  segmentApFrames,
  gearAtFrame,
  segmentBoundedByPark,
  runsSpanFrames,
  detectSummon,
};
Object.freeze(module.exports);
