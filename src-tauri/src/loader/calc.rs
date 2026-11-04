//! Port of `src/shared/drive-calc.cjs` — the shared calculation contract.
//!
//! Every constant and formula mirrors the JavaScript module line for line so the
//! Tauri build groups and measures drives exactly like the Electron build. JS
//! number semantics that matter for parity (Math.round's half-up rule, integer
//! Date truncation) are reproduced by the helpers at the bottom.

pub const M_PER_MILE: f64 = 1609.344;
pub const M_PER_KM: f64 = 1000.0;
pub const MPS_TO_MPH: f64 = 2.23694;
pub const MPS_TO_KMH: f64 = 3.6;

pub const MAX_FROM_MEDIAN_M: f64 = 1_000_000.0;
pub const MAX_JUMP_M: f64 = 5000.0;
pub const NULL_ISLAND_DEG: f64 = 1.0;

pub const DRIVE_GAP_MS: i64 = 5 * 60 * 1000;
pub const PARK_GAP_SECONDS: f64 = 2.0;
pub const CLIP_DURATION_MS: f64 = 60000.0;

pub const GAP_FILL_MIN_MS: i64 = 90 * 1000;
pub const GAP_FILL_MAX_MS: i64 = 30 * 60 * 1000;
pub const GAP_FILL_ADJ_MS: i64 = 3 * 60 * 1000;
pub const GAP_FILL_DUP_MS: i64 = 30 * 1000;
pub const GAP_FILL_MIN_SPEED_MPS: f64 = 0.5;

pub const SEI_SPEED_MAX_MPS: f64 = 100.0;
pub const DERIVED_SPEED_MAX_MPS: f64 = 70.0;

pub const GEAR_PARK: i64 = 0;

pub const AUTOPILOT_OFF: i64 = 0;
pub const AUTOPILOT_FSD: i64 = 1;
pub const AUTOPILOT_AUTOSTEER: i64 = 2;
pub const AUTOPILOT_TACC: i64 = 3;

pub const FLAG_BLINKER_LEFT: i64 = 1;
pub const FLAG_BLINKER_RIGHT: i64 = 2;
pub const FLAG_BRAKE: i64 = 4;
pub const FLAG_ACCEL: i64 = 8;

pub const SUMMON_MAX_SPEED_MPS: f64 = 4.5;
pub const SUMMON_BOOKEND_SECONDS: f64 = 10.0;
pub const SUMMON_MAX_DURATION_MS: f64 = 10.0 * 60.0 * 1000.0;
pub const SUMMON_MAX_UNCOVERED_MS: f64 = CLIP_DURATION_MS / 2.0;
pub const SUMMON_MIN_FSD_SHARE: f64 = 0.5;

const WGS84_A: f64 = 6378137.0;
const WGS84_F: f64 = 1.0 / 298.257223563;

/// Canonical WGS-84 Andoyer–Lambert distance (metres).
pub fn geodesic_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    if lat1 == lat2 && lon1 == lon2 {
        return 0.0;
    }
    let to_rad = |d: f64| (d * std::f64::consts::PI) / 180.0;
    let f = WGS84_F;
    let b1 = ((1.0 - f) * to_rad(lat1).tan()).atan();
    let b2 = ((1.0 - f) * to_rad(lat2).tan()).atan();
    let p = (b1 + b2) / 2.0;
    let q = (b2 - b1) / 2.0;
    let sin_half_dlon = (to_rad(lon2 - lon1) / 2.0).sin();
    let sin_q = q.sin();
    let h = sin_q * sin_q + b1.cos() * b2.cos() * sin_half_dlon * sin_half_dlon;
    let sigma = 2.0 * h.sqrt().atan2((1.0 - h).max(0.0).sqrt());
    if sigma == 0.0 {
        return 0.0;
    }
    let sin_sigma = sigma.sin();
    let cos2_half = (1.0 - h).max(1e-12);
    let sin2_half = h.max(1e-12);
    let sin_p = p.sin();
    let cos_p = p.cos();
    let cos_q = q.cos();
    let x = (sigma - sin_sigma) * (sin_p * sin_p * cos_q * cos_q) / cos2_half;
    let y = (sigma + sin_sigma) * (cos_p * cos_p * sin_q * sin_q) / sin2_half;
    WGS84_A * (sigma - (f / 2.0) * (x + y))
}

/// Spherical haversine used by charging-site grouping and Supercharger matching.
pub fn haversine_metres(lat_a: f64, lon_a: f64, lat_b: f64, lon_b: f64) -> f64 {
    let r = |d: f64| d * std::f64::consts::PI / 180.0;
    let dlat = r(lat_b - lat_a);
    let dlon = r(lon_b - lon_a);
    let a = (dlat / 2.0).sin().powi(2) + r(lat_a).cos() * r(lat_b).cos() * (dlon / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

/// JavaScript `Math.round`: ties round toward +infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

pub fn round2(v: f64) -> f64 {
    js_round(v * 100.0) / 100.0
}

// ── Run-length evidence ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct GearRun {
    pub gear: Option<i64>,
    pub frames: f64,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FlagRun {
    pub flags: i64,
    pub frames: f64,
    pub max_mps: Option<f64>,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ApRun {
    pub ap: Option<i64>,
    pub frames: f64,
}

pub trait Frames {
    fn frames(&self) -> f64;
}
impl Frames for GearRun {
    fn frames(&self) -> f64 { self.frames }
}
impl Frames for FlagRun {
    fn frames(&self) -> f64 { self.frames }
}
impl Frames for ApRun {
    fn frames(&self) -> f64 { self.frames }
}

pub fn runs_span_frames<T: Frames>(runs: Option<&[T]>, total_frames: f64) -> bool {
    let Some(runs) = runs else { return false };
    if runs.is_empty() || !(total_frames > 0.0) {
        return false;
    }
    let mut sum = 0.0;
    for run in runs {
        if !(run.frames() > 0.0) {
            return false;
        }
        sum += run.frames();
    }
    sum == total_frames
}

fn gear_at_frame(gear_runs: Option<&[GearRun]>, frame: f64) -> Option<i64> {
    let runs = gear_runs?;
    if !(frame >= 0.0) {
        return None;
    }
    let mut end = 0.0;
    for run in runs {
        end += run.frames;
        if frame < end {
            return run.gear;
        }
    }
    None
}

#[derive(Clone, Debug)]
pub struct ClipEvidence<'a> {
    pub flag_runs: Option<&'a [FlagRun]>,
    pub ap_runs: Option<&'a [ApRun]>,
    pub gear_runs: Option<&'a [GearRun]>,
    pub start_frame: f64,
    pub end_frame: f64,
    pub total_frames: f64,
    pub start_ms: f64,
    pub end_ms: f64,
}

fn segment_bounded_by_park(c: &ClipEvidence, at_end: bool) -> bool {
    if at_end {
        if let Some(after) = gear_at_frame(c.gear_runs, c.end_frame) {
            return after == GEAR_PARK;
        }
        // `gearAtFrame(...) === GEAR_PARK` with a null result is false.
        return gear_at_frame(c.gear_runs, c.end_frame - 1.0) == Some(GEAR_PARK);
    }
    if c.start_frame > 0.0 {
        return gear_at_frame(c.gear_runs, c.start_frame - 1.0) == Some(GEAR_PARK);
    }
    gear_at_frame(c.gear_runs, 0.0) == Some(GEAR_PARK)
}

struct ApFrames {
    fsd: f64,
    other: f64,
    total: f64,
}

fn segment_ap_frames(c: &ClipEvidence) -> Option<ApFrames> {
    let runs = c.ap_runs?;
    if runs.is_empty() {
        return None;
    }
    let (mut frame, mut fsd, mut other, mut total) = (0.0, 0.0, 0.0, 0.0);
    for run in runs {
        let start = frame;
        let end = frame + run.frames;
        frame = end;
        if end <= c.start_frame {
            continue;
        }
        if start >= c.end_frame {
            break;
        }
        let overlap = end.min(c.end_frame) - start.max(c.start_frame);
        total += overlap;
        // JS compares `run.ap === AUTOPILOT_FSD` / `!== AUTOPILOT_OFF`; a
        // missing ap (undefined) is "not Off", so it counts as other.
        match run.ap {
            Some(AUTOPILOT_FSD) => fsd += overlap,
            Some(AUTOPILOT_OFF) => {}
            _ => other += overlap,
        }
    }
    if total == 0.0 {
        return None;
    }
    Some(ApFrames { fsd, other, total })
}

fn segment_max_speed(c: &ClipEvidence) -> Option<f64> {
    let mut frame = 0.0;
    let mut max = 0.0;
    for run in c.flag_runs.unwrap_or(&[]) {
        let start = frame;
        let end = frame + run.frames;
        frame = end;
        if end <= c.start_frame {
            continue;
        }
        if start >= c.end_frame {
            break;
        }
        match run.max_mps {
            Some(v) if v.is_finite() => {
                if v > max {
                    max = v;
                }
            }
            _ => return None,
        }
    }
    Some(max)
}

fn flag_runs_overlap(flag_runs: &[FlagRun], from: f64, to: f64, mask: i64, require_all: bool) -> bool {
    let mut frame = 0.0;
    for run in flag_runs {
        let start = frame;
        let end = frame + run.frames;
        frame = end;
        if end <= from {
            continue;
        }
        if start >= to {
            break;
        }
        let bits = run.flags & mask;
        if if require_all { bits == mask } else { bits != 0 } {
            return true;
        }
    }
    false
}

/// Port of `detectSummon` — gate order is part of the contract.
pub fn detect_summon(evidence: &[ClipEvidence], max_speed_mps: f64, duration_ms: f64, has_sei_speeds: bool) -> bool {
    if evidence.is_empty() {
        return false;
    }
    if !(duration_ms > 0.0) || duration_ms > SUMMON_MAX_DURATION_MS {
        return false;
    }
    for c in evidence {
        let ok = matches!(c.flag_runs, Some(r) if !r.is_empty())
            && c.total_frames > 0.0
            && c.end_frame > c.start_frame
            && c.start_frame >= 0.0
            && c.end_frame <= c.total_frames
            && runs_span_frames(c.flag_runs, c.total_frames);
        if !ok {
            return false;
        }
    }

    let mut covered_ms = 0.0;
    let timed = evidence
        .iter()
        .all(|c| c.start_ms.is_finite() && c.end_ms.is_finite() && c.end_ms > c.start_ms);
    if timed {
        let mut spans: Vec<(f64, f64)> = evidence.iter().map(|c| (c.start_ms, c.end_ms)).collect();
        spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let (mut run_start, mut run_end) = spans[0];
        for &(s, e) in &spans[1..] {
            if s > run_end {
                covered_ms += run_end - run_start;
                run_start = s;
                run_end = e;
            } else if e > run_end {
                run_end = e;
            }
        }
        covered_ms += run_end - run_start;
    } else {
        for c in evidence {
            covered_ms += ((c.end_frame - c.start_frame) * CLIP_DURATION_MS) / c.total_frames;
        }
    }
    if duration_ms - covered_ms > SUMMON_MAX_UNCOVERED_MS {
        return false;
    }

    let mut speed_mps = 0.0;
    let mut frame_accurate = true;
    for c in evidence {
        match segment_max_speed(c) {
            None => {
                frame_accurate = false;
                break;
            }
            Some(m) => {
                if m > speed_mps {
                    speed_mps = m;
                }
            }
        }
    }
    if !frame_accurate {
        if !has_sei_speeds {
            return false;
        }
        speed_mps = max_speed_mps;
    }
    if !(speed_mps > 0.0) || speed_mps > SUMMON_MAX_SPEED_MPS {
        return false;
    }

    let hazard = FLAG_BLINKER_LEFT | FLAG_BLINKER_RIGHT;
    let pedal = FLAG_BRAKE | FLAG_ACCEL;
    for c in evidence {
        if flag_runs_overlap(c.flag_runs.unwrap_or(&[]), c.start_frame, c.end_frame, pedal, false) {
            return false;
        }
    }

    let bookend = |c: &ClipEvidence| (((c.total_frames * SUMMON_BOOKEND_SECONDS * 1000.0) / CLIP_DURATION_MS).ceil()).max(1.0);
    let first = &evidence[0];
    let last = &evidence[evidence.len() - 1];
    let hazard_at_start = flag_runs_overlap(
        first.flag_runs.unwrap_or(&[]),
        (first.start_frame - bookend(first)).max(0.0),
        first.end_frame.min(first.start_frame + bookend(first)),
        hazard,
        true,
    );
    let hazard_at_end = flag_runs_overlap(
        last.flag_runs.unwrap_or(&[]),
        last.start_frame.max(last.end_frame - bookend(last)),
        last.total_frames.min(last.end_frame + bookend(last)),
        hazard,
        true,
    );
    if hazard_at_start && hazard_at_end {
        return true;
    }

    for c in evidence {
        if !runs_span_frames(c.ap_runs, c.total_frames) {
            return false;
        }
        if !runs_span_frames(c.gear_runs, c.total_frames) {
            return false;
        }
    }
    if !segment_bounded_by_park(first, false) || !segment_bounded_by_park(last, true) {
        return false;
    }
    let (mut fsd_frames, mut ap_frames) = (0.0, 0.0);
    for c in evidence {
        match segment_ap_frames(c) {
            None => return false,
            Some(ap) => {
                if ap.other > 0.0 {
                    return false;
                }
                fsd_frames += ap.fsd;
                ap_frames += ap.total;
            }
        }
    }
    ap_frames > 0.0 && fsd_frames >= ap_frames * SUMMON_MIN_FSD_SHARE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_matches_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(round2(1.005), 1.0); // 1.005*100 = 100.49999999999999
    }

    #[test]
    fn geodesic_is_zero_for_same_point_and_sane_for_a_degree() {
        assert_eq!(geodesic_m(10.0, 10.0, 10.0, 10.0), 0.0);
        let d = geodesic_m(0.0, 0.0, 0.0, 1.0);
        assert!((d - 111_319.49).abs() < 1.0, "{d}");
    }
}
