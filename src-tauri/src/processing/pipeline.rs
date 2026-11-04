//! The processing run itself (port of src/processing/process.js, worker.js
//! and process-result.cjs), independent of Tauri so it can be driven from
//! tests. Output is the same text process.js printed to stdout/stderr; the
//! caller forwards it to the renderer, which parses `SCAN N/M`, `(N%)` and
//! `SUMMARY:` exactly as before.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use super::discovery::{discover_processing_files, ClipFile};
use super::extract::{compute_ap_runs, compute_flag_runs, compute_gear_runs, extract_gps_from_file};
use crate::drive_data::{for_each_array_element, read_range, scan_sections, write_drive_data, Replacement};
use crate::loader::calc::{js_round, ApRun, FlagRun, GearRun};
use crate::loader::grouper::group_into_drives;
use crate::loader::route::{is_event_folder_path, normalize_clip_path, telemetry_has_driving, Route, RouteJson};

/// Only process clips on or after this date (YYYY-MM-DD, inclusive).
pub const CUTOFF_DATE: &str = "2025-12-01";
const CHECKPOINT_MS: u64 = 60_000;
/// Progress lines are coalesced to this rate (Electron's stdout pipe batched
/// them the same way); the renderer only shows the latest one anyway.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

pub type Sink<'a> = &'a (dyn Fn(Stream, &str) + Sync);

#[derive(Clone, Debug)]
pub struct Options {
    pub clips_dir: PathBuf,
    pub output_path: PathBuf,
    pub workers: usize,
    pub reprocess_all: bool,
}

/// `os.cpus().length - 1`, at least 1 (process.js's default worker count).
pub fn default_workers() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(1).max(1)
}

// ── console ─────────────────────────────────────────────────────────────────

struct Console<'a> {
    sink: Sink<'a>,
    pending: RefCell<Option<String>>,
    last_flush: Cell<Option<Instant>>,
}

impl<'a> Console<'a> {
    fn new(sink: Sink<'a>) -> Self {
        Console { sink, pending: RefCell::new(None), last_flush: Cell::new(None) }
    }
    /// process.stdout.write
    fn write(&self, text: &str) {
        self.flush();
        (self.sink)(Stream::Stdout, text);
    }
    /// console.log
    fn log(&self, line: &str) {
        self.write(&format!("{line}\n"));
    }
    /// console.error
    fn error(&self, line: &str) {
        self.flush();
        (self.sink)(Stream::Stderr, &format!("{line}\n"));
    }
    /// A `\r`-overwritten progress write; only the latest one per interval is sent.
    fn progress(&self, text: String) {
        *self.pending.borrow_mut() = Some(text);
        if self.last_flush.get().map_or(true, |t| t.elapsed() >= PROGRESS_INTERVAL) {
            self.flush();
        }
    }
    fn flush(&self) {
        if let Some(text) = self.pending.borrow_mut().take() {
            (self.sink)(Stream::Stdout, &text);
            self.last_flush.set(Some(Instant::now()));
        }
    }
}

// ── number / JSON formatting ────────────────────────────────────────────────

/// `JSON.stringify` of a JS number.
fn js_num(v: f64) -> String {
    if !v.is_finite() {
        return "null".into();
    }
    if v == 0.0 {
        return "0".into();
    }
    let a = v.abs();
    if (1e-6..1e21).contains(&a) {
        // Display is the shortest round-trip decimal, like Number#toString.
        format!("{v}")
    } else {
        let s = format!("{v:e}");
        match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        }
    }
}

/// `Number#toFixed` for the progress/statistics lines.
fn to_fixed(v: f64, digits: usize) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else {
        format!("{v:.digits$}")
    }
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// `String(value)` for a processedFiles/route `file` entry.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(js_num).unwrap_or_else(|| n.to_string()),
        Value::Array(items) => items.iter().map(|i| if i.is_null() { String::new() } else { js_string(i) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ── worker.js ───────────────────────────────────────────────────────────────

struct NewRoute {
    route: Route,
    /// The route exactly as process.js writes it (routeForDisk + JSON.stringify).
    json: Vec<u8>,
}

enum Outcome {
    Error,
    NoGps,
    Gps(Box<NewRoute>),
}

fn process_file(f: &ClipFile) -> Outcome {
    let data = match extract_gps_from_file(&f.full_path) {
        Ok(Some(d)) if !d.points.is_empty() => d,
        Ok(_) => return Outcome::NoGps,
        Err(_) => return Outcome::Error,
    };
    let gear_runs = compute_gear_runs(&data.gears);
    let flag_runs = compute_flag_runs(&data.flags, &data.speeds);
    let ap_runs = compute_ap_runs(&data.ap_states);
    let raw_frame_count = data.gears.len();
    let raw_park_count = data.gears.iter().filter(|&&g| g == 0).count();

    // deduplicatePoints: drop consecutive repeats of the same (lat, lon).
    let mut points = Vec::with_capacity(data.points.len());
    let (mut gears, mut aps, mut speeds, mut accels) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for i in 0..data.points.len() {
        if i > 0 && data.points[i][0] == data.points[i - 1][0] && data.points[i][1] == data.points[i - 1][1] {
            continue;
        }
        points.push(data.points[i]);
        gears.push(data.gears[i]);
        aps.push(data.ap_states[i]);
        speeds.push(data.speeds[i]);
        accels.push(data.accel_positions[i]);
    }

    let file = normalize_clip_path(&f.relative_path);
    let json = route_json(&file, &f.date_dir, &points, &gears, &aps, &speeds, &accels, raw_park_count, raw_frame_count, &gear_runs, &flag_runs, &ap_runs);
    let route = Route {
        file,
        date: Some(f.date_dir.clone()),
        points,
        gear_states: Some(gears),
        autopilot_states: Some(aps),
        speeds: Some(speeds),
        accel_positions: Some(accels),
        raw_park_count: Some(raw_park_count as f64),
        raw_frame_count: Some(raw_frame_count as f64),
        gear_runs: Some(gear_runs),
        flag_runs: Some(flag_runs),
        ap_runs: Some(ap_runs),
        ..Default::default()
    };
    Outcome::Gps(Box::new(NewRoute { route, json }))
}

#[allow(clippy::too_many_arguments)]
fn route_json(
    file: &str,
    date: &str,
    points: &[[f64; 2]],
    gears: &[u8],
    aps: &[u8],
    speeds: &[f64],
    accels: &[f64],
    raw_park_count: usize,
    raw_frame_count: usize,
    gear_runs: &[GearRun],
    flag_runs: &[FlagRun],
    ap_runs: &[ApRun],
) -> Vec<u8> {
    use std::fmt::Write;
    let nums = |xs: &[f64]| xs.iter().map(|&x| js_num(x)).collect::<Vec<_>>().join(",");
    let mut s = String::with_capacity(points.len() * 32 + 256);
    let _ = write!(s, "{{\"file\":{},\"date\":{},\"points\":[", json_str(file), json_str(date));
    for (i, p) in points.iter().enumerate() {
        let _ = write!(s, "{}[{},{}]", if i > 0 { "," } else { "" }, js_num(p[0]), js_num(p[1]));
    }
    let _ = write!(
        s,
        "],\"gearStates\":\"{}\",\"autopilotStates\":\"{}\",\"speeds\":[{}],\"accelPositions\":[{}],\"rawParkCount\":{},\"rawFrameCount\":{},\"gearRuns\":[",
        b64(gears),
        b64(aps),
        nums(speeds),
        nums(accels),
        raw_park_count,
        raw_frame_count
    );
    for (i, r) in gear_runs.iter().enumerate() {
        let _ = write!(s, "{}{{\"gear\":{},\"frames\":{}}}", if i > 0 { "," } else { "" }, r.gear.unwrap_or(0), js_num(r.frames));
    }
    s.push_str("],\"flagRuns\":[");
    for (i, r) in flag_runs.iter().enumerate() {
        let _ = write!(
            s,
            "{}{{\"flags\":{},\"frames\":{},\"maxMps\":{}}}",
            if i > 0 { "," } else { "" },
            r.flags,
            js_num(r.frames),
            js_num(r.max_mps.unwrap_or(f64::NAN))
        );
    }
    s.push_str("],\"apRuns\":[");
    for (i, r) in ap_runs.iter().enumerate() {
        let _ = write!(s, "{}{{\"ap\":{},\"frames\":{}}}", if i > 0 { "," } else { "" }, r.ap.unwrap_or(0), js_num(r.frames));
    }
    s.push_str("]}");
    s.into_bytes()
}

// ── existing drive-data.json ────────────────────────────────────────────────

#[derive(Default)]
struct Existing {
    /// processedFiles as `String(value)`, in file order (not deduplicated).
    processed_files: Vec<String>,
    processed_count: usize,
    /// Parsed routes in file order (incremental mode only).
    routes: Vec<Route>,
    route_count: usize,
    /// Existing routes that process.js would rewrite on save (non-canonical
    /// `file`, or byte fields still stored as number arrays), keyed by the
    /// normalized file, in file order.
    rewrites: Vec<(String, Vec<u8>)>,
    tag_count: usize,
    has_drive_tags: bool,
}

/// The `{...r, file, gearStates, autopilotStates}` rewrite process.js applies
/// to every existing route on save, or None when it would not change it.
fn canonical_route_bytes(v: &mut Value) -> Result<Option<(String, Vec<u8>)>> {
    let Some(obj) = v.as_object_mut() else { return Err(anyhow!("route is not an object")) };
    let raw_file = obj.get("file").map(js_string_or_empty).unwrap_or_default();
    let file = normalize_clip_path(&raw_file);
    let mut changed = !matches!(obj.get("file"), Some(Value::String(s)) if *s == file);
    for key in ["gearStates", "autopilotStates"] {
        if let Some(Value::Array(items)) = obj.get(key) {
            // Buffer.from(array): each element is ToNumber'd and wrapped to a byte.
            let bytes: Vec<u8> = items
                .iter()
                .map(|x| x.as_f64().filter(|f| f.is_finite()).map(|f| (f.trunc() as i64).rem_euclid(256) as u8).unwrap_or(0))
                .collect();
            obj.insert(key.into(), Value::String(b64(&bytes)));
            changed = true;
        }
    }
    if !changed {
        return Ok(None);
    }
    obj.insert("file".into(), Value::String(file.clone()));
    Ok(Some((file, serde_json::to_vec(v)?)))
}

/// normalizeClipPath(String(file ?? '')).
fn js_string_or_empty(v: &Value) -> String {
    if v.is_null() { String::new() } else { js_string(v) }
}

fn load_existing(path: &Path, reprocess_all: bool) -> Result<Option<Existing>> {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let sections = scan_sections(f.try_clone()?)?;
    let mut ex = Existing::default();
    for s in &sections {
        match s.key.as_str() {
            "processedFiles" => {
                for_each_array_element(&mut f, s, |el| {
                    ex.processed_count += 1;
                    if !reprocess_all {
                        let v: Value = serde_json::from_slice(el)?;
                        ex.processed_files.push(js_string_or_empty(&v));
                    }
                    Ok(())
                })?;
            }
            "routes" => {
                for_each_array_element(&mut f, s, |el| {
                    ex.route_count += 1;
                    if !reprocess_all {
                        let mut v: Value = serde_json::from_slice(el)?;
                        let route = RouteJson::deserialize(&v)?.into_route();
                        if let Some(rw) = canonical_route_bytes(&mut v)? {
                            ex.rewrites.push(rw);
                        }
                        ex.routes.push(route);
                    }
                    Ok(())
                })?;
            }
            "driveTags" => {
                ex.has_drive_tags = true;
                let v: Value = serde_json::from_slice(&read_range(&mut f, s)?)?;
                ex.tag_count = v.as_object().map_or(0, |o| o.len());
            }
            _ => {}
        }
    }
    Ok(Some(ex))
}

// ── saving ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct FileProbe {
    #[serde(default)]
    file: Option<Value>,
}

struct SaveInput<'a> {
    processed_files: &'a [String],
    reprocess_all: bool,
    add_drive_tags: bool,
    rewrites: &'a [(String, Vec<u8>)],
    new_routes: &'a [(String, Vec<u8>)],
}

/// streamWriteJSON: rewrite processedFiles and routes, keeping driveTags and
/// every other section byte-for-byte. Existing routes are streamed from the
/// file on disk (minus the ones replaced by this run or rewritten into
/// canonical form), then this run's routes are appended.
fn save(path: &Path, input: &SaveInput, cancel: &AtomicBool) -> Result<bool> {
    let mut overridden: HashSet<String> = HashSet::new();
    let mut extra: Vec<Vec<u8>> = Vec::with_capacity(input.rewrites.len() + input.new_routes.len());
    let new_files: HashSet<&str> = input.new_routes.iter().map(|(f, _)| f.as_str()).collect();
    if !input.reprocess_all {
        for (file, bytes) in input.rewrites {
            if !new_files.contains(file.as_str()) && overridden.insert(file.clone()) {
                extra.push(bytes.clone());
            }
        }
    }
    for (file, bytes) in input.new_routes {
        overridden.insert(file.clone());
        extra.push(bytes.clone());
    }
    let reprocess_all = input.reprocess_all;
    let mut seen: HashSet<String> = HashSet::new();
    let keep = move |el: &[u8]| -> Result<bool> {
        if reprocess_all {
            return Ok(false);
        }
        let probe: FileProbe = serde_json::from_slice(el)?;
        let file = normalize_clip_path(&probe.file.as_ref().map(js_string_or_empty).unwrap_or_default());
        Ok(!overridden.contains(&file) && seen.insert(file))
    };
    let mut replacements: Vec<(&'static str, Replacement)> = vec![
        ("processedFiles", Replacement::Value(json!(input.processed_files))),
        ("routes", Replacement::Filter { keep: Box::new(keep), extra, pretty: true }),
    ];
    if input.add_drive_tags {
        replacements.push(("driveTags", Replacement::Value(json!({}))));
    }
    write_drive_data(path, replacements, &|| !cancel.load(Ordering::SeqCst))
}

/// JS Map semantics for routes keyed by normalized file: a repeated key keeps
/// its first position and takes the latest value.
#[derive(Default)]
struct RouteMap {
    routes: Vec<Route>,
    index: HashMap<String, usize>,
}

impl RouteMap {
    fn set(&mut self, file: String, route: Route) {
        match self.index.get(&file) {
            Some(&i) => self.routes[i] = route,
            None => {
                self.index.insert(file, self.routes.len());
                self.routes.push(route);
            }
        }
    }
}

// ── process.js main ─────────────────────────────────────────────────────────

/// Run one processing pass. Returns the exit code process.js would have
/// produced, or None when cancelled (the Electron child was SIGTERM'd).
pub fn run(opts: &Options, cancel: &AtomicBool, sink: Sink) -> Option<i32> {
    let con = Console::new(sink);
    let code = match run_main(opts, cancel, &con) {
        Ok(code) => code,
        Err(e) => {
            if cancel.load(Ordering::SeqCst) {
                None
            } else {
                con.error(&format!("Fatal error: {e:#}"));
                Some(1)
            }
        }
    };
    con.flush();
    code
}

fn run_main(opts: &Options, cancel: &AtomicBool, con: &Console) -> Result<Option<i32>> {
    let start = Instant::now();
    let secs = || start.elapsed().as_secs_f64();
    let output_path = &opts.output_path;
    con.log("Drives Processor - Replicating Sentry USB drives processing");
    con.log(&format!("Clips directory: {}", opts.clips_dir.display()));
    con.log(&format!("Output: {}", output_path.display()));
    con.log(&format!("Workers: {}", opts.workers));
    con.log(&format!("Cutoff: {CUTOFF_DATE} (front camera only)"));
    con.log("");

    // Successful atomic writes rename their temp files; leftovers are stale.
    if let (Some(dir), Some(base)) = (output_path.parent(), output_path.file_name()) {
        let prefix = format!("{}.", base.to_string_lossy());
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(&prefix) && name.ends_with(".tmp") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    // Reprocess-all discards extracted routes but preserves user-authored tags.
    let (existing, file_existed) = match load_existing(output_path, opts.reprocess_all) {
        Ok(Some(ex)) => {
            if opts.reprocess_all {
                con.log(&format!(
                    "Reprocess-all mode: discarding {} processed files / {} routes (preserving {} drive tags)",
                    ex.processed_count, ex.route_count, ex.tag_count
                ));
            } else {
                con.log(&format!("Loaded existing data: {} processed files, {} routes", ex.processed_count, ex.route_count));
            }
            (ex, true)
        }
        Ok(None) => (Existing::default(), false),
        Err(e) => {
            // Only a missing file is a fresh start; abort so unreadable data
            // is never replaced by an empty dataset.
            con.error(&format!("Failed to read existing {}: {e:#}", output_path.display()));
            con.error("Aborting so the existing drive data is not overwritten.");
            return Ok(Some(1));
        }
    };
    let Existing { processed_files: existing_processed, routes: existing_routes, rewrites, has_drive_tags, .. } = existing;
    let add_drive_tags = file_existed && !has_drive_tags;

    let processed_set: HashSet<String> = existing_processed.iter().map(|f| normalize_clip_path(f)).collect();

    con.log("Scanning for front camera clips...");
    let discovery = discover_processing_files(&opts.clips_dir, CUTOFF_DATE, &existing_processed, &mut |current, total| {
        if total > 0 {
            con.write(&format!("\rSCAN {current}/{total}"));
        }
    })?;
    if discovery.recent_count > 0 {
        con.write("\n");
    }
    con.log(&format!(
        "Found {} RecentClips front camera clips{}",
        discovery.recent_count,
        if discovery.gap_fill_count > 0 { format!(" + {} event gap-fill candidate(s)", discovery.gap_fill_count) } else { String::new() }
    ));

    let new_files: Vec<ClipFile> = discovery.files.into_iter().filter(|f| !processed_set.contains(&f.relative_path)).collect();
    con.log(&format!("New files to process: {}", new_files.len()));

    if new_files.is_empty() {
        con.log("\nNo new files to process.");
        if !existing_routes.is_empty() {
            let g = group_into_drives(existing_routes);
            con.log(&format!("Existing drives: {} (from {} time groups)", g.drives.len(), g.time_group_count));
        }
        return Ok(Some(0));
    }

    let pool_size = opts.workers.max(1).min(new_files.len());
    con.log(&format!("\nProcessing {} files across {} workers (shared queue)...\n", new_files.len(), pool_size));

    let (mut files_with_gps, mut total_points, mut errors, mut parked_skipped, mut total_done) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut processed_files: Vec<String> = Vec::new();
    {
        let mut seen = HashSet::new();
        for f in &existing_processed {
            let n = normalize_clip_path(f);
            if seen.insert(n.clone()) {
                processed_files.push(n);
            }
        }
    }
    drop(existing_processed);
    let mut route_map = RouteMap::default();
    for r in existing_routes {
        let file = normalize_clip_path(&r.file);
        route_map.set(file.clone(), Route { file, ..r });
    }
    let mut new_routes: Vec<(String, Vec<u8>)> = Vec::new();
    let mut last_checkpoint = Instant::now();

    let next = AtomicUsize::new(0);
    let n = new_files.len();
    std::thread::scope(|scope| -> Result<()> {
        let (tx, rx) = mpsc::channel::<(usize, Outcome)>();
        for _ in 0..pool_size {
            let tx = tx.clone();
            let (next, files) = (&next, &new_files);
            scope.spawn(move || loop {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= files.len() {
                    break;
                }
                if tx.send((i, process_file(&files[i]))).is_err() {
                    break;
                }
            });
        }
        drop(tx);

        for (i, outcome) in rx {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            total_done += 1;
            let path = normalize_clip_path(&new_files[i].relative_path);
            match outcome {
                // A failed extraction must NOT be marked processed: leaving it
                // out lets the next run rediscover and retry the clip.
                Outcome::Error => errors += 1,
                Outcome::NoGps => processed_files.push(path),
                Outcome::Gps(nr) => {
                    processed_files.push(path.clone());
                    if is_event_folder_path(&path) && !telemetry_has_driving(&nr.route) {
                        parked_skipped += 1;
                    } else {
                        files_with_gps += 1;
                        total_points += nr.route.points.len();
                        new_routes.push((path.clone(), nr.json));
                        route_map.set(path, nr.route);
                    }
                }
            }

            let pct = js_round(total_done as f64 / n as f64 * 100.0);
            let elapsed_s = secs();
            let rate = to_fixed(total_done as f64 / elapsed_s, 0);
            con.progress(format!("\r  Progress: {total_done}/{n} ({pct}%) | {rate} files/sec | {}s elapsed", to_fixed(elapsed_s, 0)));

            if last_checkpoint.elapsed() >= Duration::from_millis(CHECKPOINT_MS) {
                let input = SaveInput {
                    processed_files: &processed_files,
                    reprocess_all: opts.reprocess_all,
                    add_drive_tags,
                    rewrites: &rewrites,
                    new_routes: &new_routes,
                };
                // Checkpoint failures are ignored, as in process.js.
                if let Ok(true) = save(output_path, &input, cancel) {
                    con.log(&format!("\n  Checkpoint saved ({total_done} files)"));
                }
                last_checkpoint = Instant::now();
            }
        }
        Ok(())
    })?;

    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }

    let route_count = route_map.routes.len();
    con.log("\n\nExtraction complete:");
    con.log(&format!("  Files processed: {total_done}"));
    con.log(&format!("  Files with GPS:  {files_with_gps}"));
    con.log(&format!("  Total points:    {total_points}"));
    con.log(&format!("  Errors:          {errors}"));
    con.log(&format!("  Parked event gap-fill clips skipped: {parked_skipped}"));

    con.log("\nGrouping into drives...");
    let g = group_into_drives(route_map.routes);
    con.log(&format!("  Drives found: {} (from {} time groups, {} routes)", g.drives.len(), g.time_group_count, route_count));
    if g.dropped_count > 0 {
        con.log(&format!("  Routes without timestamps (dropped): {}", g.dropped_count));
    }

    let field = |d: &crate::loader::grouper::GroupedDrive, k: &str| d.fields.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let mut t = [0.0f64; 8];
    for d in &g.drives {
        for (slot, key) in t.iter_mut().zip([
            "distanceKm",
            "distanceMi",
            "durationMs",
            "fsdEngagedMs",
            "fsdDistanceKm",
            "fsdDistanceMi",
            "fsdDisengagements",
            "fsdAccelPushes",
        ]) {
            *slot += field(d, key);
        }
    }
    let [dist_km, dist_mi, dur_ms, fsd_ms, fsd_km, fsd_mi, diseng, pushes] = t;
    con.log("\nAggregate Statistics:");
    con.log(&format!("  Total drives:       {}", g.drives.len()));
    con.log(&format!("  Total routes:       {route_count}"));
    con.log(&format!("  Total distance:     {} mi / {} km", to_fixed(dist_mi, 1), to_fixed(dist_km, 1)));
    con.log(&format!("  Total duration:     {} hours", to_fixed(dur_ms / 3_600_000.0, 1)));
    con.log(&format!("  FSD engaged:        {} hours", to_fixed(fsd_ms / 3_600_000.0, 1)));
    con.log(&format!("  FSD distance:       {} mi / {} km", to_fixed(fsd_mi, 1), to_fixed(fsd_km, 1)));
    con.log(&format!("  FSD %:              {}%", if dist_km > 0.0 { to_fixed(fsd_km / dist_km * 100.0, 1) } else { "0".into() }));
    con.log(&format!("  Disengagements:     {}", js_num(diseng)));
    con.log(&format!("  Accel pushes:       {}", js_num(pushes)));

    con.log(&format!("\nSaving to {}...", output_path.display()));
    let input = SaveInput {
        processed_files: &processed_files,
        reprocess_all: opts.reprocess_all,
        add_drive_tags,
        rewrites: &rewrites,
        new_routes: &new_routes,
    };
    if !save(output_path, &input, cancel)? {
        return Ok(None); // stopped while saving: the temp file was discarded
    }

    let elapsed = to_fixed(secs(), 1);
    con.log(&format!("\nDone in {elapsed}s"));
    // Machine-readable outcome consumed by the main-process log.
    let no_sei = total_done - files_with_gps;
    let mut summary = format!("SUMMARY: scanned {total_done} clip(s) → {} drive(s)", g.drives.len());
    if no_sei > 0 {
        summary.push_str(&format!(", {no_sei} without GPS"));
    }
    if errors > 0 {
        summary.push_str(&format!(", {errors} error(s)"));
    }
    if parked_skipped > 0 {
        summary.push_str(&format!(", {parked_skipped} parked event candidate(s) skipped"));
    }
    if g.dropped_count > 0 {
        summary.push_str(&format!(", {} dropped", g.dropped_count));
    }
    summary.push_str(&format!(" in {elapsed}s"));
    con.log(&summary);
    Ok(Some(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn js_number_formatting() {
        assert_eq!(js_num(0.0), "0");
        assert_eq!(js_num(-0.0), "0");
        assert_eq!(js_num(12.0), "12");
        assert_eq!(js_num(53.546123), "53.546123");
        assert_eq!(js_num(-113.493877), "-113.493877");
        assert_eq!(js_num(0.000001), "0.000001");
        assert_eq!(js_num(1e-7), "1e-7");
        assert_eq!(js_num(1e21), "1e+21");
        assert_eq!(js_num(f64::NAN), "null");
        assert_eq!(to_fixed(f64::INFINITY, 0), "Infinity");
    }

    fn base_route(file: &str) -> Route {
        Route {
            file: file.into(),
            points: vec![[39.0, -76.0]],
            gear_runs: Some(vec![GearRun { gear: Some(1), frames: 60.0 }]),
            gear_states: Some(vec![1]),
            autopilot_states: Some(vec![0]),
            speeds: Some(vec![4.0]),
            raw_park_count: Some(0.0),
            raw_frame_count: Some(60.0),
            ..Default::default()
        }
    }

    // process-result.test.js: parked event clips are processed without routes.
    #[test]
    fn parked_event_detection_matches_process_result() {
        let mut parked = base_route("SavedClips/event/2026-07-27_14-02-02-front.mp4");
        parked.gear_runs = Some(vec![GearRun { gear: Some(0), frames: 60.0 }]);
        parked.gear_states = Some(vec![0]);
        parked.speeds = Some(vec![0.0]);
        parked.raw_park_count = Some(60.0);
        assert!(is_event_folder_path(&parked.file) && !telemetry_has_driving(&parked));
        assert!(telemetry_has_driving(&base_route("SavedClips/event/2026-07-27_14-02-02-front.mp4")));
        assert_eq!(normalize_clip_path("RecentClips\\2026-07-27\\2026-07-27_14-01-02-front.mp4"), "2026-07-27/2026-07-27_14-01-02-front.mp4");
    }

    #[test]
    fn route_json_matches_process_js_shape() {
        let flag_runs = vec![FlagRun { flags: 3, frames: 30.0, max_mps: Some(0.4) }, FlagRun { flags: 0, frames: 30.0, max_mps: Some(2.1) }];
        let ap_runs = vec![ApRun { ap: Some(0), frames: 10.0 }, ApRun { ap: Some(1), frames: 50.0 }];
        let gear_runs = vec![GearRun { gear: Some(1), frames: 60.0 }];
        let bytes = route_json("2026-07-27/a-front.mp4", "2026-07-27", &[[39.0, -76.5]], &[1], &[0], &[4.0], &[0.0], 0, 60, &gear_runs, &flag_runs, &ap_runs);
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"file":"2026-07-27/a-front.mp4","date":"2026-07-27","points":[[39,-76.5]],"gearStates":"AQ==","autopilotStates":"AA==","speeds":[4],"accelPositions":[0],"rawParkCount":0,"rawFrameCount":60,"gearRuns":[{"gear":1,"frames":60}],"flagRuns":[{"flags":3,"frames":30,"maxMps":0.4},{"flags":0,"frames":30,"maxMps":2.1}],"apRuns":[{"ap":0,"frames":10},{"ap":1,"frames":50}]}"#
        );
    }

    #[test]
    fn existing_routes_are_canonicalized_like_route_for_disk() {
        let mut v = json!({"file": "RecentClips\\2026-01-01\\x-front.mp4", "gearStates": [1, 257, -1], "points": []});
        let (file, bytes) = canonical_route_bytes(&mut v).unwrap().unwrap();
        assert_eq!(file, "2026-01-01/x-front.mp4");
        assert_eq!(String::from_utf8(bytes).unwrap(), r#"{"file":"2026-01-01/x-front.mp4","gearStates":"AQH/","points":[]}"#);
        let mut ok = json!({"file": "2026-01-01/x-front.mp4", "gearStates": "AQ=="});
        assert!(canonical_route_bytes(&mut ok).unwrap().is_none());
    }

    #[test]
    fn save_merges_new_routes_and_keeps_other_sections() {
        let dir = std::env::temp_dir().join(format!("sd-processing-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("drive-data.json");
        std::fs::write(
            &p,
            r#"{"processedFiles":["RecentClips/a.mp4","b.mp4"],"routes":[{"file":"a.mp4","n":1},{"file":"b.mp4","n":2},{"file":"b.mp4","n":3},{"file":"RecentClips/c.mp4","gearStates":[0]}],"driveTags":{"t":["x"]},"homeLocation":{"lat":1}}"#,
        )
        .unwrap();
        let ex = load_existing(&p, false).unwrap().unwrap();
        assert_eq!((ex.processed_count, ex.route_count, ex.tag_count), (2, 4, 1));
        assert_eq!(ex.rewrites.len(), 1);
        let new_routes = vec![("a.mp4".to_string(), br#"{"file":"a.mp4","n":9}"#.to_vec())];
        let processed = vec!["a.mp4".to_string(), "b.mp4".to_string(), "d.mp4".to_string()];
        let input = SaveInput { processed_files: &processed, reprocess_all: false, add_drive_tags: false, rewrites: &ex.rewrites, new_routes: &new_routes };
        let cancel = AtomicBool::new(false);
        assert!(save(&p, &input, &cancel).unwrap());
        let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        let files: Vec<(String, Value)> = v["routes"].as_array().unwrap().iter().map(|r| (r["file"].as_str().unwrap().to_string(), r["n"].clone())).collect();
        assert_eq!(
            files,
            vec![("b.mp4".into(), json!(2)), ("c.mp4".into(), Value::Null), ("a.mp4".into(), json!(9))]
        );
        assert_eq!(v["routes"][1]["gearStates"], "AA==");
        assert_eq!(v["driveTags"]["t"][0], "x");
        assert_eq!(v["homeLocation"]["lat"], 1);
        assert_eq!(v["processedFiles"].as_array().unwrap().len(), 3);

        // Reprocess-all drops every existing route but keeps the tags.
        let input = SaveInput { processed_files: &[], reprocess_all: true, add_drive_tags: false, rewrites: &[], new_routes: &[] };
        assert!(save(&p, &input, &cancel).unwrap());
        let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["routes"], json!([]));
        assert_eq!(v["driveTags"]["t"][0], "x");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_clips_dir_is_fatal_and_unreadable_data_aborts() {
        let dir = std::env::temp_dir().join(format!("sd-processing-run-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = Mutex::new(String::new());
        let sink = |_s: Stream, t: &str| out.lock().unwrap().push_str(t);
        let opts = Options { clips_dir: dir.join("missing"), output_path: dir.join("drive-data.json"), workers: 1, reprocess_all: false };
        assert_eq!(run(&opts, &AtomicBool::new(false), &sink), Some(1));
        assert!(out.lock().unwrap().contains("Fatal error:"));

        std::fs::write(dir.join("drive-data.json"), "{\"routes\": [").unwrap();
        out.lock().unwrap().clear();
        assert_eq!(run(&opts, &AtomicBool::new(false), &sink), Some(1));
        assert!(out.lock().unwrap().contains("Aborting so the existing drive data is not overwritten."));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Parity harness (see the processing port notes): run against a sample
    /// TeslaCam tree and compare with `node src/processing/process.js`.
    ///
    ///   PARITY_CLIPS=<dir> PARITY_OUT=<out.json> cargo test --release --lib \
    ///     processing::pipeline::tests::parity_run -- --ignored --nocapture
    #[test]
    #[ignore]
    fn parity_run() {
        let clips = std::env::var("PARITY_CLIPS").expect("PARITY_CLIPS");
        let out = std::env::var("PARITY_OUT").expect("PARITY_OUT");
        let workers = std::env::var("PARITY_WORKERS").ok().and_then(|w| w.parse().ok()).unwrap_or(2);
        let reprocess_all = std::env::var("PARITY_REPROCESS_ALL").is_ok();
        let sink = |s: Stream, t: &str| match s {
            Stream::Stdout => print!("{t}"),
            Stream::Stderr => eprint!("{t}"),
        };
        let opts = Options { clips_dir: clips.into(), output_path: out.into(), workers, reprocess_all };
        assert_eq!(run(&opts, &AtomicBool::new(false), &sink), Some(0));
    }
}
