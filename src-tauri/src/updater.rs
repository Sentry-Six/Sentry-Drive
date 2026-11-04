//! In-app updates from GitHub Releases, replacing electron-updater.
//!
//! The renderer drives the same flow as before (check → available →
//! download with progress → ready → install) through the same
//! `update-status` events. Underneath:
//!
//! 1. Pick the release: the GitHub Releases API, newest version first,
//!    skipping drafts, skipping pre-releases unless the user enrolled in the
//!    beta, and skipping releases without a `latest.json` (Electron-era
//!    releases, which the Tauri updater can't install).
//! 2. tauri-plugin-updater reads that release's `latest.json`, downloads the
//!    platform bundle, and verifies its minisign signature against the public
//!    key built into the app (and, with `requireSignedVersion`, that the
//!    signature was made for the announced version).
//! 3. Install replaces the app (macOS bundle, Windows NSIS installer, Linux
//!    AppImage) and relaunches. A downloaded update that was never installed
//!    is installed on quit, like electron-updater's autoInstallOnAppQuit.
//!
//! Builds made with `SENTRY_DRIVE_UPDATE_FEED` set (local tests only) skip
//! step 1 and read `<feed>/latest.json`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::logger;

const RELEASES_API: &str = "https://api.github.com/repos/Sentry-Six/Sentry-Drive/releases?per_page=30";
const TEST_FEED: Option<&str> = option_env!("SENTRY_DRIVE_UPDATE_FEED");

#[derive(Default)]
pub struct UpdaterState {
    allow_prerelease: AtomicBool,
    allow_downgrade: AtomicBool,
    busy: AtomicBool,
    update: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Vec<u8>>>,
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

fn fail(app: &AppHandle, what: &str, e: impl std::fmt::Display) {
    logger::error("update", format!("{what}: {e}"));
    send(app, "error", json!({ "message": e.to_string() }));
}

/// Release builds get the updater public key from the release workflow.
fn has_update_key(app: &AppHandle) -> bool {
    app.config().plugins.0.get("updater").and_then(|u| u["pubkey"].as_str()).is_some_and(|k| !k.trim().is_empty())
}

fn parse_version(v: &str) -> Option<semver::Version> {
    semver::Version::parse(v.trim_start_matches('v')).ok()
}

/// The `latest.json` URL of the release to offer, if any (step 1).
pub fn pick_release(releases: &[Value], current: &semver::Version, allow_pre: bool, allow_down: bool) -> Option<(semver::Version, String)> {
    releases
        .iter()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter(|r| allow_pre || !r["prerelease"].as_bool().unwrap_or(false))
        .filter_map(|r| {
            let v = parse_version(r["tag_name"].as_str()?)?;
            let manifest = r["assets"]
                .as_array()?
                .iter()
                .find(|a| a["name"] == "latest.json")?["browser_download_url"]
                .as_str()?
                .to_string();
            Some((v, manifest))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .filter(|(v, _)| v > current || (allow_down && v != current))
}

fn manifest_url(app: &AppHandle, allow_pre: bool, allow_down: bool) -> Result<Option<String>, String> {
    if let Some(feed) = TEST_FEED {
        return Ok(Some(format!("{}/latest.json", feed.trim_end_matches('/'))));
    }
    let current = parse_version(&app.package_info().version.to_string()).ok_or("unreadable app version")?;
    let releases: Vec<Value> = crate::app_commands::http_agent(Duration::from_secs(10))
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
        })?;
    Ok(pick_release(&releases, &current, allow_pre, allow_down).map(|(_, url)| url))
}

async fn check(app: AppHandle) {
    let st = app.state::<UpdaterState>();
    let allow_pre = st.allow_prerelease.load(Ordering::Relaxed);
    let allow_down = st.allow_downgrade.load(Ordering::Relaxed);
    logger::info("update", "checking for update…");
    send(&app, "checking", json!({}));
    let app2 = app.clone();
    let url = match tauri::async_runtime::spawn_blocking(move || manifest_url(&app2, allow_pre, allow_down)).await {
        Ok(Ok(u)) => u,
        Ok(Err(e)) => return fail(&app, "update check failed", e),
        Err(e) => return fail(&app, "update check failed", e),
    };
    let up_to_date = |app: &AppHandle| {
        logger::info("update", format!("up to date (v{})", app.package_info().version));
        send(app, "up-to-date", json!({}));
    };
    let Some(url) = url else { return up_to_date(&app) };
    if !has_update_key(&app) {
        return fail(&app, "update check failed", "This build can't install updates. Download the latest version from GitHub.");
    }
    let built = (|| {
        let endpoint = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
        let mut b = app.updater_builder().endpoints(vec![endpoint]).map_err(|e| e.to_string())?;
        if allow_down {
            // "Revert to stable": accept an older signed release on purpose.
            b = b.version_comparator(|current, remote| remote.version != current);
        }
        b.build().map_err(|e| e.to_string())
    })();
    let updater = match built {
        Ok(u) => u,
        Err(e) => return fail(&app, "update check failed", e),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            *st.update.lock().unwrap() = Some(update);
            *st.downloaded.lock().unwrap() = None;
            logger::info("update", format!("update available: v{version}"));
            send(&app, "available", json!({ "version": version }));
        }
        Ok(None) => up_to_date(&app),
        Err(e) => fail(&app, "update check failed", e),
    }
}

#[tauri::command]
pub fn set_allow_prerelease(app: AppHandle, allow: bool) {
    app.state::<UpdaterState>().allow_prerelease.store(allow, Ordering::Relaxed);
}

#[tauri::command]
pub async fn revert_to_stable(app: AppHandle) {
    let st = app.state::<UpdaterState>();
    st.allow_prerelease.store(false, Ordering::Relaxed);
    st.allow_downgrade.store(true, Ordering::Relaxed);
    check(app).await;
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) {
    check(app).await;
}

#[tauri::command]
pub async fn download_update(app: AppHandle) {
    let st = app.state::<UpdaterState>();
    let Some(update) = st.update.lock().unwrap().clone() else {
        return fail(&app, "download failed", "No update has been found yet.");
    };
    if st.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let (mut got, mut last_pct) = (0usize, -1i64);
    let app2 = app.clone();
    let result = update
        .download(
            |chunk, total| {
                got += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = crate::loader::calc::js_round(got as f64 * 100.0 / total as f64) as i64;
                    if pct != last_pct {
                        last_pct = pct;
                        send(&app2, "downloading", json!({ "percent": pct }));
                    }
                }
            },
            || {},
        )
        .await;
    st.busy.store(false, Ordering::SeqCst);
    match result {
        Ok(bytes) => {
            *st.downloaded.lock().unwrap() = Some(bytes);
            logger::info("update", "update downloaded — ready to install");
            send(&app, "ready", json!({}));
        }
        Err(e) => fail(&app, "auto-updater error", e),
    }
}

/// Install a downloaded update. Returns true when the app should relaunch.
fn install_pending(app: &AppHandle) -> bool {
    let st = app.state::<UpdaterState>();
    let (Some(update), Some(bytes)) = (st.update.lock().unwrap().clone(), st.downloaded.lock().unwrap().take()) else {
        return false;
    };
    logger::info("update", format!("installing v{}", update.version));
    match update.install(bytes) {
        Ok(()) => true,
        Err(e) => {
            fail(app, "install failed", e);
            false
        }
    }
}

#[tauri::command]
pub fn install_update(app: AppHandle) {
    if install_pending(&app) {
        app.restart();
    }
}

/// autoInstallOnAppQuit: install a downloaded update when the app quits.
pub fn install_on_quit(app: &AppHandle) {
    if let Some(st) = app.try_state::<UpdaterState>() {
        if st.downloaded.lock().unwrap().is_some() {
            install_pending(app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, pre: bool, manifest: bool) -> Value {
        let assets = if manifest {
            json!([{ "name": "latest.json", "browser_download_url": format!("https://x/{tag}/latest.json") }])
        } else {
            json!([{ "name": "latest-mac.yml", "browser_download_url": "https://x/y" }])
        };
        json!({ "tag_name": tag, "prerelease": pre, "draft": false, "assets": assets })
    }

    #[test]
    fn picks_newest_tauri_release() {
        let v = |s: &str| semver::Version::parse(s).unwrap();
        let rs = [rel("v1.6.3", false, false), rel("v1.7.0", false, true), rel("v1.8.0-beta.1", true, true), rel("v1.9.0", false, false)];
        // v1.9.0 has no latest.json (an Electron-only release): skipped.
        assert_eq!(pick_release(&rs, &v("1.6.3"), false, false).unwrap().0, v("1.7.0"));
        assert_eq!(pick_release(&rs, &v("1.6.3"), true, false).unwrap().0, v("1.8.0-beta.1"));
        assert!(pick_release(&rs, &v("1.7.0"), false, false).is_none());
        // Revert to stable from the beta.
        assert_eq!(pick_release(&rs, &v("1.8.0-beta.1"), false, true).unwrap().0, v("1.7.0"));
    }
}
