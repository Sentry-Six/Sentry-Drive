# Rust migration: haversine → WGS-84 geodesic distance + calculation sandboxing

**Audience:** Sentry-USB-Rusty maintainer (human or AI session). **Status:** Sentry Drive (the Electron app) has already shipped both halves of this change; the Rust crate needs the matching update to restore cross-app parity.

Two deliverables, done as one change (the migration touches every call site anyway):
1. Replace spherical haversine with the WGS-84 geodesic (accuracy fix).
2. **Sandbox the drive-calc layer**: centralize every calculation constant and formula into one module with locked tests — mirroring Drive's `src/shared/drive-calc.cjs` + `drive-calc.test.js` — so the math can't silently drift again. The Rust crate currently has the same duplication Drive had before its sandbox: `haversine_m` is defined twice (`aggregate.rs` and `grouper.rs`), the GPS filter thresholds are re-declared locally in two places, and unit-conversion literals are scattered across the crate.

## Environment / orientation (read first if you're starting cold)

- **Repo to modify:** `b:\Programs\Git-Fork\Repositories\Sentry-USB-Rusty` — a Cargo workspace; all changes land in `crates/drives/src` (`aggregate.rs`, `grouper.rs`, plus `db.rs`/`backfill.rs`/`schema.rs` for cache invalidation).
- **Reference repo (do NOT modify):** `B:\Programs\Git-Fork\Repositories\Sentry-Drive` — the shipped implementation is `src/shared/drive-calc.cjs` (`geodesicM`) with locked tests in `src/shared/drive-calc.test.js`. This doc lives there at `docs/RUST-GEODESIC-MIGRATION.md`.
- **Before editing:** read `aggregate.rs` (current `haversine_m` + `EARTH_RADIUS_M`), grep `haversine_m` across the crate for the full call-site list, and read `backfill.rs` + the cache-version constants in `db.rs` to learn the actual invalidation mechanism — do not guess marker names from this doc; line numbers and names here may have drifted.
- **Verify with:** `cargo test -p drives` from the workspace root (confirm the package name in `crates/drives/Cargo.toml` first). Cross-check goldens against Drive by running `npm test` in the Sentry-Drive repo — both suites must pin the same numbers from the table below.

## Why

Both apps computed GPS distances with a spherical haversine (`R = 6,371,000 m`). A sphere is the wrong Earth model: versus the WGS-84 ellipsoid, haversine carries a systematic, direction-dependent error of **−0.24% to +0.18%** (long for north–south legs, short for east–west). On a 30-mile drive that's up to ±0.1 mi of bias; it also skews lifetime totals and FSD-distance percentages.

Sentry Drive replaced haversine with the **Andoyer–Lambert first-order geodesic on WGS-84**:

- Closed-form (no iteration) → JS and Rust produce comparable results from the same operation sequence, unlike Vincenty whose iteration could differ.
- Accuracy: validated against an independent Vincenty inverse at **≤ 0.4 m over 4,100 km** and ≤ 1 mm on 1-second GPS segments (residual error is O(f²) ≈ 1e-5 relative — far below GPS noise).
- Cost: ~2 extra `atan`/`tan` calls per pair vs haversine; negligible.

Until this lands in Rust, **Drive's distances intentionally lead Rust by the bias above.** Per-drive `distanceMi` from the two apps will differ by ~0.1–0.3% until parity is restored.

## Reference implementation (port this literally)

This is Drive's canonical implementation — `src/shared/drive-calc.cjs` in the Sentry-Drive repo (function `geodesicM`). Port it operation-for-operation:

```js
const WGS84_A = 6378137.0;           // semi-major axis (m), exact by definition
const WGS84_F = 1 / 298.257223563;   // flattening, exact by definition

function geodesicM(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0;
  const toRad = (d) => (d * Math.PI) / 180.0;
  const f = WGS84_F;

  // Reduced (parametric) latitudes.
  const b1 = Math.atan((1 - f) * Math.tan(toRad(lat1)));
  const b2 = Math.atan((1 - f) * Math.tan(toRad(lat2)));
  const P = (b1 + b2) / 2;
  const Q = (b2 - b1) / 2;

  // Central angle σ on the auxiliary sphere, haversine form: h = sin²(σ/2).
  const sinHalfDLon = Math.sin(toRad(lon2 - lon1) / 2);
  const sinQ = Math.sin(Q);
  const h = sinQ * sinQ + Math.cos(b1) * Math.cos(b2) * sinHalfDLon * sinHalfDLon;
  const sigma = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  if (sigma === 0) return 0;

  // Andoyer first-order flattening correction. Clamped denominators: near σ=0
  // the numerators vanish at least as fast; near the antipode (unreachable for
  // car GPS after the 1,000 km median filter) this keeps the result finite.
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
```

Rust sketch (`f64` throughout — IEEE-754 double, same as JS):

```rust
pub const WGS84_A: f64 = 6378137.0;
pub const WGS84_F: f64 = 1.0 / 298.257223563;

pub fn geodesic_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    if lat1 == lat2 && lon1 == lon2 { return 0.0; }
    let to_rad = std::f64::consts::PI / 180.0;
    let f = WGS84_F;
    let b1 = ((1.0 - f) * (lat1 * to_rad).tan()).atan();
    let b2 = ((1.0 - f) * (lat2 * to_rad).tan()).atan();
    let p = (b1 + b2) / 2.0;
    let q = (b2 - b1) / 2.0;
    let sin_half_dlon = ((lon2 - lon1) * to_rad / 2.0).sin();
    let sin_q = q.sin();
    let h = sin_q * sin_q + b1.cos() * b2.cos() * sin_half_dlon * sin_half_dlon;
    let sigma = 2.0 * h.sqrt().atan2((1.0 - h).max(0.0).sqrt());
    if sigma == 0.0 { return 0.0; }
    let sin_sigma = sigma.sin();
    let cos2_half = (1.0 - h).max(1e-12);
    let sin2_half = h.max(1e-12);
    let (sin_p, cos_p, cos_q) = (p.sin(), p.cos(), q.cos());
    let x = (sigma - sin_sigma) * (sin_p * sin_p * cos_q * cos_q) / cos2_half;
    let y = (sigma + sin_sigma) * (cos_p * cos_p * sin_q * sin_q) / sin2_half;
    WGS84_A * (sigma - (f / 2.0) * (x + y))
}
```

## What to change in `crates/drives`

1. **Create the sandbox module — `crates/drives/src/calc.rs`** (the Rust mirror of Drive's `src/shared/drive-calc.cjs`). One module, loudly commented as the single source of truth, holding **all** of:

   ```rust
   // Geodesy
   pub const WGS84_A: f64 = 6378137.0;
   pub const WGS84_F: f64 = 1.0 / 298.257223563;
   pub const EARTH_RADIUS_M: f64 = 6371000.0; // legacy haversine only
   // Unit conversions
   pub const M_PER_MILE: f64 = 1609.344;
   pub const M_PER_KM: f64 = 1000.0;
   pub const MPS_TO_MPH: f64 = 2.23694;
   pub const MPS_TO_KMH: f64 = 3.6;
   pub const MPH_TO_MPS: f64 = 0.44704;
   // GPS outlier filtering
   pub const MAX_FROM_MEDIAN_M: f64 = 1_000_000.0;
   pub const MAX_JUMP_M: f64 = 5000.0;
   pub const NULL_ISLAND_DEG: f64 = 1.0;
   // Trip grouping
   pub const DRIVE_GAP_MS: i64 = 5 * 60 * 1000;
   pub const PARK_GAP_SECONDS: f64 = 2.0;
   pub const CLIP_DURATION_MS: i64 = 60_000;
   // Speed sanity caps
   pub const SEI_SPEED_MAX_MPS: f64 = 100.0;
   pub const DERIVED_SPEED_MAX_MPS: f64 = 70.0;
   // Gear-split thresholds (see note below)
   pub const PARK_MAJORITY_FRACTION: f64 = 0.5;
   pub const PARK_MAJORITY_FRACTION_FAST: f64 = 0.6; // count-only fast path
   // Functions
   pub fn geodesic_m(...) -> f64 { /* port from this doc */ }
   pub fn haversine_m(...) -> f64 { /* move legacy impl here */ }
   pub fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
   pub fn is_null_island(lat: f64, lng: f64) -> bool { lat.abs() < NULL_ISLAND_DEG && lng.abs() < NULL_ISLAND_DEG }
   ```

   Inventory of what currently lives where (as of last sync — **grep to confirm**, line numbers drift):
   - `haversine_m` defined **twice**: `aggregate.rs:32` and `grouper.rs:2108` → one copy, in `calc.rs`.
   - `EARTH_RADIUS_M` — `aggregate.rs:27`; `is_null_island` — `aggregate.rs:42`.
   - `DRIVE_GAP_MS`, `PARK_GAP_SECONDS` — `grouper.rs:22-25`.
   - `MAX_FROM_MEDIAN_M` / `MAX_JUMP_M` — declared **locally twice** (`grouper.rs:~1119/1123` and `~1453/1454`).
   - `1609.344`, `2.23694`, `/ 1000.0` literals — scattered through `grouper.rs` (~966-990, 1294-1319, 1410-1436, 1586-1592, 1695-1704, 2684-2708, 2959-2965) and the `r()` rounding closure in `db.rs:~1056`.
   - `round2`/`round1` helpers — `grouper.rs`; speed caps `100.0`/`70.0` — grep in `aggregate.rs`/`grouper.rs` speed loops.
   - Gear/autopilot state constants (`GEAR_PARK`, `AUTOPILOT_*`) — wherever they live (`extract.rs`/`types.rs`); re-export through `calc.rs` or leave but reference from one place only.
   - Mostly-parked `0.5` (`grouper.rs:~744, ~2505`) and the **deliberately different** `0.6` in the count-only fast path (`grouper.rs:~1734`) — centralize both as separate named constants; do NOT unify them, the 0.6 is an intentional approximation (document that at the constant).

2. **Switch every distance call site** to `calc::geodesic_m` and every constant/literal to the `calc::` names — this kills the duplication in the same pass. Call sites as of last sync: `aggregate.rs` `compute_route_aggregates` pair loop (~108); `grouper.rs` clip distance walks, cross-clip boundary distance, median-cluster filter, neighbor-jump filter, GPS-derived speed, summary paths (~808, 825, 1120, 1131/1138, 1173, 1228, 1281, 1481, 1492/1494, 1508, 1614, 2549). Keep `haversine_m` only in `calc.rs` as the legacy test reference. No threshold retuning needed — the filters are coarse.

3. **Invalidate caches** — this is the easy-to-miss part. Per-route aggregates (`distance_m`, `fsd_distance_m`, …) are **persisted in SQLite** and served from caches:
   - Bump **`DRIVE_LIST_CACHE_ALGO_VERSION`** (db.rs) so `drive_list_cache` / `drive_stats_cache` recompute.
   - Stored `RouteAggregates` rows must be **re-aggregated** (the backfill path in `backfill.rs`) or they'll keep serving haversine-era distances forever. Add/bump whatever aggregate-version marker gates the backfill.
4. **Tests** — port Drive's locked vectors so the two implementations are pinned to identical values (Drive: `src/shared/drive-calc.test.js`):

   | Case | Input | Expected | Tolerance |
   |---|---|---|---|
   | NYC → LA | (40.7128, −74.006) → (34.0522, −118.2437) | **3,944,422.179 m** | ±1 m (Vincenty: 3,944,422.232) |
   | SF → NYC | (37.7749, −122.4194) → (40.7128, −74.006) | **4,139,145.867 m** | ±1 m (Vincenty: 4,139,145.472) |
   | 1-second segment | (37.7749, −122.4194) → (37.77517, −122.4194) | **29.968 m** | ±0.01 m |
   | Identical point | any → same | exactly 0 | — |
   | Symmetry | A→B vs B→A | equal | exact |

   The existing loose brackets (`test_haversine_m` NYC→LA ±50 km, `haversine_known_distance_sf_to_nyc` 4.0–4.2 Mm) still pass with the geodesic — keep them, retargeted at `geodesic_m`.

5. **Lock tests for the sandbox** — a `#[cfg(test)]` module in `calc.rs` mirroring Drive's `drive-calc.test.js`. It must pin **every constant to its exact value** (e.g. `assert_eq!(M_PER_MILE, 1609.344)`, `assert_eq!(MAX_JUMP_M, 5000.0)`, `assert_eq!(DRIVE_GAP_MS, 300_000)`, …) plus the golden vectors above. The point is that any future edit to a constant or formula fails `cargo test` loudly instead of silently desyncing the two apps — this is exactly how Drive caught its divergences. If the repo has a CI workflow, confirm it runs `cargo test` for this crate so the lock actually gates merges.

6. **Prove the sandbox is complete** — after the refactor, these greps over `crates/drives/src` must each return matches **only in `calc.rs`** (and its tests): `haversine_m`'s body, `6371000`, `1609.344`, `2.23694`, `1_000_000.0`, `5000.0` (filter), `0.44704`. Any hit elsewhere is a missed duplicate.

## User-visible effect & rollout

- Displayed mileage shifts by **~0.1–0.3%** (direction-dependent). Expect users to notice lifetime totals change slightly after the backfill; worth a release note ("more accurate WGS-84 distance model").
- **Definition of done:**
  1. On the same dataset, Rust and Drive produce identical per-drive `distanceMi` at 2 dp, and Drive's `drive-calc.test.js` golden values match the Rust test values exactly.
  2. All calc constants/formulas live only in `calc.rs` (the greps in step 6 are clean), every constant is pinned by a lock test, and `cargo test -p drives` passes.
- Cross-check tool: any Vincenty/Karney implementation; agreement should be within ~1 m on the table above.
