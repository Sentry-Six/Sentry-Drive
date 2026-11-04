//! Update checks. The Electron build uses electron-updater against GitHub
//! Releases (download + install in place). Installing a Tauri build in place
//! needs tauri-plugin-updater with signed update bundles and a `latest.json`
//! manifest, which the release pipeline does not produce yet. Until it does,
//! this checks GitHub Releases for a newer version and sends the user to the
//! release page to download it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::logger;

const RELEASES_API: &str = "https://api.github.com/repos/Sentry-Six/Sentry-Drive/releases?per_page=20";
const RELEASES_PAGE: &str = "https://github.com/Sentry-Six/Sentry-Drive/releases";

#[derive(Default)]
pub struct UpdaterState {
    allow_prerelease: AtomicBool,
    allow_downgrade: AtomicBool,
    latest_url: std::sync::Mutex<Option<String>>,
}

fn send(app: &AppHandle, status: &str, extra: Value) {
    let mut payload = json!({ "status": status });
    if let (Some(p), Some(e)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            p.insert(k.clone(), v.clone());
        }
    }
    let _ = app.emit("update-status", payload);
}

fn parse_version(v: &str) -> Option<semver::Version> {
    semver::Version::parse(v.trim_start_matches('v')).ok()
}

fn check(app: AppHandle) {
    let st = app.state::<UpdaterState>();
    let allow_pre = st.allow_prerelease.load(Ordering::Relaxed);
    let allow_down = st.allow_downgrade.load(Ordering::Relaxed);
    logger::info("update", "checking for update…");
    send(&app, "checking", json!({}));
    let current = parse_version(&app.package_info().version.to_string());
    let releases: Result<Vec<Value>, String> = crate::app_commands::http_agent(Duration::from_secs(10))
        .get(RELEASES_API)
        .header("User-Agent", "Sentry-Drive")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())
        .and_then(|mut r| {
            if r.status() != 200 {
                return Err(format!("GitHub returned {}", r.status()));
            }
            r.body_mut().read_json::<Vec<Value>>().map_err(|e| e.to_string())
        });
    let releases = match releases {
        Ok(r) => r,
        Err(e) => {
            logger::error("update", format!("update check failed: {e}"));
            send(&app, "error", json!({ "message": e }));
            return;
        }
    };
    let best = releases
        .iter()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter(|r| allow_pre || !r["prerelease"].as_bool().unwrap_or(false))
        .filter_map(|r| Some((parse_version(r["tag_name"].as_str()?)?, r)))
        .max_by(|a, b| a.0.cmp(&b.0));
    match (best, current) {
        (Some((v, r)), Some(cur)) if v > cur || (allow_down && v < cur) => {
            *st.latest_url.lock().unwrap() = r["html_url"].as_str().map(String::from);
            logger::info("update", format!("update available: v{v}"));
            send(&app, "available", json!({ "version": v.to_string() }));
        }
        _ => {
            logger::info("update", format!("up to date (v{})", app.package_info().version));
            send(&app, "up-to-date", json!({}));
        }
    }
}

#[tauri::command]
pub fn set_allow_prerelease(app: AppHandle, allow: bool) {
    app.state::<UpdaterState>().allow_prerelease.store(allow, Ordering::Relaxed);
}

#[tauri::command]
pub fn revert_to_stable(app: AppHandle) {
    let st = app.state::<UpdaterState>();
    st.allow_prerelease.store(false, Ordering::Relaxed);
    st.allow_downgrade.store(true, Ordering::Relaxed);
    std::thread::spawn(move || check(app));
}

#[tauri::command]
pub fn check_for_update(app: AppHandle) {
    std::thread::spawn(move || check(app));
}

/// No in-place download yet: open the release page instead.
#[tauri::command]
pub fn download_update(app: AppHandle) {
    let url = app.state::<UpdaterState>().latest_url.lock().unwrap().clone().unwrap_or_else(|| RELEASES_PAGE.into());
    let _ = app.opener().open_url(url, None::<&str>);
    send(
        &app,
        "error",
        json!({ "message": "In-app updates aren't available in the Tauri preview yet. The release page has been opened in your browser." }),
    );
}

#[tauri::command]
pub fn install_update(app: AppHandle) {
    download_update(app);
}
