//! Check Drives: the `repair-gps` (bridge short recording gaps) and
//! `check-summon` (backfill per-frame Summon evidence) handlers from
//! electron-main.cjs.
//!
//! Both stream drive-data.json instead of holding it in memory: GPS repair
//! needs only a few fields per route, and the Summon check groups drives one
//! time window at a time from a temporary loader index, which gives the same
//! drives as Electron's whole-file `groupIntoDrives`.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use anyhow::Result;
use base64::Engine;
use chrono::{Local, LocalResult, NaiveDate, TimeZone, Timelike};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::drive_data::{self, for_each_array_element, scan_sections, Replacement};
use crate::drive_edit::{note_own_write, DriveDataLock};
use crate::loader::calc::{self, geodesic_m, CLIP_DURATION_MS, DRIVE_GAP_MS, GEAR_PARK, MPS_TO_MPH, SUMMON_MAX_DURATION_MS, SUMMON_MAX_SPEED_MPS};
use crate::loader::grouper::group_into_drives;
use crate::loader::index::{self, parallel_map, DriveIndex};
use crate::loader::route::{local_naive_to_ms, normalize_clip_path, Route, RouteJson};
use crate::loader::LoaderService;
use crate::logger;
use crate::processing::extract::{compute_ap_runs, compute_flag_runs, compute_gear_runs, extract_gps_from_file};

const BRIDGE_MARK: &str = "-front-bridge.mp4";

/// `repair-progress` reporter: (phase, current, total, etaSec).
pub type Progress<'a> = &'a (dyn Fn(&str, usize, usize, Option<f64>) + Sync);

fn emitter(app: &AppHandle) -> impl Fn(&str, usize, usize, Option<f64>) + Sync + '_ {
    move |phase, current, total, eta_sec| {
        let mut p = json!({ "phase": phase, "current": current, "total": total });
        if let Some(eta) = eta_sec {
            p["etaSec"] = jnum(eta);
        }
        let _ = app.emit("repair-progress", p);
    }
}

fn eta(started: Instant, done: usize, total: usize) -> f64 {
    if done == 0 {
        return 0.0;
    }
    let elapsed = started.elapsed().as_millis() as f64;
    calc::js_round((elapsed / done as f64) * (total - done) as f64 / 1000.0)
}

/// A JS number as JSON.stringify writes it: integral values without ".0".
pub fn jnum(v: f64) -> Value {
    if !v.is_finite() {
        Value::Null
    } else if v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Parse every element of the `routes` array on all cores, in file order.
fn map_routes<T: Send>(path: &Path, parse: impl Fn(&[u8]) -> T + Sync) -> Result<Vec<T>> {
    let mut f = File::open(path)?;
    let sections = scan_sections(f.try_clone()?)?;
    let mut out = Vec::new();
    let Some(s) = sections.iter().find(|s| s.key == "routes") else { return Ok(out) };
    let mut batch: Vec<Vec<u8>> = Vec::with_capacity(1024);
    let flush = |batch: Vec<Vec<u8>>, out: &mut Vec<T>| out.extend(parallel_map(batch, |el| parse(&el)));
    for_each_array_element(&mut f, s, |el| {
        batch.push(el.to_vec());
        if batch.len() == 1024 {
            flush(std::mem::take(&mut batch), &mut out);
        }
        Ok(())
    })?;
    flush(batch, &mut out);
    Ok(out)
}

fn has_section(path: &Path, key: &str) -> Result<bool> {
    let f = File::open(path)?;
    Ok(scan_sections(f)?.iter().any(|s| s.key == key))
}

/// `route.file` of a raw element, read only when the element could match.
fn element_file_if(el: &[u8], needle: &[u8]) -> Option<String> {
    if !el.windows(needle.len()).any(|w| w == needle) {
        return None;
    }
    #[derive(Deserialize)]
    struct FileOnly {
        #[serde(default)]
        file: Value,
    }
    serde_json::from_slice::<FileOnly>(el).ok().and_then(|f| f.file.as_str().map(String::from))
}

// ── GPS repair ──────────────────────────────────────────────────────────────

/// `new Date("YYYY-MM-DDTHH:MM:SS")` for the first `YYYY-MM-DD_HH-MM-SS` in a
/// path, with V8's leniency (day 29–31 rolls into the next month, T24:00:00).
fn parse_file_ts(file: &str) -> Option<i64> {
    let b = file.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let d = |c: u8| c.is_ascii_digit();
    for i in 0..=b.len() - 19 {
        let w = &b[i..i + 19];
        let shape = w[..4].iter().all(|&c| d(c))
            && w[4] == b'-' && d(w[5]) && d(w[6])
            && w[7] == b'-' && d(w[8]) && d(w[9])
            && w[10] == b'_' && d(w[11]) && d(w[12])
            && w[13] == b'-' && d(w[14]) && d(w[15])
            && w[16] == b'-' && d(w[17]) && d(w[18]);
        if !shape {
            continue;
        }
        let n = |s: &[u8]| std::str::from_utf8(s).ok().and_then(|s| s.parse::<u32>().ok());
        let (y, mo, day) = (n(&w[0..4])? as i32, n(&w[5..7])?, n(&w[8..10])?);
        let (h, mi, s) = (n(&w[11..13])?, n(&w[14..16])?, n(&w[17..19])?);
        if !(1..=12).contains(&mo) || !(1..=31).contains(&day) || mi > 59 || s > 59 || h > 24 || (h == 24 && (mi > 0 || s > 0)) {
            return None;
        }
        let date = NaiveDate::from_ymd_opt(y, mo, 1)? + chrono::Duration::days(day as i64 - 1);
        let naive = date.and_hms_opt(0, mi, s)? + chrono::Duration::hours(h as i64);
        return Some(local_naive_to_ms(naive));
    }
    None
}

/// What GPS repair needs from one route.
struct Lite {
    file: String,
    date: Option<String>,
    ts: Option<i64>,
    first_pt: Option<[f64; 2]>,
    last_pt: Option<[f64; 2]>,
    first_gear: Option<i64>,
    last_gear: Option<i64>,
}

fn lite(el: &[u8]) -> Option<Lite> {
    if el.first() != Some(&b'{') {
        return None;
    }
    let r: Route = serde_json::from_slice::<RouteJson>(el).ok()?.into_route();
    let gear = |first: bool| -> Option<i64> {
        if let Some(runs) = r.gear_runs.as_ref().filter(|v| !v.is_empty()) {
            let run = if first { runs.first() } else { runs.last() };
            return run.and_then(|g| g.gear);
        }
        let states = r.gear_states.as_ref().filter(|v| !v.is_empty())?;
        let g = if first { states.first() } else { states.last() };
        g.map(|&g| g as i64)
    };
    Some(Lite {
        ts: parse_file_ts(&r.file),
        first_gear: gear(true),
        last_gear: gear(false),
        first_pt: r.points.first().copied(),
        last_pt: r.points.last().copied(),
        date: r.date.clone(),
        file: r.file,
    })
}

fn http() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// OSRM driving route as [lat, lng] pairs, or None.
fn fetch_osrm_route(agent: &ureq::Agent, a: [f64; 2], b: [f64; 2]) -> Result<Option<Vec<[f64; 2]>>> {
    let url = format!(
        "https://router.project-osrm.org/route/v1/driving/{},{};{},{}?overview=full&geometries=geojson",
        js_str(a[1]),
        js_str(a[0]),
        js_str(b[1]),
        js_str(b[0])
    );
    let body = agent.get(&url).call()?.into_body().read_to_string()?;
    let Ok(v) = serde_json::from_str::<Value>(&body) else { return Ok(None) };
    if v["code"] != "Ok" {
        return Ok(None);
    }
    let Some(coords) = v["routes"][0]["geometry"]["coordinates"].as_array() else { return Ok(None) };
    Ok(Some(
        coords
            .iter()
            .map(|c| [c[1].as_f64().unwrap_or(f64::NAN), c[0].as_f64().unwrap_or(f64::NAN)])
            .collect(),
    ))
}

/// `String(number)`.
fn js_str(v: f64) -> String {
    match jnum(v) {
        Value::Null => if v.is_nan() { "NaN".into() } else if v > 0.0 { "Infinity".into() } else { "-Infinity".into() },
        n => n.to_string(),
    }
}

struct Gap {
    last_pt: [f64; 2],
    first_pt: [f64; 2],
    cur_end: i64,
    gap_ms: i64,
    cur_last_gear: Option<i64>,
    date: Option<String>,
}

fn find_gaps(routes: &[Lite]) -> Vec<Gap> {
    let mut timed: Vec<&Lite> = routes.iter().filter(|r| r.ts.is_some()).collect();
    timed.sort_by_key(|r| r.ts); // stable, like Array#sort
    let mut gaps = Vec::new();
    for w in timed.windows(2) {
        let (cur, next) = (w[0], w[1]);
        let cur_end = cur.ts.unwrap() + CLIP_DURATION_MS as i64;
        let gap_ms = next.ts.unwrap() - cur_end;
        if gap_ms <= CLIP_DURATION_MS as i64 || gap_ms > DRIVE_GAP_MS {
            continue;
        }
        let (Some(last_pt), Some(first_pt)) = (cur.last_pt, next.first_pt) else { continue };
        if cur.last_gear == Some(GEAR_PARK) || next.first_gear == Some(GEAR_PARK) {
            continue;
        }
        if cur.date != next.date {
            continue;
        }
        gaps.push(Gap { last_pt, first_pt, cur_end, gap_ms, cur_last_gear: cur.last_gear, date: cur.date.clone() });
    }
    gaps
}

fn bridge_route(g: &Gap, routed: Option<Vec<[f64; 2]>>) -> (String, Vec<u8>) {
    let points = routed.unwrap_or_else(|| {
        let n_steps = (calc::js_round(g.gap_ms as f64 / 1000.0) as i64).max(2);
        (1..n_steps)
            .map(|s| {
                let t = s as f64 / n_steps as f64;
                [
                    g.last_pt[0] + (g.first_pt[0] - g.last_pt[0]) * t,
                    g.last_pt[1] + (g.first_pt[1] - g.last_pt[1]) * t,
                ]
            })
            .collect()
    });
    let n = points.len();
    let dist_m = geodesic_m(g.last_pt[0], g.last_pt[1], g.first_pt[0], g.first_pt[1]);
    let avg_speed = dist_m / (g.gap_ms as f64 / 1000.0);
    let (h, m, s) = match Local.timestamp_millis_opt(g.cur_end) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => (t.hour(), t.minute(), t.second()),
        LocalResult::None => (0, 0, 0),
    };
    let date = g.date.clone().unwrap_or_else(|| "undefined".into());
    let file = format!("{date}/{date}_{h:02}-{m:02}-{s:02}{BRIDGE_MARK}");
    let gear = g.cur_last_gear.unwrap_or(1);
    let gear_byte = gear.rem_euclid(256) as u8;
    let mut r = Map::new();
    r.insert("file".into(), json!(file));
    if let Some(d) = &g.date {
        r.insert("date".into(), json!(d));
    }
    r.insert("points".into(), Value::Array(points.iter().map(|p| json!([jnum(p[0]), jnum(p[1])])).collect()));
    r.insert("gearStates".into(), json!(b64(&vec![gear_byte; n])));
    r.insert("autopilotStates".into(), json!(b64(&vec![0u8; n])));
    r.insert("speeds".into(), Value::Array(vec![jnum(avg_speed); n]));
    r.insert("accelPositions".into(), Value::Array(vec![json!(0); n]));
    r.insert("rawParkCount".into(), json!(0));
    r.insert("rawFrameCount".into(), json!(n));
    r.insert("gearRuns".into(), json!([{ "gear": gear, "frames": n }]));
    (file, serde_json::to_vec(&Value::Object(r)).unwrap_or_default())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairArgs {
    file_path: String,
    #[serde(default)]
    use_routing: bool,
}

pub fn repair_gps_core(path: &Path, use_routing: bool, progress: Progress) -> Result<Value> {
    progress("Reading…", 0, 1, None);
    std::fs::copy(path, format!("{}.bak", path.display()))?;
    let routes: Vec<Lite> = map_routes(path, lite)?.into_iter().flatten().collect();
    let removed_bridges = routes.iter().filter(|r| r.file.contains(BRIDGE_MARK)).count();
    let kept: Vec<Lite> = routes.into_iter().filter(|r| !r.file.contains(BRIDGE_MARK)).collect();

    progress("Scanning for gaps…", 0, 1, None);
    let gaps = find_gaps(&kept);
    drop(kept);

    let agent = http();
    let started = Instant::now();
    let (mut bridged, mut routed_gaps) = (0usize, 0usize);
    let mut bridges: Vec<(String, Vec<u8>)> = Vec::new();
    for (i, g) in gaps.iter().enumerate() {
        progress("Bridging…", i + 1, gaps.len(), Some(eta(started, i, gaps.len())));
        let mut routed = None;
        if use_routing {
            if let Ok(Some(pts)) = fetch_osrm_route(&agent, g.last_pt, g.first_pt) {
                if pts.len() >= 2 {
                    routed = Some(pts);
                    routed_gaps += 1;
                }
            }
        }
        bridges.push(bridge_route(g, routed));
        bridged += 1;
    }

    let bridge_files: Vec<Vec<u8>> = bridges.iter().map(|(f, _)| serde_json::to_vec(f).unwrap_or_default()).collect();
    let mut replacements = vec![(
        "routes",
        Replacement::Filter {
            keep: Box::new(|el: &[u8]| Ok(!element_file_if(el, BRIDGE_MARK.as_bytes()).is_some_and(|f| f.contains(BRIDGE_MARK)))),
            extra: bridges.into_iter().map(|(_, b)| b).collect(),
            pretty: true,
        },
    )];
    if has_section(path, "processedFiles")? || !bridge_files.is_empty() {
        replacements.push((
            "processedFiles",
            Replacement::Filter {
                keep: Box::new(|el: &[u8]| {
                    if !el.windows(BRIDGE_MARK.len()).any(|w| w == BRIDGE_MARK.as_bytes()) {
                        return Ok(true);
                    }
                    let f: Value = serde_json::from_slice(el)?;
                    Ok(!f.as_str().is_some_and(|s| s.contains(BRIDGE_MARK)))
                }),
                extra: bridge_files,
                pretty: false,
            },
        ));
    }
    drive_data::write_drive_data(path, replacements, &|| true)?;
    logger::info(
        "gps",
        format!("check drives: {bridged} gap(s) bridged ({routed_gaps} via routing), {removed_bridges} old bridge(s) rebuilt"),
    );
    Ok(json!({ "success": true, "bridgedGaps": bridged, "routedGaps": routed_gaps, "removedBridges": removed_bridges }))
}

#[tauri::command]
pub async fn repair_gps(app: AppHandle, args: RepairArgs) -> Value {
    let lock = app.state::<DriveDataLock>();
    let _g = lock.0.lock().await;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&args.file_path);
        let r = repair_gps_core(path, args.use_routing, &emitter(&app2));
        note_own_write(&app2, path);
        r.unwrap_or_else(|e| {
            logger::error("gps", format!("check drives failed: {e:#}"));
            json!({ "success": false, "error": format!("{e:#}") })
        })
    })
    .await
    .unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }))
}

// ── Check for Summon ────────────────────────────────────────────────────────

/// resolveClipPath: accept route paths with or without a RecentClips prefix.
fn resolve_clip_path(clips_dir: Option<&str>, norm: &str) -> Option<PathBuf> {
    let dir = Path::new(clips_dir.filter(|d| !d.is_empty())?);
    let mut cands = vec![dir.join(norm)];
    let lower = norm.to_ascii_lowercase();
    if lower.starts_with("recentclips/") {
        cands.push(dir.join(&norm["recentclips/".len()..]));
    } else if dir.file_name().map(|n| n.to_string_lossy().to_lowercase()) != Some("recentclips".into()) {
        cands.push(dir.join("RecentClips").join(norm));
    }
    cands.into_iter().find(|c| c.exists())
}

fn has_current_evidence(r: &Route) -> bool {
    r.flag_runs.as_ref().is_some_and(|runs| !runs.is_empty() && runs.iter().all(|run| run.max_mps.is_some_and(f64::is_finite)))
        && r.ap_runs.as_ref().is_some_and(|runs| !runs.is_empty())
}

fn route_is_slow(r: Option<&Route>) -> bool {
    let Some(speeds) = r.and_then(|r| r.speeds.as_ref()).filter(|s| !s.is_empty()) else { return false };
    speeds.iter().all(|s| !(s.abs() > SUMMON_MAX_SPEED_MPS))
}

/// Pick the clips whose evidence to refresh, one window of routes at a time.
fn summon_candidates(window: Vec<Route>, pending: &mut Vec<String>, seen: &mut HashSet<String>) -> usize {
    let by_file: HashMap<String, Route> = window.iter().map(|r| (r.file.clone(), r.clone())).collect();
    let grouped = group_into_drives(window);
    let max_mph = SUMMON_MAX_SPEED_MPS * MPS_TO_MPH + 0.01;
    const MAX_EDGE_CLIPS: usize = 10;
    let mut add = |f: &str| {
        let norm = normalize_clip_path(f);
        if norm.contains(BRIDGE_MARK) {
            return;
        }
        if let Some(route) = by_file.get(&norm) {
            if !has_current_evidence(route) && seen.insert(norm.clone()) {
                pending.push(norm);
            }
        }
    };
    let mut candidate_drives = 0;
    for d in grouped.drives {
        if d.source != "sei" || d.summon {
            continue;
        }
        let files = &d.route_files;
        if files.is_empty() {
            continue;
        }
        let num = |k: &str| d.fields.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        if num("maxSpeedMph") <= max_mph && num("durationMs") <= SUMMON_MAX_DURATION_MS {
            candidate_drives += 1;
            for f in files {
                add(f);
            }
            continue;
        }
        let slow = |f: &str| route_is_slow(by_file.get(&normalize_clip_path(f)));
        let mut took = false;
        for f in files.iter().take(MAX_EDGE_CLIPS) {
            if !slow(f) {
                if took {
                    add(f);
                }
                break;
            }
            add(f);
            took = true;
        }
        let mut took_tail = false;
        for f in files.iter().rev().take(MAX_EDGE_CLIPS) {
            if !slow(f) {
                if took_tail {
                    add(f);
                }
                break;
            }
            add(f);
            took_tail = true;
        }
        if took || took_tail {
            candidate_drives += 1;
        }
    }
    candidate_drives
}

/// Fresh evidence for one clip, as the five route fields in JS key order.
fn evidence(clips_dir: Option<&str>, norm: &str) -> Result<Option<Vec<(&'static str, Value)>>, ()> {
    let full = resolve_clip_path(clips_dir, norm).ok_or(())?;
    let Some(x) = extract_gps_from_file(&full).map_err(|_| ())? else { return Ok(None) };
    if x.flags.is_empty() {
        return Ok(None);
    }
    let flag_runs: Vec<Value> = compute_flag_runs(&x.flags, &x.speeds)
        .iter()
        .map(|r| json!({ "flags": r.flags, "frames": jnum(r.frames), "maxMps": r.max_mps.map(jnum).unwrap_or(Value::Null) }))
        .collect();
    let gear_runs: Vec<Value> = compute_gear_runs(&x.gears)
        .iter()
        .map(|r| json!({ "gear": r.gear, "frames": jnum(r.frames) }))
        .collect();
    let ap_runs: Vec<Value> = compute_ap_runs(&x.ap_states).iter().map(|r| json!({ "ap": r.ap, "frames": jnum(r.frames) })).collect();
    let park = x.gears.iter().filter(|&&g| g as i64 == GEAR_PARK).count();
    Ok(Some(vec![
        ("flagRuns", Value::Array(flag_runs)),
        ("gearRuns", Value::Array(gear_runs)),
        ("apRuns", Value::Array(ap_runs)),
        ("rawFrameCount", json!(x.gears.len())),
        ("rawParkCount", json!(park)),
    ]))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummonArgs {
    file_path: String,
    clips_dir: Option<String>,
}

pub fn check_summon_core(path: &Path, clips_dir: Option<&str>, cache_root: &Path, progress: Progress) -> Result<Value> {
    progress("Reading…", 0, 1, None);
    let dir = cache_root.join(format!("summon-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let scan = (|| -> Result<(usize, Vec<String>)> {
        let ix = DriveIndex::create(&dir.join("drive-index.sqlite"), path)?;
        index::index_drive_data(&ix, &|_| {}, &AtomicBool::new(false))?;
        progress("Scanning drives…", 0, 1, None);
        let (mut candidates, mut pending, mut seen) = (0usize, Vec::new(), HashSet::new());
        index::for_each_route_window(&ix, |w| {
            candidates += summon_candidates(w, &mut pending, &mut seen);
            Ok(())
        })?;
        Ok((candidates, pending))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    let (candidate_drives, pending) = scan?;

    // Read clips a few at a time on all cores, reporting progress per chunk.
    let started = Instant::now();
    let (mut scanned, mut missing) = (0usize, 0usize);
    let mut updates: HashMap<String, Vec<(&'static str, Value)>> = HashMap::new();
    let total = pending.len();
    let mut done = 0usize;
    for chunk in pending.chunks(16) {
        progress("Reading clips…", done + 1, total, Some(eta(started, done, total)));
        let results = parallel_map(chunk.to_vec(), |norm| {
            let ev = evidence(clips_dir, &norm);
            (norm, ev)
        });
        for (norm, ev) in results {
            match ev {
                Err(()) => missing += 1,
                Ok(None) => scanned += 1,
                Ok(Some(fields)) => {
                    scanned += 1;
                    updates.insert(norm, fields);
                }
            }
        }
        done += chunk.len();
    }
    let updated = updates.len();

    if updated > 0 {
        progress("Saving…", 1, 1, None);
        // Take the restore point only when a write actually follows.
        std::fs::copy(path, format!("{}.bak", path.display()))?;
        let mut updates = updates;
        drive_data::write_drive_data(
            path,
            vec![(
                "routes",
                Replacement::Map {
                    edit: Box::new(move |el: &[u8]| {
                        #[derive(Deserialize)]
                        struct FileOnly {
                            #[serde(default)]
                            file: Value,
                        }
                        let Some(file) = serde_json::from_slice::<FileOnly>(el).ok().and_then(|f| f.file.as_str().map(String::from)) else {
                            return Ok(None);
                        };
                        let norm = normalize_clip_path(&file);
                        // One update per path. With duplicate paths Electron
                        // updates the last copy; this updates the first, which
                        // is the copy the loader index evaluated.
                        let Some(fields) = updates.remove(&norm) else { return Ok(None) };
                        let mut v: Map<String, Value> = serde_json::from_slice(el)?;
                        for (k, val) in fields {
                            v.insert(k.into(), val);
                        }
                        Ok(Some(serde_json::to_vec(&v)?))
                    }),
                    pretty: true,
                },
            )],
            &|| true,
        )?;
    }
    logger::info(
        "gps",
        format!(
            "check summon: {candidate_drives} candidate drive(s), {scanned} clip(s) read, {updated} route(s) gained flag+gear+autopilot evidence, {missing} clip(s) unavailable"
        ),
    );
    Ok(json!({
        "success": true,
        "candidateDrives": candidate_drives,
        "clipsScanned": scanned,
        "updatedRoutes": updated,
        "missingClips": missing,
    }))
}

#[tauri::command]
pub async fn check_summon(app: AppHandle, args: SummonArgs) -> Value {
    let lock = app.state::<DriveDataLock>();
    let _g = lock.0.lock().await;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&args.file_path);
        let cache_root = app2.state::<LoaderService>().cache_root.clone();
        let r = check_summon_core(path, args.clips_dir.as_deref(), &cache_root, &emitter(&app2));
        note_own_write(&app2, path);
        r.unwrap_or_else(|e| {
            logger::error("gps", format!("check summon failed: {e:#}"));
            json!({ "success": false, "error": format!("{e:#}") })
        })
    })
    .await
    .unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_timestamps_follow_v8_leniency() {
        let ms = |s: &str| parse_file_ts(s);
        assert_eq!(ms("2024-02-30_10-00-00-front.mp4"), ms("x/2024-03-01_10-00-00-front.mp4"));
        assert_eq!(ms("2024-01-01_24-00-00"), ms("2024-01-02_00-00-00"));
        assert!(ms("2024-13-01_10-00-00").is_none());
        assert!(ms("2024-01-01_23-60-00").is_none());
        assert!(ms("2024-01-01/front.mp4").is_none());
    }

    #[test]
    fn js_numbers_format_like_json_stringify() {
        assert_eq!(serde_json::to_string(&jnum(60.0)).unwrap(), "60");
        assert_eq!(serde_json::to_string(&jnum(-0.0)).unwrap(), "0");
        assert_eq!(serde_json::to_string(&jnum(13.25)).unwrap(), "13.25");
        assert_eq!(serde_json::to_string(&jnum(f64::NAN)).unwrap(), "null");
    }
}
