# WGS-84 distance parity

Sentry Drive and Sentry USB Rusty use the same WGS-84 Andoyer–Lambert distance calculation. This document records their parity contract.

## Implementations

- Sentry Drive: `src/shared/drive-calc.cjs` (`geodesicM`), locked by `src/shared/drive-calc.test.js`.
- Sentry USB Rusty: `crates/drives/src/calc.rs` (`geodesic_m`) in the Rust workspace.

Keep each implementation's operation order and constants aligned. JavaScript and Rust both use IEEE-754 double precision, so matching formulas produce comparable results without an iterative solver.

## Why WGS-84

The previous spherical haversine calculation used a 6,371,000 m radius. Its direction-dependent error affected per-drive mileage, lifetime totals, and FSD-distance percentages. The Andoyer–Lambert calculation models the WGS-84 ellipsoid and remains closed-form.

The shared long-distance vectors were cross-validated against an independent Vincenty inverse:

| Case | Expected | Tolerance |
|---|---:|---:|
| NYC to Los Angeles | 3,944,422.179 m | ±1 m |
| San Francisco to NYC | 4,139,145.867 m | ±1 m |

Both suites also cover short GPS segments, identical points, and symmetry.

## Parity requirements

- Keep parity-bound constants synchronized and covered by each project's lock tests.
- Pin calculation constants and golden vectors in both test suites.
- Preserve the legacy haversine function only as a comparison reference; production distance paths use the WGS-84 function.
- In Rust, changes that affect persisted aggregate values require the corresponding cache/formula version to advance so stored distances are rebuilt.
- Do not retune coarse GPS filters merely because the distance model changes.

Run `npm test` in Sentry Drive and `cargo test -p sentryusb-drives` in the Rust workspace when changing the parity surface.
