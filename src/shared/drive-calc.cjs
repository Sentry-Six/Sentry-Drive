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

// Summon evidence requires hazard bookends, no pedal input, and parking-lot
// speed. The cap leaves margin above Tesla's 8 mph Summon limit.
const SUMMON_MAX_SPEED_MPS = 4.5;
const SUMMON_BOOKEND_SECONDS = 10;      // hazards must appear this close to each end
const SUMMON_MAX_DURATION_MS = 10 * 60 * 1000;

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
 * startFrame, endFrame, and totalFrames. The signature is hazard bookends,
 * no pedal input, and parking-lot speed.
 */
function detectSummon(clipEvidence, { maxSpeedMps, durationMs, hasSeiSpeeds }) {
  if (!Array.isArray(clipEvidence) || clipEvidence.length === 0) return false;
  if (!(durationMs > 0) || durationMs > SUMMON_MAX_DURATION_MS) return false;

  // Missing flag evidence makes the complete drive unverifiable.
  for (const c of clipEvidence) {
    if (!c || !Array.isArray(c.flagRuns) || c.flagRuns.length === 0 ||
        !(c.totalFrames > 0) || !(c.endFrame > c.startFrame)) {
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
  return hazardAtStart && hazardAtEnd;
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
  WGS84_A,
  WGS84_F,
  geodesicM,
  haversineM,
  round2,
  computeGearRuns,
  computeFlagRuns,
  flagRunsOverlap,
  segmentMaxSpeed,
  detectSummon,
};
Object.freeze(module.exports);
