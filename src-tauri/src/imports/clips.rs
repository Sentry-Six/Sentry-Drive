//! Synthetic 60-second clips from Tessie / Teslascope drives (port of the
//! clip-building and overlap half of `src/processing/tessie-import.cjs`).

use std::collections::HashSet;
use std::sync::OnceLock;

use base64::Engine;
use regex::Regex;
use serde_json::{json, Value};

use super::js::{clamp, local_parts, max0, num, number_to_string, pad2, to_fixed, v8_sort_by_key};
use crate::loader::calc::js_round;
use crate::loader::grouper::GroupedDrive;
use crate::loader::route::parse_local_iso;

pub const MPH_TO_MPS: f64 = 0.44704;
const GEAR_DRIVE: u8 = 1;
const GEAR_REVERSE: u8 = 2;

/// A parsed CSV drive (all times epoch ms).
#[derive(Clone, Debug)]
pub struct Drive {
    pub started_at: f64,
    pub ended_at: f64,
    pub duration_ms: f64,
    pub distance_mi: f64,
    pub autopilot_distance_mi: f64,
    pub starting_odometer: Option<f64>,
    pub ending_odometer: Option<f64>,
    pub start_lat: Option<f64>,
    pub start_lng: Option<f64>,
    pub end_lat: Option<f64>,
    pub end_lng: Option<f64>,
    /// `_tzShiftMs`, set when calibration moved the drive.
    pub tz_shift_ms: Option<f64>,
}

/// A driving-states CSV row.
#[derive(Clone, Debug)]
pub struct StatePoint {
    pub time_ms: f64,
    pub lat: f64,
    pub lng: f64,
    pub shift: String,
    pub speed_mph: f64,
    pub odometer: Option<f64>,
}

/// `drive.startingOdometer` as `buildExternalSignature` sees it.
#[derive(Clone, Debug, PartialEq)]
pub enum Odo {
    /// null / undefined → "x".
    Missing,
    Num(f64),
    /// A non-number (e.g. a string from a provider) — `.toFixed` throws.
    Other,
}

impl Odo {
    pub fn from_opt(v: Option<f64>) -> Odo {
        v.map_or(Odo::Missing, Odo::Num)
    }
    pub fn from_value(v: Option<&Value>) -> Odo {
        match v {
            None | Some(Value::Null) => Odo::Missing,
            Some(Value::Number(n)) => Odo::Num(n.as_f64().unwrap_or(f64::NAN)),
            Some(_) => Odo::Other,
        }
    }
}

/// `buildExternalSignature`: stable identity despite small boundary
/// adjustments between exports. `started_at` is the already-coerced number
/// (`null` reads as 0).
pub fn external_signature(started_at: f64, odo: &Odo, source: &str) -> Result<String, String> {
    let minute_bucket = (started_at / 60000.0).floor();
    let od = match odo {
        Odo::Missing => "x".to_string(),
        Odo::Num(x) => to_fixed(*x, 2),
        Odo::Other => return Err("drive.startingOdometer.toFixed is not a function".into()),
    };
    Ok(format!("{source}:{}:{od}", number_to_string(minute_bucket)))
}

pub fn signature_to_filename_suffix(signature: &str) -> String {
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    let re = PREFIX.get_or_init(|| Regex::new(r"^[a-z]+:").expect("valid regex"));
    re.replace(signature, "").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect()
}

fn local_date(ms: f64) -> (String, String, String, String, String, String) {
    match local_parts(ms) {
        Some((y, mo, d, h, mi, s)) => (y.to_string(), pad2(mo), pad2(d), pad2(h), pad2(mi), pad2(s)),
        None => {
            let n = || "NaN".to_string();
            (n(), n(), n(), n(), n(), n())
        }
    }
}

/// Local wall-clock filename matching SEI parsing, with the signature so
/// adjacent imports sharing a minute don't deduplicate by path.
pub fn format_clip_filename(window_start_ms: f64, sig_suffix: &str, source: &str) -> String {
    let (y, mo, d, h, mi, s) = local_date(window_start_ms);
    format!("{source}/{y}-{mo}-{d}/{y}-{mo}-{d}_{h}-{mi}-{s}-front-{source}-{sig_suffix}.mp4")
}

pub fn format_clip_date(window_start_ms: f64) -> String {
    let (y, mo, d, ..) = local_date(window_start_ms);
    format!("{y}-{mo}-{d}")
}

/// Calibrate an export-time timezone mismatch by anchoring the drive to the
/// nearest in-gear state sample (within ±6 h and ~300 m of the start).
pub fn calibrate_drive_time(drive: &Drive, states: &[StatePoint]) -> Drive {
    let (Some(start_lat), Some(start_lng)) = (drive.start_lat, drive.start_lng) else {
        return drive.clone();
    };
    let window = 6.0 * 3600.0 * 1000.0;
    let lo = drive.started_at - window;
    let hi = drive.started_at + window;
    // States are sorted, so skipping `timeMs < lo` is a binary search.
    let first = states.partition_point(|s| s.time_ms < lo);
    let mut best: Option<&StatePoint> = None;
    let mut best_delta = f64::INFINITY;
    for s in &states[first..] {
        if s.time_ms > hi {
            break;
        }
        if s.shift != "D" {
            continue;
        }
        let d_lat = s.lat - start_lat;
        let d_lng = s.lng - start_lng;
        if d_lat * d_lat + d_lng * d_lng > 0.003 * 0.003 {
            continue;
        }
        let delta = (s.time_ms - drive.started_at).abs();
        if delta < best_delta {
            best_delta = delta;
            best = Some(s);
        }
    }
    let Some(best) = best else { return drive.clone() };
    let shift = best.time_ms - drive.started_at;
    if shift.abs() < 60.0 * 1000.0 {
        return drive.clone();
    }
    Drive {
        started_at: drive.started_at + shift,
        ended_at: drive.ended_at + shift,
        tz_shift_ms: Some(shift),
        ..drive.clone()
    }
}

/// In-gear (D/R) samples within 90 s of the drive boundaries.
pub fn join_drive_with_points<'a>(drive: &Drive, states: &'a [StatePoint]) -> Vec<&'a StatePoint> {
    let tolerance = 90.0 * 1000.0;
    let lo = drive.started_at - tolerance;
    let hi = drive.ended_at + tolerance;
    let first = states.partition_point(|s| s.time_ms < lo);
    let mut pts = Vec::new();
    for s in &states[first..] {
        if s.time_ms > hi {
            break;
        }
        if s.shift != "D" && s.shift != "R" {
            continue;
        }
        pts.push(s);
    }
    pts
}

/// A point being cut into clips.
#[derive(Clone, Debug)]
pub struct Pt {
    pub lat: f64,
    pub lng: f64,
    pub time_ms: f64,
    pub speed_mps: f64,
    pub gear: u8,
    pub ap_state: u8,
}

/// Inputs shared by the CSV and API clip splitters.
struct ClipMeta<'a> {
    signature: String,
    source: &'a str,
    autopilot_percent: f64,
}

fn autopilot_percent(distance_mi: f64, autopilot_distance_mi: f64) -> f64 {
    if distance_mi > 0.0 {
        clamp((autopilot_distance_mi / distance_mi) * 100.0, 0.0, 100.0)
    } else {
        0.0
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// splitIntoSyntheticClips / splitIntoApiClips (identical apart from the
/// autopilot bytes, which CSV points leave at 0). Clips are produced in wire
/// format: byte fields already base64 (`encodeByteField`).
fn split_into_clips(pts: &[Pt], meta: &ClipMeta) -> Vec<Value> {
    let Some(first) = pts.first() else { return Vec::new() };
    let first_ms = first.time_ms;
    let last_ms = pts[pts.len() - 1].time_ms;
    let anchor = (first_ms / 60000.0).floor() * 60000.0;
    let sig_suffix = signature_to_filename_suffix(&meta.signature);
    let pct = js_round(meta.autopilot_percent * 10.0) / 10.0;

    let mut clips = Vec::new();
    let mut w_start = anchor;
    while w_start <= last_ms {
        let w_end = w_start + 60000.0;
        let window: Vec<&Pt> = pts.iter().filter(|p| p.time_ms >= w_start && p.time_ms < w_end).collect();
        if !window.is_empty() {
            let n = window.len();
            let points: Vec<Value> = window
                .iter()
                .map(|p| json!([num(js_round(p.lat * 1e6) / 1e6), num(js_round(p.lng * 1e6) / 1e6)]))
                .collect();
            let gears: Vec<u8> = window.iter().map(|p| p.gear).collect();
            let aps: Vec<u8> = window.iter().map(|p| p.ap_state).collect();
            let speeds: Vec<Value> = window.iter().map(|p| num(max0(p.speed_mps))).collect();
            clips.push(json!({
                "file": format_clip_filename(w_start, &sig_suffix, meta.source),
                "date": format_clip_date(w_start),
                "points": points,
                "gearStates": b64(&gears),
                "autopilotStates": b64(&aps),
                "speeds": speeds,
                "accelPositions": vec![0; n],
                "rawParkCount": 0,
                "rawFrameCount": n,
                "gearRuns": [{ "gear": 1, "frames": n }],
                "source": meta.source,
                "externalSignature": meta.signature,
                "tessieAutopilotPercent": num(pct),
            }));
        }
        w_start += 60000.0;
    }
    clips
}

/// Fill empty minute windows with one interpolated point so polling gaps
/// don't fragment a drive; the summary endpoints anchor both ends.
pub fn fill_minute_gaps(raw: Vec<Pt>, drive: &Drive) -> Vec<Pt> {
    let mut anchors = raw;
    let synthetic = |lat, lng, time_ms| Pt { lat, lng, time_ms, speed_mps: 0.0, gear: 1, ap_state: 0 };
    if let (Some(lat), Some(lng)) = (drive.start_lat, drive.start_lng) {
        if drive.started_at.is_finite() {
            anchors.push(synthetic(lat, lng, drive.started_at));
        }
    }
    if let (Some(lat), Some(lng)) = (drive.end_lat, drive.end_lng) {
        if drive.ended_at.is_finite() {
            anchors.push(synthetic(lat, lng, drive.ended_at));
        }
    }
    v8_sort_by_key(&mut anchors, |p| p.time_ms);
    if anchors.len() < 2 {
        return anchors;
    }
    let minute_key = |ms: f64| (ms / 60000.0).floor() as i64;
    let occupied: HashSet<i64> = anchors.iter().map(|a| minute_key(a.time_ms)).collect();
    let first_min = minute_key(anchors[0].time_ms);
    let last_min = minute_key(anchors[anchors.len() - 1].time_ms);

    let mut filled = Vec::new();
    let mut bracket = 0usize;
    for m in first_min..=last_min {
        if occupied.contains(&m) {
            continue;
        }
        let t_mid = m as f64 * 60000.0 + 30000.0;
        while bracket < anchors.len() - 2 && anchors[bracket + 1].time_ms < t_mid {
            bracket += 1;
        }
        let a = &anchors[bracket];
        let b = &anchors[bracket + 1];
        let span = b.time_ms - a.time_ms;
        let frac = if span > 0.0 { clamp((t_mid - a.time_ms) / span, 0.0, 1.0) } else { 0.0 };
        filled.push(synthetic(a.lat + (b.lat - a.lat) * frac, a.lng + (b.lng - a.lng) * frac, t_mid));
    }
    anchors.extend(filled);
    v8_sort_by_key(&mut anchors, |p| p.time_ms);
    anchors
}

pub enum Built {
    Clips { clips: Vec<Value>, point_count: usize },
    Skip(&'static str),
}

/// buildClipsForDrive: raw Tessie breadcrumbs plus minute-gap fillers.
pub fn build_clips_for_drive(original: &Drive, states: &[StatePoint], source: &str) -> Result<Built, String> {
    let drive = calibrate_drive_time(original, states);
    let pts: Vec<Pt> = join_drive_with_points(&drive, states)
        .into_iter()
        .map(|r| Pt {
            lat: r.lat,
            lng: r.lng,
            time_ms: r.time_ms,
            speed_mps: r.speed_mph * MPH_TO_MPS,
            gear: match r.shift.as_str() {
                "P" => 0,
                "D" => GEAR_DRIVE,
                "R" => GEAR_REVERSE,
                "N" => 3,
                _ => 1,
            },
            ap_state: 0,
        })
        .collect();
    let all = fill_minute_gaps(pts, &drive);
    if all.len() < 2 {
        return Ok(Built::Skip("no-coords"));
    }
    let meta = ClipMeta {
        signature: external_signature(drive.started_at, &Odo::from_opt(drive.starting_odometer), source)?,
        source,
        autopilot_percent: autopilot_percent(drive.distance_mi, drive.autopilot_distance_mi),
    };
    let clips = split_into_clips(&all, &meta);
    if clips.is_empty() {
        return Ok(Built::Skip("no-clips"));
    }
    Ok(Built::Clips { clips, point_count: all.len() })
}

/// One provider path point, already coerced the way buildClipsForApiDrive
/// reads it.
#[derive(Clone, Debug)]
pub struct ApiPoint {
    /// `latitude` when it is a finite number (else the point is dropped).
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// `Number(timestamp)` (NaN when missing).
    pub timestamp: f64,
    /// `speed` when it is a finite number.
    pub speed: Option<f64>,
    /// mapAutopilotString(autopilot).
    pub ap_state: u8,
}

/// The normalized drive buildClipsForApiDrive consumes.
#[derive(Clone, Debug)]
pub struct ApiDrive {
    /// None is `null` (reads as 0 in arithmetic, not finite).
    pub started_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub distance_mi: f64,
    pub autopilot_distance_mi: f64,
    pub starting_odometer: Odo,
    pub start_lat: Option<f64>,
    pub start_lng: Option<f64>,
    pub end_lat: Option<f64>,
    pub end_lng: Option<f64>,
    pub points: Vec<ApiPoint>,
}

fn is_finite_opt(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite())
}

/// buildClipsForApiDrive: dense provider paths, falling back to the summary
/// endpoints when the API omits path points.
pub fn build_clips_for_api_drive(drive: &ApiDrive, source: &str) -> Result<Built, String> {
    let mut pts: Vec<Pt> = drive
        .points
        .iter()
        .filter_map(|p| {
            let (lat, lng) = (is_finite_opt(p.latitude)?, is_finite_opt(p.longitude)?);
            Some(Pt {
                lat,
                lng,
                // Path timestamps are Unix seconds unless already ms.
                time_ms: if p.timestamp > 1e12 { p.timestamp } else { p.timestamp * 1000.0 },
                speed_mps: p.speed.filter(|s| s.is_finite()).map_or(0.0, |s| s * MPH_TO_MPS),
                gear: 1,
                ap_state: p.ap_state,
            })
        })
        .collect();
    v8_sort_by_key(&mut pts, |p| p.time_ms);

    if pts.len() < 2 {
        let fin = |v: Option<f64>| v.filter(|x| x.is_finite());
        let mut fallback = Vec::new();
        let endpoint = |lat: f64, lng: f64, t: f64| Pt { lat, lng, time_ms: t, speed_mps: 0.0, gear: 1, ap_state: 0 };
        if let (Some(lat), Some(lng), Some(t)) = (drive.start_lat, drive.start_lng, fin(drive.started_at)) {
            fallback.push(endpoint(lat, lng, t));
        }
        if let (Some(lat), Some(lng), Some(t)) = (drive.end_lat, drive.end_lng, fin(drive.ended_at)) {
            fallback.push(endpoint(lat, lng, t));
        }
        if fallback.len() < 2 {
            return Ok(Built::Skip("no-points"));
        }
        pts.extend(fallback);
    }
    let meta = ClipMeta {
        signature: external_signature(drive.started_at.unwrap_or(0.0), &drive.starting_odometer, source)?,
        source,
        autopilot_percent: autopilot_percent(drive.distance_mi, drive.autopilot_distance_mi),
    };
    let clips = split_into_clips(&pts, &meta);
    if clips.is_empty() {
        return Ok(Built::Skip("no-clips"));
    }
    Ok(Built::Clips { clips, point_count: pts.len() })
}

// ── Overlap detection ──────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Range {
    pub start: f64,
    pub end: f64,
    pub source: String,
}

/// buildExistingDriveRanges over grouped drives (naive SEI timestamps parse
/// in local time, matching the converted provider epochs).
pub fn build_existing_drive_ranges(drives: &[GroupedDrive]) -> Vec<Range> {
    let mut ranges: Vec<Range> = drives
        .iter()
        .filter(|d| !d.start_time.is_empty() && !d.end_time.is_empty())
        .filter_map(|d| {
            Some(Range { start: parse_local_iso(&d.start_time)? as f64, end: parse_local_iso(&d.end_time)? as f64, source: d.source.clone() })
        })
        .collect();
    ranges.sort_by(|a, b| a.start.total_cmp(&b.start));
    ranges
}

/// hasOverlap after widening to the synthetic clips' minute boundaries.
pub fn has_overlap(started_at: f64, ended_at: f64, ranges: &[Range]) -> bool {
    let start = (started_at / 60000.0).floor() * 60000.0;
    let end = (ended_at / 60000.0).ceil() * 60000.0;
    for r in ranges {
        if r.end <= start {
            continue;
        }
        if r.start >= end {
            break;
        }
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_and_suffix() {
        let sig = external_signature(1_721_052_000_000.0, &Odo::Num(12345.675), "tessie").unwrap();
        assert_eq!(sig, "tessie:28684200:12345.67");
        assert_eq!(signature_to_filename_suffix(&sig), "286842001234567");
        assert_eq!(external_signature(0.0, &Odo::Missing, "teslascope").unwrap(), "teslascope:0:x");
        assert!(external_signature(0.0, &Odo::Other, "tessie").is_err());
        assert_eq!(external_signature(f64::NAN, &Odo::Missing, "tessie").unwrap(), "tessie:NaN:x");
    }

    #[test]
    fn overlap_widens_to_minutes() {
        let ranges = vec![Range { start: 120_000.0, end: 180_000.0, source: "sei".into() }];
        assert!(has_overlap(170_000.0, 200_000.0, &ranges));
        assert!(!has_overlap(180_000.0, 230_000.0, &ranges));
        // ceil(119 000) = 120 000: touching the range is not an overlap.
        assert!(!has_overlap(60_500.0, 119_000.0, &ranges));
    }
}
