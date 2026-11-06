//! Route (one dashcam clip) model, clip-path helpers and the event-folder
//! gap-fill selection the grouper relies on.
//!
//! A route is parsed leniently from drive-data.json (`RouteJson`, which accepts
//! anything the JavaScript build tolerated) into a compact typed `Route` that is
//! stored in the SQLite index with bincode.

use base64::Engine;
use chrono::{Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone};
use serde::de::{self, Deserializer, IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::calc::{self, ApRun, FlagRun, GearRun};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Route {
    pub file: String,
    pub date: Option<String>,
    pub points: Vec<[f64; 2]>,
    pub gear_states: Option<Vec<u8>>,
    pub autopilot_states: Option<Vec<u8>>,
    pub speeds: Option<Vec<f64>>,
    pub accel_positions: Option<Vec<f64>>,
    pub raw_park_count: Option<f64>,
    pub raw_frame_count: Option<f64>,
    pub gear_runs: Option<Vec<GearRun>>,
    pub flag_runs: Option<Vec<FlagRun>>,
    pub ap_runs: Option<Vec<ApRun>>,
    pub source: Option<String>,
    pub external_signature: Option<String>,
    pub tessie_autopilot_percent: Option<f64>,
    pub telemetry: Telemetry,
}

/// BLE telemetry fields carried on a route (inputs to the telemetry roll-up).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Telemetry {
    pub battery_pct_start: Option<f64>,
    pub battery_pct_end: Option<f64>,
    pub interior_temp_min: Option<f64>,
    pub interior_temp_max: Option<f64>,
    pub exterior_temp_avg: Option<f64>,
    pub hvac_runtime_s: Option<f64>,
    pub tire_fl_psi: Option<f64>,
    pub tire_fr_psi: Option<f64>,
    pub tire_rl_psi: Option<f64>,
    pub tire_rr_psi: Option<f64>,
    pub odometer_mi_start: Option<f64>,
    pub odometer_mi_end: Option<f64>,
    /// Location labels are copied verbatim (any JSON value) in the JS build.
    pub location_name_start: Option<String>,
    pub location_name_end: Option<String>,
}

// ── Lenient JSON shape ──────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RouteJson {
    #[serde(deserialize_with = "lenient_string")]
    file: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    date: Option<String>,
    #[serde(deserialize_with = "lenient_points")]
    points: Vec<[f64; 2]>,
    #[serde(deserialize_with = "lenient_bytes")]
    gear_states: Option<Vec<u8>>,
    #[serde(deserialize_with = "lenient_bytes")]
    autopilot_states: Option<Vec<u8>>,
    #[serde(deserialize_with = "lenient_f64_vec")]
    speeds: Option<Vec<f64>>,
    #[serde(deserialize_with = "lenient_f64_vec")]
    accel_positions: Option<Vec<f64>>,
    #[serde(deserialize_with = "lenient_f64")]
    raw_park_count: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    raw_frame_count: Option<f64>,
    #[serde(deserialize_with = "lenient_vec")]
    gear_runs: Option<Vec<GearRun>>,
    #[serde(deserialize_with = "lenient_vec")]
    flag_runs: Option<Vec<FlagRun>>,
    #[serde(deserialize_with = "lenient_vec")]
    ap_runs: Option<Vec<ApRun>>,
    #[serde(deserialize_with = "lenient_string")]
    source: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    external_signature: Option<String>,
    #[serde(deserialize_with = "lenient_f64")]
    tessie_autopilot_percent: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    battery_pct_start: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    battery_pct_end: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    interior_temp_min: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    interior_temp_max: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    exterior_temp_avg: Option<f64>,
    #[serde(deserialize_with = "lenient_f64", rename = "hvacRuntimeS")]
    hvac_runtime_s: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    tire_fl_psi: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    tire_fr_psi: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    tire_rl_psi: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    tire_rr_psi: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    odometer_mi_start: Option<f64>,
    #[serde(deserialize_with = "lenient_f64")]
    odometer_mi_end: Option<f64>,
    #[serde(deserialize_with = "lenient_string")]
    location_name_start: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    location_name_end: Option<String>,
}

impl RouteJson {
    pub fn into_route(self) -> Route {
        Route {
            file: self.file.unwrap_or_default(),
            date: self.date,
            points: self.points,
            gear_states: self.gear_states,
            autopilot_states: self.autopilot_states,
            speeds: self.speeds,
            accel_positions: self.accel_positions,
            raw_park_count: self.raw_park_count,
            raw_frame_count: self.raw_frame_count,
            gear_runs: self.gear_runs,
            flag_runs: self.flag_runs,
            ap_runs: self.ap_runs,
            source: self.source,
            external_signature: self.external_signature.filter(|s| !s.is_empty()),
            tessie_autopilot_percent: self.tessie_autopilot_percent,
            telemetry: Telemetry {
                battery_pct_start: self.battery_pct_start,
                battery_pct_end: self.battery_pct_end,
                interior_temp_min: self.interior_temp_min,
                interior_temp_max: self.interior_temp_max,
                exterior_temp_avg: self.exterior_temp_avg,
                hvac_runtime_s: self.hvac_runtime_s,
                tire_fl_psi: self.tire_fl_psi,
                tire_fr_psi: self.tire_fr_psi,
                tire_rl_psi: self.tire_rl_psi,
                tire_rr_psi: self.tire_rr_psi,
                odometer_mi_start: self.odometer_mi_start,
                odometer_mi_end: self.odometer_mi_end,
                location_name_start: self.location_name_start,
                location_name_end: self.location_name_end,
            },
        }
    }
}

fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => Some(s),
        _ => None,
    })
}

fn lenient_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        _ => None,
    })
}

fn lenient_vec<'de, D: Deserializer<'de>, T: serde::de::DeserializeOwned>(d: D) -> Result<Option<Vec<T>>, D::Error> {
    let v = Value::deserialize(d)?;
    match v {
        Value::Array(items) => Ok(Some(
            items.into_iter().filter_map(|item| serde_json::from_value(item).ok()).collect(),
        )),
        _ => Ok(None),
    }
}

/// Numeric arrays. `null` entries read as 0, matching how the grouper's
/// arithmetic treats them.
fn lenient_f64_vec<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<f64>>, D::Error> {
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = Option<Vec<f64>>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("number array")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(64));
            while let Some(v) = seq.next_element::<Option<f64>>()? {
                out.push(v.unwrap_or(0.0));
            }
            Ok(Some(out))
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
        fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> { Ok(None) }
        fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> { Ok(None) }
        fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> { Ok(None) }
        fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> { Ok(None) }
        fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> { Ok(None) }
        fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    }
    d.deserialize_any(V)
}

/// `[[lat, lng, ...], ...]` — only the first two numbers of each point matter.
fn lenient_points<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<[f64; 2]>, D::Error> {
    struct Pt;
    impl<'de> Visitor<'de> for Pt {
        type Value = Option<[f64; 2]>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("point")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let a = seq.next_element::<Option<f64>>()?.flatten();
            let b = seq.next_element::<Option<f64>>()?.flatten();
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(match (a, b) {
                (Some(a), Some(b)) => Some([a, b]),
                _ => Some([a.unwrap_or(f64::NAN), b.unwrap_or(f64::NAN)]),
            })
        }
    }
    struct PtSeed;
    impl<'de> de::DeserializeSeed<'de> for PtSeed {
        type Value = Option<[f64; 2]>;
        fn deserialize<D2: Deserializer<'de>>(self, d: D2) -> Result<Self::Value, D2::Error> {
            d.deserialize_seq(Pt)
        }
    }
    struct Pts;
    impl<'de> Visitor<'de> for Pts {
        type Value = Vec<[f64; 2]>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("point array")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(256));
            while let Some(p) = seq.next_element_seed(PtSeed)? {
                if let Some(p) = p {
                    out.push(p);
                }
            }
            Ok(out)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(Vec::new()) }
    }
    d.deserialize_any(Pts)
}

/// Go serializes `[]uint8` as base64; older/other writers use number arrays.
fn lenient_bytes<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(s.as_bytes())
                .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(s.trim_end_matches('=').as_bytes()))
                .unwrap_or_default(),
        ),
        Value::Array(items) => Some(items.iter().map(|v| v.as_f64().unwrap_or(0.0) as u8).collect()),
        _ => None,
    })
}

// ── Clip paths ──────────────────────────────────────────────────────────────

pub fn normalize_clip_path(file: &str) -> String {
    let normalized = file.replace('\\', "/");
    match normalized.strip_prefix("RecentClips/") {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => normalized,
    }
}

pub fn is_event_folder_path(file: &str) -> bool {
    let n = normalize_clip_path(file);
    n.starts_with("SavedClips/") || n.starts_with("SentryClips/")
}

/// `YYYY-MM-DD_HH-MM-SS` in the clip basename, interpreted in this machine's
/// local zone exactly like `new Date("YYYY-MM-DDTHH:MM:SS")`.
pub fn parse_clip_timestamp_ms(file: &str) -> Option<i64> {
    let normalized = normalize_clip_path(file);
    let name = match normalized.rfind('/') {
        Some(i) => &normalized[i + 1..],
        None => &normalized[..],
    };
    let b = name.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let digit = |c: u8| c.is_ascii_digit();
    for i in 0..=b.len() - 19 {
        let w = &b[i..i + 19];
        let shape = w[..4].iter().all(|&c| digit(c))
            && w[4] == b'-' && digit(w[5]) && digit(w[6])
            && w[7] == b'-' && digit(w[8]) && digit(w[9])
            && w[10] == b'_' && digit(w[11]) && digit(w[12])
            && w[13] == b'-' && digit(w[14]) && digit(w[15])
            && w[16] == b'-' && digit(w[17]) && digit(w[18]);
        if !shape {
            continue;
        }
        let num = |s: &[u8]| std::str::from_utf8(s).ok()?.parse::<u32>().ok();
        let (y, mo, d) = (num(&w[0..4])? as i32, num(&w[5..7])?, num(&w[8..10])?);
        let (h, mi, s) = (num(&w[11..13])?, num(&w[14..16])?, num(&w[17..19])?);
        return local_ms(y, mo, d, h, mi, s);
    }
    None
}

fn local_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> Option<i64> {
    // ECMAScript accepts T24:00:00 as midnight of the next day.
    let (date, h) = if h == 24 && mi == 0 && s == 0 {
        (NaiveDate::from_ymd_opt(y, mo, d)?.succ_opt()?, 0)
    } else {
        (NaiveDate::from_ymd_opt(y, mo, d)?, h)
    };
    let naive = date.and_hms_opt(h, mi, s)?;
    Some(local_naive_to_ms(naive))
}

/// ECMAScript LocalTime->UTC: ambiguous times take the earlier instant;
/// times in a spring-forward gap use the offset in effect before the gap.
pub fn local_naive_to_ms(naive: NaiveDateTime) -> i64 {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(t) => t.timestamp_millis(),
        LocalResult::Ambiguous(a, b) => a.timestamp_millis().min(b.timestamp_millis()),
        LocalResult::None => {
            let before = naive - chrono::Duration::hours(3);
            let offset = match Local.from_local_datetime(&before) {
                LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t.offset().local_minus_utc() as i64,
                LocalResult::None => 0,
            };
            naive.and_utc().timestamp_millis() - offset * 1000
        }
    }
}

/// `formatISO`: local wall clock, second precision, no zone.
pub fn format_local_iso(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t.format("%Y-%m-%dT%H:%M:%S").to_string(),
        LocalResult::None => String::new(),
    }
}

/// `Date.parse` of a `formatISO` string (local time). NaN-equivalent is None.
pub fn parse_local_iso(s: &str) -> Option<i64> {
    let naive = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok()?;
    Some(local_naive_to_ms(naive))
}

// ── Event-folder gap fill ───────────────────────────────────────────────────

pub fn telemetry_has_driving(route: &Route) -> bool {
    if let Some(runs) = &route.gear_runs {
        if runs.iter().any(|r| r.gear != Some(calc::GEAR_PARK)) {
            return true;
        }
    }
    let gear_states: &[u8] = route.gear_states.as_deref().unwrap_or(&[]);
    if gear_states.iter().any(|&g| g as i64 != calc::GEAR_PARK) {
        return true;
    }
    let runs_empty = route.gear_runs.as_ref().is_none_or(|r| r.is_empty());
    if runs_empty && gear_states.is_empty() {
        if let Some(frames) = route.raw_frame_count {
            // Number(undefined) is NaN, and NaN < frames is false.
            if frames > 0.0 && route.raw_park_count.is_some_and(|p| p < frames) {
                return true;
            }
        }
    }
    if let Some(speeds) = &route.speeds {
        if speeds.iter().any(|s| s.abs() > calc::GAP_FILL_MIN_SPEED_MPS) {
            return true;
        }
    }
    false
}

pub struct GapCandidate {
    pub timestamp_ms: i64,
    pub file: String,
    pub driving: bool,
}

fn partition_point(values: &[i64], pred: impl Fn(i64) -> bool) -> usize {
    values.partition_point(|&v| pred(v))
}

fn fillable_holes(recent: &[i64]) -> Vec<(i64, i64)> {
    let mut holes = Vec::new();
    for i in 1..recent.len() {
        let gap = recent[i] - recent[i - 1];
        if gap > calc::GAP_FILL_MIN_MS && gap <= calc::GAP_FILL_MAX_MS {
            holes.push((recent[i - 1], recent[i]));
        }
    }
    holes
}

fn deduplicate(recent: &[i64], candidates: &[GapCandidate], eligible: Vec<usize>) -> Vec<usize> {
    let mut not_occupied: Vec<usize> = eligible
        .into_iter()
        .filter(|&ci| {
            let ts = candidates[ci].timestamp_ms;
            let ins = partition_point(recent, |r| r <= ts);
            ins == 0 || ts - recent[ins - 1] > calc::GAP_FILL_DUP_MS
        })
        .collect();
    not_occupied.sort_by(|&l, &r| {
        let (a, b) = (&candidates[l], &candidates[r]);
        a.timestamp_ms.cmp(&b.timestamp_ms).then_with(|| a.file.as_bytes().cmp(b.file.as_bytes()))
    });
    let mut kept: Vec<usize> = Vec::new();
    for ci in not_occupied {
        if let Some(&prev) = kept.last() {
            if candidates[ci].timestamp_ms - candidates[prev].timestamp_ms <= calc::GAP_FILL_DUP_MS {
                continue;
            }
        }
        kept.push(ci);
    }
    kept
}

/// Indices of the candidates admitted to fill RecentClips holes.
pub fn select_gap_fill(recent: &[i64], candidates: &[GapCandidate]) -> Vec<usize> {
    if recent.is_empty() || candidates.is_empty() {
        return Vec::new();
    }
    let holes = fillable_holes(recent);
    let eligible: Vec<usize> = (0..candidates.len()).filter(|&i| candidates[i].driving).collect();
    let kept = deduplicate(recent, candidates, eligible);

    let nearest_recent = |ts: i64| -> f64 {
        let ins = partition_point(recent, |r| r < ts);
        let mut best = f64::INFINITY;
        if ins > 0 {
            best = best.min((ts - recent[ins - 1]) as f64);
        }
        if ins < recent.len() {
            best = best.min((recent[ins] - ts) as f64);
        }
        best
    };

    // (timestamp, keptIndex) merged and stably sorted by timestamp.
    let mut merged: Vec<(i64, Option<usize>)> = recent.iter().map(|&t| (t, None)).collect();
    merged.extend(kept.iter().enumerate().map(|(ki, &ci)| (candidates[ci].timestamp_ms, Some(ki))));
    merged.sort_by_key(|e| e.0);

    let mut chained = vec![false; kept.len()];
    let mut cluster_start = 0;
    for index in 0..=merged.len() {
        let ends = index == merged.len()
            || (index > 0 && merged[index].0 - merged[index - 1].0 > calc::GAP_FILL_ADJ_MS);
        if !ends {
            continue;
        }
        let cluster = &merged[cluster_start..index];
        if cluster.iter().any(|e| e.1.is_none()) {
            for e in cluster {
                if let Some(ki) = e.1 {
                    if nearest_recent(e.0) <= calc::GAP_FILL_MAX_MS as f64 {
                        chained[ki] = true;
                    }
                }
            }
        }
        cluster_start = index;
    }

    kept.iter()
        .enumerate()
        .filter(|&(ki, &ci)| {
            let ts = candidates[ci].timestamp_ms;
            holes.iter().any(|&(s, e)| s < ts && ts < e) || chained[ki]
        })
        .map(|(_, &ci)| ci)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_recentclips_prefix_and_backslashes() {
        assert_eq!(normalize_clip_path("RecentClips\\2026-05-05\\a.mp4"), "2026-05-05/a.mp4");
        assert_eq!(normalize_clip_path("RecentClips/"), "RecentClips/");
        assert!(is_event_folder_path("RecentClips/SavedClips/x/2026-05-05_15-54-00-front.mp4"));
    }

    #[test]
    fn parses_and_formats_local_timestamps_round_trip() {
        let ms = parse_clip_timestamp_ms("2026-05-05/2026-05-05_15-54-00-front.mp4").unwrap();
        assert_eq!(format_local_iso(ms), "2026-05-05T15:54:00");
        assert!(parse_clip_timestamp_ms("nope.mp4").is_none());
        assert!(parse_clip_timestamp_ms("2026-13-05_15-54-00-front.mp4").is_none());
    }

    // ── Clip-path and gap-fill tests. Expected epochs come from `parse_local_iso`,
    // the same local-zone rule as `new Date("YYYY-MM-DDTHH:MM:SS")`, so these
    // assertions hold in any time zone.

    use serde_json::json;

    fn ms(s: &str) -> i64 {
        parse_local_iso(s).expect("valid local time")
    }

    fn route_json(v: Value) -> Route {
        serde_json::from_value::<RouteJson>(v).expect("route json").into_route()
    }

    fn cand(ts: &str, file: &str, driving: bool) -> GapCandidate {
        GapCandidate { timestamp_ms: ms(ts), file: file.into(), driving }
    }

    #[test]
    fn normalize_clip_path_canonicalizes_only_a_leading_recentclips_component() {
        assert_eq!(
            normalize_clip_path("RecentClips\\2026-07-27\\2026-07-27_14-01-02-front.mp4"),
            "2026-07-27/2026-07-27_14-01-02-front.mp4"
        );
        assert_eq!(
            normalize_clip_path("2026-07-27/2026-07-27_14-01-02-front.mp4"),
            "2026-07-27/2026-07-27_14-01-02-front.mp4"
        );
        assert_eq!(
            normalize_clip_path("SavedClips/2026-07-27_14-12-29/clip-front.mp4"),
            "SavedClips/2026-07-27_14-12-29/clip-front.mp4"
        );
        assert_eq!(normalize_clip_path("MyRecentClips/clip-front.mp4"), "MyRecentClips/clip-front.mp4");
        assert_eq!(normalize_clip_path("RecentClips/"), "RecentClips/");
    }

    #[test]
    fn clip_timestamp_parsing_uses_the_final_filename_component() {
        assert_eq!(
            parse_clip_timestamp_ms("SavedClips/2026-07-27_14-12-29/2026-07-27_14-02-02-front.mp4"),
            Some(ms("2026-07-27T14:02:02"))
        );
        assert_eq!(parse_clip_timestamp_ms("2026-07-27/2026-07-27_14-01-02-front.mp4"), Some(ms("2026-07-27T14:01:02")));
        assert_eq!(parse_clip_timestamp_ms("SavedClips/no-time/front.mp4"), None);
        assert_eq!(parse_clip_timestamp_ms("SavedClips/no-timestamp/front.mp4"), None);
        // The event folder's own (later) timestamp is ignored.
        assert_eq!(
            parse_clip_timestamp_ms("SentryClips/2026-05-17_18-46-39/2026-05-17_18-35-39-front.mp4"),
            Some(ms("2026-05-17T18:35:39"))
        );
        assert_eq!(
            parse_clip_timestamp_ms("SavedClips\\2026-05-17_18-47-59\\2026-05-17_18-47-34-front.mp4"),
            Some(ms("2026-05-17T18:47:34"))
        );
        assert_eq!(
            parse_clip_timestamp_ms("RecentClips/2026-05-17/2026-05-17_18-47-34-front.mp4"),
            Some(ms("2026-05-17T18:47:34"))
        );
        assert_eq!(parse_clip_timestamp_ms("SentryClips/2026-05-17_18-46-39/event.json"), None);
    }

    #[test]
    fn event_folder_recognition_is_top_level_only_and_survives_normalization() {
        assert!(is_event_folder_path("SavedClips\\event\\clip-front.mp4"));
        assert!(is_event_folder_path("SentryClips/event/clip-front.mp4"));
        assert!(!is_event_folder_path("RecentClips/event/clip-front.mp4"));
        assert!(is_event_folder_path("SavedClips/event/clip.mp4"));
        assert!(is_event_folder_path("SentryClips\\event\\clip.mp4"));
        assert!(!is_event_folder_path("foo/SavedClips/event/clip.mp4"));
        assert!(!is_event_folder_path("RecentClips/clip.mp4"));
        assert!(is_event_folder_path("SavedClips/2026-05-17_18-47-59/2026-05-17_18-47-34-front.mp4"));
        assert!(is_event_folder_path("SentryClips/2026-05-17_18-46-39/2026-05-17_18-35-39-front.mp4"));
        assert!(is_event_folder_path("SavedClips\\2026-05-17_18-47-59\\2026-05-17_18-47-34-front.mp4"));
        assert!(is_event_folder_path("SentryClips\\foo\\bar-front.mp4"));
        assert!(!is_event_folder_path("RecentClips/2026-05-17/2026-05-17_18-47-34-front.mp4"));
        assert!(!is_event_folder_path("2026-05-17/2026-05-17_18-47-34-front.mp4"));
        assert!(!is_event_folder_path("2026-05-17\\2026-05-17_18-47-34-front.mp4"));
        assert!(!is_event_folder_path(""));
        assert!(!is_event_folder_path("foo/SavedClips/x.mp4"));
        assert!(!is_event_folder_path("MySavedClips/x.mp4"));
    }

    #[test]
    fn telemetry_has_driving_requires_gear_legacy_frame_or_speed_evidence() {
        assert!(telemetry_has_driving(&route_json(json!({ "gearRuns": [{ "gear": 1, "frames": 60 }] }))));
        // Go's base64 []uint8 encoding of [0, 1].
        assert!(telemetry_has_driving(&route_json(json!({ "gearStates": "AAE=" }))));
        assert!(!telemetry_has_driving(&route_json(json!({
            "gearRuns": [{ "gear": 0, "frames": 60 }],
            "gearStates": [0, 0],
            "speeds": [0, 0.2],
            "rawParkCount": 60,
            "rawFrameCount": 60,
        }))));
        assert!(telemetry_has_driving(&route_json(json!({ "speeds": [-2] }))));
        assert!(telemetry_has_driving(&route_json(json!({ "rawParkCount": 40, "rawFrameCount": 60 }))));
        assert!(!telemetry_has_driving(&route_json(json!({}))));

        assert!(telemetry_has_driving(&route_json(json!({
            "gearRuns": [{ "gear": 0, "frames": 30 }, { "gear": 1, "frames": 30 }],
        }))));
        assert!(!telemetry_has_driving(&route_json(json!({
            "gearRuns": [{ "gear": 0, "frames": 30 }],
            "gearStates": vec![0; 60],
            "speeds": vec![0; 60],
            "rawParkCount": 60,
            "rawFrameCount": 60,
        }))));
        assert!(telemetry_has_driving(&route_json(json!({
            "gearRuns": [{ "gear": 0, "frames": 30 }],
            "speeds": [-2.0],
        }))));
        assert!(!telemetry_has_driving(&route_json(json!({ "speeds": [0.2] }))));
        // rawFrameCount alone does not establish driving telemetry.
        assert!(!telemetry_has_driving(&route_json(json!({ "rawFrameCount": 60 }))));
    }

    #[test]
    fn fillable_holes_are_over_90s_and_at_most_30min_with_strict_interiors() {
        let seq = [
            ms("2026-06-01T10:00:00"),
            ms("2026-06-01T10:01:00"),
            ms("2026-06-01T10:04:00"),
            ms("2026-06-01T10:05:00"),
            ms("2026-06-01T10:11:00"),
            ms("2026-06-01T10:46:00"),
        ];
        assert_eq!(
            fillable_holes(&seq),
            vec![
                (ms("2026-06-01T10:01:00"), ms("2026-06-01T10:04:00")),
                (ms("2026-06-01T10:05:00"), ms("2026-06-01T10:11:00")),
            ]
        );

        // Hole membership is inlined into select_gap_fill. Check it with a
        // 20-minute hole, which adjacency
        // chaining (3-minute hops) cannot bridge on its own.
        let recent = [ms("2026-06-01T10:00:00"), ms("2026-06-01T10:20:00")];
        let inside = [cand("2026-06-01T10:10:00", "SentryClips/e/a-front.mp4", true)];
        assert_eq!(select_gap_fill(&recent, &inside), vec![0]);
        let outside = [cand("2026-06-01T10:30:00", "SentryClips/e/a-front.mp4", true)];
        assert!(select_gap_fill(&recent, &outside).is_empty());
        // A 35-minute gap is not a hole.
        let long_gap = [ms("2026-06-01T10:11:00"), ms("2026-06-01T10:46:00")];
        let in_long_gap = [cand("2026-06-01T10:30:00", "SentryClips/e/a-front.mp4", true)];
        assert!(select_gap_fill(&long_gap, &in_long_gap).is_empty());
    }

    #[test]
    fn select_gap_fill_admits_an_interior_minute_and_suppresses_occupied_and_twin_rows() {
        let recent = [ms("2026-06-01T10:00:00"), ms("2026-06-01T10:02:00")];
        let candidates = [
            cand("2026-06-01T10:01:00", "SavedClips/event/2026-06-01_10-01-00-front.mp4", true),
            cand("2026-06-01T10:01:01", "SentryClips/event/2026-06-01_10-01-01-front.mp4", true),
            cand("2026-06-01T10:02:05", "SavedClips/event/2026-06-01_10-02-05-front.mp4", true),
            cand("2026-06-01T10:01:30", "SavedClips/event/2026-06-01_10-01-30-front.mp4", false),
        ];
        assert_eq!(select_gap_fill(&recent, &candidates), vec![0]);
    }

    #[test]
    fn select_gap_fill_admits_anchored_leading_and_trailing_chains() {
        let recent = [ms("2026-06-01T10:00:00")];
        let candidates = [
            cand("2026-06-01T09:58:10", "SavedClips/event/2026-06-01_09-58-10-front.mp4", true),
            cand("2026-06-01T09:59:10", "SavedClips/event/2026-06-01_09-59-10-front.mp4", true),
            cand("2026-06-01T10:01:01", "SavedClips/event/2026-06-01_10-01-01-front.mp4", true),
            cand("2026-06-01T10:02:02", "SavedClips/event/2026-06-01_10-02-02-front.mp4", true),
        ];
        assert_eq!(select_gap_fill(&recent, &candidates), vec![0, 1, 2, 3]);
    }

    #[test]
    fn select_gap_fill_rejects_parked_candidates_and_isolated_driving_clusters() {
        let recent = [ms("2026-06-01T10:00:00")];
        let candidates = [
            cand("2026-06-01T10:01:00", "SentryClips/event/2026-06-01_10-01-00-front.mp4", false),
            cand("2026-06-01T14:00:00", "SavedClips/event/2026-06-01_14-00-00-front.mp4", true),
            cand("2026-06-01T14:01:00", "SavedClips/event/2026-06-01_14-01-00-front.mp4", true),
        ];
        assert!(select_gap_fill(&recent, &candidates).is_empty());
    }

    #[test]
    fn select_gap_fill_twin_dedup_keeps_lowest_path_and_rejects_outside_holes() {
        // Candidates without telemetry are eligible (`driving: true` here).
        let recent = [ms("2026-06-01T10:00:00"), ms("2026-06-01T10:03:00")];
        let candidates = [
            cand("2026-06-01T10:01:00", "SentryClips/2026-06-01_10-02-30/2026-06-01_10-01-00-front.mp4", true),
            cand("2026-06-01T10:01:00", "SavedClips/2026-06-01_10-02-30/2026-06-01_10-01-00-front.mp4", true),
            cand("2026-06-01T10:02:00", "SentryClips/2026-06-01_10-02-30/2026-06-01_10-02-00-front.mp4", true),
            cand("2026-06-01T09:30:00", "SentryClips/2026-06-01_09-31-00/2026-06-01_09-30-00-front.mp4", true),
        ];
        let mut picked: Vec<&str> =
            select_gap_fill(&recent, &candidates).into_iter().map(|i| candidates[i].file.as_str()).collect();
        picked.sort();
        assert_eq!(
            picked,
            vec![
                "SavedClips/2026-06-01_10-02-30/2026-06-01_10-01-00-front.mp4",
                "SentryClips/2026-06-01_10-02-30/2026-06-01_10-02-00-front.mp4",
            ]
        );
    }

    #[test]
    fn select_gap_fill_chain_hop_window_and_30min_cap() {
        let recent = [ms("2026-06-01T10:00:00")];
        let chain = [
            cand("2026-06-01T10:01:01", "SentryClips/e/a-front.mp4", true),
            cand("2026-06-01T10:02:02", "SentryClips/e/b-front.mp4", true),
            cand("2026-06-01T10:04:34", "SentryClips/e/c-front.mp4", true),
            cand("2026-06-01T10:07:00", "SentryClips/e/d-front.mp4", true),
            cand("2026-06-01T10:12:00", "SentryClips/e/e-front.mp4", true),
        ];
        assert_eq!(select_gap_fill(&recent, &chain), vec![0, 1, 2, 3]);

        // The 30-minute cap is measured from the chain anchor.
        let long: Vec<GapCandidate> = (0..35)
            .map(|k| GapCandidate {
                timestamp_ms: recent[0] + (k + 1) * 61_000,
                file: format!("SentryClips/e/clip{k:02}-front.mp4"),
                driving: true,
            })
            .collect();
        let picked = select_gap_fill(&recent, &long);
        assert!(!picked.is_empty() && picked.len() < long.len());
        for i in picked {
            assert!(long[i].timestamp_ms - recent[0] <= 30 * 60 * 1000, "{} exceeds the cap", long[i].file);
        }
    }

    #[test]
    fn select_gap_fill_rejects_occupied_slot_twins_overlap_dups_and_parked() {
        let recent = [ms("2026-07-04T20:43:50"), ms("2026-07-04T20:44:50")];
        let candidates = [
            cand("2026-07-04T20:44:51", "SentryClips/e/2026-07-04_20-44-51-front.mp4", true),
            cand("2026-07-04T20:45:51", "SentryClips/e/2026-07-04_20-45-51-front.mp4", true),
            cand("2026-07-04T20:46:11", "SavedClips/e2/2026-07-04_20-46-11-front.mp4", true),
        ];
        assert_eq!(select_gap_fill(&recent, &candidates), vec![1]);

        let parked = [cand("2026-07-04T20:45:51", "SentryClips/e/2026-07-04_20-45-51-front.mp4", false)];
        assert!(select_gap_fill(&recent, &parked).is_empty());
    }
}
