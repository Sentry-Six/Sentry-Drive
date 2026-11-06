//! Tessie (CSV export and REST API) and Teslascope imports: port of the
//! `tessie-*` / `teslascope-*` handlers in `src/main/electron-main.cjs`.
//!
//! Each handler is a plain function over its JSON args (`*_core`) so the
//! parity harness can run it without a Tauri app; the commands at the bottom
//! add the drive-data lock, progress events and the own-write watcher note.
//! Like Electron, nothing here touches the loader index: the renderer
//! reloads the file after an import or removal.

pub mod clips;
pub mod csv;
pub mod http;
pub mod js;
pub mod teslascope_api;
pub mod tessie_api;

use std::collections::HashSet;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::drive_data::{self, for_each_array_element, scan_sections, Replacement};
use crate::loader::grouper::group_into_drives;
use crate::loader::route::{parse_local_iso, Route, RouteJson};
use crate::logger;
use clips::{build_clips_for_api_drive, build_clips_for_drive, build_existing_drive_ranges, calibrate_drive_time, external_signature, has_overlap, Built, Odo, Range};
use http::{Http, UreqHttp};
use js::to_string;

/// Cancel flags (one per importer, like the JS module flags), the overlap
/// index cache and Teslascope's remembered auth style.
#[derive(Default)]
pub struct ImportState {
    pub tessie_csv_cancel: AtomicBool,
    pub tessie_api_cancel: AtomicBool,
    pub teslascope_cancel: AtomicBool,
    pub overlap_cache: OverlapCache,
    pub teslascope_auth: teslascope_api::AuthState,
}

pub type Emit<'a> = &'a (dyn Fn(Value) + Sync);

// ── drive-data.json access ─────────────────────────────────────────────────

/// Every route in the file, streamed (non-object elements are skipped).
pub fn read_routes(path: &Path) -> anyhow::Result<Vec<Route>> {
    let mut f = File::open(path)?;
    let sections = scan_sections(f.try_clone()?)?;
    let mut out = Vec::new();
    if let Some(s) = sections.iter().find(|s| s.key == "routes") {
        for_each_array_element(&mut f, s, |el| {
            if let Ok(r) = serde_json::from_slice::<RouteJson>(el) {
                out.push(r.into_route());
            }
            Ok(())
        })?;
    }
    Ok(out)
}

/// `data.driveTags && typeof data.driveTags === 'object' ? data.driveTags : {}`.
fn read_drive_tags(path: &Path) -> anyhow::Result<Value> {
    if !path.exists() {
        return Ok(json!({}));
    }
    Ok(match drive_data::read_top_level_values(path, &["driveTags"])?.remove("driveTags") {
        Some(v @ (Value::Object(_) | Value::Array(_))) => v,
        _ => json!({}),
    })
}

type Keep = Box<dyn FnMut(&[u8]) -> anyhow::Result<bool> + Send>;

fn keep_all() -> Keep {
    Box::new(|_: &[u8]| Ok(true))
}

/// Append clips to `routes` and their files to `processedFiles` (the
/// read-push-write of saveImportedClips / tessie-import), rewriting
/// `driveTags` as Electron's writer does.
pub fn append_clips(path: &Path, clips: &[Value]) -> anyhow::Result<()> {
    let routes = clips.iter().map(serde_json::to_vec).collect::<Result<Vec<_>, _>>()?;
    let files = clips.iter().map(|c| serde_json::to_vec(&c["file"])).collect::<Result<Vec<_>, _>>()?;
    let tags = read_drive_tags(path)?;
    drive_data::write_drive_data(
        path,
        vec![
            ("processedFiles", Replacement::Filter { keep: keep_all(), extra: files, pretty: false }),
            ("routes", Replacement::Filter { keep: keep_all(), extra: routes, pretty: true }),
            ("driveTags", Replacement::Value(tags)),
        ],
        &|| true,
    )?;
    Ok(())
}

fn backup(path: &Path) -> anyhow::Result<()> {
    std::fs::copy(path, format!("{}.bak", path.display()))?;
    Ok(())
}

/// Existing drives' time ranges and import signatures.
pub struct OverlapIndex {
    pub ranges: Vec<Range>,
    pub signatures: HashSet<String>,
}

impl OverlapIndex {
    fn empty() -> Self {
        OverlapIndex { ranges: Vec::new(), signatures: HashSet::new() }
    }

    fn from_routes(routes: Vec<Route>) -> Self {
        let signatures = routes.iter().filter_map(|r| r.external_signature.clone()).collect();
        let ranges = build_existing_drive_ranges(&group_into_drives(routes).drives);
        OverlapIndex { ranges, signatures }
    }

    pub fn read(path: &Path) -> anyhow::Result<Self> {
        Ok(Self::from_routes(read_routes(path)?))
    }

    fn skip(&self, sig: &str, started_at: f64, ended_at: f64) -> Option<&'static str> {
        if self.signatures.contains(sig) {
            Some("duplicate")
        } else if has_overlap(started_at, ended_at, &self.ranges) {
            Some("overlap")
        } else {
            None
        }
    }
}

/// getOverlapIndex: the derived index cached by path, mtime and size.
#[derive(Default)]
pub struct OverlapCache(Mutex<Option<(String, Arc<OverlapIndex>)>>);

impl OverlapCache {
    pub fn get(&self, path: Option<&str>) -> anyhow::Result<Arc<OverlapIndex>> {
        let Some(path) = path.filter(|p| Path::new(p).exists()) else {
            return Ok(Arc::new(OverlapIndex::empty()));
        };
        let meta = std::fs::metadata(path)?;
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).unwrap_or_default();
        let key = format!("{path}|{}|{}", mtime.as_nanos(), meta.len());
        if let Some((k, ix)) = self.0.lock().unwrap().as_ref() {
            if *k == key {
                return Ok(ix.clone());
            }
        }
        let ix = Arc::new(OverlapIndex::read(Path::new(path))?);
        *self.0.lock().unwrap() = Some((key, ix.clone()));
        Ok(ix)
    }
}

// ── arg helpers ────────────────────────────────────────────────────────────

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key)
}

fn arg_path(args: &Value, key: &str) -> Option<String> {
    arg(args, key).and_then(Value::as_str).map(String::from)
}

const PATH_TYPE_ERROR: &str = "The \"path\" argument must be of type string or an instance of Buffer or URL. Received undefined";

/// `fs.readFileSync(p, 'utf-8')` with Node's error text for the common cases.
fn read_text(path: Option<&str>) -> Result<String, String> {
    let path = path.ok_or_else(|| PATH_TYPE_ERROR.to_string())?;
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(format!("ENOENT: no such file or directory, open '{path}'")),
        Err(e) => Err(e.to_string()),
    }
}

fn exists(path: Option<&str>) -> Option<&Path> {
    path.map(Path::new).filter(|p| p.exists())
}

fn basename(p: Option<&str>) -> String {
    p.map(|p| Path::new(p).file_name().map_or(p.to_string(), |n| n.to_string_lossy().into_owned())).unwrap_or_default()
}

/// `String(v).slice(-6)`.
fn tail6(v: Option<&Value>) -> String {
    let s = to_string(v);
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(6)..].iter().collect()
}

fn fail(e: impl std::fmt::Display) -> Value {
    json!({ "success": false, "error": e.to_string() })
}

fn bump(reasons: &mut Map<String, Value>, key: &str) {
    let n = reasons.get(key).and_then(Value::as_u64).unwrap_or(0);
    reasons.insert(key.to_string(), json!(n + 1));
}

fn eta(i: usize, n: usize, start: Instant) -> Value {
    if i == 0 {
        return json!(0);
    }
    let elapsed = start.elapsed().as_millis() as f64;
    js::num(crate::loader::calc::js_round((elapsed / i as f64) * (n - i) as f64 / 1000.0))
}

fn progress(phase: &str, current: usize, total: usize) -> Value {
    json!({ "phase": phase, "current": current, "total": total })
}

/// Throttler: at most one request per `rate`.
struct Throttler {
    rate: Duration,
    last: Option<Instant>,
}

impl Throttler {
    fn wait(&mut self) {
        if let Some(last) = self.last {
            let elapsed = last.elapsed();
            if elapsed < self.rate {
                std::thread::sleep(self.rate - elapsed);
            }
        }
        self.last = Some(Instant::now());
    }
}

// ── Tessie CSV ─────────────────────────────────────────────────────────────

struct CsvInput {
    drives: Vec<clips::Drive>,
    states: Vec<clips::StatePoint>,
}

fn read_csvs(args: &Value) -> Result<CsvInput, String> {
    let drives_text = read_text(arg_path(args, "drivesCsvPath").as_deref())?;
    let states_text = read_text(arg_path(args, "statesCsvPath").as_deref())?;
    let raw = csv::parse_drives_csv(&drives_text)?;
    let states = csv::parse_driving_states_csv(&states_text);
    // Calibrate timestamps before overlap checks.
    let drives = raw.iter().map(|d| calibrate_drive_time(d, &states)).collect();
    Ok(CsvInput { drives, states })
}

fn csv_signature(d: &clips::Drive) -> Result<String, String> {
    external_signature(d.started_at, &Odo::from_opt(d.starting_odometer), "tessie")
}

pub fn tessie_preview_core(args: &Value) -> Value {
    let run = || -> Result<Value, String> {
        let input = read_csvs(args)?;
        let index = match exists(arg_path(args, "driveDataPath").as_deref()) {
            Some(p) => OverlapIndex::read(p).map_err(|e| e.to_string())?,
            None => OverlapIndex::empty(),
        };
        let (mut to_import, mut overlap, mut duplicate) = (0, 0, 0);
        for d in &input.drives {
            match index.skip(&csv_signature(d)?, d.started_at, d.ended_at) {
                Some("duplicate") => duplicate += 1,
                Some(_) => overlap += 1,
                None => to_import += 1,
            }
        }
        Ok(json!({
            "success": true,
            "totalDrives": input.drives.len(),
            "toImport": to_import,
            "overlapSkipped": overlap,
            "duplicateSkipped": duplicate,
            "statePointCount": input.states.len(),
        }))
    };
    run().unwrap_or_else(fail)
}

/// tessie-import (CSV). Runs under the drive-data lock; returns the result
/// and the path written (for the watcher), if any.
pub fn tessie_import_core(args: &Value, cancel: &AtomicBool, emit: Emit) -> (Value, Option<PathBuf>) {
    cancel.store(false, Ordering::SeqCst);
    let drive_data_path = arg_path(args, "driveDataPath");
    let run = || -> Result<Value, String> {
        logger::info(
            "import",
            format!(
                "tessie csv import: {} + {}",
                basename(arg_path(args, "drivesCsvPath").as_deref()),
                basename(arg_path(args, "statesCsvPath").as_deref())
            ),
        );
        emit(progress("Reading CSVs…", 0, 1));
        let input = read_csvs(args)?;
        let index = match exists(drive_data_path.as_deref()) {
            Some(p) => {
                backup(p).map_err(|e| e.to_string())?;
                OverlapIndex::read(p).map_err(|e| e.to_string())?
            }
            None => OverlapIndex::empty(),
        };
        let mut candidates = Vec::new();
        for d in &input.drives {
            if index.skip(&csv_signature(d)?, d.started_at, d.ended_at).is_none() {
                candidates.push(d);
            }
        }
        let n = candidates.len();
        emit(progress("Building clips…", 0, n));

        let mut imported = 0;
        let mut canceled = false;
        let mut reasons = Map::new();
        let mut new_clips: Vec<Value> = Vec::new();
        let start = Instant::now();
        for (i, d) in candidates.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                canceled = true;
                break;
            }
            let mut p = progress("Building clips…", i + 1, n);
            p["etaSec"] = eta(i, n, start);
            emit(p);
            match build_clips_for_drive(d, &input.states, "tessie")? {
                Built::Skip(reason) => bump(&mut reasons, reason),
                Built::Clips { clips, .. } => {
                    new_clips.extend(clips);
                    imported += 1;
                }
            }
        }
        emit(progress("Saving…", n, n));
        let path = drive_data_path.as_deref().ok_or_else(|| PATH_TYPE_ERROR.to_string())?;
        append_clips(Path::new(path), &new_clips).map_err(|e| e.to_string())?;
        Ok(json!({
            "success": true,
            "imported": imported,
            "canceled": canceled,
            "totalCandidates": n,
            "skipReasons": reasons,
        }))
    };
    let result = run();
    cancel.store(false, Ordering::SeqCst);
    match result {
        Ok(v) => (v, drive_data_path.map(PathBuf::from)),
        Err(e) => (fail(e), None),
    }
}

// ── Removal ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RouteTag {
    #[serde(default)]
    source: Value,
    #[serde(default, rename = "externalSignature")]
    external_signature: Value,
}

fn route_tag(el: &[u8]) -> Option<RouteTag> {
    serde_json::from_slice::<RouteTag>(el).ok()
}

fn ms_or_nan(iso: &str) -> f64 {
    parse_local_iso(iso).map_or(f64::NAN, |v| v as f64)
}

/// {tessie,teslascope}-remove-hidden: drop imported drives that overlap SEI
/// footage (only SEI counts as coverage).
pub fn remove_hidden_core(path: Option<&str>, source: &'static str) -> (Value, bool) {
    let Some(p) = exists(path) else { return (fail("File not found"), false) };
    let run = || -> anyhow::Result<(Value, bool)> {
        let drives = group_into_drives(read_routes(p)?).drives;
        let mut sei: Vec<(f64, f64)> = drives
            .iter()
            .filter(|d| d.source == "sei" && !d.start_time.is_empty() && !d.end_time.is_empty())
            .filter_map(|d| Some((parse_local_iso(&d.start_time)? as f64, parse_local_iso(&d.end_time)? as f64)))
            .collect();
        sei.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut hidden: HashSet<String> = HashSet::new();
        for d in drives.iter().filter(|d| d.source == source) {
            let (s, e) = (ms_or_nan(&d.start_time), ms_or_nan(&d.end_time));
            for r in &sei {
                // NaN compares false both ways, like JS.
                if r.1 <= s {
                    continue;
                }
                if r.0 >= e {
                    break;
                }
                if let Some(sig) = d.fields.get("externalSignature").and_then(Value::as_str) {
                    hidden.insert(sig.to_string());
                }
                break;
            }
        }
        if hidden.is_empty() {
            return Ok((json!({ "success": true, "removed": 0 }), false));
        }
        backup(p)?;
        let removed_routes = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter = removed_routes.clone();
        let sigs = hidden.clone();
        drive_data::write_drive_data(
            p,
            vec![
                ("processedFiles", Replacement::Filter { keep: keep_all(), extra: Vec::new(), pretty: false }),
                (
                    "routes",
                    Replacement::Filter {
                        keep: Box::new(move |el: &[u8]| {
                            let drop = route_tag(el).is_some_and(|t| {
                                t.source.as_str() == Some(source) && t.external_signature.as_str().is_some_and(|s| sigs.contains(s))
                            });
                            if drop {
                                counter.fetch_add(1, Ordering::Relaxed);
                            }
                            Ok(!drop)
                        }),
                        extra: Vec::new(),
                        pretty: true,
                    },
                ),
                ("driveTags", Replacement::Value(read_drive_tags(p)?)),
            ],
            &|| true,
        )?;
        Ok((
            json!({ "success": true, "removed": hidden.len(), "removedRoutes": removed_routes.load(Ordering::Relaxed) }),
            true,
        ))
    };
    run().unwrap_or_else(|e| (fail(format!("{e:#}")), false))
}

fn norm_slashes(s: &str) -> String {
    s.replace('\\', "/")
}

/// {tessie,teslascope}-remove-all: every clip from the source, and its
/// processedFiles entries. `removed` counts grouped drives.
pub fn remove_all_core(path: Option<&str>, source: &'static str) -> (Value, bool) {
    let Some(p) = exists(path) else { return (fail("File not found"), false) };
    let run = || -> anyhow::Result<(Value, bool)> {
        backup(p)?;
        let routes = read_routes(p)?;
        let files: HashSet<String> = routes
            .iter()
            .filter(|r| r.source.as_deref() == Some(source))
            .map(|r| norm_slashes(&r.file))
            .collect();
        if files.is_empty() {
            return Ok((json!({ "success": true, "removed": 0 }), false));
        }
        let removed = group_into_drives(routes).drives.iter().filter(|d| d.source == source).count();
        drive_data::write_drive_data(
            p,
            vec![
                (
                    "processedFiles",
                    Replacement::Filter {
                        keep: Box::new(move |el: &[u8]| {
                            // `(f || '')`; other non-strings would throw in JS and are kept here.
                            let key = match serde_json::from_slice::<Value>(el)? {
                                Value::String(s) => norm_slashes(&s),
                                v if !js::truthy(Some(&v)) => String::new(),
                                _ => return Ok(true),
                            };
                            Ok(!files.contains(&key))
                        }),
                        extra: Vec::new(),
                        pretty: false,
                    },
                ),
                (
                    "routes",
                    Replacement::Filter {
                        keep: Box::new(move |el: &[u8]| Ok(route_tag(el).is_none_or(|t| t.source.as_str() != Some(source)))),
                        extra: Vec::new(),
                        pretty: true,
                    },
                ),
                ("driveTags", Replacement::Value(read_drive_tags(p)?)),
            ],
            &|| true,
        )?;
        Ok((json!({ "success": true, "removed": removed }), true))
    };
    run().unwrap_or_else(|e| (fail(format!("{e:#}")), false))
}

// ── API imports ────────────────────────────────────────────────────────────

/// What the fetch half of an API import produced; the save half runs under
/// the drive-data lock.
pub struct FetchOutcome {
    pub imported: usize,
    pub canceled: bool,
    pub total_candidates: usize,
    pub skip_reasons: Map<String, Value>,
    pub clips: Vec<Value>,
}

impl FetchOutcome {
    fn result(&self) -> Value {
        json!({
            "success": true,
            "imported": self.imported,
            "canceled": self.canceled,
            "totalCandidates": self.total_candidates,
            "skipReasons": self.skip_reasons,
        })
    }
}

/// saveImportedClips: re-read under the lock after the API fetch so
/// intervening edits survive.
pub fn save_imported_clips(path: Option<&str>, clips: &[Value], emit: Emit) -> Result<PathBuf, String> {
    logger::info("import", format!("saving {} imported clip(s) → {}", clips.len(), path.unwrap_or("undefined")));
    let path = path.ok_or_else(|| PATH_TYPE_ERROR.to_string())?;
    let p = Path::new(path);
    if p.exists() {
        backup(p).map_err(|e| e.to_string())?;
        let total = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        if total > 0 {
            emit(json!({ "phase": "Saving — reading current data…", "current": total, "total": total }));
        }
    }
    emit(progress("Saving — writing drive data…", 0, 0));
    append_clips(p, clips).map_err(|e| e.to_string())?;
    Ok(p.to_path_buf())
}

fn tessie_token(args: &Value) -> String {
    to_string(arg(args, "token"))
}

pub fn tessie_api_validate_core(http: &dyn Http, args: &Value) -> Value {
    let token = tessie_token(args);
    match tessie_api::fetch_vehicles(http, &token).and_then(|v| tessie_api::vehicle_summaries(&v)) {
        Ok(vehicles) => json!({ "success": true, "vehicles": vehicles }),
        Err(e) => fail(e),
    }
}

pub fn tessie_api_preview_core(http: &dyn Http, cache: &OverlapCache, args: &Value) -> Value {
    let (vin, from, to) = (to_string(arg(args, "vin")), arg(args, "fromSec"), arg(args, "toSec"));
    let run = || -> Result<Value, String> {
        logger::info("import", format!("tessie preview: vehicle …{}, window {}→{}", tail6(arg(args, "vin")), to_string(from), to_string(to)));
        let drives = tessie_api::fetch_drives(http, &tessie_token(args), &vin, from, to)?;
        let index = cache.get(arg_path(args, "driveDataPath").as_deref()).map_err(|e| e.to_string())?;
        let (mut to_import, mut overlap, mut duplicate) = (0, 0, 0);
        for d in &drives {
            let (s, e, odo) = tessie_api::overlap_key(d)?;
            match index.skip(&external_signature(s, &odo, "tessie")?, s, e) {
                Some("duplicate") => duplicate += 1,
                Some(_) => overlap += 1,
                None => to_import += 1,
            }
        }
        logger::info(
            "import",
            format!("tessie preview result: {} drives, {to_import} to import, {overlap} overlap-skipped, {duplicate} duplicates", drives.len()),
        );
        Ok(json!({ "success": true, "totalDrives": drives.len(), "toImport": to_import, "overlapSkipped": overlap, "duplicateSkipped": duplicate }))
    };
    run().unwrap_or_else(|e| {
        logger::error("import", format!("tessie preview failed: {e}"));
        fail(e)
    })
}

pub fn tessie_api_fetch(http: &dyn Http, cache: &OverlapCache, args: &Value, cancel: &AtomicBool, emit: Emit, rate: Duration) -> Result<FetchOutcome, String> {
    let (token, vin, from, to) = (tessie_token(args), to_string(arg(args, "vin")), arg(args, "fromSec"), arg(args, "toSec"));
    logger::info("import", format!("tessie import: vehicle …{}, window {}→{}", tail6(arg(args, "vin")), to_string(from), to_string(to)));
    emit(progress("Fetching drives list…", 0, 1));
    let list = tessie_api::fetch_drives(http, &token, &vin, from, to)?;
    let index = cache.get(arg_path(args, "driveDataPath").as_deref()).map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    for d in &list {
        let (s, e, odo) = tessie_api::overlap_key(d)?;
        if index.skip(&external_signature(s, &odo, "tessie")?, s, e).is_none() {
            candidates.push(d);
        }
    }
    let n = candidates.len();
    emit(progress("Fetching paths…", 0, n));
    let mut throttler = Throttler { rate, last: None };
    let mut out = FetchOutcome { imported: 0, canceled: false, total_candidates: n, skip_reasons: Map::new(), clips: Vec::new() };
    let start = Instant::now();
    for (i, d) in candidates.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            out.canceled = true;
            break;
        }
        let mut p = progress("Fetching paths…", i + 1, n);
        p["etaSec"] = eta(i, n, start);
        emit(p);
        throttler.wait();
        let buckets = match tessie_api::fetch_path(http, &token, &vin, js::prop(d, "started_at")?, js::prop(d, "ended_at")?) {
            Ok(b) => b,
            Err(_) => {
                bump(&mut out.skip_reasons, "fetch-error");
                continue;
            }
        };
        let points = buckets.into_iter().next().unwrap_or_default();
        let drive = tessie_api::normalize_api_drive(d, &points)?;
        match build_clips_for_api_drive(&drive, "tessie")? {
            Built::Skip(reason) => bump(&mut out.skip_reasons, reason),
            Built::Clips { clips, .. } => {
                out.clips.extend(clips);
                out.imported += 1;
            }
        }
    }
    Ok(out)
}

pub fn teslascope_api_validate_core(client: &teslascope_api::Client, args: &Value) -> Value {
    match client.fetch_vehicles(&to_string(arg(args, "token"))) {
        Ok(vehicles) => json!({
            "success": true,
            "vehicles": vehicles.into_iter().map(|v| {
                let vin = if js::truthy(v.vin.as_ref()) { v.vin.clone().unwrap_or_default() } else { json!("") };
                json!({ "publicId": v.public_id, "vin": vin, "displayName": v.display_name })
            }).collect::<Vec<_>>(),
        }),
        Err(e) => fail(e),
    }
}

/// The `{ startedAt, endedAt, startingOdometer }` key, or None for drives
/// whose timestamps can't produce clip filenames.
fn teslascope_key(d: &Value) -> Result<Option<(String, f64, f64)>, String> {
    let n = teslascope_api::normalize_drive(Some(d), None);
    if !n.started_at.is_finite() || !n.ended_at.is_finite() {
        return Ok(None);
    }
    let sig = external_signature(n.started_at, &Odo::from_opt(n.starting_odometer), "teslascope")?;
    Ok(Some((sig, n.started_at, n.ended_at)))
}

fn raw_keys(d: &Value) -> String {
    match d {
        Value::Object(m) => m.keys().cloned().collect::<Vec<_>>().join(", "),
        _ => String::new(),
    }
}

pub fn teslascope_api_preview_core(client: &teslascope_api::Client, cache: &OverlapCache, args: &Value) -> Value {
    let (token, public_id, from, to) = (to_string(arg(args, "token")), to_string(arg(args, "publicId")), arg(args, "fromSec"), arg(args, "toSec"));
    let run = || -> Result<Value, String> {
        logger::info("import", format!("teslascope preview: vehicle …{}, window {}→{}", tail6(arg(args, "publicId")), to_string(from), to_string(to)));
        let drives = client.fetch_drives(&token, &public_id, from, to)?;
        let index = cache.get(arg_path(args, "driveDataPath").as_deref()).map_err(|e| e.to_string())?;
        let (mut to_import, mut overlap, mut duplicate, mut bad) = (0, 0, 0, 0);
        for d in &drives {
            let Some((sig, s, e)) = teslascope_key(d)? else {
                if bad == 0 {
                    logger::warn("import", format!("teslascope drive has unrecognized timestamp fields; raw keys: {}", raw_keys(d)));
                }
                bad += 1;
                continue;
            };
            match index.skip(&sig, s, e) {
                Some("duplicate") => duplicate += 1,
                Some(_) => overlap += 1,
                None => to_import += 1,
            }
        }
        logger::info(
            "import",
            format!(
                "teslascope preview result: {} drives, {to_import} to import, {overlap} overlap-skipped, {duplicate} duplicates, {bad} bad-timestamps",
                drives.len()
            ),
        );
        Ok(json!({
            "success": true,
            "totalDrives": drives.len(),
            "toImport": to_import,
            "overlapSkipped": overlap,
            "duplicateSkipped": duplicate,
            "badTimestamps": bad,
        }))
    };
    run().unwrap_or_else(|e| {
        logger::error("import", format!("teslascope preview failed: {e}"));
        fail(e)
    })
}

pub fn teslascope_api_fetch(
    client: &teslascope_api::Client,
    cache: &OverlapCache,
    args: &Value,
    cancel: &AtomicBool,
    emit: Emit,
    rate: Duration,
) -> Result<FetchOutcome, String> {
    let (token, public_id, from, to) = (to_string(arg(args, "token")), to_string(arg(args, "publicId")), arg(args, "fromSec"), arg(args, "toSec"));
    logger::info("import", format!("teslascope import: vehicle …{}, window {}→{}", tail6(arg(args, "publicId")), to_string(from), to_string(to)));
    emit(progress("Fetching drives list…", 0, 1));
    let list = client.fetch_drives(&token, &public_id, from, to)?;
    let index = cache.get(arg_path(args, "driveDataPath").as_deref()).map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    let mut bad = 0;
    for d in &list {
        let Some((sig, s, e)) = teslascope_key(d)? else {
            bad += 1;
            continue;
        };
        if index.skip(&sig, s, e).is_none() {
            candidates.push(d);
        }
    }
    let n = candidates.len();
    emit(progress("Fetching paths…", 0, n));
    let mut throttler = Throttler { rate, last: None };
    let mut out = FetchOutcome { imported: 0, canceled: false, total_candidates: n, skip_reasons: Map::new(), clips: Vec::new() };
    if bad > 0 {
        out.skip_reasons.insert("bad-timestamps".into(), json!(bad));
    }
    let start = Instant::now();
    for (i, d) in candidates.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            out.canceled = true;
            break;
        }
        let mut p = progress("Fetching paths…", i + 1, n);
        p["etaSec"] = eta(i, n, start);
        emit(p);
        throttler.wait();
        let summary = teslascope_api::normalize_drive(Some(d), None);
        // Summary endpoints are the detail-fetch fallback.
        let detail = match client.fetch_drive_path(&token, &public_id, summary.id.as_ref()) {
            Ok(v) => Some(v),
            Err(_) => {
                bump(&mut out.skip_reasons, "detail-fetch-error");
                None
            }
        };
        let drive = teslascope_api::normalize_drive(Some(d), detail.as_ref()).to_api();
        match build_clips_for_api_drive(&drive, "teslascope")? {
            Built::Skip(reason) => bump(&mut out.skip_reasons, reason),
            Built::Clips { clips, .. } => {
                out.clips.extend(clips);
                out.imported += 1;
            }
        }
    }
    Ok(out)
}

/// The save half shared by both API importers.
pub fn finish_api_import(label: &str, fetched: FetchOutcome, path: Option<&str>, emit: Emit) -> (Value, Option<PathBuf>) {
    let n = fetched.total_candidates;
    emit(progress("Saving…", n, n));
    let mut written = None;
    if !fetched.clips.is_empty() {
        match save_imported_clips(path, &fetched.clips, emit) {
            Ok(p) => written = Some(p),
            Err(e) => {
                logger::error("import", format!("{label} import failed: {e}"));
                return (fail(e), None);
            }
        }
    }
    logger::info(
        "import",
        format!(
            "{label} import done: {}/{n} imported{}, skips: {}",
            fetched.imported,
            if fetched.canceled { " (canceled)" } else { "" },
            Value::Object(fetched.skip_reasons.clone())
        ),
    );
    (fetched.result(), written)
}

// ── Commands ───────────────────────────────────────────────────────────────

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f).await.expect("blocking task panicked")
}

fn emitter(app: &AppHandle, event: &'static str) -> impl Fn(Value) + Sync {
    let app = app.clone();
    move |v: Value| {
        let _ = app.emit(event, v);
    }
}

fn noted(app: &AppHandle, (result, written): (Value, Option<PathBuf>)) -> Value {
    if let Some(p) = written {
        crate::drive_edit::note_own_write(app, &p);
    }
    result
}

const API_RATE: Duration = Duration::from_millis(1000);
const TESLASCOPE_PAGE_PAUSE: Duration = Duration::from_millis(300);

#[tauri::command]
pub async fn tessie_preview(args: Option<Value>) -> Value {
    let args = args.unwrap_or_default();
    blocking(move || tessie_preview_core(&args)).await
}

#[tauri::command]
pub fn tessie_import_cancel(app: AppHandle) -> Value {
    app.state::<ImportState>().tessie_csv_cancel.store(true, Ordering::SeqCst);
    json!({ "success": true })
}

#[tauri::command]
pub async fn tessie_import(app: AppHandle, args: Option<Value>) -> Value {
    let args = args.unwrap_or_default();
    let lock = app.state::<crate::drive_edit::DriveDataLock>();
    let _g = lock.0.lock().await;
    let app2 = app.clone();
    blocking(move || {
        let emit = emitter(&app2, "tessie-progress");
        let out = tessie_import_core(&args, &app2.state::<ImportState>().tessie_csv_cancel, &emit);
        noted(&app2, out)
    })
    .await
}

async fn remove(app: AppHandle, args: Option<Value>, source: &'static str, all: bool) -> Value {
    let path = args.as_ref().and_then(|a| arg_path(a, "driveDataPath"));
    let lock = app.state::<crate::drive_edit::DriveDataLock>();
    let _g = lock.0.lock().await;
    let app2 = app.clone();
    blocking(move || {
        let (v, wrote) = if all { remove_all_core(path.as_deref(), source) } else { remove_hidden_core(path.as_deref(), source) };
        noted(&app2, (v, wrote.then(|| PathBuf::from(path.unwrap_or_default()))))
    })
    .await
}

#[tauri::command]
pub async fn tessie_remove_hidden(app: AppHandle, args: Option<Value>) -> Value {
    remove(app, args, "tessie", false).await
}

#[tauri::command]
pub async fn tessie_remove_all(app: AppHandle, args: Option<Value>) -> Value {
    remove(app, args, "tessie", true).await
}

#[tauri::command]
pub async fn teslascope_remove_hidden(app: AppHandle, args: Option<Value>) -> Value {
    remove(app, args, "teslascope", false).await
}

#[tauri::command]
pub async fn teslascope_remove_all(app: AppHandle, args: Option<Value>) -> Value {
    remove(app, args, "teslascope", true).await
}

#[tauri::command]
pub async fn tessie_api_validate(args: Option<Value>) -> Value {
    let args = args.unwrap_or_default();
    blocking(move || tessie_api_validate_core(&UreqHttp, &args)).await
}

#[tauri::command]
pub fn tessie_api_cancel(app: AppHandle) -> Value {
    app.state::<ImportState>().tessie_api_cancel.store(true, Ordering::SeqCst);
    json!({ "success": true })
}

#[tauri::command]
pub async fn tessie_api_preview(app: AppHandle, args: Option<Value>) -> Value {
    let args = args.unwrap_or_default();
    blocking(move || tessie_api_preview_core(&UreqHttp, &app.state::<ImportState>().overlap_cache, &args)).await
}

/// Shared shape of both API import commands: reset the cancel flag, fetch
/// outside the lock, save under it, reset the flag.
async fn api_import(
    app: AppHandle,
    args: Value,
    label: &'static str,
    event: &'static str,
    cancel: fn(&ImportState) -> &AtomicBool,
    fetch: fn(&AppHandle, &Value, Emit) -> Result<FetchOutcome, String>,
) -> Value {
    cancel(&app.state::<ImportState>()).store(false, Ordering::SeqCst);
    let (app2, args2) = (app.clone(), args.clone());
    let fetched = blocking(move || {
        let emit = emitter(&app2, event);
        fetch(&app2, &args2, &emit)
    })
    .await;
    let result = match fetched {
        Err(e) => {
            logger::error("import", format!("{label} import failed: {e}"));
            fail(e)
        }
        Ok(fetched) => {
            let lock = app.state::<crate::drive_edit::DriveDataLock>();
            let _g = lock.0.lock().await;
            let app3 = app.clone();
            blocking(move || {
                let emit = emitter(&app3, event);
                let path = arg_path(&args, "driveDataPath");
                let out = finish_api_import(label, fetched, path.as_deref(), &emit);
                noted(&app3, out)
            })
            .await
        }
    };
    cancel(&app.state::<ImportState>()).store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub async fn tessie_api_import(app: AppHandle, args: Option<Value>) -> Value {
    api_import(app, args.unwrap_or_default(), "tessie", "tessie-progress", |s| &s.tessie_api_cancel, |app, args, emit| {
        let st = app.state::<ImportState>();
        tessie_api_fetch(&UreqHttp, &st.overlap_cache, args, &st.tessie_api_cancel, emit, API_RATE)
    })
    .await
}

fn teslascope_client(st: &ImportState) -> teslascope_api::Client<'_> {
    static HTTP: UreqHttp = UreqHttp;
    teslascope_api::Client { http: &HTTP, auth: &st.teslascope_auth, page_pause: TESLASCOPE_PAGE_PAUSE }
}

#[tauri::command]
pub async fn teslascope_api_validate(app: AppHandle, args: Option<Value>) -> Value {
    let args = args.unwrap_or_default();
    blocking(move || teslascope_api_validate_core(&teslascope_client(&app.state::<ImportState>()), &args)).await
}

#[tauri::command]
pub fn teslascope_api_cancel(app: AppHandle) -> Value {
    app.state::<ImportState>().teslascope_cancel.store(true, Ordering::SeqCst);
    json!({ "success": true })
}

#[tauri::command]
pub async fn teslascope_api_preview(app: AppHandle, args: Option<Value>) -> Value {
    let args = args.unwrap_or_default();
    blocking(move || {
        let st = app.state::<ImportState>();
        teslascope_api_preview_core(&teslascope_client(&st), &st.overlap_cache, &args)
    })
    .await
}

#[tauri::command]
pub async fn teslascope_api_import(app: AppHandle, args: Option<Value>) -> Value {
    api_import(app, args.unwrap_or_default(), "teslascope", "teslascope-progress", |s| &s.teslascope_cancel, |app, args, emit| {
        let st = app.state::<ImportState>();
        teslascope_api_fetch(&teslascope_client(&st), &st.overlap_cache, args, &st.teslascope_cancel, emit, API_RATE)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/tauri/fixtures/imports").join(name)
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sd-imports-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(fixture("drive-data.json"), dir.join("drive-data.json")).unwrap();
        dir
    }

    fn read(p: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
    }

    // Time-zone independent checks of the write path.
    #[test]
    fn remove_all_drops_routes_files_and_keeps_other_sections() {
        let dir = scratch("remove-all");
        let dd = dir.join("drive-data.json");
        let before = read(&dd);
        let (res, wrote) = remove_all_core(dd.to_str(), "tessie");
        assert!(wrote);
        assert_eq!(res, json!({ "success": true, "removed": 2 }));
        let after = read(&dd);
        assert!(after["routes"].as_array().unwrap().iter().all(|r| r["source"] != "tessie"));
        // The backslash spelling of a Tessie clip goes too; unrelated entries stay.
        let files = after["processedFiles"].as_array().unwrap();
        assert!(files.iter().all(|f| !f.as_str().unwrap().starts_with("tessie")));
        assert!(files.contains(&json!("RecentClips/2024-04-01_08-00-00-front.mp4")));
        assert_eq!(after["driveTags"], before["driveTags"]);
        assert_eq!(after["meta"], before["meta"]);
        assert_eq!(read(&PathBuf::from(format!("{}.bak", dd.display()))), before);
        // Nothing left to remove: still a success, the file is untouched.
        assert_eq!(remove_all_core(dd.to_str(), "tessie"), (json!({ "success": true, "removed": 0 }), false));
        assert_eq!(remove_hidden_core(dir.join("missing.json").to_str(), "tessie").0["error"], "File not found");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn csv_import_appends_clips_in_wire_format() {
        let dir = scratch("csv");
        let fresh = dir.join("new.json");
        let args = json!({
            "driveDataPath": fresh.to_str(),
            "drivesCsvPath": fixture("drives.csv").to_str(),
            "statesCsvPath": fixture("driving_states.csv").to_str(),
        });
        let preview = tessie_preview_core(&args);
        assert_eq!(preview["totalDrives"], 10);
        assert_eq!(preview["statePointCount"], 234);
        let events = Mutex::new(Vec::new());
        let (res, wrote) = tessie_import_core(&args, &AtomicBool::new(true), &|v| events.lock().unwrap().push(v));
        assert_eq!(wrote.as_deref(), Some(fresh.as_path()));
        assert_eq!(res["imported"], 9);
        assert_eq!(res["canceled"], false, "a stale cancel flag is cleared at start");
        assert_eq!(res["skipReasons"], json!({ "no-coords": 1 }));
        let data = read(&fresh);
        let keys: Vec<&String> = data.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["processedFiles", "routes", "driveTags"]);
        let routes = data["routes"].as_array().unwrap();
        assert_eq!(routes.len(), data["processedFiles"].as_array().unwrap().len());
        let first = routes[0].as_object().unwrap();
        let order: Vec<&str> = first.keys().map(String::as_str).collect();
        assert_eq!(
            order,
            [
                "file", "date", "points", "gearStates", "autopilotStates", "speeds", "accelPositions", "rawParkCount",
                "rawFrameCount", "gearRuns", "source", "externalSignature", "tessieAutopilotPercent"
            ]
        );
        assert!(first["gearStates"].is_string());
        let ev = events.into_inner().unwrap();
        assert_eq!(ev.first().unwrap()["phase"], "Reading CSVs…");
        assert_eq!(ev.last().unwrap(), &json!({ "phase": "Saving…", "current": 10, "total": 10 }));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
