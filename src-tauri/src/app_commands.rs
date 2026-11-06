//! General IPC handlers: logging, dialogs, paths, changelog, drive loading and
//! charging history.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::loader::{error_json, LoaderService};
use crate::supercharger::{self, SuperchargerCatalog};
use crate::{logger, AppPaths, MAIN_WINDOW};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f).await.expect("blocking task panicked")
}

#[derive(Deserialize)]
pub struct LogEntry {
    level: Option<String>,
    scope: Option<String>,
    text: Option<Value>,
}

#[tauri::command]
pub fn app_log(entry: LogEntry) {
    let level = match entry.level.as_deref() {
        Some("error") => "error",
        Some("warn") => "warn",
        _ => "info",
    };
    let scope = entry.scope.filter(|s| !s.is_empty()).unwrap_or_else(|| "renderer".into());
    let text = match entry.text {
        Some(Value::String(s)) => s,
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    };
    logger::log(level, &scope, &text);
}

fn logs_prefs_file(paths: &AppPaths) -> PathBuf {
    paths.user_data.join("support-prefs.json")
}

#[tauri::command]
pub async fn download_logs(app: AppHandle) -> Value {
    let paths = app.state::<AppPaths>();
    let prefs = logs_prefs_file(&paths);
    let dir = crate::fsutil::read_json(&prefs)
        .and_then(|v| v.get("logsDir").and_then(Value::as_str).map(PathBuf::from))
        .filter(|p| p.exists())
        .or_else(|| app.path().download_dir().ok())
        .unwrap_or_default();
    let stamp = chrono::Utc::now().format("%Y-%m-%d-%H-%M-%S").to_string();
    let mut dialog = app
        .dialog()
        .file()
        .set_directory(&dir)
        .set_file_name(format!("sentry-drive-logs-{stamp}.txt"))
        .add_filter("Text", &["txt"]);
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        dialog = dialog.set_parent(&w);
    }
    let picked = blocking(move || dialog.blocking_save_file()).await;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return json!({ "success": false, "canceled": true });
    };
    match std::fs::write(&path, logger::log_text()) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::write(&prefs, json!({ "logsDir": parent }).to_string());
            }
            json!({ "success": true, "filePath": path })
        }
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DialogOptions {
    default_path: Option<String>,
    filters: Option<Vec<DialogFilter>>,
}

#[derive(Deserialize)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

fn dialog_for(app: &AppHandle, default_path: Option<&str>) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut d = app.dialog().file();
    if let Some(p) = default_path.filter(|p| !p.is_empty()) {
        let p = Path::new(p);
        if p.is_dir() {
            d = d.set_directory(p);
        } else {
            if let Some(parent) = p.parent() {
                d = d.set_directory(parent);
            }
            if let Some(name) = p.file_name() {
                d = d.set_file_name(name.to_string_lossy());
            }
        }
    }
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        d = d.set_parent(&w);
    }
    d
}

#[tauri::command]
pub async fn select_directory(app: AppHandle, options: Option<DialogOptions>) -> Option<String> {
    let options = options.unwrap_or_default();
    let d = dialog_for(&app, options.default_path.as_deref());
    blocking(move || d.blocking_pick_folder())
        .await
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn select_file(app: AppHandle, options: Option<DialogOptions>) -> Option<String> {
    let options = options.unwrap_or_default();
    let mut d = dialog_for(&app, options.default_path.as_deref());
    let filters = options.filters.unwrap_or_else(|| vec![DialogFilter { name: "JSON".into(), extensions: vec!["json".into()] }]);
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        d = d.add_filter(&f.name, &exts);
    }
    blocking(move || d.blocking_pick_file())
        .await
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn find_drive_data(dir: String) -> Option<String> {
    let p = Path::new(&dir).join("drive-data.json");
    p.exists().then(|| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn check_drive_data(dir: String) -> bool {
    Path::new(&dir).join("drive-data.json").exists()
}

#[tauri::command]
pub fn get_default_output_dir(app: AppHandle) -> String {
    app.path()
        .document_dir()
        .map(|d| d.join("Sentry Six").join("Sentry Drive"))
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub fn get_cpu_count() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get())
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    // Same reach as shell.openExternal: http(s) and mailto links.
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("Only web links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn get_changelog(app: AppHandle) -> Value {
    let path = app.state::<AppPaths>().resources.join("changelog.json");
    match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string())) {
        Ok(v) => json!({ "success": true, "versions": v.get("versions").cloned().unwrap_or(json!([])) }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

pub fn http_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .new_agent()
}

#[tauri::command]
pub async fn fetch_remote_changelog() -> Value {
    blocking(|| {
        let url = "https://raw.githubusercontent.com/Sentry-Six/Sentry-Drive/main/changelog.json";
        match http_agent(Duration::from_secs(5)).get(url).header("User-Agent", "Sentry-Drive").call() {
            Ok(mut r) if r.status() == 200 => match r.body_mut().read_json::<Value>() {
                Ok(v) => json!({ "success": true, "versions": v.get("versions").cloned().unwrap_or(json!([])) }),
                Err(e) => json!({ "success": false, "error": e.to_string() }),
            },
            Ok(r) => json!({ "success": false, "status": r.status().as_u16() }),
            Err(e) => json!({ "success": false, "error": e.to_string() }),
        }
    })
    .await
}

#[tauri::command]
pub async fn check_online() -> bool {
    blocking(|| http_agent(Duration::from_secs(5)).get("https://router.project-osrm.org/health").call().is_ok()).await
}

#[tauri::command]
pub fn toggle_devtools(app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        if w.is_devtools_open() {
            w.close_devtools();
        } else {
            w.open_devtools();
        }
    }
}

// ── Drive loading ───────────────────────────────────────────────────────────

/// Index cache location: the app's cache directory.
pub fn resolve_loader_cache_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("sentry-drive"))
        .join("load-cache")
}

#[tauri::command]
pub async fn load_and_group_drives(app: AppHandle, file_path: String) -> Value {
    let loader = app.state::<LoaderService>();
    let _guard = loader.load_lock.lock().await;
    // Invalidate before loading so in-flight list/detail calls fail stale.
    let cache_gen = loader.generation.fetch_add(1, Ordering::SeqCst) + 1;
    static SWEPT: std::sync::Once = std::sync::Once::new();
    let app2 = app.clone();
    let result = blocking(move || {
        let loader = app2.state::<LoaderService>();
        SWEPT.call_once(|| {
            let (removed, bytes) = loader.sweep_stale();
            if removed > 0 {
                logger::info("main", format!("index cache: swept {removed} stale load dir(s), freed {} MB", bytes / 1_048_576));
            }
            logger::info("main", format!("index cache root: {}", loader.cache_root.display()));
        });
        let emitter = app2.clone();
        let progress = move |p: crate::loader::index::Progress| {
            let _ = emitter.emit("load-progress", json!({ "phase": p.phase, "current": p.current, "total": p.total }));
        };
        loader.load(Path::new(&file_path), 250, &progress).map(|v| (v, file_path))
    })
    .await;
    match result {
        Ok((mut v, file_path)) => {
            logger::info(
                "main",
                format!(
                    "loaded {} drive(s) from {} clips — {}",
                    v.get("totalDriveCount").and_then(Value::as_i64).unwrap_or(0),
                    v.get("totalRoutes").and_then(Value::as_i64).unwrap_or(0),
                    file_path
                ),
            );
            v["cacheGen"] = json!(cache_gen);
            v
        }
        Err(e) => {
            logger::error("main", format!("load drives failed: {e:#}"));
            json!({ "success": false, "error": error_json(&e)["error"] })
        }
    }
}

fn stale() -> Value {
    json!({ "success": false, "error": "Drive list was reloaded", "code": "STALE_DRIVE_DATA" })
}

fn merge_success(v: Value) -> Value {
    let mut m = v.as_object().cloned().unwrap_or_default();
    m.insert("success".into(), json!(true));
    Value::Object(m)
}

#[tauri::command]
pub async fn list_drive_summaries(app: AppHandle, query: Option<Value>) -> Value {
    blocking(move || {
        let loader = app.state::<LoaderService>();
        let query = query.unwrap_or(json!({}));
        if loader.is_stale(query.get("gen").and_then(Value::as_u64)) {
            return stale();
        }
        match loader.with_index(|ix| ix.list_drive_summaries(&query)) {
            Ok(v) => merge_success(v),
            Err(e) => error_json(&e),
        }
    })
    .await
}

#[tauri::command]
pub async fn get_drive_detail(app: AppHandle, arg: Value) -> Value {
    blocking(move || {
        let loader = app.state::<LoaderService>();
        let (id, gen) = match &arg {
            Value::Object(m) => (m.get("driveId").and_then(Value::as_i64), m.get("gen").and_then(Value::as_u64)),
            other => (other.as_i64(), None),
        };
        if loader.is_stale(gen) {
            return stale();
        }
        let Some(id) = id else { return json!({ "success": false, "error": "Drive not found" }) };
        match loader.with_index(|ix| ix.get_drive_detail(id, 200_000.0)) {
            Ok(Some(v)) => merge_success(v),
            Ok(None) => json!({ "success": false, "error": "Drive not found" }),
            Err(e) => error_json(&e),
        }
    })
    .await
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChargingArgs {
    gen: Option<u64>,
    site_id: Option<String>,
    session_id: Option<String>,
}

fn stale_charging() -> Value {
    json!({ "success": false, "error": "Drive data was reloaded", "code": "STALE_DRIVE_DATA" })
}

#[tauri::command]
pub async fn list_charging_sites(app: AppHandle, args: Option<ChargingArgs>) -> Value {
    blocking(move || {
        let args = args.unwrap_or_default();
        let loader = app.state::<LoaderService>();
        if loader.is_stale(args.gen) {
            return stale_charging();
        }
        let sites = match loader.with_index(|ix| ix.list_charging_sites()) {
            Ok(s) => s,
            Err(e) => return error_json(&e),
        };
        let cat = app.state::<SuperchargerCatalog>();
        let guard = cat.lock();
        let (sites, status) = match guard.as_ref() {
            Some(c) => (supercharger::match_charging_sites(sites, &c.data), c.status()),
            None => (supercharger::match_charging_sites(sites, &json!({ "stations": [] })), Value::Null),
        };
        json!({ "success": true, "sites": sites, "catalog": status })
    })
    .await
}

#[tauri::command]
pub async fn list_charging_sessions(app: AppHandle, args: Option<ChargingArgs>) -> Value {
    blocking(move || {
        let args = args.unwrap_or_default();
        let loader = app.state::<LoaderService>();
        if loader.is_stale(args.gen) {
            return stale_charging();
        }
        let site = args.site_id.unwrap_or_default();
        match loader.with_index(|ix| ix.list_charging_sessions(&site)) {
            Ok(s) => json!({ "success": true, "sessions": s }),
            Err(e) => error_json(&e),
        }
    })
    .await
}

#[tauri::command]
pub async fn get_charging_session(app: AppHandle, args: Option<ChargingArgs>) -> Value {
    blocking(move || {
        let args = args.unwrap_or_default();
        let loader = app.state::<LoaderService>();
        if loader.is_stale(args.gen) {
            return stale_charging();
        }
        let id = args.session_id.unwrap_or_default();
        match loader.with_index(|ix| ix.get_charging_session(&id)) {
            Ok(Some(v)) => merge_success(v),
            Ok(None) => json!({ "success": false, "error": "Charging session not found" }),
            Err(e) => error_json(&e),
        }
    })
    .await
}

#[tauri::command]
pub fn get_supercharger_catalog_status(app: AppHandle) -> Value {
    let cat = app.state::<SuperchargerCatalog>();
    let guard = cat.lock();
    match guard.as_ref() {
        Some(c) => merge_success(c.status()),
        None => json!({ "success": false, "error": "Supercharger catalog unavailable" }),
    }
}

#[tauri::command]
pub async fn refresh_supercharger_catalog(app: AppHandle) -> Value {
    blocking(move || {
        let cat: State<SuperchargerCatalog> = app.state();
        supercharger::refresh(&cat)
    })
    .await
}
