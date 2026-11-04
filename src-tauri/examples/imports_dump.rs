//! Rust half of the import parity check (see scripts/tauri/imports-parity.mjs,
//! which runs this and diffs the output against the JavaScript):
//!
//!   TZ=America/Denver cargo run --example imports_dump -- <fixtures dir> <work dir> <out.json>
//!
//! HTTP is answered from the fixture maps by `FakeHttp`, which applies the
//! same auth rules as the Node fake and records every request.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Duration;

use sentry_drive_lib::imports::{self, clips, csv, http::Http, teslascope_api, OverlapCache};
use serde_json::{json, Map, Value};

// ── Encoding shared with the Node dumper ───────────────────────────────────

fn f(x: f64) -> Value {
    if x.is_nan() {
        json!("__NaN")
    } else if x.is_infinite() {
        json!(if x > 0.0 { "__Infinity" } else { "__-Infinity" })
    } else {
        imports::js::num(x)
    }
}

/// `null` for a JS `null` field.
fn null_or(x: Option<f64>) -> Value {
    x.map_or(Value::Null, f)
}

/// "__undefined" for a JS `undefined` field.
fn undef_or(x: Option<f64>) -> Value {
    x.map_or(json!("__undefined"), f)
}

fn csv_drive(d: &clips::Drive) -> Value {
    let mut v = json!({
        "startedAt": f(d.started_at),
        "endedAt": f(d.ended_at),
        "durationMs": f(d.duration_ms),
        "distanceMi": f(d.distance_mi),
        "autopilotDistanceMi": f(d.autopilot_distance_mi),
        "startingOdometer": null_or(d.starting_odometer),
        "endingOdometer": null_or(d.ending_odometer),
        "startLat": null_or(d.start_lat),
        "startLng": null_or(d.start_lng),
        "endLat": null_or(d.end_lat),
        "endLng": null_or(d.end_lng),
    });
    if let Some(s) = d.tz_shift_ms {
        v["_tzShiftMs"] = f(s);
    }
    v
}

fn state(s: &clips::StatePoint) -> Value {
    json!({ "timeMs": f(s.time_ms), "lat": f(s.lat), "lng": f(s.lng), "shift": s.shift, "speedMph": f(s.speed_mph), "odometer": null_or(s.odometer) })
}

fn built(b: Result<clips::Built, String>) -> Value {
    match b {
        Ok(clips::Built::Clips { clips, point_count }) => json!({ "clips": clips, "pointCount": point_count }),
        Ok(clips::Built::Skip(reason)) => json!({ "clips": null, "reason": reason }),
        Err(e) => json!({ "__error": e }),
    }
}

fn ts_drive(d: &teslascope_api::Drive) -> Value {
    json!({
        "id": d.id.clone().unwrap_or(json!("__undefined")),
        "startedAt": f(d.started_at),
        "endedAt": f(d.ended_at),
        "distanceMi": f(d.distance_mi),
        "autopilotDistanceMi": f(d.autopilot_distance_mi),
        "startingOdometer": undef_or(d.starting_odometer),
        "startLat": undef_or(d.start_lat),
        "startLng": undef_or(d.start_lng),
        "endLat": undef_or(d.end_lat),
        "endLng": undef_or(d.end_lng),
        "points": d.points.iter().map(|p| json!({
            "latitude": f(p.latitude),
            "longitude": f(p.longitude),
            "timestamp": f(p.timestamp),
            "speed": undef_or(p.speed),
            "autopilot": p.autopilot,
        })).collect::<Vec<_>>(),
    })
}

// ── Fake HTTP ──────────────────────────────────────────────────────────────

struct FakeHttp {
    tessie: Value,
    teslascope: Value,
    log: Mutex<Vec<Value>>,
}

fn route(fix: &Value, path: &str) -> (u16, String) {
    match fix["routes"].get(path) {
        None => (404, "Not Found".into()),
        Some(r) => {
            let status = r["status"].as_u64().unwrap_or(500) as u16;
            let body = match r.get("json") {
                Some(j) => j.to_string(),
                None => r["text"].as_str().unwrap_or("").to_string(),
            };
            (status, body)
        }
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Http for FakeHttp {
    fn get(&self, host: &str, path: &str, headers: &[(&str, String)]) -> Result<(u16, String), String> {
        let mut sorted: Vec<(&str, String)> = headers.to_vec();
        sorted.sort_by(|a, b| a.0.cmp(b.0));
        self.log.lock().unwrap().push(json!({
            "host": host,
            "path": path,
            "headers": sorted.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
        }));
        let auth = headers.iter().find(|(k, _)| *k == "Authorization").map(|(_, v)| v.as_str());
        Ok(match host {
            "api.tessie.com" => {
                if auth != self.tessie["auth"].as_str() {
                    (401, r#"{"error":"unauthorized"}"#.into())
                } else {
                    route(&self.tessie, path)
                }
            }
            "teslascope.com" => {
                let key = path.split(['?', '&']).find_map(|kv| kv.strip_prefix("api_key=")).map(percent_decode);
                if auth.is_some() || key.as_deref() != self.teslascope["legacyKey"].as_str() {
                    (401, "Unauthorized".into())
                } else {
                    route(&self.teslascope, path)
                }
            }
            _ => (404, "Not Found".into()),
        })
    }
}

// ── Steps (mirrors `steps()` in imports-parity.mjs) ────────────────────────

fn steps(fix: &Path, work: &Path) -> Vec<(&'static str, Value, Option<PathBuf>)> {
    let args: Value = serde_json::from_slice(&std::fs::read(fix.join("args.json")).unwrap()).unwrap();
    let p = |x: &Path| x.to_string_lossy().into_owned();
    let dd = work.join("drive-data.json");
    let fresh = work.join("new.json");
    let missing = work.join("missing.json");
    let csv = |dd: &Path, drives: &str, states: &str| {
        json!({ "driveDataPath": p(dd), "drivesCsvPath": p(&fix.join(drives)), "statesCsvPath": p(&fix.join(states)) })
    };
    let with_dd = |base: &Value| {
        let mut v = base.clone();
        v["driveDataPath"] = json!(p(&dd));
        v
    };
    let (t_args, ts_args) = (with_dd(&args["tessie"]), with_dd(&args["teslascope"]));
    let ddv = json!({ "driveDataPath": p(&dd) });
    let s = Some(dd.clone());
    vec![
        ("tessie-preview", csv(&missing, "drives.csv", "driving_states.csv"), None),
        ("tessie-preview", csv(&dd, "drives.csv", "driving_states.csv"), None),
        ("tessie-preview", csv(&dd, "drives-bad-tz.csv", "driving_states.csv"), None),
        ("tessie-preview", csv(&dd, "drives.csv", "nope.csv"), None),
        ("tessie-import", csv(&dd, "drives.csv", "driving_states.csv"), s.clone()),
        ("tessie-import", csv(&dd, "drives.csv", "driving_states.csv"), s.clone()),
        ("tessie-import", csv(&fresh, "drives.csv", "driving_states.csv"), Some(fresh.clone())),
        ("tessie-import", csv(&fresh, "drives-legacy.csv", "driving_states.csv"), Some(fresh.clone())),
        ("tessie-api-validate", json!({ "token": "wrong" }), None),
        ("tessie-api-validate", json!({ "token": args["tessie"]["token"] }), None),
        ("tessie-api-preview", t_args.clone(), None),
        ("tessie-api-import", t_args.clone(), s.clone()),
        ("tessie-api-preview", t_args.clone(), None),
        ("teslascope-api-validate", json!({ "token": "wrong" }), None),
        ("teslascope-api-validate", json!({ "token": args["teslascope"]["token"] }), None),
        ("teslascope-api-preview", ts_args.clone(), None),
        ("teslascope-api-import", ts_args.clone(), s.clone()),
        ("teslascope-api-preview", ts_args.clone(), None),
        ("tessie-remove-hidden", ddv.clone(), s.clone()),
        ("teslascope-remove-hidden", ddv.clone(), s.clone()),
        ("teslascope-remove-hidden", ddv.clone(), s.clone()),
        ("tessie-remove-all", ddv.clone(), s.clone()),
        ("teslascope-remove-all", ddv.clone(), s.clone()),
        ("tessie-remove-all", ddv.clone(), s.clone()),
        ("tessie-remove-hidden", json!({ "driveDataPath": p(&missing) }), None),
    ]
}

/// Raw text: Node parses both sides (serde_json's default float parsing is
/// not correctly rounded, so re-parsing here would add 1-ulp noise).
fn read_text(p: &Path) -> Value {
    std::fs::read(p).ok().map_or(Value::Null, |b| Value::String(String::from_utf8_lossy(&b).into_owned()))
}

fn norm_events(events: Vec<(String, Value)>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for (ch, mut d) in events {
        if d.get("etaSec").is_some() {
            d["etaSec"] = json!("eta");
        }
        let e = json!([ch, d]);
        if out.last() != Some(&e) {
            out.push(e);
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let fix = PathBuf::from(&args[1]);
    let work = PathBuf::from(&args[2]);
    let out_path = PathBuf::from(&args[3]);
    let read = |name: &str| String::from_utf8_lossy(&std::fs::read(fix.join(name)).unwrap()).into_owned();
    let read_v = |name: &str| -> Value { serde_json::from_str(&read(name)).unwrap() };
    let mut out = Map::new();

    // CSV parsing, calibration, signatures, clip building.
    let states = csv::parse_driving_states_csv(&read("driving_states.csv"));
    let drives = csv::parse_drives_csv(&read("drives.csv")).unwrap();
    let legacy = csv::parse_drives_csv(&read("drives-legacy.csv")).unwrap();
    out.insert("csvDrives".into(), drives.iter().map(csv_drive).collect());
    out.insert("csvLegacy".into(), legacy.iter().map(csv_drive).collect());
    out.insert(
        "csvBadTz".into(),
        match csv::parse_drives_csv(&read("drives-bad-tz.csv")) {
            Ok(d) => d.iter().map(csv_drive).collect(),
            Err(e) => json!({ "__error": e }),
        },
    );
    out.insert("states".into(), states.iter().map(state).collect());
    let cal: Vec<clips::Drive> = drives.iter().map(|d| clips::calibrate_drive_time(d, &states)).collect();
    out.insert("calibrated".into(), cal.iter().map(csv_drive).collect());
    out.insert(
        "signatures".into(),
        cal.iter().map(|d| json!(clips::external_signature(d.started_at, &clips::Odo::from_opt(d.starting_odometer), "tessie").unwrap())).collect(),
    );
    out.insert("built".into(), drives.iter().map(|d| built(clips::build_clips_for_drive(d, &states, "tessie"))).collect());
    out.insert("legacyBuilt".into(), legacy.iter().map(|d| built(clips::build_clips_for_drive(d, &states, "tessie"))).collect());
    let cases: [(f64, Option<f64>, &str); 8] = [
        (1_721_052_000_000.0, Some(12345.675), "tessie"),
        (1_721_052_059_999.0, Some(0.125), "tessie"),
        (-1.0, Some(99999.995), "tessie"),
        (0.0, Some(1.005), "teslascope"),
        (f64::NAN, None, "tessie"),
        (1.5e12, Some(-0.125), "tessie"),
        (1_721_052_000_000.0, None, "teslascope"),
        (1_721_052_000_000.0, Some(1e21), "tessie"),
    ];
    out.insert(
        "sigCases".into(),
        cases.iter().map(|(s, o, src)| json!(clips::external_signature(*s, &clips::Odo::from_opt(*o), src).unwrap())).collect(),
    );

    // Overlap against the fixture drive-data.json.
    let index = imports::OverlapIndex::read(&fix.join("drive-data.json")).unwrap();
    out.insert(
        "ranges".into(),
        index.ranges.iter().map(|r| json!({ "start": f(r.start), "end": f(r.end), "source": r.source })).collect(),
    );
    out.insert("overlap".into(), cal.iter().map(|d| json!(clips::has_overlap(d.started_at, d.ended_at, &index.ranges))).collect());

    // Teslascope normalization and clips straight from the fixture responses.
    let dates: Vec<Value> = serde_json::from_str(&read("date-strings.json")).unwrap();
    out.insert("toMs".into(), dates.iter().map(|d| f(teslascope_api::to_ms(Some(d)))).collect());
    let nums = [json!("12.5"), json!(" 7"), json!("1e3x"), json!("abc"), json!(""), json!(3), Value::Null, json!(true), json!("-0.5")];
    out.insert("num".into(), nums.iter().map(|v| undef_or(teslascope_api::num(Some(v)))).collect());
    let aps = [
        json!("on"), json!(" Active "), json!("FSD"), json!("standby"), json!(""), json!("true"), json!("1"), json!(1), json!(0),
        json!(-1), json!(true), json!(false), Value::Null, json!("engaged!"),
    ];
    out.insert("mapAutopilot".into(), aps.iter().map(|v| json!(teslascope_api::map_autopilot(Some(v)))).collect());
    let tsc = read_v("teslascope-api.json");
    let list = teslascope_api::unwrap_envelope(tsc["routes"]["/api/vehicle/tsv1/drives?limit=100&api_key=ts-key"]["json"].clone());
    let (mut norm, mut tsb) = (Vec::new(), Vec::new());
    for raw in list["drives"].as_array().unwrap() {
        let id = imports::js::to_string(raw.get("id"));
        let key = format!("/api/vehicle/tsv1/drive/{}?api_key=ts-key", imports::js::encode_uri_component(&id));
        let det = tsc["routes"].get(&key).and_then(|r| r.get("json")).map(|j| {
            let body = teslascope_api::unwrap_envelope(j.clone());
            teslascope_api::pick(Some(&body), &["drive", "result", "data"]).cloned().unwrap_or(body)
        });
        let n = teslascope_api::normalize_drive(Some(raw), det.as_ref());
        norm.push(ts_drive(&teslascope_api::normalize_drive(Some(raw), None)));
        norm.push(ts_drive(&n));
        tsb.push(if n.started_at.is_finite() { built(clips::build_clips_for_api_drive(&n.to_api(), "teslascope")) } else { Value::Null });
    }
    out.insert("tsNormalized".into(), norm.into());
    out.insert("tsBuilt".into(), tsb.into());

    // Handlers against a scratch copy, step by step.
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    std::fs::copy(fix.join("drive-data.json"), work.join("drive-data.json")).unwrap();
    let fake = FakeHttp { tessie: read_v("tessie-api.json"), teslascope: tsc.clone(), log: Mutex::new(Vec::new()) };
    let cache = OverlapCache::default();
    let auth = teslascope_api::AuthState::default();
    let client = teslascope_api::Client { http: &fake, auth: &auth, page_pause: Duration::ZERO };
    let cancel = AtomicBool::new(false);
    let mut out_steps = Vec::new();
    for (name, args, file) in steps(&fix, &work) {
        fake.log.lock().unwrap().clear();
        let events: Mutex<Vec<(String, Value)>> = Mutex::new(Vec::new());
        let channel = if name.starts_with("teslascope") { "teslascope-progress" } else { "tessie-progress" };
        let path = args.get("driveDataPath").and_then(Value::as_str).map(String::from);
        let result = {
            let emit = |v: Value| events.lock().unwrap().push((channel.to_string(), v));
            let api_result = |fetched: Result<imports::FetchOutcome, String>, label: &str| match fetched {
                Ok(fo) => imports::finish_api_import(label, fo, path.as_deref(), &emit).0,
                Err(e) => json!({ "success": false, "error": e }),
            };
            let result = match name {
                "tessie-preview" => imports::tessie_preview_core(&args),
                "tessie-import" => imports::tessie_import_core(&args, &cancel, &emit).0,
                "tessie-api-validate" => imports::tessie_api_validate_core(&fake, &args),
                "tessie-api-preview" => imports::tessie_api_preview_core(&fake, &cache, &args),
                "tessie-api-import" => api_result(imports::tessie_api_fetch(&fake, &cache, &args, &cancel, &emit, Duration::ZERO), "tessie"),
                "teslascope-api-validate" => imports::teslascope_api_validate_core(&client, &args),
                "teslascope-api-preview" => imports::teslascope_api_preview_core(&client, &cache, &args),
                "teslascope-api-import" => api_result(imports::teslascope_api_fetch(&client, &cache, &args, &cancel, &emit, Duration::ZERO), "teslascope"),
                "tessie-remove-hidden" => imports::remove_hidden_core(path.as_deref(), "tessie").0,
                "teslascope-remove-hidden" => imports::remove_hidden_core(path.as_deref(), "teslascope").0,
                "tessie-remove-all" => imports::remove_all_core(path.as_deref(), "tessie").0,
                "teslascope-remove-all" => imports::remove_all_core(path.as_deref(), "teslascope").0,
                other => panic!("unknown step {other}"),
            };
            result
        };
        let bak = file.as_ref().map(|f| PathBuf::from(format!("{}.bak", f.display())));
        out_steps.push(json!({
            "name": name,
            "result": result,
            "events": norm_events(events.into_inner().unwrap()),
            "requests": std::mem::take(&mut *fake.log.lock().unwrap()),
            "file": file.as_deref().map_or(Value::Null, read_text),
            "bak": bak.as_deref().map_or(Value::Null, read_text),
        }));
    }
    out.insert("steps".into(), out_steps.into());
    std::fs::write(&out_path, serde_json::to_vec(&Value::Object(out)).unwrap()).unwrap();
}
