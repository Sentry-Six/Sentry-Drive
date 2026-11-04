//! Drop-in replacement for the Electron build.
//!
//! The Tauri build ships with Electron's product name and bundle identifier,
//! and uses Electron's data folder (`<config dir>/sentry-drive`) for every
//! file the Electron main process kept there: logs, window-state.json, the
//! geocode cache and settings, known places, the supercharger catalog cache,
//! support-prefs.json and the token files. Two things lived in Chromium's own
//! storage and are copied over once:
//!
//! - renderer settings in Chromium's localStorage (`Local Storage/leveldb`):
//!   read here and replayed into the webview's localStorage by the
//!   initialization script, skipping keys the webview already has;
//! - API tokens encrypted with safeStorage: see `secrets.rs`.
//!
//! Nothing in the Electron folder is deleted except a token file after its
//! token is safely in the credential store, so going back to the Electron
//! build keeps working.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

use crate::logger;
use crate::AppPaths;

/// The Electron build's `app.name`, which names its data folder and its
/// safeStorage keychain item. Test builds override it at compile time so they
/// never touch a real install's data.
pub const ELECTRON_APP_NAME: &str = match option_env!("SENTRY_DRIVE_ELECTRON_NAME") {
    Some(n) => n,
    None => "sentry-drive",
};

/// Electron's `app.getPath('userData')`.
pub fn user_data_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().config_dir()?.join(ELECTRON_APP_NAME))
}

// ── localStorage ────────────────────────────────────────────────────────────

const IMPORTED_MARKER: &str = ".tauri-imported-local-storage";

/// Renderer localStorage entries from the Electron build (origin file://), or
/// an empty list once they have been imported.
pub fn pending_local_storage(user_data: &Path) -> Vec<(String, String)> {
    if user_data.join(IMPORTED_MARKER).exists() {
        return Vec::new();
    }
    let dir = user_data.join("Local Storage").join("leveldb");
    if !dir.is_dir() {
        return Vec::new();
    }
    match read_chromium_local_storage(&dir, "file://") {
        Ok(items) => items,
        Err(e) => {
            logger::warn("main", format!("could not read the Electron build's settings: {e:#}"));
            Vec::new()
        }
    }
}

/// Read one origin's entries from Chromium's localStorage LevelDB. The
/// database is copied first: opening LevelDB may write to it, and Electron
/// could still be running.
pub fn read_chromium_local_storage(dir: &Path, origin: &str) -> Result<Vec<(String, String)>> {
    use rusty_leveldb::{LdbIterator, Options, DB};
    let tmp = std::env::temp_dir().join(format!("sentry-drive-ls-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp)?;
    let result = (|| -> Result<Vec<(String, String)>> {
        for e in std::fs::read_dir(dir)?.flatten() {
            if e.file_name() != "LOCK" && e.path().is_file() {
                std::fs::copy(e.path(), tmp.join(e.file_name()))?;
            }
        }
        let opts = Options { create_if_missing: false, ..Options::default() };
        let mut db = DB::open(&tmp, opts).map_err(|e| anyhow!("{e}"))?;
        let mut it = db.new_iter().map_err(|e| anyhow!("{e}"))?;
        let prefix = [b"_".as_slice(), origin.as_bytes(), b"\0"].concat();
        let mut out = Vec::new();
        while let Some((k, v)) = it.next() {
            let Some(key) = k.strip_prefix(prefix.as_slice()) else { continue };
            if let (Some(key), Some(value)) = (decode_chromium_string(key), decode_chromium_string(&v)) {
                out.push((key, value));
            }
        }
        Ok(out)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Chromium's localStorage string encoding: a leading 1 means Latin-1, a
/// leading 0 means UTF-16LE.
fn decode_chromium_string(b: &[u8]) -> Option<String> {
    match b.split_first()? {
        (1, rest) => Some(rest.iter().map(|&c| c as char).collect()),
        (0, rest) if rest.len() % 2 == 0 => {
            let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

/// Initialization-script snippet that replays the Electron settings once.
pub fn local_storage_script(items: &[(String, String)]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let json = serde_json::to_string(items).unwrap_or_else(|_| "[]".into());
    format!(
        "\n;(function (items) {{
  try {{
    if (localStorage.getItem('__importedFromElectron') !== null) return;
    for (const [k, v] of items) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    localStorage.setItem('__importedFromElectron', String(Date.now()));
    const done = () => window.__TAURI__.core.invoke('electron_storage_imported', {{ count: items.length }});
    if (window.__TAURI__) done(); else window.addEventListener('DOMContentLoaded', done);
  }} catch (e) {{}}
}})({json});\n"
    )
}

#[tauri::command]
pub fn electron_storage_imported(app: AppHandle, count: u64) {
    let user_data = app.state::<AppPaths>().user_data.clone();
    let _ = std::fs::write(user_data.join(IMPORTED_MARKER), b"");
    logger::info("main", format!("imported {count} setting(s) from the Electron build's localStorage"));
}

// ── window-state.json (Electron's format, so the window opens where it was) ─

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub is_maximized: bool,
    pub is_full_screen: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self { x: None, y: None, width: 1440.0, height: 900.0, is_maximized: false, is_full_screen: false }
    }
}

fn window_state_file(app: &AppHandle) -> PathBuf {
    app.state::<AppPaths>().user_data.join("window-state.json")
}

pub fn load_window_state(app: &AppHandle) -> WindowState {
    let mut s = WindowState::default();
    let Ok(raw) = std::fs::read(window_state_file(app)) else { return s };
    let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&raw) else { return s };
    let num = |k: &str| m.get(k).and_then(Value::as_f64);
    s.x = num("x");
    s.y = num("y");
    s.width = num("width").unwrap_or(s.width);
    s.height = num("height").unwrap_or(s.height);
    s.is_maximized = m.get("isMaximized").and_then(Value::as_bool).unwrap_or(false);
    s.is_full_screen = m.get("isFullScreen").and_then(Value::as_bool).unwrap_or(false);
    s
}

/// Keep the window's normal (not maximized or full-screen) bounds current and
/// write them on close, as Electron's saveWindowState did.
pub fn track_window_state(window: &WebviewWindow, initial: WindowState) {
    let state = std::sync::Arc::new(std::sync::Mutex::new(initial));
    let w = window.clone();
    window.on_window_event(move |event| {
        let snapshot = || -> Option<(f64, f64, f64, f64)> {
            let scale = w.scale_factor().ok()?;
            let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
            let size = w.inner_size().ok()?.to_logical::<f64>(scale);
            Some((pos.x, pos.y, size.width, size.height))
        };
        let maximized = w.is_maximized().unwrap_or(false);
        let full = w.is_fullscreen().unwrap_or(false);
        match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) if !maximized && !full => {
                if let Some((x, y, width, height)) = snapshot() {
                    let mut s = state.lock().unwrap();
                    (s.x, s.y, s.width, s.height) = (Some(x.round()), Some(y.round()), width.round(), height.round());
                }
            }
            WindowEvent::CloseRequested { .. } => {
                let mut s = state.lock().unwrap().clone();
                s.is_maximized = maximized;
                s.is_full_screen = full;
                if let Ok(json) = serde_json::to_string_pretty(&s) {
                    let _ = std::fs::write(window_state_file(w.app_handle()), json);
                }
            }
            _ => {}
        }
    });
}

pub fn apply_window_state<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    s: &WindowState,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    let mut b = builder.inner_size(s.width, s.height);
    if let (Some(x), Some(y)) = (s.x, s.y) {
        b = b.position(x, y);
    }
    b.maximized(s.is_maximized).fullscreen(s.is_full_screen)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_strings_decode() {
        assert_eq!(decode_chromium_string(b"\x01caf\xe9").unwrap(), "caf\u{e9}");
        assert_eq!(decode_chromium_string(&[0, 0x3d, 0xd8, 0x97, 0xde]).unwrap(), "\u{1f697}");
        assert!(decode_chromium_string(b"\x02x").is_none());
    }

    /// Reads an Electron profile's localStorage when one is given, e.g.
    /// ELECTRON_LS_DIR=".../Local Storage/leveldb" cargo test electron_profile -- --nocapture
    #[test]
    fn electron_profile() {
        let Ok(dir) = std::env::var("ELECTRON_LS_DIR") else { return };
        let items = read_chromium_local_storage(Path::new(&dir), "file://").unwrap();
        for (k, v) in &items {
            println!("{k} = {}", v.chars().take(80).collect::<String>());
        }
        assert!(!items.is_empty());
    }
}
