//! Sentry Drive — Tauri shell.
//!
//! Replaces Electron's main process (`src/main/electron-main.cjs`) and preload
//! (`electron-preload.cjs`). The renderer (`src/renderer/*`) is unchanged: an
//! initialization script installs the same `window.electronAPI`,
//! `window.driveCalc` and `window.driveTelemetryView` objects the preload
//! exposed, backed by the Tauri commands registered here.

mod app_commands;
pub mod drive_data;
mod drive_edit;
pub mod fsutil;
mod geocode;
pub mod loader;
pub mod logger;
mod processing;
mod supercharger;
mod updater;

use std::path::PathBuf;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub const MAIN_WINDOW: &str = "main";

/// Benchmark mode (scripts/bench): set by SENTRY_DRIVE_BENCH_* env vars.
pub struct BenchConfig {
    pub out: PathBuf,
    pub mode: String,
    pub file: String,
    pub idle_ms: u64,
}

pub struct AppPaths {
    pub user_data: PathBuf,
    pub resources: PathBuf,
}

fn bench_config() -> Option<BenchConfig> {
    let out = std::env::var_os("SENTRY_DRIVE_BENCH_OUT")?;
    Some(BenchConfig {
        out: PathBuf::from(out),
        mode: std::env::var("SENTRY_DRIVE_BENCH_MODE").unwrap_or_else(|_| "drive".into()),
        file: std::env::var("SENTRY_DRIVE_BENCH_FILE").unwrap_or_default(),
        idle_ms: std::env::var("SENTRY_DRIVE_BENCH_IDLE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(80_000),
    })
}

/// Wrap a CommonJS module so it can run as a classic page script and publish
/// its exports as a frozen global (what contextBridge did in the preload).
fn cjs_global(global: &str, source: &str) -> String {
    format!(
        "(function () {{ var module = {{ exports: {{}} }}; var exports = module.exports;\n{source}\n;window.{global} = Object.freeze(Object.assign({{}}, module.exports)); }})();\n"
    )
}

fn init_script(app_version: &str, bench: Option<&BenchConfig>) -> String {
    let mut js = String::new();
    js.push_str(&cjs_global("driveCalc", include_str!("../../src/shared/drive-calc.cjs")));
    js.push_str(&cjs_global("driveTelemetryView", include_str!("../../src/renderer/drive-telemetry-view.cjs")));
    js.push_str(include_str!("../../src/tauri-bridge/bridge.js"));
    if let Some(b) = bench {
        let cfg = serde_json::json!({ "mode": b.mode, "file": b.file, "idleMs": b.idle_ms, "version": app_version });
        js.push_str(&format!(
            "\n;(function () {{ const B = {cfg};
              try {{
                localStorage.setItem('lastSeenVersion', B.version);
                localStorage.setItem('autoLoadDriveData', String(B.mode === 'drive'));
                if (B.mode === 'drive') localStorage.setItem('lastDriveDataPath', B.file);
                else localStorage.removeItem('lastDriveDataPath');
              }} catch (e) {{}}
              window.__SENTRY_BENCH__ = B; }})();\n"
        ));
        js.push_str(include_str!("../../scripts/bench/probe.js"));
        js.push_str(
            "\n;window.addEventListener('DOMContentLoaded', () => { const B = window.__SENTRY_BENCH__; window.__benchStart({ mode: B.mode, idleMs: B.idleMs, file: B.file }); });\n",
        );
    }
    js
}

pub fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let version = app.package_info().version.to_string();
    let bench = app.try_state::<Option<BenchConfig>>();
    let script = init_script(&version, bench.as_ref().and_then(|b| b.inner().as_ref()));
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("src/renderer/index.html".into()))
        .title("Sentry Drive")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1050.0, 650.0)
        .background_color(tauri::window::Color(0x0a, 0x0a, 0x0f, 0xff))
        .initialization_script(&script)
        .disable_drag_drop_handler();
    #[cfg(debug_assertions)]
    {
        builder = builder.devtools(true);
    }
    builder = builder.visible(true);
    builder.build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .setup(|app| {
            let user_data = app.path().app_data_dir()?;
            let resources = app.path().resource_dir()?;
            std::fs::create_dir_all(&user_data)?;

            let version = app.package_info().version.to_string();
            let os_build = sysctl_os_release();
            logger::set_app_info(&version, &os_build);
            logger::init_file_sink(user_data.join("logs"));
            logger::info(
                "main",
                format!(
                    "app starting — v{version} | {} {} ({os_build}) | {} CPUs | tauri {} | webview {}",
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    std::thread::available_parallelism().map_or(1, |n| n.get()),
                    tauri::VERSION,
                    tauri::webview_version().unwrap_or_else(|_| "?".into()),
                ),
            );

            let cache_root = app_commands::resolve_loader_cache_root(app.handle());
            app.manage(loader::LoaderService::new(cache_root));
            app.manage(supercharger::SuperchargerCatalog::new(
                resources.join("assets/tesla-superchargers.json"),
                user_data.join("catalogs/tesla-superchargers.json"),
            ));
            app.manage(drive_edit::DriveDataLock::default());
            app.manage(drive_edit::Watcher::default());
            app.manage(updater::UpdaterState::default());
            app.manage(geocode::GeocodeState::new(&user_data));
            app.manage(processing::ProcessingState::default());
            app.manage(bench_config());
            app.manage(AppPaths { user_data, resources });

            create_main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_commands::app_log,
            app_commands::download_logs,
            app_commands::select_directory,
            app_commands::select_file,
            app_commands::find_drive_data,
            app_commands::get_default_output_dir,
            app_commands::check_drive_data,
            app_commands::get_cpu_count,
            app_commands::open_external,
            app_commands::get_app_version,
            app_commands::get_changelog,
            app_commands::fetch_remote_changelog,
            app_commands::check_online,
            app_commands::load_and_group_drives,
            app_commands::list_drive_summaries,
            app_commands::get_drive_detail,
            app_commands::list_charging_sites,
            app_commands::list_charging_sessions,
            app_commands::get_charging_session,
            app_commands::get_supercharger_catalog_status,
            app_commands::refresh_supercharger_catalog,
            app_commands::toggle_devtools,
            app_commands::bench_report,
            drive_edit::set_drive_tags,
            drive_edit::remove_drive,
            drive_edit::remove_drives,
            drive_edit::watch_drive_data,
            drive_edit::revert_gps,
            drive_edit::has_gps_backup,
            drive_edit::import_drive_data_file_preview,
            drive_edit::import_drive_data_file,
            updater::set_allow_prerelease,
            updater::revert_to_stable,
            updater::check_for_update,
            updater::download_update,
            updater::install_update,
            geocode::reverse_geocode,
            geocode::get_geocode_settings,
            geocode::set_geocode_settings,
            geocode::remember_known_place,
            geocode::remove_known_place,
            geocode::sync_known_place_zones,
            processing::start_processing,
            processing::stop_processing,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sentry Drive");

    app.run(|handle, event| match event {
        // macOS convention (and the Electron build): closing the window keeps
        // the app in the Dock; clicking the Dock icon reopens it.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested { api, code: None, .. } => {
            api.prevent_exit();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => {
            if handle.get_webview_window(MAIN_WINDOW).is_none() {
                let _ = create_main_window(handle);
            }
        }
        RunEvent::Exit => {
            processing::kill_active(handle);
            if let Some(loader) = handle.try_state::<loader::LoaderService>() {
                loader.close_current();
            }
            logger::info("main", "app quitting");
        }
        _ => {}
    });
}

fn sysctl_os_release() -> String {
    std::process::Command::new("uname")
        .arg("-r")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}
