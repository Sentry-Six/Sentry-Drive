//! Drive loader: loads drive-data.json into the index and serves drive
//! summaries, details and charging history from it.

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

    /// Remove load directories left by a crashed session. Indexes never
    /// outlive the session that built them (each load creates a new directory,
    /// and a normal quit deletes it), so the route payload encoding can change
    /// between app versions without any migration: an older build's leftover
    /// index is deleted here, never opened.
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

/// Loader service tests: `load`, then queries through `with_index`.
#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        service: LoaderService,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.service.close_current();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("sd-loader-service-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("drive-data.json");
        std::fs::write(
            &source,
            json!({
                "processedFiles": ["a.mp4"],
                "routes": [{
                    "file": "RecentClips/2026-07-28_10-00-00-front.mp4",
                    "date": "2026-07-28_10-00-00",
                    "points": [[39.1, -76.7], [39.11, -76.71]],
                    "speeds": [1, 2],
                }],
                "driveTags": {},
                "telemetrySamples": [
                    { "ts": 1_000, "lat": 40, "lng": -76, "locationName": "Charge stop" },
                    { "ts": 1_010, "chargingState": "charging", "chargeEnergyAddedKwh": 2 },
                    { "ts": 1_020, "chargingState": "complete" },
                ],
                "chargeCosts": { "1010": { "amount": 3, "currency": "$" } },
            })
            .to_string(),
        )
        .unwrap();
        let service = LoaderService::new(root.join("cache"));
        Fixture { root, source, service }
    }

    #[test]
    fn loader_service_owns_a_disposable_index_and_serves_bounded_queries() {
        let f = fixture();
        let phases = Mutex::new(Vec::new());
        let loaded = f.service.load(&f.source, 25, &|p: Progress| phases.lock().unwrap().push(p.phase)).unwrap();
        assert_eq!(loaded["success"], json!(true));
        assert_eq!(loaded["totalDriveCount"], json!(1));
        assert_eq!(loaded["groupedDriveCount"], json!(1));
        assert_eq!(loaded["hiddenTessieCount"], json!(0));
        assert_eq!(loaded["hiddenTessieDrives"], json!([]));
        assert_eq!(loaded["drives"].as_array().unwrap().len(), 1);
        assert_eq!(loaded["chargingSessionCount"], json!(1));
        assert_eq!(loaded["chargingSiteCount"], json!(1));
        let phases = phases.into_inner().unwrap();
        assert!(phases.contains(&"reading") && phases.contains(&"grouping"), "{phases:?}");

        let page = f.service.with_index(|i| i.list_drive_summaries(&json!({ "offset": 0, "limit": 25 }))).unwrap();
        assert_eq!(page["total"], json!(1));
        assert_eq!(page["drives"].as_array().unwrap().len(), 1);

        let detail = f.service.with_index(|i| i.get_drive_detail(0, 100.0)).unwrap().unwrap();
        assert_eq!(detail["fullPointCount"], json!(2));

        let sites = f.service.with_index(|i| i.list_charging_sites()).unwrap();
        assert_eq!(sites.len(), 1);
        let site_id = sites[0]["siteId"].as_str().unwrap().to_string();
        let sessions = f.service.with_index(|i| i.list_charging_sessions(&site_id)).unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].get("chargeRateSamples").is_none());
        let session_id = sessions[0]["sessionId"].as_str().unwrap().to_string();
        let charging = f.service.with_index(|i| i.get_charging_session(&session_id)).unwrap().unwrap();
        assert_eq!(charging["chargeRateSamples"].as_array().unwrap().len(), 1);
        assert_eq!(charging["cost"]["amount"].as_f64(), Some(3.0));

        f.service.close_current();
        assert_eq!(std::fs::read_dir(&f.service.cache_root).unwrap().count(), 0);
        let err = f.service.with_index(|_| Ok(())).unwrap_err();
        assert_eq!(error_json(&err)["code"], "NO_DRIVE_DATA");
    }

    #[test]
    fn leftover_index_from_an_earlier_build_is_swept_not_read() {
        let f = fixture();
        // A crashed session of an older version left its index behind, in an
        // encoding this build can't read.
        let stale = f.service.cache_root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("drive-index.sqlite"), b"not an index this build can read").unwrap();
        assert_eq!(f.service.sweep_stale(), (1, 32));
        assert!(!stale.exists());

        let loaded = f.service.load(&f.source, 25, &|_| {}).unwrap();
        assert_eq!(loaded["totalDriveCount"], json!(1));
        let detail = f.service.with_index(|i| i.get_drive_detail(0, 100.0)).unwrap().unwrap();
        assert_eq!(detail["fullPointCount"], json!(2));
    }

    #[test]
    fn loader_service_converts_malformed_json_into_a_structured_error() {
        let f = fixture();
        std::fs::write(&f.source, r#"{"routes": ["#).unwrap();
        let err = f.service.load(&f.source, 250, &|_| {}).unwrap_err();
        let e = error_json(&err);
        assert_eq!(e["success"], json!(false));
        assert_eq!(e["code"], "DRIVE_DATA_INVALID");
        let message = e["error"].as_str().unwrap().to_lowercase();
        assert!(["parse", "json", "end"].iter().any(|w| message.contains(w)), "{message}");
        // A failed load leaves no index directory behind.
        assert_eq!(std::fs::read_dir(&f.service.cache_root).unwrap().count(), 0);
    }
}
