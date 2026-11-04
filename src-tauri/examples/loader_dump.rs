//! Rust half of the loader parity check (see scripts/tauri/loader-parity.mjs):
//!
//!   TZ=America/Denver cargo run --release --example loader_dump -- <drive-data.json> <out.ndjson>

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use serde_json::{json, Value};
use sentry_drive_lib::loader::LoaderService;

fn digest(detail: &Value) -> Value {
    let empty = vec![];
    let pts = detail["points"].as_array().unwrap_or(&empty);
    let mut sum = [0.0f64; 4];
    for p in pts {
        for (i, s) in sum.iter_mut().enumerate() {
            *s += p[i].as_f64().unwrap_or(0.0);
        }
    }
    let hist = |v: &Value| -> Value {
        match v.as_array() {
            None => Value::Null,
            Some(xs) => {
                let mut h: BTreeMap<String, u64> = BTreeMap::new();
                for x in xs {
                    *h.entry(x.to_string()).or_default() += 1;
                }
                json!(h)
            }
        }
    };
    let events: Vec<String> = detail["fsdEvents"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .map(|e| format!("{}@{:.6},{:.6}", e["type"].as_str().unwrap_or(""), e["lat"].as_f64().unwrap_or(0.0), e["lng"].as_f64().unwrap_or(0.0)))
        .collect();
    json!({
        "n": pts.len(),
        "sum": sum,
        "first": pts.first(),
        "last": pts.last(),
        "fsd": hist(&detail["fsdStates"]),
        "gear": hist(&detail["gearStates"]),
        "events": events,
    })
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let file = PathBuf::from(&args[1]);
    let out_path = PathBuf::from(&args[2]);
    let cache = std::env::temp_dir().join(format!("sd-parity-rust-{}", std::process::id()));
    let svc = LoaderService::new(cache.clone());
    let t0 = Instant::now();
    let res = svc.load(&file, 1000, &|_| {})?;
    let elapsed = t0.elapsed();
    let mut out = std::io::BufWriter::new(std::fs::File::create(&out_path)?);
    let mut meta = res.as_object().cloned().unwrap_or_default();
    meta.remove("drives");
    meta.remove("page");
    writeln!(out, "{}", json!({ "meta": meta }))?;
    svc.with_index(|ix| {
        let mut offset = 0;
        loop {
            let page = ix.list_drive_summaries(&json!({ "offset": offset, "limit": 1000 }))?;
            let drives = page["drives"].as_array().cloned().unwrap_or_default();
            for s in &drives {
                let detail = ix.get_drive_detail(s["id"].as_i64().unwrap(), 200_000.0)?.unwrap_or(Value::Null);
                writeln!(out, "{}", json!({ "summary": s, "detail": digest(&detail) }))?;
            }
            offset += drives.len();
            if drives.is_empty() || offset as i64 >= page["total"].as_i64().unwrap_or(0) {
                break;
            }
        }
        let sites = ix.list_charging_sites()?;
        writeln!(out, "{}", json!({ "chargingSites": sites }))?;
        for site in &sites {
            let id = site["siteId"].as_str().unwrap_or("");
            writeln!(out, "{}", json!({ "chargingSessions": id, "sessions": ix.list_charging_sessions(id)? }))?;
        }
        Ok(())
    })?;
    out.flush()?;
    svc.close_current();
    let _ = std::fs::remove_dir_all(cache);
    eprintln!("rust loader: {} drives in {:.1} s", res["totalDriveCount"], elapsed.as_secs_f64());
    Ok(())
}
