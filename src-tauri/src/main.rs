// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// mimalloc returns freed pages to the OS; the system allocator kept ~400 MB
// of a finished drive load mapped (measured with vmmap: 89% fragmentation).
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    sentry_drive_lib::run()
}
