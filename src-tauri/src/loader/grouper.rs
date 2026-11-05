//! Port of `src/processing/grouper.js` `groupIntoDrives` and its helpers, plus
//! `src/shared/drive-telemetry.cjs`. Follows the JavaScript control flow line
//! for line; comments only note where JS semantics needed care.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use super::calc::{self, js_round, round2, ClipEvidence};
use super::route::{self, format_local_iso, normalize_clip_path, parse_clip_timestamp_ms, GapCandidate, Route};

/// A route being grouped: the stored route plus grouping-time annotations.
#[derive(Clone)]
struct Clip {
    r: Route,
    source: String,
    timestamp_ms: i64,
    clip_span_ms: Option<f64>,
    sub_clip_frames: Option<SubClip>,
}

#[derive(Clone, Copy)]
struct SubClip {
    start_frame: f64,
    end_frame: f64,
    total_frames: f64,
}

pub struct GroupedDrive {
    pub start_time: String,
    pub end_time: String,
    pub source: String,
    pub summon: bool,
    pub route_files: Vec<String>,
    /// Summary fields in grouper.js order, without points/fsdStates/gearStates/fsdEvents.
    pub fields: Map<String, Value>,
    /// Detail: [lat, lng, timeMs, speed] per point.
    pub points: Vec<[f64; 4]>,
    pub fsd_states: Option<Vec<i64>>,
    pub gear_states: Option<Vec<i64>>,
    pub fsd_events: Option<Vec<Value>>,
}

pub struct GroupResult {
    pub drives: Vec<GroupedDrive>,
    pub time_group_count: usize,
    pub route_count: usize,
    pub dropped_count: usize,
}

fn clip_span_of(c: &Clip) -> f64 {
    match c.clip_span_ms {
        Some(span) if span > 0.0 && span <= calc::CLIP_DURATION_MS => span,
        _ => calc::CLIP_DURATION_MS,
    }
}

/// Date arithmetic truncates fractional milliseconds (TimeClip).
fn date_ms(v: f64) -> i64 {
    v.trunc() as i64
}

pub fn group_into_drives(routes: Vec<Route>) -> GroupResult {
    let input_len = routes.len();
    let mut seen: HashSet<String> = HashSet::new();
    let mut unique: Vec<Route> = Vec::new();
    let mut event_candidates: Vec<Route> = Vec::new();
    for mut r in routes {
        let norm = normalize_clip_path(&r.file);
        if !seen.insert(norm.clone()) {
            continue;
        }
        r.file = norm;
        if route::is_event_folder_path(&r.file) {
            event_candidates.push(r);
            continue;
        }
        unique.push(r);
    }

    let mut timed: Vec<Clip> = Vec::new();
    for r in unique {
        if let Some(t) = parse_clip_timestamp_ms(&r.file) {
            let source = r.source.clone().unwrap_or_else(|| "sei".into());
            timed.push(Clip { r, source, timestamp_ms: t, clip_span_ms: None, sub_clip_frames: None });
        }
    }
    if timed.is_empty() {
        return GroupResult { drives: Vec::new(), time_group_count: 0, route_count: 0, dropped_count: input_len };
    }
    timed.sort_by_key(|c| c.timestamp_ms);

    if !event_candidates.is_empty() {
        let mut candidates: Vec<GapCandidate> = Vec::new();
        let mut candidate_routes: Vec<Route> = Vec::new();
        for r in event_candidates {
            let Some(ts) = parse_clip_timestamp_ms(&r.file) else { continue };
            candidates.push(GapCandidate { timestamp_ms: ts, file: r.file.clone(), driving: route::telemetry_has_driving(&r) });
            candidate_routes.push(r);
        }
        let recent: Vec<i64> = timed.iter().map(|c| c.timestamp_ms).collect();
        for ci in route::select_gap_fill(&recent, &candidates) {
            let r = candidate_routes[ci].clone();
            let source = r.source.clone().unwrap_or_else(|| "sei".into());
            timed.push(Clip { r, source, timestamp_ms: candidates[ci].timestamp_ms, clip_span_ms: None, sub_clip_frames: None });
        }
        timed.sort_by_key(|c| c.timestamp_ms);
    }

    annotate_clip_spans(&mut timed);

    let mut time_groups: Vec<Vec<Clip>> = Vec::new();
    let mut current: Vec<Clip> = Vec::new();
    for c in timed.iter().cloned() {
        if let Some(last) = current.last() {
            if c.timestamp_ms - last.timestamp_ms > calc::DRIVE_GAP_MS {
                time_groups.push(std::mem::take(&mut current));
            }
        }
        current.push(c);
    }
    time_groups.push(current);
    let time_group_count = time_groups.len();
    let route_count = timed.len();
    drop(timed);

    let mut groups: Vec<Vec<Clip>> = Vec::new();
    for tg in time_groups {
        for gear_group in split_by_gear_state(tg) {
            groups.extend(split_by_external_signature(gear_group));
        }
    }

    let drives = groups.into_iter().map(build_drive_stats).collect();
    GroupResult { drives, time_group_count, route_count, dropped_count: input_len - route_count }
}

fn annotate_clip_spans(sorted: &mut [Clip]) {
    let native: Vec<usize> = (0..sorted.len())
        .filter(|&i| sorted[i].source == "sei" && !sorted[i].r.file.contains("-front-bridge.mp4"))
        .collect();
    for w in native.windows(2) {
        let gap = (sorted[w[1]].timestamp_ms - sorted[w[0]].timestamp_ms) as f64;
        if gap > 0.0 && gap <= calc::CLIP_DURATION_MS {
            sorted[w[0]].clip_span_ms = Some(gap);
        }
    }
}

fn split_by_external_signature(group: Vec<Clip>) -> Vec<Vec<Clip>> {
    if group.len() <= 1 || !group.iter().any(|c| c.r.external_signature.is_some()) {
        return vec![group];
    }
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<Clip>> = HashMap::new();
    let mut no_sig: Vec<Clip> = Vec::new();
    for clip in group {
        match clip.r.external_signature.clone() {
            None => no_sig.push(clip),
            Some(sig) => {
                if !buckets.contains_key(&sig) {
                    order.push(sig.clone());
                }
                buckets.entry(sig).or_default().push(clip);
            }
        }
    }
    let mut result = Vec::new();
    if !no_sig.is_empty() {
        result.push(no_sig);
    }
    for sig in order {
        result.push(buckets.remove(&sig).unwrap_or_default());
    }
    result
}

fn has_runs(c: &Clip) -> bool {
    c.r.gear_runs.as_ref().is_some_and(|r| !r.is_empty())
}

fn split_by_gear_state(group: Vec<Clip>) -> Vec<Vec<Clip>> {
    if group.is_empty() {
        return Vec::new();
    }
    if !group.iter().any(has_runs) {
        return split_by_gear_state_legacy(group);
    }
    let mut result = Vec::new();
    let mut current: Vec<Clip> = Vec::new();
    for clip in group {
        if !has_runs(&clip) {
            current.push(clip);
            continue;
        }
        for seg in split_clip_at_park_gaps(clip) {
            match seg {
                None => {
                    if !current.is_empty() {
                        result.push(std::mem::take(&mut current));
                    }
                }
                Some(route) => {
                    if !route.r.points.is_empty() {
                        current.push(route);
                    }
                }
            }
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn slice_opt<T: Clone>(v: &Option<Vec<T>>, a: usize, b: usize) -> Option<Vec<T>> {
    // `clip.x ? clip.x.slice(a, b) : []` — absent arrays become empty arrays.
    Some(match v {
        Some(v) => v[a.min(v.len())..b.min(v.len())].to_vec(),
        None => Vec::new(),
    })
}

/// Returns segments; `None` marks a park gap.
fn split_clip_at_park_gaps(clip: Clip) -> Vec<Option<Clip>> {
    let runs = clip.r.gear_runs.clone().unwrap_or_default();
    let total_raw: f64 = runs.iter().map(|r| r.frames).sum();
    if total_raw == 0.0 {
        return vec![Some(clip)];
    }
    let n_points = clip.r.points.len();
    let seconds_per_frame = 60.0 / total_raw;

    struct Seg {
        start: f64,
        end: f64,
        parked: bool,
    }
    let mut raw = Vec::new();
    let mut frame = 0.0;
    for run in &runs {
        let duration = run.frames * seconds_per_frame;
        let parked = run.gear == Some(calc::GEAR_PARK) && duration >= calc::PARK_GAP_SECONDS;
        raw.push(Seg { start: frame, end: frame + run.frames, parked });
        frame += run.frames;
    }
    let mut merged: Vec<Seg> = Vec::new();
    for seg in raw {
        if let Some(last) = merged.last_mut() {
            if !last.parked && !seg.parked {
                last.end = seg.end;
                continue;
            }
        }
        merged.push(seg);
    }
    if !merged.iter().any(|s| s.parked) {
        return vec![Some(clip)];
    }

    let mut result = Vec::new();
    for seg in merged {
        if seg.parked {
            result.push(None);
            continue;
        }
        let start_frac = seg.start / total_raw;
        let end_frac = seg.end / total_raw;
        let np = n_points as f64;
        let mut start_idx = js_round(start_frac * np);
        let mut end_idx = js_round(end_frac * np);
        if start_idx >= np {
            start_idx = np - 1.0;
        }
        if end_idx > np {
            end_idx = np;
        }
        if start_idx < 0.0 {
            start_idx = 0.0;
        }
        if end_idx <= start_idx {
            end_idx = start_idx + 1.0;
        }
        if end_idx > np {
            continue;
        }
        let (a, b) = (start_idx as usize, end_idx as usize);
        let mut seg_clip = clip.clone();
        seg_clip.r.points = clip.r.points[a..b].to_vec();
        seg_clip.r.gear_states = slice_opt(&clip.r.gear_states, a, b);
        seg_clip.r.autopilot_states = slice_opt(&clip.r.autopilot_states, a, b);
        seg_clip.r.speeds = slice_opt(&clip.r.speeds, a, b);
        seg_clip.r.accel_positions = slice_opt(&clip.r.accel_positions, a, b);
        let offset_ms = start_frac * calc::CLIP_DURATION_MS;
        seg_clip.timestamp_ms = date_ms(clip.timestamp_ms as f64 + offset_ms);
        seg_clip.sub_clip_frames = Some(SubClip { start_frame: seg.start, end_frame: seg.end, total_frames: total_raw });
        result.push(Some(seg_clip));
    }
    result
}

fn split_by_gear_state_legacy(group: Vec<Clip>) -> Vec<Vec<Clip>> {
    if group.len() <= 1 {
        return vec![group];
    }
    if !group.iter().any(|c| c.r.gear_states.as_ref().is_some_and(|g| !g.is_empty())) {
        return vec![group];
    }
    let mut result = Vec::new();
    let mut current = Vec::new();
    for clip in group {
        if clip_is_mostly_parked_legacy(&clip) {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
        } else {
            current.push(clip);
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn clip_is_mostly_parked_legacy(c: &Clip) -> bool {
    if let Some(frames) = c.r.raw_frame_count {
        if frames > 0.0 {
            return match c.r.raw_park_count {
                Some(p) => p / frames > 0.5,
                None => false,
            };
        }
    }
    let Some(g) = &c.r.gear_states else { return false };
    if g.is_empty() {
        return false;
    }
    let park = g.iter().filter(|&&x| x as i64 == calc::GEAR_PARK).count() as f64;
    park > g.len() as f64 / 2.0
}

#[derive(Clone, Copy)]
struct Pt {
    lat: f64,
    lng: f64,
    time_ms: f64,
    ap_state: i64,
    gear: i64,
    sei_speed: f64,
    motion_evidence: u8,
    accel_pos: f64,
}

fn seg_len_ms(c: &Clip) -> f64 {
    match c.sub_clip_frames {
        Some(sf) if sf.total_frames > 0.0 => ((sf.end_frame - sf.start_frame) * clip_span_of(c)) / sf.total_frames,
        _ => clip_span_of(c),
    }
}

fn build_drive_stats(clips: Vec<Clip>) -> GroupedDrive {
    let first = &clips[0];
    let last = &clips[clips.len() - 1];
    let start_ms = first.timestamp_ms;
    let mut last_segment_len_ms = clip_span_of(last);
    if let Some(lf) = last.sub_clip_frames {
        if lf.total_frames > 0.0 {
            last_segment_len_ms = js_round(((lf.end_frame - lf.start_frame) * clip_span_of(last)) / lf.total_frames);
        }
    }
    let end_ms = date_ms(last.timestamp_ms as f64 + last_segment_len_ms);

    let mut all: Vec<Pt> = Vec::new();
    for clip in &clips {
        let clip_start = clip.timestamp_ms as f64;
        let n = clip.r.points.len();
        let clip_duration_ms = seg_len_ms(clip);
        let ap = clip.r.autopilot_states.as_ref().filter(|v| v.len() == n);
        let gears = clip.r.gear_states.as_ref().filter(|v| v.len() == n);
        let speeds = clip.r.speeds.as_ref().filter(|v| v.len() == n);
        let accel = clip.r.accel_positions.as_ref().filter(|v| v.len() == n);
        for i in 0..n {
            let t = if n > 1 { clip_start + (clip_duration_ms * i as f64) / (n - 1) as f64 } else { clip_start };
            all.push(Pt {
                lat: clip.r.points[i][0],
                lng: clip.r.points[i][1],
                time_ms: t,
                ap_state: ap.map_or(0, |v| v[i] as i64),
                gear: gears.map_or(0, |v| v[i] as i64),
                sei_speed: speeds.map_or(0.0, |v| v[i]),
                motion_evidence: (if gears.is_some() { 1 } else { 0 }) | (if speeds.is_some() { 2 } else { 0 }),
                accel_pos: accel.map_or(0.0, |v| v[i]),
            });
        }
    }

    all.retain(|p| p.lat.abs() >= calc::NULL_ISLAND_DEG || p.lng.abs() >= calc::NULL_ISLAND_DEG);
    filter_gps_outliers(&mut all);

    let mut total_distance_m = 0.0;
    let mut max_speed_mps: f64 = 0.0;
    let mut speed_sum = 0.0;
    let mut speed_count = 0usize;
    let has_sei_speeds = all.iter().any(|p| p.sei_speed != 0.0);
    for i in 1..all.len() {
        let (p0, p1) = (all[i - 1], all[i]);
        let d = calc::geodesic_m(p0.lat, p0.lng, p1.lat, p1.lng);
        let dt = (p1.time_ms - p0.time_ms) / 1000.0;
        total_distance_m += d;
        if has_sei_speeds {
            let speed = p1.sei_speed.abs();
            if speed < calc::SEI_SPEED_MAX_MPS {
                speed_sum += speed;
                speed_count += 1;
                if speed > max_speed_mps {
                    max_speed_mps = speed;
                }
            }
        } else if dt > 0.0 {
            let speed = d / dt;
            if speed < calc::DERIVED_SPEED_MAX_MPS {
                speed_sum += speed;
                speed_count += 1;
                if speed > max_speed_mps {
                    max_speed_mps = speed;
                }
            }
        }
    }
    let avg_speed_mps = if speed_count > 0 { speed_sum / speed_count as f64 } else { 0.0 };

    let mut points = Vec::with_capacity(all.len());
    let mut fsd_states = Vec::with_capacity(all.len());
    let mut gear_states = Vec::with_capacity(all.len());
    let mut has_assisted = false;
    let mut has_gear = false;
    for i in 0..all.len() {
        let p = all[i];
        let speed = if has_sei_speeds {
            p.sei_speed
        } else if i > 0 {
            let q = all[i - 1];
            let d = calc::geodesic_m(q.lat, q.lng, p.lat, p.lng);
            let dt = (p.time_ms - q.time_ms) / 1000.0;
            if dt > 0.0 { (d / dt).min(calc::DERIVED_SPEED_MAX_MPS) } else { 0.0 }
        } else {
            0.0
        };
        points.push([p.lat, p.lng, p.time_ms, js_round(speed * 100.0) / 100.0]);
        fsd_states.push(p.ap_state);
        gear_states.push(p.gear);
        if p.ap_state != calc::AUTOPILOT_OFF {
            has_assisted = true;
        }
        if p.gear != calc::GEAR_PARK {
            has_gear = true;
        }
    }

    let (mut fsd_engaged_ms, mut fsd_disengagements, mut fsd_accel_pushes, mut fsd_distance_m) = (0.0, 0i64, 0i64, 0.0);
    let (mut autosteer_engaged_ms, mut autosteer_distance_m) = (0.0, 0.0);
    let (mut tacc_engaged_ms, mut tacc_distance_m) = (0.0, 0.0);
    let mut assisted_distance_m = 0.0;
    let mut fsd_events: Vec<Value> = Vec::new();

    if has_assisted && all.len() > 1 {
        let mut in_accel_press = false;
        let (mut accel_lat, mut accel_lng) = (0.0, 0.0);
        let mut fsd_engage_time = 0.0;
        let mut pending = false;
        let mut pending_time = 0.0;
        let (mut pending_lat, mut pending_lng) = (0.0, 0.0);
        for i in 1..all.len() {
            let prev = all[i - 1];
            let cur = all[i];
            let dt = cur.time_ms - prev.time_ms;
            let d = calc::geodesic_m(prev.lat, prev.lng, cur.lat, cur.lng);
            let prev_fsd = prev.ap_state == calc::AUTOPILOT_FSD;
            let cur_fsd = cur.ap_state == calc::AUTOPILOT_FSD;
            let cur_engaged = cur.ap_state != calc::AUTOPILOT_OFF;

            if pending {
                let since = cur.time_ms - pending_time;
                if cur.gear == calc::GEAR_PARK && since <= 2000.0 {
                    pending = false;
                } else if since > 2000.0 || cur_fsd {
                    fsd_disengagements += 1;
                    fsd_events.push(json!({ "lat": pending_lat, "lng": pending_lng, "type": "disengagement" }));
                    pending = false;
                }
            }
            if !prev_fsd && cur_fsd {
                in_accel_press = false;
                fsd_engage_time = cur.time_ms;
            }
            if cur_engaged {
                assisted_distance_m += d;
                match cur.ap_state {
                    calc::AUTOPILOT_FSD => {
                        fsd_engaged_ms += dt;
                        fsd_distance_m += d;
                    }
                    calc::AUTOPILOT_AUTOSTEER => {
                        autosteer_engaged_ms += dt;
                        autosteer_distance_m += d;
                    }
                    calc::AUTOPILOT_TACC => {
                        tacc_engaged_ms += dt;
                        tacc_distance_m += d;
                    }
                    _ => {}
                }
            }
            if prev_fsd && !cur_fsd {
                pending = true;
                pending_time = cur.time_ms;
                pending_lat = cur.lat;
                pending_lng = cur.lng;
                in_accel_press = false;
            }
            let mut accel_pct = cur.accel_pos;
            if accel_pct <= 1.0 {
                accel_pct *= 100.0;
            }
            if cur_fsd && !in_accel_press && accel_pct > 1.0 && cur.time_ms - fsd_engage_time >= 3000.0 {
                in_accel_press = true;
                accel_lat = cur.lat;
                accel_lng = cur.lng;
            }
            if in_accel_press && accel_pct <= 0.0 {
                fsd_accel_pushes += 1;
                fsd_events.push(json!({ "lat": accel_lat, "lng": accel_lng, "type": "accel_push" }));
                in_accel_press = false;
            }
        }
        if pending && !all.is_empty() && all[all.len() - 1].gear != calc::GEAR_PARK {
            fsd_disengagements += 1;
            fsd_events.push(json!({ "lat": pending_lat, "lng": pending_lng, "type": "disengagement" }));
        }
    }

    let duration_ms = end_ms - start_ms;
    let pct = |part: f64| if total_distance_m > 0.0 { js_round((part / total_distance_m) * 1000.0) / 10.0 } else { 0.0 };

    let evidence: Vec<ClipEvidence> = clips
        .iter()
        .map(|clip| {
            let runs = clip.r.flag_runs.as_deref();
            let mut total_frames = match clip.sub_clip_frames {
                Some(sf) => sf.total_frames,
                None => clip.r.raw_frame_count.unwrap_or(0.0),
            };
            if !(total_frames > 0.0) {
                if let Some(runs) = runs {
                    total_frames = runs.iter().map(|r| r.frames).sum();
                }
            }
            let start = clip.timestamp_ms as f64;
            ClipEvidence {
                flag_runs: runs,
                ap_runs: clip.r.ap_runs.as_deref(),
                gear_runs: clip.r.gear_runs.as_deref(),
                start_frame: clip.sub_clip_frames.map_or(0.0, |s| s.start_frame),
                end_frame: clip.sub_clip_frames.map_or(total_frames, |s| s.end_frame),
                total_frames,
                start_ms: start,
                end_ms: start + seg_len_ms(clip),
            }
        })
        .collect();
    let summon = calc::detect_summon(
        &evidence,
        if has_sei_speeds { max_speed_mps } else { 0.0 },
        duration_ms as f64,
        has_sei_speeds,
    );
    drop(evidence);

    if summon {
        fsd_engaged_ms = 0.0;
        fsd_disengagements = 0;
        fsd_accel_pushes = 0;
        fsd_distance_m = 0.0;
        autosteer_engaged_ms = 0.0;
        autosteer_distance_m = 0.0;
        tacc_engaged_ms = 0.0;
        tacc_distance_m = 0.0;
        assisted_distance_m = 0.0;
        fsd_events.clear();
    }

    let geocode_start = snap_geocode_endpoint(&all, false);
    let geocode_end = snap_geocode_endpoint(&all, true);
    let point_count = all.len();
    drop(all);

    let start_time = format_local_iso(start_ms);
    let end_time = format_local_iso(end_ms);
    let route_files: Vec<String> = clips.iter().map(|c| c.r.file.clone()).collect();
    let source = first.r.source.clone().unwrap_or_else(|| "sei".into());

    let mut f = Map::new();
    if let Some(date) = &first.r.date {
        f.insert("date".into(), json!(date));
    }
    f.insert("startTime".into(), json!(start_time));
    f.insert("endTime".into(), json!(end_time));
    f.insert("durationMs".into(), json!(duration_ms));
    f.insert("distanceMi".into(), json!(round2(total_distance_m / calc::M_PER_MILE)));
    f.insert("distanceKm".into(), json!(round2(total_distance_m / calc::M_PER_KM)));
    f.insert("avgSpeedMph".into(), json!(round2(avg_speed_mps * calc::MPS_TO_MPH)));
    f.insert("maxSpeedMph".into(), json!(round2(max_speed_mps * calc::MPS_TO_MPH)));
    f.insert("avgSpeedKmh".into(), json!(round2(avg_speed_mps * calc::MPS_TO_KMH)));
    f.insert("maxSpeedKmh".into(), json!(round2(max_speed_mps * calc::MPS_TO_KMH)));
    f.insert("clipCount".into(), json!(clips.len()));
    f.insert("pointCount".into(), json!(point_count));
    f.insert("fsdEngagedMs".into(), json!(js_round(fsd_engaged_ms)));
    f.insert("fsdDisengagements".into(), json!(fsd_disengagements));
    f.insert("fsdAccelPushes".into(), json!(fsd_accel_pushes));
    f.insert("fsdPercent".into(), json!(pct(fsd_distance_m)));
    f.insert("fsdDistanceKm".into(), json!(round2(fsd_distance_m / calc::M_PER_KM)));
    f.insert("fsdDistanceMi".into(), json!(round2(fsd_distance_m / calc::M_PER_MILE)));
    f.insert("autosteerEngagedMs".into(), json!(js_round(autosteer_engaged_ms)));
    f.insert("autosteerPercent".into(), json!(pct(autosteer_distance_m)));
    f.insert("autosteerDistanceKm".into(), json!(round2(autosteer_distance_m / calc::M_PER_KM)));
    f.insert("autosteerDistanceMi".into(), json!(round2(autosteer_distance_m / calc::M_PER_MILE)));
    f.insert("taccEngagedMs".into(), json!(js_round(tacc_engaged_ms)));
    f.insert("taccPercent".into(), json!(pct(tacc_distance_m)));
    f.insert("taccDistanceKm".into(), json!(round2(tacc_distance_m / calc::M_PER_KM)));
    f.insert("taccDistanceMi".into(), json!(round2(tacc_distance_m / calc::M_PER_MILE)));
    f.insert("assistedPercent".into(), json!(pct(assisted_distance_m)));
    f.insert("routeFiles".into(), json!(route_files));
    f.insert("source".into(), json!(source));
    if summon {
        f.insert("summon".into(), json!(true));
    }
    if let Some(sig) = &first.r.external_signature {
        f.insert("externalSignature".into(), json!(sig));
    }
    if let Some(p) = first.r.tessie_autopilot_percent {
        f.insert("tessieAutopilotPercent".into(), json!(p));
    }
    roll_up_drive_telemetry(&clips, &mut f);
    for (prefix, ep) in [("geocodeStart", geocode_start), ("geocodeEnd", geocode_end)] {
        if let Some(ep) = ep {
            f.insert(format!("{prefix}Point"), json!([ep.point[0], ep.point[1]]));
            f.insert(format!("{prefix}AccuracyM"), json!(ep.accuracy_m));
            f.insert(format!("{prefix}Samples"), json!(ep.sample_count));
            f.insert(format!("{prefix}Stationary"), json!(ep.stationary));
        }
    }

    GroupedDrive {
        start_time,
        end_time,
        source,
        summon,
        route_files,
        fields: f,
        points,
        fsd_states: has_assisted.then_some(fsd_states),
        gear_states: has_gear.then_some(gear_states),
        fsd_events: (!fsd_events.is_empty()).then_some(fsd_events),
    }
}

fn roll_up_drive_telemetry(clips: &[Clip], out: &mut Map<String, Value>) {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut battery_start: Option<f64> = None;
    let mut battery_end: Option<f64> = None;
    let (mut interior_min, mut interior_max): (Option<f64>, Option<f64>) = (None, None);
    let (mut ext_sum, mut ext_count) = (0.0, 0usize);
    let (mut hvac_sum, mut has_hvac) = (0.0, false);
    let mut tires: [Option<f64>; 4] = [None; 4];
    let (mut odo_start, mut odo_end): (Option<f64>, Option<f64>) = (None, None);
    let (mut loc_start, mut loc_end): (Option<String>, Option<String>) = (None, None);

    for clip in clips {
        if !seen.insert(clip.r.file.as_str()) {
            continue;
        }
        let t = &clip.r.telemetry;
        if battery_start.is_none() {
            if let Some(v) = t.battery_pct_start {
                battery_start = Some(round2(v));
            }
        }
        if let Some(v) = t.battery_pct_end {
            battery_end = Some(round2(v));
        }
        if let Some(v) = t.interior_temp_min {
            interior_min = Some(interior_min.map_or(v, |m| m.min(v)));
        }
        if let Some(v) = t.interior_temp_max {
            interior_max = Some(interior_max.map_or(v, |m| m.max(v)));
        }
        if let Some(v) = t.exterior_temp_avg {
            ext_sum += v;
            ext_count += 1;
        }
        if let Some(v) = t.hvac_runtime_s {
            hvac_sum += v;
            has_hvac = true;
        }
        for (slot, v) in tires.iter_mut().zip([t.tire_fl_psi, t.tire_fr_psi, t.tire_rl_psi, t.tire_rr_psi]) {
            if let Some(v) = v {
                *slot = Some(round2(v));
            }
        }
        if odo_start.is_none() {
            if let Some(v) = t.odometer_mi_start {
                odo_start = Some(round2(v));
            }
        }
        if let Some(v) = t.odometer_mi_end {
            odo_end = Some(round2(v));
        }
        if loc_start.is_none() && t.location_name_start.is_some() {
            loc_start = t.location_name_start.clone();
        }
        if t.location_name_end.is_some() {
            loc_end = t.location_name_end.clone();
        }
    }

    // Insertion order follows the JS object's first-assignment order closely
    // enough for consumers, which read fields by name.
    if let Some(v) = battery_start {
        out.insert("batteryPctStart".into(), json!(v));
    }
    if let Some(v) = battery_end {
        out.insert("batteryPctEnd".into(), json!(v));
    }
    for (key, v) in ["tireFlPsi", "tireFrPsi", "tireRlPsi", "tireRrPsi"].iter().zip(tires) {
        if let Some(v) = v {
            out.insert((*key).into(), json!(v));
        }
    }
    if let Some(v) = odo_start {
        out.insert("odometerMiStart".into(), json!(v));
    }
    if let Some(v) = odo_end {
        out.insert("odometerMiEnd".into(), json!(v));
    }
    if let Some(v) = loc_start {
        out.insert("locationNameStart".into(), json!(v));
    }
    if let Some(v) = loc_end {
        out.insert("locationNameEnd".into(), json!(v));
    }
    if let (Some(s), Some(e)) = (battery_start, battery_end) {
        out.insert("batteryPctUsed".into(), json!(round2(s - e)));
    }
    if let Some(v) = interior_min {
        out.insert("interiorTempMinC".into(), json!(round2(v)));
    }
    if let Some(v) = interior_max {
        out.insert("interiorTempMaxC".into(), json!(round2(v)));
    }
    if ext_count > 0 {
        out.insert("exteriorTempAvgC".into(), json!(round2(ext_sum / ext_count as f64)));
    }
    if has_hvac {
        out.insert("hvacRuntimeS".into(), json!(js_round(hvac_sum)));
    }
    if let (Some(s), Some(e)) = (odo_start, odo_end) {
        if e >= s {
            out.insert("odometerMiDriven".into(), json!(round2(e - s)));
        }
    }
}

fn stationary_evidence(p: &Pt) -> Option<bool> {
    if p.motion_evidence & 1 != 0 && p.gear == calc::GEAR_PARK {
        return Some(true);
    }
    if p.motion_evidence & 2 != 0 {
        return Some(p.sei_speed.abs() <= 0.75);
    }
    None
}

struct Endpoint {
    point: [f64; 2],
    accuracy_m: f64,
    sample_count: usize,
    stationary: bool,
}

fn cluster_medoid(points: &[Pt]) -> Endpoint {
    let mut best = points[0];
    let mut best_sum = f64::INFINITY;
    for c in points {
        let sum: f64 = points.iter().map(|p| calc::geodesic_m(c.lat, c.lng, p.lat, p.lng)).sum();
        if sum < best_sum {
            best = *c;
            best_sum = sum;
        }
    }
    let mut d: Vec<f64> = points.iter().map(|p| calc::geodesic_m(best.lat, best.lng, p.lat, p.lng)).collect();
    d.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((d.len() as f64 * 0.9).ceil() as usize).saturating_sub(1).min(d.len() - 1);
    let p90 = d[idx];
    Endpoint {
        point: [best.lat, best.lng],
        accuracy_m: js_round(p90.max(5.0) * 10.0) / 10.0,
        sample_count: points.len(),
        stationary: true,
    }
}

fn snap_geocode_endpoint(pts: &[Pt], from_end: bool) -> Option<Endpoint> {
    let n = pts.len();
    if n == 0 {
        return None;
    }
    let anchor = if from_end { pts[n - 1] } else { pts[0] };
    const WINDOW_MS: f64 = 30000.0;
    const FALLBACK_SAMPLES: usize = 30;
    const MAX_WINDOW_SAMPLES: usize = 600;
    const MAX_SEEDS: usize = 3;
    const RADIUS_M: f64 = 15.0;
    let mut ordered: Vec<Pt> = Vec::new();
    let has_anchor_time = anchor.time_ms.is_finite();
    for k in 0..MAX_WINDOW_SAMPLES.min(n) {
        let p = if from_end { pts[n - 1 - k] } else { pts[k] };
        if has_anchor_time && p.time_ms.is_finite() {
            if (p.time_ms - anchor.time_ms).abs() > WINDOW_MS {
                break;
            }
        } else if k >= FALLBACK_SAMPLES {
            break;
        }
        ordered.push(p);
    }
    let has_motion = ordered.iter().any(|p| stationary_evidence(p).is_some());
    let candidates: Vec<Pt> = if has_motion {
        ordered.iter().copied().filter(|p| stationary_evidence(p) == Some(true)).collect()
    } else {
        ordered.clone()
    };
    let raw = Endpoint { point: [anchor.lat, anchor.lng], accuracy_m: 35.0, sample_count: 1, stationary: false };
    if candidates.len() < 3 {
        return Some(raw);
    }
    let mut best: Option<Vec<Pt>> = None;
    for seed in ordered.iter().take(MAX_SEEDS) {
        if has_motion && stationary_evidence(seed) != Some(true) {
            continue;
        }
        let cluster: Vec<Pt> = candidates
            .iter()
            .copied()
            .filter(|p| calc::geodesic_m(seed.lat, seed.lng, p.lat, p.lng) <= RADIUS_M)
            .collect();
        // Every point carries a finite time here, so this reduces to the span test.
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for p in &cluster {
            lo = lo.min(p.time_ms);
            hi = hi.max(p.time_ms);
        }
        let enough_time = hi - lo >= 2000.0;
        if cluster.len() >= 3 && enough_time && best.as_ref().map_or(true, |b| cluster.len() > b.len()) {
            best = Some(cluster);
        }
    }
    Some(match best {
        Some(c) => cluster_medoid(&c),
        None => raw,
    })
}

fn filter_gps_outliers(points: &mut Vec<Pt>) {
    if points.len() <= 2 {
        return;
    }
    let q1 = (points.len() as f64 * 0.25).floor() as usize;
    let q3 = (points.len() as f64 * 0.75).floor() as usize;
    let (mut med_lat, mut med_lng, mut count) = (0.0, 0.0, 0.0);
    for p in &points[q1..=q3.min(points.len() - 1)] {
        med_lat += p.lat;
        med_lng += p.lng;
        count += 1.0;
    }
    // JS loops i <= q3 and reads points[q3]; q3 < len for len >= 3.
    med_lat /= count;
    med_lng /= count;
    points.retain(|p| calc::geodesic_m(p.lat, p.lng, med_lat, med_lng) <= calc::MAX_FROM_MEDIAN_M);

    let len = points.len();
    let mut removed = vec![false; len];
    let mut next_survivor: Option<Pt> = None;
    for i in (0..len).rev() {
        let prev = if i > 0 { Some(points[i - 1]) } else { None };
        let next = next_survivor;
        let p = points[i];
        let far_prev = prev.is_some_and(|q| calc::geodesic_m(q.lat, q.lng, p.lat, p.lng) > calc::MAX_JUMP_M);
        let far_next = next.is_some_and(|q| calc::geodesic_m(p.lat, p.lng, q.lat, q.lng) > calc::MAX_JUMP_M);
        if (prev.is_some() && next.is_some() && far_prev && far_next)
            || (prev.is_none() && far_next)
            || (next.is_none() && far_prev)
        {
            removed[i] = true;
        } else {
            next_survivor = Some(p);
        }
    }
    let mut k = 0;
    points.retain(|_| {
        let keep = !removed[k];
        k += 1;
        keep
    });
}

/// Ports of `src/processing/grouper.test.js` (grouping, rollups, geocode
/// endpoints, end-time convention, clip spans, Summon, park splitting) and
/// `src/shared/drive-telemetry.test.js`. The clip-path and gap-fill tests from
/// grouper.test.js live with their implementations in `route.rs`.
///
/// Clip timestamps are parsed in the machine's local zone, as in the JS build;
/// every assertion here compares durations, orderings or counts derived from
/// those epochs, so the tests hold in any zone (including DST-observing ones,
/// since no fixture spans a transition).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::loader::calc::{ApRun, FlagRun, GearRun};
    use crate::loader::route::{RouteJson, Telemetry};

    const GEAR_PARK: i64 = calc::GEAR_PARK;
    const GEAR_DRIVE: i64 = 1;
    const GEAR_REVERSE: i64 = 2;

    // ── Fixtures ────────────────────────────────────────────────────────────

    fn line_points(n: usize, base_lat: f64, base_lng: f64) -> Vec<[f64; 2]> {
        (0..n).map(|i| [base_lat + i as f64 * 1e-4, base_lng]).collect()
    }

    fn test_route(file: &str, points: Vec<[f64; 2]>) -> Route {
        Route {
            file: file.into(),
            points,
            gear_states: Some(vec![]),
            autopilot_states: Some(vec![]),
            speeds: Some(vec![]),
            accel_positions: Some(vec![]),
            raw_park_count: Some(0.0),
            raw_frame_count: Some(10.0),
            gear_runs: Some(vec![GearRun { gear: Some(GEAR_DRIVE), frames: 10.0 }]),
            ..Default::default()
        }
    }

    fn park_route(file: &str, lat: f64) -> Route {
        Route {
            raw_park_count: Some(60.0),
            raw_frame_count: Some(60.0),
            gear_runs: Some(vec![GearRun { gear: Some(GEAR_PARK), frames: 60.0 }]),
            ..test_route(file, vec![[lat, -76.795]])
        }
    }

    /// One point per frame keeps frame-fraction slicing aligned with point indices.
    fn clip_with_gear_runs(file: &str, runs: &[(i64, u32)], base_lat: f64) -> Route {
        let total: u32 = runs.iter().map(|r| r.1).sum();
        let park: u32 = runs.iter().filter(|r| r.0 == GEAR_PARK).map(|r| r.1).sum();
        Route {
            raw_park_count: Some(park as f64),
            raw_frame_count: Some(total as f64),
            gear_runs: Some(runs.iter().map(|&(gear, frames)| GearRun { gear: Some(gear), frames: frames as f64 }).collect()),
            ..test_route(file, line_points(total.max(1) as usize, base_lat, -122.0))
        }
    }

    fn with_telemetry(mut r: Route, t: Telemetry) -> Route {
        r.telemetry = t;
        r
    }

    fn drives_of(routes: Vec<Route>) -> Vec<GroupedDrive> {
        group_into_drives(routes).drives
    }

    fn field<'a>(d: &'a GroupedDrive, key: &str) -> &'a Value {
        d.fields.get(key).unwrap_or_else(|| panic!("drive has no {key}"))
    }

    fn num(d: &GroupedDrive, key: &str) -> f64 {
        field(d, key).as_f64().unwrap_or_else(|| panic!("{key} is not a number"))
    }

    fn point2(d: &GroupedDrive, key: &str) -> [f64; 2] {
        let v = field(d, key).as_array().expect("point array");
        [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]
    }

    fn files(d: &GroupedDrive) -> Vec<&str> {
        d.route_files.iter().map(String::as_str).collect()
    }

    // ── Grouping ────────────────────────────────────────────────────────────

    #[test]
    fn empty_input_yields_no_drives() {
        assert_eq!(drives_of(vec![]).len(), 0);
    }

    #[test]
    fn single_clip_yields_one_drive() {
        let drives = drives_of(vec![test_route("/cam/2025-01-15_12-30-45-front.mp4", vec![[37.0, -122.0]])]);
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].route_files.len(), 1);
    }

    #[test]
    fn gap_over_five_minutes_splits_drives() {
        let drives = drives_of(vec![
            test_route("/cam/2025-01-15_12-00-00-front.mp4", vec![[37.0, -122.0]]),
            test_route("/cam/2025-01-15_13-00-00-front.mp4", vec![[37.1, -122.1]]),
        ]);
        assert_eq!(drives.len(), 2);
    }

    #[test]
    fn clips_under_five_minutes_apart_stay_in_one_drive() {
        let drives = drives_of(vec![
            test_route("/cam/2025-01-15_12-00-00-front.mp4", vec![[37.0, -122.0]]),
            test_route("/cam/2025-01-15_12-01-00-front.mp4", vec![[37.0001, -122.0]]),
        ]);
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].route_files.len(), 2);
    }

    // ── Gear-state park splitting ───────────────────────────────────────────

    #[test]
    fn two_internal_park_gaps_split_one_clip_into_three_drives() {
        let drives = drives_of(vec![clip_with_gear_runs(
            "/cam/2025-01-15_12-00-00-front.mp4",
            &[(GEAR_DRIVE, 20), (GEAR_PARK, 5), (GEAR_DRIVE, 15), (GEAR_PARK, 5), (GEAR_DRIVE, 15)],
            37.0,
        )]);
        assert_eq!(drives.len(), 3);
    }

    #[test]
    fn no_internal_park_gap_keeps_one_drive() {
        let drives = drives_of(vec![clip_with_gear_runs("/cam/2025-01-15_12-00-00-front.mp4", &[(GEAR_DRIVE, 60)], 37.0)]);
        assert_eq!(drives.len(), 1);
    }

    #[test]
    fn all_parked_clip_yields_no_drive() {
        // Fully parked groups are recordings, not trips.
        let drives = drives_of(vec![clip_with_gear_runs("/cam/2025-01-15_12-00-00-front.mp4", &[(GEAR_PARK, 60)], 37.0)]);
        assert_eq!(drives.len(), 0);
    }

    #[test]
    fn fully_parked_clip_between_two_drives_yields_two_drives() {
        let drives = drives_of(vec![
            clip_with_gear_runs("/cam/2025-01-15_12-00-00-front.mp4", &[(GEAR_DRIVE, 60)], 37.0),
            clip_with_gear_runs("/cam/2025-01-15_12-01-00-front.mp4", &[(GEAR_PARK, 60)], 37.0),
            clip_with_gear_runs("/cam/2025-01-15_12-02-00-front.mp4", &[(GEAR_DRIVE, 60)], 37.0),
        ]);
        assert_eq!(drives.len(), 2);
        assert_eq!(drives[0].route_files.len(), 1);
        assert_eq!(drives[1].route_files.len(), 1);
    }

    // ── Dedup + event-folder filtering ──────────────────────────────────────

    #[test]
    fn duplicate_paths_with_mixed_separators_are_deduped() {
        let drives = drives_of(vec![
            test_route("cam/2025-01-15_12-00-00-front.mp4", vec![[37.0, -122.0]]),
            test_route("cam\\2025-01-15_12-00-00-front.mp4", vec![[37.0, -122.0]]),
        ]);
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].route_files.len(), 1);
    }

    #[test]
    fn recentclips_prefixed_and_canonical_paths_are_one_clip() {
        let drives = drives_of(vec![
            test_route("RecentClips/2026-07-27/2026-07-27_14-01-02-front.mp4", vec![[37.0, -122.0]]),
            test_route("2026-07-27/2026-07-27_14-01-02-front.mp4", vec![[38.0, -123.0]]),
        ]);
        assert_eq!(drives.len(), 1);
        assert_eq!(files(&drives[0]), vec!["2026-07-27/2026-07-27_14-01-02-front.mp4"]);
    }

    #[test]
    fn event_folder_routes_are_filtered_out_of_grouping() {
        let drives = drives_of(vec![
            test_route("RecentClips/2025-01-15/2025-01-15_12-30-00-front.mp4", vec![[37.0, -122.0]]),
            test_route("SavedClips/2025-01-15_12-30-30/2025-01-15_12-30-00-front.mp4", vec![[37.0, -122.0]]),
            test_route("SentryClips/2025-01-15_12-29-30/2025-01-15_12-30-00-front.mp4", vec![[37.0, -122.0]]),
        ]);
        assert_eq!(drives.len(), 1);
        assert_eq!(files(&drives[0]), vec!["2025-01-15/2025-01-15_12-30-00-front.mp4"]);
    }

    #[test]
    fn july_27_manual_save_driving_savedclips_fill_the_recentclips_hole() {
        let mut routes = vec![test_route("2026-07-27/2026-07-27_14-01-02-front.mp4", vec![[39.0, -76.7]])];
        let saved = [
            "14-02-02", "14-03-02", "14-04-03", "14-05-03", "14-06-03", "14-07-03", "14-08-04", "14-09-04", "14-10-04",
            "14-11-04", "14-12-05",
        ];
        for (index, time) in saved.iter().enumerate() {
            routes.push(test_route(
                &format!("SavedClips/2026-07-27_14-12-29/2026-07-27_{time}-front.mp4"),
                vec![[39.001 + index as f64 * 0.001, -76.7]],
            ));
        }
        routes.push(test_route("2026-07-27/2026-07-27_14-12-26-front.mp4", vec![[39.013, -76.7]]));
        let expected: Vec<String> = routes.iter().map(|r| r.file.clone()).collect();

        let drives = drives_of(routes);
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].route_files.len(), 13);
        assert_eq!(drives[0].route_files.iter().filter(|f| f.starts_with("SavedClips/")).count(), 11);
        assert_eq!(drives[0].route_files, expected);
    }

    #[test]
    fn may_17_event_clips_do_not_create_a_phantom_parked_drive() {
        let mut routes = Vec::new();
        for minute in 35..=45u32 {
            let ss = 39 + (minute - 35);
            routes.push(park_route(
                &format!("SentryClips/2026-05-17_18-46-39/2026-05-17_18-{minute}-{ss:02}-front.mp4"),
                39.1988 + minute as f64 * 1e-6,
            ));
        }
        routes.push(test_route(
            "SavedClips/2026-05-17_18-47-59/2026-05-17_18-47-34-front.mp4",
            vec![[39.198835, -76.795246]],
        ));
        let minutes = ["47", "48", "49", "50", "51"];
        for (i, m) in minutes.iter().enumerate() {
            routes.push(test_route(
                &format!("RecentClips/2026-05-17/2026-05-17_18-{m}-34-front.mp4"),
                vec![[39.198835 + i as f64 * 1e-4, -76.795246]],
            ));
        }
        let expected: Vec<String> = minutes.iter().map(|m| format!("2026-05-17/2026-05-17_18-{m}-34-front.mp4")).collect();

        let drives = drives_of(routes);
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].route_files, expected);
    }

    // ── BLE telemetry rollups ───────────────────────────────────────────────

    #[test]
    fn location_name_rollup_keeps_first_start_and_last_end() {
        let drives = drives_of(vec![
            with_telemetry(
                test_route("RecentClips/2026-05-17_10-00-00-front.mp4", vec![[37.0, -122.0]]),
                Telemetry { location_name_end: Some("100 First St".into()), ..Default::default() },
            ),
            with_telemetry(
                test_route("RecentClips/2026-05-17_10-01-00-front.mp4", vec![[37.001, -122.0]]),
                Telemetry {
                    location_name_start: Some("100 First St".into()),
                    location_name_end: Some("250 Mid Ave".into()),
                    ..Default::default()
                },
            ),
            test_route("RecentClips/2026-05-17_10-02-00-front.mp4", vec![[37.002, -122.0]]),
        ]);
        assert_eq!(drives.len(), 1);
        assert_eq!(field(&drives[0], "locationNameStart"), "100 First St");
        assert_eq!(field(&drives[0], "locationNameEnd"), "250 Mid Ave");
    }

    #[test]
    fn location_name_and_battery_rollups_are_omitted_without_telemetry() {
        let drives = drives_of(vec![
            test_route("RecentClips/2026-05-17_10-00-00-front.mp4", vec![[37.0, -122.0]]),
            test_route("RecentClips/2026-05-17_10-01-00-front.mp4", vec![[37.001, -122.0]]),
        ]);
        assert_eq!(drives.len(), 1);
        for key in ["locationNameStart", "locationNameEnd", "batteryPctStart", "batteryPctEnd"] {
            assert!(!drives[0].fields.contains_key(key), "{key} present");
        }
    }

    #[test]
    fn battery_rollup_keeps_first_start_and_last_end() {
        let drives = drives_of(vec![
            test_route("RecentClips/2026-05-17_10-00-00-front.mp4", vec![[37.0, -122.0]]),
            with_telemetry(
                test_route("RecentClips/2026-05-17_10-01-00-front.mp4", vec![[37.001, -122.0]]),
                Telemetry { battery_pct_start: Some(78.0), battery_pct_end: Some(71.0), ..Default::default() },
            ),
            with_telemetry(
                test_route("RecentClips/2026-05-17_10-02-00-front.mp4", vec![[37.002, -122.0]]),
                Telemetry { battery_pct_start: Some(71.0), battery_pct_end: Some(64.0), ..Default::default() },
            ),
        ]);
        assert_eq!(drives.len(), 1);
        assert_eq!(num(&drives[0], "batteryPctStart"), 78.0);
        assert_eq!(num(&drives[0], "batteryPctEnd"), 64.0);
    }

    #[test]
    fn complete_ble_telemetry_rollup_matches_sentry_usb_summaries() {
        let drives = drives_of(vec![
            with_telemetry(
                test_route("2026-07-27/2026-07-27_10-00-00-front.mp4", vec![[37.0, -122.0]]),
                Telemetry {
                    battery_pct_start: Some(80.0),
                    battery_pct_end: Some(79.0),
                    interior_temp_min: Some(20.0),
                    interior_temp_max: Some(24.0),
                    exterior_temp_avg: Some(30.0),
                    hvac_runtime_s: Some(30.0),
                    tire_fl_psi: Some(42.0),
                    tire_rl_psi: Some(43.0),
                    odometer_mi_start: Some(1000.0),
                    ..Default::default()
                },
            ),
            with_telemetry(
                test_route("2026-07-27/2026-07-27_10-01-00-front.mp4", vec![[37.001, -122.0]]),
                Telemetry {
                    battery_pct_start: Some(79.0),
                    battery_pct_end: Some(78.0),
                    interior_temp_min: Some(18.0),
                    interior_temp_max: Some(28.0),
                    exterior_temp_avg: Some(32.0),
                    hvac_runtime_s: Some(45.0),
                    tire_fl_psi: Some(41.5),
                    tire_fr_psi: Some(42.5),
                    tire_rr_psi: Some(43.5),
                    odometer_mi_end: Some(1002.25),
                    ..Default::default()
                },
            ),
        ]);
        assert_eq!(drives.len(), 1);
        let expected = [
            ("batteryPctStart", 80.0),
            ("batteryPctEnd", 78.0),
            ("batteryPctUsed", 2.0),
            ("interiorTempMinC", 18.0),
            ("interiorTempMaxC", 28.0),
            ("exteriorTempAvgC", 31.0),
            ("hvacRuntimeS", 75.0),
            ("tireFlPsi", 41.5),
            ("tireFrPsi", 42.5),
            ("tireRlPsi", 43.0),
            ("tireRrPsi", 43.5),
            ("odometerMiStart", 1000.0),
            ("odometerMiEnd", 1002.25),
            ("odometerMiDriven", 2.25),
        ];
        for (key, want) in expected {
            assert_eq!(num(&drives[0], key), want, "{key}");
        }
    }

    // ── Geocode endpoint snapping ───────────────────────────────────────────

    #[test]
    fn geocode_endpoints_stationary_medoid_start_and_raw_terminal_fix_when_rolling() {
        let pts = vec![
            [37.000000, -122.0],
            [37.000018, -122.0],
            [36.999991, -122.0],
            [37.000009, -122.0],
            [37.000036, -122.0],
            [37.000300, -122.0],
            [37.000600, -122.0],
            [37.000900, -122.0],
        ];
        let drives = drives_of(vec![test_route("RecentClips/2026-05-17_10-00-00-front.mp4", pts)]);
        assert_eq!(drives.len(), 1);
        let d = &drives[0];
        assert_eq!(point2(d, "geocodeStartPoint"), [37.000009, -122.0]);
        assert_eq!(point2(d, "geocodeEndPoint"), [37.000900, -122.0]);
        assert_eq!(field(d, "geocodeStartStationary"), &json!(true));
        assert_eq!(num(d, "geocodeStartSamples"), 4.0);
        let acc = num(d, "geocodeStartAccuracyM");
        assert!((5.0..=15.0).contains(&acc), "{acc}");
        assert_eq!(field(d, "geocodeEndStationary"), &json!(false));
        assert_eq!(num(d, "geocodeEndAccuracyM"), 35.0);
    }

    #[test]
    fn geocode_endpoint_medoid_skips_a_terminal_gps_outlier_using_speed_evidence() {
        let pts = vec![
            [37.000000, -122.0],
            [37.000300, -122.0],
            [37.000600, -122.0],
            [37.001000, -122.0],
            [37.001009, -122.0],
            [37.000991, -122.0],
            [37.001500, -122.0], // stopped, but a bad terminal GPS fix
        ];
        let mut route = test_route("RecentClips/2026-05-17_10-00-00-front.mp4", pts.clone());
        route.gear_states = Some(vec![GEAR_DRIVE as u8; pts.len()]);
        route.speeds = Some(vec![5.0, 5.0, 5.0, 0.0, 0.0, 0.0, 0.0]);
        let drives = drives_of(vec![route]);
        assert_eq!(point2(&drives[0], "geocodeStartPoint"), pts[0]);
        assert_eq!(point2(&drives[0], "geocodeEndPoint"), [37.001000, -122.0]);
    }

    #[test]
    fn geocode_endpoint_does_not_mistake_tightly_spaced_moving_samples_for_parking() {
        let pts = vec![[37.000000, -122.0], [37.000030, -122.0], [37.000060, -122.0], [37.000090, -122.0]];
        let mut route = test_route("RecentClips/2026-05-17_10-00-00-front.mp4", pts.clone());
        route.gear_states = Some(vec![GEAR_DRIVE as u8; pts.len()]);
        route.speeds = Some(vec![3.0; pts.len()]);
        let drives = drives_of(vec![route]);
        assert_eq!(point2(&drives[0], "geocodeStartPoint"), pts[0]);
        assert_eq!(point2(&drives[0], "geocodeEndPoint"), pts[pts.len() - 1]);
    }

    #[test]
    fn geocode_endpoint_clustering_uses_elapsed_time_rather_than_sample_count() {
        let point = [37.0, -122.0];
        let sparse = drives_of(vec![test_route("RecentClips/2026-05-17_10-00-00-front.mp4", vec![point; 61])]);
        let dense = drives_of(vec![test_route("RecentClips/2026-05-17_10-00-00-front.mp4", vec![point; 601])]);
        let (sparse, dense) = (&sparse[0], &dense[0]);
        assert_eq!(point2(sparse, "geocodeStartPoint"), point2(dense, "geocodeStartPoint"));
        assert_eq!(num(sparse, "geocodeStartAccuracyM"), 5.0);
        assert_eq!(num(dense, "geocodeStartAccuracyM"), 5.0);
        assert_eq!(num(sparse, "geocodeStartSamples"), 31.0);
        assert_eq!(num(dense, "geocodeStartSamples"), 301.0);
    }

    // ── Drive end-time convention ───────────────────────────────────────────

    #[test]
    fn drive_ends_at_the_last_driving_frame_when_the_final_clip_is_park_split() {
        let drives = drives_of(vec![clip_with_gear_runs(
            "RecentClips/2026-05-17_10-00-00-front.mp4",
            &[(GEAR_DRIVE, 30), (GEAR_PARK, 30)],
            37.0,
        )]);
        assert_eq!(drives.len(), 1);
        assert_eq!(num(&drives[0], "durationMs"), 30000.0);
    }

    #[test]
    fn drive_with_an_unsplit_final_clip_keeps_the_plus_60s_convention() {
        let drives = drives_of(vec![test_route("RecentClips/2026-05-17_10-00-00-front.mp4", line_points(10, 37.0, -122.0))]);
        assert_eq!(drives.len(), 1);
        assert_eq!(num(&drives[0], "durationMs"), 60000.0);
    }

    // ── Event-clip gap fill through grouping ────────────────────────────────

    #[test]
    fn trailing_pre_roll_chain_extends_the_drive_and_parked_tail_is_excluded() {
        let driving = |file: &str, lat: f64| Route {
            file: file.into(),
            points: vec![[lat, -122.0], [lat + 0.001, -122.0]],
            speeds: Some(vec![5.0, 5.0]),
            gear_states: Some(vec![1, 1]),
            gear_runs: Some(vec![GearRun { gear: Some(1), frames: 2.0 }]),
            ..Default::default()
        };
        let parked = |file: &str, lat: f64| Route {
            file: file.into(),
            points: vec![[lat, -122.0], [lat, -122.0]],
            speeds: Some(vec![0.0, 0.0]),
            gear_states: Some(vec![0, 0]),
            gear_runs: Some(vec![GearRun { gear: Some(0), frames: 2.0 }]),
            ..Default::default()
        };
        let drives = drives_of(vec![
            driving("RecentClips/2026-07-04/2026-07-04_20-42-50-front.mp4", 37.0),
            driving("RecentClips/2026-07-04/2026-07-04_20-43-50-front.mp4", 37.001),
            driving("SentryClips/2026-07-04_20-55-50/2026-07-04_20-44-51-front.mp4", 37.002),
            driving("SentryClips/2026-07-04_20-55-50/2026-07-04_20-45-51-front.mp4", 37.003),
            parked("SentryClips/2026-07-04_20-55-50/2026-07-04_20-46-52-front.mp4", 37.003),
            parked("SentryClips/2026-07-04_20-55-50/2026-07-04_20-47-52-front.mp4", 37.003),
        ]);
        assert_eq!(drives.len(), 1, "expected a single extended drive");
        assert_eq!(
            files(&drives[0]),
            vec![
                "2026-07-04/2026-07-04_20-42-50-front.mp4",
                "2026-07-04/2026-07-04_20-43-50-front.mp4",
                "SentryClips/2026-07-04_20-55-50/2026-07-04_20-44-51-front.mp4",
                "SentryClips/2026-07-04_20-55-50/2026-07-04_20-45-51-front.mp4",
            ]
        );
    }

    // ── Clip span ───────────────────────────────────────────────────────────

    #[test]
    fn a_clip_that_stopped_early_stamps_its_points_inside_the_drive() {
        // The next clip starts 20 s later, so clip A's 700 frames cover 20 s,
        // not a nominal minute.
        let a = clip_with_gear_runs("2026-08-11/2026-08-11_00-33-32-front.mp4", &[(GEAR_DRIVE, 700)], 37.0);
        let b = clip_with_gear_runs("2026-08-11/2026-08-11_00-33-52-front.mp4", &[(GEAR_DRIVE, 2100)], 37.1);
        let drives = drives_of(vec![a, b]);
        assert_eq!(drives.len(), 1);
        let pts = &drives[0].points;
        for i in 1..pts.len() {
            assert!(pts[i][2] >= pts[i - 1][2], "point {i} steps backwards");
        }
        let span = pts[pts.len() - 1][2] - pts[0][2];
        let duration = num(&drives[0], "durationMs");
        assert!(span <= duration, "point span {span} exceeds duration {duration}");
        // 20 s of clip A, then clip B runs to its own nominal end.
        assert_eq!(duration, 80000.0);
    }

    #[test]
    fn clip_spans_do_not_stretch_across_a_recording_gap() {
        let a = clip_with_gear_runs("2026-08-11/2026-08-11_00-33-32-front.mp4", &[(GEAR_DRIVE, 2100)], 37.0);
        let b = clip_with_gear_runs("2026-08-11/2026-08-11_00-43-32-front.mp4", &[(GEAR_DRIVE, 2100)], 37.1);
        let drives = drives_of(vec![a, b]);
        assert_eq!(drives.len(), 2);
        assert_eq!(num(&drives[0], "durationMs"), 60000.0);
        assert_eq!(num(&drives[1], "durationMs"), 60000.0);
    }

    // ── Summon detection ────────────────────────────────────────────────────
    // flagRuns and gearRuns share the raw SEI frame sequence.

    struct SummonOpts {
        speed: f64,
        n: usize,
        ap_runs: Option<Vec<ApRun>>,
        ap_state: Option<u8>,
    }

    impl Default for SummonOpts {
        fn default() -> Self {
            SummonOpts { speed: 2.0, n: 100, ap_runs: None, ap_state: None }
        }
    }

    fn summon_clip(file: &str, runs: &[(i64, u32)], flag_runs: Option<Vec<FlagRun>>, o: SummonOpts) -> Route {
        let base_lat = 37.0;
        let mut clip = clip_with_gear_runs(file, runs, base_lat);
        clip.points.truncate(o.n);
        while clip.points.len() < o.n {
            let len = clip.points.len();
            clip.points.push([base_lat + len as f64 * 1e-6, -122.0]);
        }
        clip.speeds = Some(vec![o.speed; o.n]);
        clip.flag_runs = flag_runs;
        if let Some(runs) = o.ap_runs {
            clip.ap_runs = Some(runs);
        }
        if let Some(state) = o.ap_state {
            clip.autopilot_states = Some(vec![state; o.n]);
        }
        clip
    }

    fn fr(flags: i64, frames: u32) -> FlagRun {
        FlagRun { flags, frames: frames as f64, max_mps: None }
    }

    fn frm(flags: i64, frames: u32, max_mps: f64) -> FlagRun {
        FlagRun { flags, frames: frames as f64, max_mps: Some(max_mps) }
    }

    fn apr(ap: i64, frames: u32) -> ApRun {
        ApRun { ap: Some(ap), frames: frames as f64 }
    }

    fn ass_start_runs() -> Vec<FlagRun> {
        vec![fr(0, 27), fr(3, 123) /* hazards through P→D */, fr(0, 17), fr(1, 873), fr(0, 746)]
    }

    fn ass_end_runs() -> Vec<FlagRun> {
        vec![fr(0, 471), fr(3, 82) /* hazards through D→P */]
    }

    #[test]
    fn summon_hazard_bookended_pedal_free_crawl_across_two_clips_is_flagged() {
        let a = summon_clip(
            "2026-07-15/2026-07-15_20-49-54-front.mp4",
            &[(GEAR_PARK, 60), (GEAR_DRIVE, 1726)],
            Some(ass_start_runs()),
            SummonOpts::default(),
        );
        let b = summon_clip(
            "2026-07-15/2026-07-15_20-50-43-front.mp4",
            &[(GEAR_DRIVE, 500), (GEAR_PARK, 53)],
            Some(ass_end_runs()),
            SummonOpts::default(),
        );
        let drives = drives_of(vec![a, b]);
        assert_eq!(drives.len(), 1);
        assert!(drives[0].summon);
        assert_eq!(field(&drives[0], "summon"), &json!(true));
    }

    #[test]
    fn summon_missing_flag_runs_or_pedal_input_never_flags() {
        // Missing evidence must not infer Summon.
        let bare_a = summon_clip(
            "2026-07-15/2026-07-15_20-49-54-front.mp4",
            &[(GEAR_PARK, 60), (GEAR_DRIVE, 1726)],
            None,
            SummonOpts::default(),
        );
        let bare_b = summon_clip(
            "2026-07-15/2026-07-15_20-50-43-front.mp4",
            &[(GEAR_DRIVE, 500), (GEAR_PARK, 53)],
            None,
            SummonOpts::default(),
        );
        let bare = drives_of(vec![bare_a, bare_b]);
        assert_eq!(bare.len(), 1);
        assert!(!bare[0].summon && !bare[0].fields.contains_key("summon"));

        let pedal_runs = vec![fr(3, 150), fr(0, 800), fr(8, 36), fr(0, 718), fr(3, 82)];
        let pedal = drives_of(vec![summon_clip(
            "2026-07-16/2026-07-16_09-00-00-front.mp4",
            &[(GEAR_PARK, 60), (GEAR_DRIVE, 1726)],
            Some(pedal_runs),
            SummonOpts::default(),
        )]);
        assert_eq!(pedal.len(), 1);
        assert!(!pedal[0].summon && !pedal[0].fields.contains_key("summon"));
    }

    #[test]
    fn summon_self_driving_crawl_without_hazards_is_flagged_and_skips_fsd_stats() {
        // Newer firmware reports Summon as autopilot_state = FSD.
        let clip = summon_clip(
            "2026-08-14/2026-08-14_09-00-00-front.mp4",
            &[(GEAR_PARK, 90), (GEAR_DRIVE, 300), (GEAR_PARK, 60)],
            Some(vec![fr(0, 450)]),
            SummonOpts { ap_runs: Some(vec![apr(0, 90), apr(1, 300), apr(0, 60)]), ap_state: Some(1), ..Default::default() },
        );
        let drives = drives_of(vec![clip]);
        assert_eq!(drives.len(), 1);
        let d = &drives[0];
        assert!(d.summon);
        // The maneuver is driverless: no FSD engagement or disengagement.
        assert_eq!(num(d, "fsdEngagedMs"), 0.0);
        assert_eq!(num(d, "fsdDistanceKm"), 0.0);
        assert_eq!(num(d, "fsdPercent"), 0.0);
        assert_eq!(num(d, "fsdDisengagements"), 0.0);
        assert_eq!(num(d, "assistedPercent"), 0.0);
        assert!(d.fsd_events.is_none());
    }

    #[test]
    fn summon_slow_pedal_free_fsd_fragment_without_park_bracketing_keeps_fsd_stats() {
        let clip = summon_clip(
            "2026-08-14/2026-08-14_11-00-00-front.mp4",
            &[(GEAR_DRIVE, 450)],
            Some(vec![fr(0, 450)]),
            SummonOpts { ap_runs: Some(vec![apr(1, 450)]), ap_state: Some(1), ..Default::default() },
        );
        let drives = drives_of(vec![clip]);
        assert_eq!(drives.len(), 1);
        assert!(!drives[0].summon && !drives[0].fields.contains_key("summon"));
        assert!(num(&drives[0], "fsdEngagedMs") > 0.0);
        assert_eq!(num(&drives[0], "fsdPercent"), 100.0);
    }

    #[test]
    fn summon_pedal_free_fsd_crawl_still_needs_the_speed_gate() {
        let clip = summon_clip(
            "2026-08-14/2026-08-14_10-00-00-front.mp4",
            &[(GEAR_PARK, 90), (GEAR_DRIVE, 300), (GEAR_PARK, 60)],
            Some(vec![fr(0, 450)]),
            SummonOpts {
                speed: 12.0,
                ap_runs: Some(vec![apr(0, 90), apr(1, 300), apr(0, 60)]),
                ap_state: Some(1),
                ..Default::default()
            },
        );
        let drives = drives_of(vec![clip]);
        assert_eq!(drives.len(), 1);
        assert!(!drives[0].summon);
        assert!(num(&drives[0], "fsdEngagedMs") > 0.0);
    }

    #[test]
    fn summon_reverse_only_with_negative_sei_speeds_is_flagged() {
        let clip = summon_clip(
            "2026-07-20/2026-07-20_09-00-00-front.mp4",
            &[(GEAR_PARK, 90), (GEAR_REVERSE, 300), (GEAR_PARK, 60)],
            Some(vec![fr(3, 120), fr(0, 240), fr(3, 90)]),
            SummonOpts { speed: -1.5, ..Default::default() },
        );
        let drives = drives_of(vec![clip]);
        assert_eq!(drives.len(), 1);
        assert!(drives[0].summon);
        // Display statistics also use the SEI magnitude.
        assert_eq!(num(&drives[0], "maxSpeedMph"), 3.36);
        assert_eq!(num(&drives[0], "avgSpeedMph"), 3.36);
    }

    #[test]
    fn summon_reverse_summon_ending_seconds_before_the_human_drives_off_splits_and_flags() {
        let a = summon_clip(
            "2026-07-27/2026-07-27_20-04-00-front.mp4",
            &[(GEAR_PARK, 46), (GEAR_REVERSE, 727), (GEAR_DRIVE, 917)],
            Some(vec![fr(0, 11), fr(3, 113) /* hazards spanning P→R */, fr(0, 394), fr(2, 256), fr(0, 301), fr(2, 615)]),
            SummonOpts { speed: 2.0, ..Default::default() },
        );
        let mut b = summon_clip(
            "2026-07-27/2026-07-27_20-04-46-front.mp4",
            &[(GEAR_DRIVE, 120), (GEAR_PARK, 84), (GEAR_DRIVE, 1469)],
            Some(vec![
                fr(2, 81),
                fr(3, 89), // hazards through D→P
                fr(4, 70),
                fr(0, 200),
                fr(8, 690),
                fr(0, 112),
                fr(1, 431),
            ]),
            SummonOpts { speed: 0.3, ..Default::default() },
        );
        // Only the pre-park tail remains at Summon speed.
        b.speeds = Some((0..100).map(|i| if i < 10 { 0.3 } else { 5.4 }).collect());

        let drives = drives_of(vec![a, b]);
        assert_eq!(drives.len(), 2);
        assert!(drives[0].summon);
        assert!(!drives[1].summon);
    }

    #[test]
    fn summon_point_slice_speed_pollution_does_not_reject_a_frame_slow_summon() {
        let a = summon_clip(
            "2026-07-27/2026-07-27_00-34-31-front.mp4",
            &[(GEAR_PARK, 68), (GEAR_REVERSE, 538), (GEAR_DRIVE, 311)],
            Some(vec![frm(0, 7, 0.0), frm(3, 144, 0.1) /* hazards spanning P→R */, frm(0, 766, 2.7)]),
            SummonOpts { speed: 1.5, ..Default::default() },
        );
        let mut b = summon_clip(
            "2026-07-27/2026-07-27_00-34-59-front.mp4",
            &[(GEAR_DRIVE, 579), (GEAR_PARK, 114), (GEAR_DRIVE, 1162)],
            Some(vec![
                frm(0, 143, 2.7),
                frm(3, 219, 2.6),
                frm(0, 105, 2.0),
                frm(3, 191, 1.8), // hazards through D→P
                frm(4, 50, 0.0),
                frm(0, 10, 0.0),
                frm(8, 521, 4.7),
                frm(0, 16, 4.0),
                frm(8, 545, 4.7),
                frm(0, 55, 1.0),
            ]),
            SummonOpts { speed: 0.4, ..Default::default() },
        );
        // The fraction-based slice reaches into faster post-park samples.
        b.speeds = Some((0..100).map(|i| if i < 25 { 0.4 } else { 4.7 }).collect());

        let drives = drives_of(vec![a, b]);
        assert_eq!(drives.len(), 2);
        assert!(num(&drives[0], "maxSpeedMph") > 8.0, "fixture must reproduce the pollution");
        assert!(drives[0].summon);
        assert!(!drives[1].summon);
    }

    // ── Park splitting: short segments survive GPS deduplication ────────────

    #[test]
    fn summon_tail_finishing_seconds_into_the_next_clip_survives_gps_dedup() {
        let clips_for = |n: usize| {
            vec![
                summon_clip(
                    "2026-08-01/2026-08-01_09-00-00-front.mp4",
                    &[(GEAR_PARK, 60), (GEAR_DRIVE, 1740)],
                    Some(vec![frm(0, 20, 0.0), frm(3, 130, 0.4) /* hazards through P→D */, frm(0, 1650, 2.2)]),
                    SummonOpts { n: 100, ..Default::default() },
                ),
                summon_clip(
                    "2026-08-01/2026-08-01_09-01-00-front.mp4",
                    &[(GEAR_DRIVE, 120), (GEAR_PARK, 120), (GEAR_DRIVE, 1560)],
                    Some(vec![frm(3, 120, 1.1) /* hazards through D→P */, frm(0, 120, 0.0), frm(8, 1560, 12.0)]),
                    SummonOpts { n, speed: 1.0, ..Default::default() },
                ),
            ]
        };
        // Six points across clip B is the dedup level that used to lose the tail.
        for n in [6, 12, 100] {
            let drives = drives_of(clips_for(n));
            assert_eq!(drives.len(), 2, "n={n}");
            assert!(drives[0].summon, "n={n}");
            assert_eq!(drives[0].route_files.len(), 2, "n={n}: tail segment kept");
            // 58 s of clip A plus 4 s of clip B, from raw frame bounds.
            assert_eq!(num(&drives[0], "durationMs"), 62000.0, "n={n}");
            assert!(!drives[1].summon, "n={n}");
        }
    }

    #[test]
    fn park_split_leading_and_middle_motion_segments_survive_at_any_point_density() {
        let runs = [
            (GEAR_DRIVE, 30),
            (GEAR_PARK, 120),
            (GEAR_DRIVE, 420),
            (GEAR_PARK, 120),
            (GEAR_DRIVE, 30),
            (GEAR_PARK, 120),
            (GEAR_DRIVE, 960),
        ];
        let expected = [1000.0, 14000.0, 1000.0, 32000.0];
        for n in [6, 100, 1800] {
            let mut clip = clip_with_gear_runs("2026-08-02/2026-08-02_09-00-00-front.mp4", &runs, 37.0);
            clip.points.truncate(n);
            let drives = drives_of(vec![clip]);
            assert_eq!(drives.len(), expected.len(), "n={n}: one drive per motion run");
            let durations: Vec<f64> = drives.iter().map(|d| num(d, "durationMs")).collect();
            assert_eq!(durations, expected, "n={n}");
            for d in &drives {
                assert!(num(d, "pointCount") > 0.0, "n={n}: every drive keeps a point");
            }
        }
    }

    // ── drive-telemetry.test.js (rollUpDriveTelemetry) ──────────────────────

    fn roll_up(routes: Vec<Value>) -> Value {
        let clips: Vec<Clip> = routes
            .into_iter()
            .map(|v| Clip {
                r: serde_json::from_value::<RouteJson>(v).expect("route json").into_route(),
                source: "sei".into(),
                timestamp_ms: 0,
                clip_span_ms: None,
                sub_clip_frames: None,
            })
            .collect();
        let mut out = Map::new();
        roll_up_drive_telemetry(&clips, &mut out);
        Value::Object(out)
    }

    #[test]
    fn telemetry_rolls_every_supported_category_across_a_drive() {
        let got = roll_up(vec![
            json!({
                "file": "2026-07-27/a-front.mp4",
                "batteryPctStart": 80, "batteryPctEnd": 79.5,
                "interiorTempMin": 20, "interiorTempMax": 24, "exteriorTempAvg": 30,
                "hvacRuntimeS": 30, "tireFlPsi": 42, "tireRlPsi": 43,
                "odometerMiStart": 1000, "locationNameStart": "Home",
            }),
            json!({
                "file": "2026-07-27/b-front.mp4",
                "batteryPctStart": 79.5, "batteryPctEnd": 78,
                "interiorTempMin": 18, "interiorTempMax": 28, "exteriorTempAvg": 32,
                "hvacRuntimeS": 45, "tireFlPsi": 41.5, "tireFrPsi": 42.5,
                "tireRrPsi": 43.5, "odometerMiEnd": 1002.25, "locationNameEnd": "Work",
            }),
        ]);
        assert_eq!(
            got,
            json!({
                "batteryPctStart": 80.0, "batteryPctEnd": 78.0, "batteryPctUsed": 2.0,
                "interiorTempMinC": 18.0, "interiorTempMaxC": 28.0, "exteriorTempAvgC": 31.0,
                "hvacRuntimeS": 75.0, "tireFlPsi": 41.5, "tireFrPsi": 42.5,
                "tireRlPsi": 43.0, "tireRrPsi": 43.5,
                "odometerMiStart": 1000.0, "odometerMiEnd": 1002.25, "odometerMiDriven": 2.25,
                "locationNameStart": "Home", "locationNameEnd": "Work",
            })
        );
    }

    #[test]
    fn telemetry_counts_a_parent_clip_once_when_it_appears_as_multiple_subclips() {
        let sub = json!({
            "file": "2026-07-27/a-front.mp4",
            "batteryPctStart": 70, "batteryPctEnd": 69, "exteriorTempAvg": 30, "hvacRuntimeS": 30,
        });
        assert_eq!(
            roll_up(vec![sub.clone(), sub]),
            json!({
                "batteryPctStart": 70.0, "batteryPctEnd": 69.0, "batteryPctUsed": 1.0,
                "exteriorTempAvgC": 30.0, "hvacRuntimeS": 30.0,
            })
        );
    }

    #[test]
    fn telemetry_uses_the_latest_tire_reading_independently_per_wheel() {
        assert_eq!(
            roll_up(vec![
                json!({ "file": "2026-07-27/a-front.mp4", "tireFlPsi": 40, "tireFrPsi": 41, "tireRlPsi": 42 }),
                json!({ "file": "2026-07-27/b-front.mp4", "tireFlPsi": 39.5, "tireRrPsi": 43 }),
            ]),
            json!({ "tireFlPsi": 39.5, "tireFrPsi": 41.0, "tireRlPsi": 42.0, "tireRrPsi": 43.0 })
        );
    }

    #[test]
    fn telemetry_omits_a_negative_odometer_delta_but_keeps_its_endpoints() {
        assert_eq!(
            roll_up(vec![json!({ "file": "2026-07-27/a-front.mp4", "odometerMiStart": 1002, "odometerMiEnd": 1001 })]),
            json!({ "odometerMiStart": 1002.0, "odometerMiEnd": 1001.0 })
        );
    }

    #[test]
    fn telemetry_ignores_non_finite_and_non_number_values() {
        // NaN and ±Infinity have no JSON form (json! writes them as null, as
        // JSON.stringify does); non-numbers are dropped when the route is read.
        assert_eq!(
            roll_up(vec![
                json!({
                    "file": "2026-07-27/a-front.mp4",
                    "batteryPctStart": "80", "batteryPctEnd": f64::NAN,
                    "interiorTempMin": f64::INFINITY, "exteriorTempAvg": "30",
                    "hvacRuntimeS": "60", "tireFlPsi": f64::NEG_INFINITY,
                    "odometerMiStart": null,
                }),
                json!({ "file": "2026-07-27/b-front.mp4", "batteryPctStart": 79.25, "batteryPctEnd": 78.1 }),
            ]),
            json!({ "batteryPctStart": 79.25, "batteryPctEnd": 78.1, "batteryPctUsed": 1.15 })
        );
    }

    #[test]
    fn telemetry_returns_no_optional_fields_when_a_drive_has_none() {
        assert_eq!(roll_up(vec![json!({ "file": "2026-07-27/a-front.mp4" })]), json!({}));
    }
}
