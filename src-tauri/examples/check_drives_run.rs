//! Run Check Drives on a drive-data.json copy (parity checks):
//!   check_drives_run repair <file> [routing]
//!   check_drives_run summon <file> <clipsDir> <cacheDir>
use std::path::Path;

use sentry_drive_lib::check_drives::{check_summon_core, repair_gps_core};

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let progress = |_: &str, _: usize, _: usize, _: Option<f64>| {};
    let t = std::time::Instant::now();
    let out = match a.get(1).map(String::as_str) {
        Some("repair") => repair_gps_core(Path::new(&a[2]), a.get(3).is_some_and(|s| s == "routing"), &progress)?,
        Some("summon") => check_summon_core(Path::new(&a[2]), Some(&a[3]), Path::new(&a[4]), &progress)?,
        // Test setup: drop Summon evidence from routes whose file contains
        // `needle`, so check-summon has clips to read.
        Some("strip") => {
            let needle = a[3].clone();
            let n = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let n2 = n.clone();
            sentry_drive_lib::drive_data::write_drive_data(
                Path::new(&a[2]),
                vec![(
                    "routes",
                    sentry_drive_lib::drive_data::Replacement::Map {
                        edit: Box::new(move |el: &[u8]| {
                            if !el.windows(needle.len()).any(|w| w == needle.as_bytes()) {
                                return Ok(None);
                            }
                            let mut v: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(el)?;
                            if v.remove("flagRuns").is_some() | v.remove("apRuns").is_some() {
                                n2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            }
                            Ok(Some(serde_json::to_vec(&v)?))
                        }),
                        pretty: true,
                    },
                )],
                &|| true,
            )?;
            serde_json::json!({ "stripped": n.load(std::sync::atomic::Ordering::Relaxed) })
        }
        _ => anyhow::bail!("usage: repair <file> [routing] | summon <file> <clipsDir> <cacheDir>"),
    };
    eprintln!("{:.1} s", t.elapsed().as_secs_f64());
    println!("{out}");
    Ok(())
}
