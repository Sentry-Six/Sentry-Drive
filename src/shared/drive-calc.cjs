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
// inline `R` used by every haversine in this codebase and the Rust crate.
const R_EARTH_M = 6371000.0;

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

// Great-circle distance in metres between two GPS coordinates.
// Identical to haversine_m (grouper.rs:2108, aggregate.rs:32).
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
  haversineM,
  round2,
  metersToMiles,
  metersToKm,
  mpsToMph,
  mpsToKmh,
};
Object.freeze(module.exports);
