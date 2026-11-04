//! Clip processing: native port of src/processing/process.js, worker.js,
//! extract.js, clip-discovery.js and process-result.cjs, run in-process on
//! background threads instead of a Node child process. The commands mirror
//! electron-main.cjs's `start-processing` / `stop-processing` handlers and
//! stream the same `processing-output` events.

mod discovery;
mod extract;
pub mod pipeline;

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::logger;
use pipeline::{Options, Stream};

const SCOPE: &str = "processing";
/// How long stop waits for the run to wind down (Electron: SIGTERM, then
/// SIGKILL after 5 s). Workers finish the clip they are reading first.
const STOP_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct ActiveRun {
    id: u64,
    cancel: Arc<AtomicBool>,
    user_stopped: Arc<AtomicBool>,
    finished: Arc<(Mutex<bool>, Condvar)>,
}

#[derive(Default)]
pub struct ProcessingState {
    active: Mutex<Option<ActiveRun>>,
    next_id: AtomicU64,
}

fn lock_active(state: &ProcessingState) -> std::sync::MutexGuard<'_, Option<ActiveRun>> {
    state.active.lock().unwrap_or_else(|e| e.into_inner())
}

/// Called on app exit: stop any run without waiting for it.
pub fn kill_active(app: &AppHandle) {
    let Some(state) = app.try_state::<ProcessingState>() else { return };
    let active = lock_active(&state);
    if let Some(run) = active.as_ref() {
        run.user_stopped.store(true, Ordering::SeqCst);
        run.cancel.store(true, Ordering::SeqCst);
    }
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("processing-output", payload);
}

#[tauri::command]
pub async fn start_processing(app: AppHandle, args: Value) -> Value {
    let clips_dir = args.get("clipsDir").and_then(Value::as_str).unwrap_or("").to_string();
    let output_dir = args.get("outputDir").and_then(Value::as_str).unwrap_or("").to_string();
    let reprocess_all = args.get("reprocessAll").and_then(Value::as_bool).unwrap_or(false);
    // `workerCount && workerCount > 0` → parseInt → max(1, n); otherwise auto.
    let worker_arg = args.get("workerCount").and_then(Value::as_f64).filter(|w| w.is_finite() && *w > 0.0);
    let workers = worker_arg.map(|w| (w.trunc() as usize).max(1)).unwrap_or_else(pipeline::default_workers);

    if clips_dir.is_empty() {
        return json!({ "success": false, "error": "No clips folder selected" });
    }
    if output_dir.is_empty() {
        return json!({ "success": false, "error": "No output folder selected" });
    }

    let state = app.state::<ProcessingState>();
    let run = {
        let mut active = lock_active(&state);
        if active.is_some() {
            return json!({ "success": false, "error": "Processing already running" });
        }
        // Validate the output directory before starting a long processing run.
        if let Err(err) = std::fs::create_dir_all(&output_dir) {
            logger::error(SCOPE, format!("output dir not usable: {output_dir} — {err}"));
            return json!({ "success": false, "error": format!("Cannot create output folder \"{output_dir}\": {err}") });
        }
        let run = ActiveRun {
            id: state.next_id.fetch_add(1, Ordering::SeqCst) + 1,
            cancel: Arc::new(AtomicBool::new(false)),
            user_stopped: Arc::new(AtomicBool::new(false)),
            finished: Arc::new((Mutex::new(false), Condvar::new())),
        };
        *active = Some(run.clone());
        run
    };

    logger::info(
        SCOPE,
        format!(
            "{} started — workers={}, clips={clips_dir}",
            if reprocess_all { "reprocess-all" } else { "process new" },
            worker_arg.map(|w| w.to_string()).unwrap_or_else(|| "auto".into())
        ),
    );

    let opts = Options {
        clips_dir: PathBuf::from(&clips_dir),
        output_path: PathBuf::from(&output_dir).join("drive-data.json"),
        workers,
        reprocess_all,
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    let app2 = app.clone();
    let spawned = std::thread::Builder::new().name("processing".into()).spawn(move || {
        let app = app2;
        let stopped = run.user_stopped.clone();
        let sink = |stream: Stream, text: &str| {
            // A stopped run is silent, like the SIGTERM'd child.
            if stopped.load(Ordering::SeqCst) {
                return;
            }
            match stream {
                Stream::Stdout => {
                    emit(&app, json!({ "type": "stdout", "text": text }));
                    for line in text.split('\n') {
                        if let Some(rest) = line.strip_prefix("SUMMARY:") {
                            logger::info(SCOPE, rest.trim());
                        }
                    }
                }
                Stream::Stderr => {
                    logger::error(SCOPE, text.trim());
                    emit(&app, json!({ "type": "stderr", "text": text }));
                }
            }
        };
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| pipeline::run(&opts, &run.cancel, &sink)));

        // Release the slot before announcing completion, as the Electron
        // close handler did, so a stop or a new start sees it free.
        {
            let state = app.state::<ProcessingState>();
            let mut active = lock_active(&state);
            if active.as_ref().is_some_and(|a| a.id == run.id) {
                *active = None;
            }
        }
        let user_stopped = run.user_stopped.load(Ordering::SeqCst);
        let result = match outcome {
            Ok(code) => {
                let code_json = code.map_or(Value::Null, |c| json!(c));
                logger::info(SCOPE, format!("child exited with code {}", code.map_or("null".into(), |c| c.to_string())));
                if !user_stopped {
                    emit(&app, json!({ "type": "done", "code": code_json }));
                }
                json!({ "success": true, "exitCode": code_json })
            }
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "processing crashed".into());
                logger::error(SCOPE, format!("processing crashed: {msg}"));
                if !user_stopped {
                    emit(&app, json!({ "type": "error", "text": msg }));
                }
                json!({ "success": false, "error": msg })
            }
        };
        let (lock, cv) = &*run.finished;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
        cv.notify_all();
        let _ = tx.send(result);
    });

    if let Err(err) = spawned {
        let state = app.state::<ProcessingState>();
        *lock_active(&state) = None;
        logger::error(SCOPE, format!("spawn failed: {err}"));
        return json!({ "success": false, "error": format!("spawn failed: {err}") });
    }
    rx.await.unwrap_or_else(|_| json!({ "success": false, "error": "processing thread ended unexpectedly" }))
}

#[tauri::command]
pub async fn stop_processing(app: AppHandle) -> Value {
    let run = {
        let state = app.state::<ProcessingState>();
        let active = lock_active(&state);
        match active.as_ref() {
            Some(run) => run.clone(),
            None => return json!({ "success": false, "error": "No process running" }),
        }
    };
    // Suppress the run's own final status; the renderer reports the stop.
    run.user_stopped.store(true, Ordering::SeqCst);
    run.cancel.store(true, Ordering::SeqCst);
    let finished = run.finished.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let (lock, cv) = &*finished;
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = cv.wait_timeout_while(guard, STOP_WAIT, |done| !*done);
    })
    .await;
    json!({ "success": true })
}
