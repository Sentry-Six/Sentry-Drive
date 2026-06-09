'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for Tesla drive calculations.
//
// Every constant and formula here is mirrored from the canonical Rust
// implementation at Sentry-USB-Rusty/crates/drives/src (grouper.rs,
// aggregate.rs, extract.rs). Sentry Drive must stay byte-for-byte equivalent
// in its drive math, so DO NOT change any value here without:
//   (a) making the matching change in that Rust crate, and
//   (b) updating the locked tests in drive-calc.test.js.
// Those tests run on `prebuild`, so a drifted constant or formula fails the
// build before it can ship.
//
// CommonJS on purpose so it loads in every context of this mixed-module app:
//   • ESM processing modules (grouper.js, …) `import { … }` the named exports
//   • CommonJS main/helper files (electron-main.cjs, …) `require()` it
//   • the sandboxed renderer receives the constants via electron-preload.cjs
// ─────────────────────────────────────────────────────────────────────────────

// ─── Geodesy ─────────────────────────────────────────────────────────────────
// Earth radius in metres. Mirrors EARTH_RADIUS_M (aggregate.rs:27) and the
// inline `R` used by the legacy haversine here and in the Rust crate.
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

// ─── GPS outlier filtering (grouper.rs:1119-1123, 1453-1454) ─────────────────
const MAX_FROM_MEDIAN_M = 1000000; // drop points >1,000 km from the median cluster
const MAX_JUMP_M = 5000;           // drop a point >5 km from BOTH neighbours
const NULL_ISLAND_DEG = 1;         // |lat|<1 && |lon|<1 ⇒ pre-GPS-lock junk

// ─── Trip grouping (grouper.rs:22-25) ────────────────────────────────────────
const DRIVE_GAP_MS = 5 * 60 * 1000; // >5 min between clips ⇒ separate drives
const PARK_GAP_SECONDS = 2.0;       // ≥2 s in Park ⇒ split the drive
const CLIP_DURATION_MS = 60000;     // each dashcam clip spans ~60 s

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

// ─── Pure helpers ────────────────────────────────────────────────────────────

// Ellipsoidal distance in metres between two GPS coordinates — Andoyer–Lambert
// first-order geodesic on WGS-84. THE canonical distance function for all
// drive math (distance, speed, GPS filters).
//
// Why not haversine: haversine assumes a sphere (R = 6371 km) and carries a
// systematic 0.1–0.5% error vs the real ellipsoid depending on latitude and
// bearing. Andoyer–Lambert corrects to first order in the flattening; residual
// error is O(f²) ≈ 1e-5 relative (metres over thousands of km) — far below GPS
// noise. Chosen over Vincenty because it is closed-form (no iteration), so JS
// and Rust produce bit-comparable results from the same operations.
//
// NOTE: the Rust crate (Sentry-USB-Rusty) still uses haversine_m. Migration
// plan for the Rust dev: docs/RUST-GEODESIC-MIGRATION.md. Until that lands,
// Drive's distances intentionally lead Rust by the accuracy delta above.
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

// Great-circle distance in metres between two GPS coordinates (spherical).
// Identical to haversine_m (grouper.rs:2108, aggregate.rs:32). LEGACY — kept
// only as the Rust-parity reference for tests; app code must use geodesicM.
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

// Round to 2 decimals — mirrors round2 (grouper.rs) and the per-drive `r2`.
function round2(v) {
  return Math.round(v * 100) / 100;
}

function metersToMiles(m) {
  return m / M_PER_MILE;
}
function metersToKm(m) {
  return m / M_PER_KM;
}
function mpsToMph(v) {
  return v * MPS_TO_MPH;
}
function mpsToKmh(v) {
  return v * MPS_TO_KMH;
}

// IMPORTANT: assign a plain object literal first so Node's cjs-module-lexer can
// statically detect the named exports for ESM `import { … }`. Freeze on the
// next line — `module.exports = Object.freeze({…})` wraps the literal in a call
// expression, which hides the names from the lexer and breaks named imports.
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
  WGS84_A,
  WGS84_F,
  geodesicM,
  haversineM,
  round2,
  metersToMiles,
  metersToKm,
  mpsToMph,
  mpsToKmh,
};
Object.freeze(module.exports);
