//! Build script. Before tauri-build runs, make sure the two generated inputs
//! the config points at exist, so `cargo build` / `cargo test` work from a
//! clean checkout (CI runs the Rust tests before any `tauri build`):
//!
//! - `../tauri-dist`: the frontend (`frontendDist`), normally assembled by
//!   the `beforeBuildCommand`; `generate_context!()` needs it to compile.
//! - `target/squirrel-shim/Squirrel.framework` (macOS targets): the relaunch
//!   helper listed in `bundle.macOS.frameworks`, normally built by the
//!   `beforeBundleCommand`, which rebuilds and signs it before bundling.
//!
//! Both come from the same Node scripts the Tauri CLI runs, and only when
//! missing, so a normal `tauri build` is unchanged.

use std::path::Path;
use std::process::Command;

fn run_node(script: &str, what: &str) {
    let status = Command::new("node").arg(script).status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!("{what}: `node {script}` failed ({s})"),
        Err(e) => panic!("{what} is missing and Node.js could not be run ({e}). Run `node {script}` from the repo root, or install Node."),
    }
}

fn main() {
    if !Path::new("../tauri-dist/src/renderer/index.html").exists() {
        run_node("../scripts/tauri/prepare-frontend.mjs", "the frontend (tauri-dist)");
    }
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" && !Path::new("target/squirrel-shim/Squirrel.framework/Versions/A/Resources/ShipIt").exists() {
        run_node("../scripts/tauri/squirrel-shim.mjs", "the macOS relaunch helper (Squirrel.framework)");
    }
    tauri_build::build()
}
