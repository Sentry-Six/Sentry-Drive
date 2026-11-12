//! Sentry Drive — Tauri shell.
//!
//! The renderer (`src/renderer/*`) talks to this backend through
//! `window.electronAPI`, plus the `window.driveCalc` and
//! `window.driveTelemetryView` helpers. An initialization script installs all
//! three, backed by the Tauri commands registered here.


// Comparisons such as `!(a > b)` mirror the JavaScript they were ported from,
// including how NaN behaves; rewriting them with partial_cmp would obscure that.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

mod app_commands;
pub mod check_drives;
pub mod drive_data;
mod drive_edit;
pub mod fsutil;
mod geocode;
pub mod imports;
pub mod loader;
pub mod logger;
mod migrate;
mod processing;
mod secrets;
pub mod supercharger;
mod updater;

use std::path::PathBuf;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub const MAIN_WINDOW: &str = "main";

pub struct AppPaths {
    pub user_data: PathBuf,
    pub resources: PathBuf,
}

/// Wrap a CommonJS module so it can run as a classic page script and publish
/// its exports as a frozen global (what contextBridge did in the preload).
fn cjs_global(global: &str, source: &str) -> String {
    format!(
        "(function () {{ var module = {{ exports: {{}} }}; var exports = module.exports;\n{source}\n;window.{global} = Object.freeze(Object.assign({{}}, module.exports)); }})();\n"
    )
}

fn init_script() -> String {
    let mut js = String::new();
    js.push_str(&cjs_global("driveCalc", include_str!("../../src/shared/drive-calc.cjs")));
    js.push_str(&cjs_global("driveTelemetryView", include_str!("../../src/renderer/drive-telemetry-view.cjs")));
    js.push_str(include_str!("../../src/tauri-bridge/bridge.js"));
    js
}

pub fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut script = init_script();
    if let Some(p) = app.try_state::<AppPaths>() {
        script.push_str(&migrate::local_storage_script(&migrate::pending_local_storage(&p.user_data)));
    }
    let window_state = migrate::load_window_state(app);
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("src/renderer/index.html".into()))
        .title("Sentry Drive")
        .min_inner_size(1050.0, 650.0)
        .background_color(tauri::window::Color(0x0a, 0x0a, 0x0f, 0xff))
        .initialization_script(&script)
        .disable_drag_drop_handler();
    #[cfg(debug_assertions)]
    {
        builder = builder.devtools(true);
    }
    builder = migrate::apply_window_state(builder, &window_state).visible(true);
    let window = builder.build()?;
    migrate::track_window_state(&window, window_state);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Electron's data folder, so the Tauri build is a drop-in update.
            let user_data = migrate::user_data_dir(app.handle())?;
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
            app.manage(imports::ImportState::default());
            app.manage(updater::UpdaterState::default());
            app.manage(geocode::GeocodeState::new(&user_data));
            app.manage(processing::ProcessingState::default());
            app.manage(AppPaths { user_data, resources });

            create_main_window(app.handle())?;
            // Logged like Electron (presence only); moves Electron tokens over.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let has = |k| if secrets::load_token(&handle, k).is_empty() { "no" } else { "yes" };
                logger::info(
                    "import",
                    format!("integrations: tessie={} teslascope={}", has(secrets::Kind::Tessie), has(secrets::Kind::Teslascope)),
                );
            });
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
            app_commands::open_licenses,
            app_commands::get_app_version,
            app_commands::get_changelog,
            app_commands::fetch_remote_changelog,
            app_commands::check_online,
            app_commands::load_and_group_drives,
            app_commands::list_drive_summaries,
            app_commands::list_drive_overview,
            app_commands::get_drive_detail,
            app_commands::list_charging_sites,
            app_commands::list_charging_sessions,
            app_commands::get_charging_session,
            app_commands::get_supercharger_catalog_status,
            app_commands::refresh_supercharger_catalog,
            app_commands::toggle_devtools,
            drive_edit::set_drive_tags,
            drive_edit::remove_drive,
            drive_edit::remove_drives,
            drive_edit::watch_drive_data,
            drive_edit::revert_gps,
            drive_edit::has_gps_backup,
            check_drives::repair_gps,
            check_drives::check_summon,
            secrets::tessie_api_get_token,
            secrets::tessie_api_save_token,
            secrets::teslascope_api_get_token,
            secrets::teslascope_api_save_token,
            imports::tessie_preview,
            imports::tessie_import,
            imports::tessie_import_cancel,
            imports::tessie_remove_hidden,
            imports::tessie_remove_all,
            imports::tessie_api_validate,
            imports::tessie_api_preview,
            imports::tessie_api_import,
            imports::tessie_api_cancel,
            imports::teslascope_api_validate,
            imports::teslascope_api_preview,
            imports::teslascope_api_import,
            imports::teslascope_api_cancel,
            imports::teslascope_remove_hidden,
            imports::teslascope_remove_all,
            migrate::electron_storage_imported,
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
        // macOS convention: closing the window keeps the app in the Dock;
        // clicking the Dock icon reopens it.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested { api, code: None, .. } => {
            api.prevent_exit();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } if handle.get_webview_window(MAIN_WINDOW).is_none() => {
            let _ = create_main_window(handle);
        }
        RunEvent::Exit => {
            updater::install_on_quit(handle);
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
