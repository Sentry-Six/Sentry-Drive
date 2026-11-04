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
