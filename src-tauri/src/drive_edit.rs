//! drive-data.json edits: tags, drive removal, external-change watching,
//! GPS backup revert and importing another drive-data.json.

use std::collections::HashSet;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::drive_data::{self, for_each_array_element, scan_sections, Replacement};
use crate::loader::grouper::group_into_drives;
use crate::loader::route::{normalize_clip_path, Route, RouteJson};
use crate::loader::LoaderService;
use crate::logger;

/// Serializes read-modify-write operations on drive-data.json.
#[derive(Default)]
pub struct DriveDataLock(pub tokio::sync::Mutex<()>);

type Sig = Option<(u64, SystemTime)>;

#[derive(Default)]
pub struct Watcher {
    inner: Arc<Mutex<(Option<PathBuf>, Sig)>>,
    started: AtomicU64,
}

fn sig(p: &Path) -> Sig {
    let m = std::fs::metadata(p).ok()?;
    Some((m.len(), m.modified().ok()?))
}

/// Re-baseline after our own write so it doesn't trigger a reload.
pub fn note_own_write(app: &AppHandle, path: &Path) {
    let w = app.state::<Watcher>();
    let mut g = w.inner.lock().unwrap();
    if g.0.as_deref() == Some(path) {
        g.1 = sig(path);
    }
}

#[tauri::command]
pub fn watch_drive_data(app: AppHandle, file_path: Option<String>) -> Value {
    let w = app.state::<Watcher>();
    {
        let mut g = w.inner.lock().unwrap();
        g.0 = file_path.filter(|p| !p.is_empty()).map(PathBuf::from);
        g.1 = g.0.as_deref().and_then(sig);
    }
    // Poll size+mtime every 3 s (fs events are unreliable on SMB shares).
    if w.started.fetch_add(1, Ordering::SeqCst) == 0 {
        let inner = w.inner.clone();
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(3));
            let changed = {
                let mut g = inner.lock().unwrap();
                let Some(path) = g.0.clone() else { continue };
                let cur = sig(&path);
                if cur.is_none() {
                    continue; // atomic rename in progress
                }
                if g.1.is_none() {
                    g.1 = cur;
                    continue;
                }
                if cur != g.1 {
                    g.1 = cur;
                    Some(path)
                } else {
                    None
                }
            };
            if let Some(path) = changed {
                let _ = app.emit("drive-data-changed", json!({ "filePath": path }));
            }
        });
    }
    json!({ "success": true })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f).await.expect("blocking task panicked")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagArgs {
    file_path: String,
    drive_key: String,
    tags: Vec<Value>,
}

#[tauri::command]
pub async fn set_drive_tags(app: AppHandle, args: TagArgs) -> Value {
    let lock = app.state::<DriveDataLock>();
    let _g = lock.0.lock().await;
    let app2 = app.clone();
    blocking(move || {
        let path = PathBuf::from(&args.file_path);
        let result = (|| -> Result<()> {
            let values = drive_data::read_top_level_values(&path, &["driveTags"])?;
            let mut tags: Map<String, Value> = match values.get("driveTags") {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            if args.tags.is_empty() {
                tags.remove(&args.drive_key);
            } else {
                tags.insert(args.drive_key.clone(), Value::Array(args.tags.clone()));
            }
            drive_data::write_drive_data(&path, vec![("driveTags", Replacement::Value(Value::Object(tags)))], &|| true)?;
            note_own_write(&app2, &path);
            Ok(())
        })();
        match result {
            Ok(()) => {
                let loader = app2.state::<LoaderService>();
                if let Err(e) = loader.with_index(|ix| ix.set_drive_tags(&args.drive_key, &args.tags)) {
                    loader.generation.fetch_add(1, Ordering::SeqCst);
                    logger::warn("main", format!("tag filter index not updated for {}: {e:#}", args.drive_key));
                }
                json!({ "success": true })
            }
            Err(e) => json!({ "success": false, "error": format!("{e:#}") }),
        }
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveArgs {
    file_path: String,
    drive_start_time: Option<String>,
    drive_start_times: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct FileOnly {
    #[serde(default)]
    file: Value,
}

fn element_file(el: &[u8]) -> Option<String> {
    serde_json::from_slice::<FileOnly>(el).ok().and_then(|f| f.file.as_str().map(String::from))
}

/// Remove the routes of the given drives (as grouped in the loaded index).
fn remove_drives_blocking(app: &AppHandle, path: &Path, start_times: &[String], single: bool) -> Value {
    let loader = app.state::<LoaderService>();
    let targets = match loader.with_index(|ix| ix.drives_by_start_times(start_times)) {
        Ok(t) => t,
        Err(e) => return json!({ "success": false, "error": format!("{e:#}") }),
    };
    if targets.is_empty() {
        return json!({ "success": false, "error": if single { "Drive not found" } else { "Drives not found" } });
    }
    let remove: HashSet<String> = targets
        .iter()
        .flat_map(|d| d["routeFiles"].as_array().cloned().unwrap_or_default())
        .filter_map(|f| f.as_str().map(normalize_clip_path))
        .collect();
    let found_starts: Vec<String> = targets.iter().filter_map(|d| d["startTime"].as_str().map(String::from)).collect();
    let removed_routes = Arc::new(AtomicU64::new(0));
    let result = (|| -> Result<bool> {
        let tags = drive_data::read_top_level_values(path, &["driveTags"])?;
        let mut tags: Map<String, Value> = match tags.get("driveTags") {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        for st in &found_starts {
            tags.remove(st);
        }
        let set_routes = remove.clone();
        let counter = removed_routes.clone();
        let set_files = remove.clone();
        drive_data::write_drive_data(
            path,
            vec![
                (
                    "routes",
                    Replacement::Filter {
                        keep: Box::new(move |el: &[u8]| {
                            let file = element_file(el).unwrap_or_default();
                            let drop = set_routes.contains(&normalize_clip_path(&file));
                            if drop {
                                counter.fetch_add(1, Ordering::Relaxed);
                            }
                            Ok(!drop)
                        }),
                        extra: Vec::new(),
                        pretty: true,
                    },
                ),
                (
                    "processedFiles",
                    Replacement::Filter {
                        keep: Box::new(move |el: &[u8]| {
                            let f: Value = serde_json::from_slice(el)?;
                            Ok(!f.as_str().is_some_and(|s| set_files.contains(&normalize_clip_path(s))))
                        }),
                        extra: Vec::new(),
                        pretty: false,
                    },
                ),
                ("driveTags", Replacement::Value(Value::Object(tags))),
            ],
            // Writing would only drop tags while removing nothing.
            &|| removed_routes.load(Ordering::Relaxed) > 0,
        )
    })();
    match result {
        Ok(false) => json!({
            "success": false,
            "error": if single { "No stored routes matched this drive" } else { "No stored routes matched the selected drives" },
        }),
        Ok(true) => {
            note_own_write(app, path);
            if let Err(e) = loader.with_index(|ix| ix.delete_drives_by_start_times(&found_starts)) {
                loader.generation.fetch_add(1, Ordering::SeqCst);
                logger::warn("main", format!("loader index not updated after remove: {e:#}"));
            }
            if single {
                logger::info("main", format!("removed drive at {} ({} clip(s))", found_starts[0], remove.len()));
                json!({ "success": true })
            } else {
                logger::info("main", format!("removed {} drive(s) ({} clip(s)) via multi-select", found_starts.len(), remove.len()));
                json!({ "success": true, "removed": found_starts.len() })
            }
        }
        Err(e) => {
            logger::error("main", format!("remove drive failed: {e:#}"));
            json!({ "success": false, "error": format!("{e:#}") })
        }
    }
}

#[tauri::command]
pub async fn remove_drive(app: AppHandle, args: RemoveArgs) -> Value {
    let lock = app.state::<DriveDataLock>();
    let _g = lock.0.lock().await;
    let app2 = app.clone();
    blocking(move || {
        let st = args.drive_start_time.unwrap_or_default();
        remove_drives_blocking(&app2, Path::new(&args.file_path), &[st], true)
    })
    .await
}

#[tauri::command]
pub async fn remove_drives(app: AppHandle, args: RemoveArgs) -> Value {
    let lock = app.state::<DriveDataLock>();
    let _g = lock.0.lock().await;
    let app2 = app.clone();
    blocking(move || {
        let wanted: Vec<String> = args.drive_start_times.unwrap_or_default().into_iter().collect::<HashSet<_>>().into_iter().collect();
        if wanted.is_empty() {
            return json!({ "success": false, "error": "No drives given" });
        }
        remove_drives_blocking(&app2, Path::new(&args.file_path), &wanted, false)
    })
    .await
}

#[tauri::command]
pub fn revert_gps(file_path: String) -> Value {
    let bak = format!("{file_path}.bak");
    if !Path::new(&bak).exists() {
        return json!({ "success": false, "error": "No backup file found." });
    }
    match std::fs::copy(&bak, &file_path) {
        Ok(_) => {
            logger::info("main", format!("reverted drive data from backup — {file_path}"));
            json!({ "success": true })
        }
        Err(e) => {
            logger::error("main", format!("revert failed: {e}"));
            json!({ "success": false, "error": e.to_string() })
        }
    }
}

#[tauri::command]
pub fn has_gps_backup(file_path: String) -> bool {
    Path::new(&format!("{file_path}.bak")).exists()
}

// ── Import another drive-data.json ──────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportArgs {
    drive_data_path: Option<String>,
    source_path: Option<String>,
}

fn norm_file_key(f: &str) -> String {
    f.replace('\\', "/")
}

struct SourceRoutes {
    all: Vec<Route>,
    new_routes: Vec<Route>,
    new_raw: Vec<Vec<u8>>,
    drive_tags: Map<String, Value>,
}

fn read_source_and_new_routes(dest: Option<&Path>, source: &Path, progress: &dyn Fn(u64, u64)) -> Result<SourceRoutes> {
    let mut have: HashSet<String> = HashSet::new();
    if let Some(dest) = dest.filter(|p| p.exists()) {
        let mut f = File::open(dest)?;
        let sections = scan_sections(f.try_clone()?)?;
        if let Some(s) = sections.iter().find(|s| s.key == "routes") {
            for_each_array_element(&mut f, s, |el| {
                if let Some(file) = element_file(el) {
                    have.insert(norm_file_key(&file));
                }
                Ok(())
            })?;
        }
    }
    let mut f = File::open(source)?;
    let total = f.metadata()?.len();
    let sections = scan_sections(f.try_clone()?)?;
    let mut out = SourceRoutes { all: Vec::new(), new_routes: Vec::new(), new_raw: Vec::new(), drive_tags: Map::new() };
    if let Some(s) = sections.iter().find(|s| s.key == "routes") {
        let mut last = std::time::Instant::now();
        for_each_array_element(&mut f, s, |el| {
            let Ok(r) = serde_json::from_slice::<RouteJson>(el) else { return Ok(()) };
            let r = r.into_route();
            if !r.file.is_empty() && !have.contains(&norm_file_key(&r.file)) {
                out.new_routes.push(r.clone());
                out.new_raw.push(el.to_vec());
            }
            out.all.push(r);
            if last.elapsed() >= Duration::from_millis(100) {
                last = std::time::Instant::now();
                progress(s.start, total);
            }
            Ok(())
        })?;
    }
    if let Some(Value::Object(m)) = drive_data::read_top_level_values(source, &["driveTags"])?.remove("driveTags") {
        out.drive_tags = m;
    }
    progress(total, total);
    Ok(out)
}

fn validate_import(args: &ImportArgs) -> Result<(PathBuf, Option<PathBuf>), Value> {
    let Some(src) = args.source_path.clone().filter(|p| Path::new(p).exists()) else {
        return Err(json!({ "success": false, "error": "File not found." }));
    };
    if args.drive_data_path.as_deref() == Some(src.as_str()) {
        return Err(json!({ "success": false, "error": "That's the file you already have loaded." }));
    }
    Ok((PathBuf::from(src), args.drive_data_path.clone().map(PathBuf::from)))
}

#[tauri::command]
pub async fn import_drive_data_file_preview(args: ImportArgs) -> Value {
    blocking(move || {
        let (src, dest) = match validate_import(&args) {
            Ok(v) => v,
            Err(v) => return v,
        };
        match read_source_and_new_routes(dest.as_deref(), &src, &|_, _| {}) {
            Ok(s) => {
                let clips = s.all.len();
                let new_clips = s.new_routes.len();
                let total = group_into_drives(s.all).drives.len();
                let to_import = group_into_drives(s.new_routes).drives.len();
                logger::info("import", format!("drive-data file preview: {clips} clips ({new_clips} new) → {to_import} new drive(s)"));
                json!({ "success": true, "totalDrives": total, "toImport": to_import })
            }
            Err(e) => {
                logger::error("import", format!("drive-data file preview failed: {e:#}"));
                json!({ "success": false, "error": format!("{e:#}") })
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn import_drive_data_file(app: AppHandle, args: ImportArgs) -> Value {
    let app2 = app.clone();
    let send = move |phase: &str, current: u64, total: u64| {
        let _ = app2.emit("import-json-progress", json!({ "phase": phase, "current": current, "total": total }));
    };
    let (src, dest) = match validate_import(&args) {
        Ok(v) => v,
        Err(v) => return v,
    };
    send("Reading file…", 0, 0);
    let send2 = send.clone();
    let dest2 = dest.clone();
    let read = blocking(move || read_source_and_new_routes(dest2.as_deref(), &src, &|c, t| send2("Reading file…", c, t))).await;
    let s = match read {
        Ok(s) => s,
        Err(e) => return json!({ "success": false, "error": format!("{e:#}") }),
    };
    if s.new_routes.is_empty() {
        return json!({ "success": true, "imported": 0, "clips": 0, "tagged": 0 });
    }
    let Some(dest) = dest else {
        return json!({ "success": false, "error": "No drive data file is loaded to import into." });
    };
    let lock = app.state::<DriveDataLock>();
    let _g = lock.0.lock().await;
    let app3 = app.clone();
    blocking(move || {
        let clips = s.new_routes.len();
        let files: Vec<Vec<u8>> = s.new_routes.iter().map(|r| serde_json::to_vec(&r.file).unwrap_or_default()).collect();
        let new_drives = group_into_drives(s.new_routes).drives;
        let imported = new_drives.len();
        let starts: HashSet<&str> = new_drives.iter().map(|d| d.start_time.as_str()).collect();
        let mut merge: Map<String, Value> = Map::new();
        for (k, v) in &s.drive_tags {
            if starts.contains(k.as_str()) && v.as_array().is_some_and(|a| !a.is_empty()) {
                merge.insert(k.clone(), v.clone());
            }
        }
        let tagged = merge.len();
        let result = (|| -> Result<()> {
            if dest.exists() {
                std::fs::copy(&dest, format!("{}.bak", dest.display()))?; // import restore point
            }
            send("Saving — writing drive data…", 0, 0);
            let mut tags = if dest.exists() {
                match drive_data::read_top_level_values(&dest, &["driveTags"])?.remove("driveTags") {
                    Some(Value::Object(m)) => m,
                    _ => Map::new(),
                }
            } else {
                Map::new()
            };
            for (k, v) in merge {
                let mut merged: Vec<Value> = tags.get(&k).and_then(Value::as_array).cloned().unwrap_or_default();
                for t in v.as_array().unwrap() {
                    if !merged.contains(t) {
                        merged.push(t.clone());
                    }
                }
                tags.insert(k, Value::Array(merged));
            }
            drive_data::write_drive_data(
                &dest,
                vec![
                    ("routes", Replacement::Filter { keep: Box::new(|_: &[u8]| Ok(true)), extra: s.new_raw, pretty: true }),
                    ("processedFiles", Replacement::Filter { keep: Box::new(|_: &[u8]| Ok(true)), extra: files, pretty: false }),
                    ("driveTags", Replacement::Value(Value::Object(tags))),
                ],
                &|| true,
            )
            .map(|_| ())
            .map_err(|e| anyhow!(e))
        })();
        match result {
            Ok(()) => {
                note_own_write(&app3, &dest);
                logger::info("import", format!("drive-data file import: {clips} new clip(s) → {imported} drive(s), {tagged} tagged"));
                json!({ "success": true, "imported": imported, "clips": clips, "tagged": tagged })
            }
            Err(e) => {
                logger::error("import", format!("drive-data file import failed: {e:#}"));
                json!({ "success": false, "error": format!("{e:#}") })
            }
        }
    })
    .await
}
