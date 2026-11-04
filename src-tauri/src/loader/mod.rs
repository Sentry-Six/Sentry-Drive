//! Drive loader: the Rust replacement for Electron's drive-loader utility
//! process (`drive-loader-service.cjs` + `drive-loader-client.cjs`).

pub mod calc;
pub mod charging;
pub mod grouper;
pub mod index;
pub mod route;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use index::{DriveIndex, Progress};

pub struct Loaded {
    pub index: DriveIndex,
    pub load_dir: PathBuf,
}

pub struct LoaderService {
    pub cache_root: PathBuf,
    pub state: Mutex<Option<Loaded>>,
    pub generation: AtomicU64,
    pub cancel: Arc<AtomicBool>,
    /// Serializes loads: each replaces the on-disk index.
    pub load_lock: tokio::sync::Mutex<()>,
}

/// Error carrying the `code` the renderer branches on.
#[derive(Debug)]
pub struct CodedError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for CodedError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for CodedError {}

pub fn coded(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    CodedError { code, message: message.into() }.into()
}

pub fn error_json(err: &anyhow::Error) -> Value {
    match err.downcast_ref::<CodedError>() {
        Some(c) => json!({ "success": false, "error": c.message, "code": c.code }),
        None => json!({ "success": false, "error": format!("{err:#}") }),
    }
}

fn file_sig(path: &Path) -> Option<(u64, SystemTime)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()?))
}

impl LoaderService {
    pub fn new(cache_root: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&cache_root);
        Self {
            cache_root,
            state: Mutex::new(None),
            generation: AtomicU64::new(0),
            cancel: Arc::new(AtomicBool::new(false)),
            load_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Remove load directories left by a crashed session.
    pub fn sweep_stale(&self) -> (usize, u64) {
        let (mut removed, mut bytes) = (0, 0);
        if let Ok(entries) = std::fs::read_dir(&self.cache_root) {
            for e in entries.flatten() {
                let p = e.path();
                if !p.is_dir() {
                    continue;
                }
                if let Ok(files) = std::fs::read_dir(&p) {
                    for f in files.flatten() {
                        bytes += f.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
                if std::fs::remove_dir_all(&p).is_ok() {
                    removed += 1;
                }
            }
        }
        (removed, bytes)
    }

    pub fn close_current(&self) {
        let old = self.state.lock().unwrap().take();
        if let Some(old) = old {
            let dir = old.load_dir.clone();
            drop(old);
            if dir.starts_with(&self.cache_root) && dir != self.cache_root {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    /// Blocking: index + group `file_path`, returning the IPC result.
    pub fn load(&self, file_path: &Path, page_size: i64, progress: &(dyn Fn(Progress) + Sync)) -> Result<Value> {
        self.close_current();
        self.cancel.store(false, Ordering::Relaxed);
        let before = file_sig(file_path).ok_or_else(|| anyhow!("ENOENT: no such file, stat '{}'", file_path.display()))?;
        let load_dir = self.cache_root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&load_dir)?;
        let run = || -> Result<(DriveIndex, Value)> {
            let index = DriveIndex::create(&load_dir.join("drive-index.sqlite"), file_path)
                .map_err(|e| coded("DRIVE_DATA_INVALID", format!("{e:#}")))?;
            let t_index = std::time::Instant::now();
            let counts = index::index_drive_data(&index, progress, &self.cancel).map_err(|e| {
                let msg = format!("{e:#}");
                if msg.contains("database or disk is full") {
                    coded("DRIVE_DATA_CACHE_FULL", msg)
                } else {
                    coded("DRIVE_DATA_INVALID", msg)
                }
            })?;
            let after = file_sig(file_path);
            if after != Some(before) {
                return Err(coded("DRIVE_DATA_CHANGED", "The drive data file changed while it was loading. Please retry."));
            }
            let t_group = std::time::Instant::now();
            let grouped = index::group_indexed_drives(&index, progress, &self.cancel)
                .map_err(|e| coded("DRIVE_DATA_INVALID", format!("{e:#}")))?;
            crate::logger::info(
                "main",
                format!(
                    "load phases: index {:.1} s ({} routes), group {:.1} s",
                    (t_group - t_index).as_secs_f64(),
                    counts.route_count,
                    t_group.elapsed().as_secs_f64()
                ),
            );
            let page = index.list_drive_summaries(&json!({ "offset": 0, "limit": page_size }))?;
            progress(Progress { phase: "preparing", current: 1, total: 1 });
            let mut out = serde_json::to_value(&counts)?.as_object().cloned().unwrap_or_default();
            out.insert("success".into(), json!(true));
            for (k, v) in grouped.as_object().cloned().unwrap_or_default() {
                out.insert(k, v);
            }
            out.insert("drives".into(), page["drives"].clone());
            out.insert(
                "page".into(),
                json!({ "offset": page["offset"], "limit": page["limit"], "total": page["total"] }),
            );
            Ok((index, Value::Object(out)))
        };
        let result = run();
        release_free_memory();
        match result {
            Ok((index, out)) => {
                *self.state.lock().unwrap() = Some(Loaded { index, load_dir });
                Ok(out)
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&load_dir);
                Err(e)
            }
        }
    }

    pub fn with_index<T>(&self, f: impl FnOnce(&DriveIndex) -> Result<T>) -> Result<T> {
        let guard = self.state.lock().unwrap();
        match guard.as_ref() {
            Some(l) => f(&l.index),
            None => Err(coded("NO_DRIVE_DATA", "No drive data is loaded")),
        }
    }

    pub fn is_stale(&self, gen: Option<u64>) -> bool {
        gen.is_some_and(|g| g != self.generation.load(Ordering::SeqCst))
    }
}

/// Hand memory freed after a load back to the OS. macOS's allocator otherwise
/// keeps the parse/group working set mapped, which inflates the footprint
/// Activity Monitor reports long after the load finished.
pub fn release_free_memory() {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // SAFETY: a null zone means "all zones"; goal 0 means "as much as possible".
        unsafe {
            malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        }
    }
}
