//! Teslascope REST client. The per-drive schema is unpublished, so
//! normalization accepts several field variants.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value};

use super::clips::{ApiDrive, ApiPoint, Odo};
use super::http::Http;
use super::js::{date_parse, encode_uri_component, js_trim, local_parts, pad2, parse_float, present, search_params, slice_utf16, to_number, to_string, truthy};
use super::tessie_api::map_autopilot_string;
use crate::logger;

pub const API_HOST: &str = "teslascope.com";
const PAGE_LIMIT: usize = 100;
const MAX_PAGES: usize = 50;

pub const START_KEYS: &[&str] = &["started_at", "start_date", "start_time", "starting_time", "start", "startedAt", "created_at"];
const END_KEYS: &[&str] = &["ended_at", "end_date", "end_time", "finishing_time", "finished_at", "end", "endedAt"];
const LIST_KEYS: &[&str] = &["vehicles", "results", "data", "response"];
const DRIVE_LIST_KEYS: &[&str] = &["drives", "results", "data", "response"];
const POINT_KEYS: &[&str] = &["progress", "path", "points", "locations", "coordinates", "gps", "route"];

/// Module-level auth state: which credential style last worked, and which
/// one was last logged.
#[derive(Default)]
pub struct AuthState {
    /// 0 = bearer, 1 = legacy `api_key`.
    mode: AtomicU8,
    /// 0 = nothing logged yet, else mode + 1.
    logged: AtomicU8,
}

pub struct Client<'a> {
    pub http: &'a dyn Http,
    pub auth: &'a AuthState,
    /// Pause between full pages of drives (300 ms in the app).
    pub page_pause: Duration,
}

/// Unwrap common single-key envelopes (`response` / `result` / `payload`).
pub fn unwrap_envelope(body: Value) -> Value {
    let mut b = body;
    for _ in 0..3 {
        let Value::Object(m) = &b else { break };
        let inner = ["response", "result", "payload"].iter().find_map(|k| present(m.get(*k)));
        match inner {
            Some(v) => b = v.clone(),
            None => break,
        }
    }
    b
}

pub fn request(path: &str, token: &str, legacy: bool) -> (String, Vec<(&'static str, String)>) {
    let mut headers = vec![("Accept", "application/json".to_string()), ("User-Agent", "Sentry-Drive".to_string())];
    let mut full = path.to_string();
    if legacy {
        full.push(if path.contains('?') { '&' } else { '?' });
        full.push_str(&format!("api_key={}", encode_uri_component(token)));
    } else {
        headers.push(("Authorization", format!("Bearer {token}")));
    }
    (full, headers)
}

enum Fail {
    Unauthorized(String),
    Other(String),
}

pub fn handle_response(status: u16, body: &str) -> Result<Value, (String, bool)> {
    match status {
        200..=299 => serde_json::from_str(body).map(unwrap_envelope).map_err(|e| (format!("Parse error: {e}"), false)),
        401 | 403 => Err((format!("Unauthorized (HTTP {status})"), true)),
        429 => Err(("Rate-limited by Teslascope (HTTP 429) — slow down or try later".into(), false)),
        _ => Err((format!("HTTP {status}: {}", slice_utf16(body, 200)), false)),
    }
}

impl Client<'_> {
    fn request_once(&self, path: &str, token: &str, legacy: bool) -> Result<Value, Fail> {
        let (full, headers) = request(path, token, legacy);
        let (status, body) = self.http.get(API_HOST, &full, &headers).map_err(Fail::Other)?;
        handle_response(status, &body).map_err(|(m, unauth)| if unauth { Fail::Unauthorized(m) } else { Fail::Other(m) })
    }

    /// Bearer or legacy credentials: retry the other style once after an
    /// authorization failure and remember the one that worked.
    pub fn http_get(&self, path: &str, token: &str) -> Result<Value, String> {
        let modes: [u8; 2] = if self.auth.mode.load(Ordering::Relaxed) == 1 { [1, 0] } else { [0, 1] };
        let mut last = String::new();
        for mode in modes {
            match self.request_once(path, token, mode == 1) {
                Ok(body) => {
                    self.auth.mode.store(mode, Ordering::Relaxed);
                    if self.auth.logged.swap(mode + 1, Ordering::Relaxed) != mode + 1 {
                        logger::info("teslascope", format!("auth mode in use: {}", if mode == 1 { "legacy" } else { "bearer" }));
                    }
                    return Ok(body);
                }
                Err(Fail::Unauthorized(m)) => last = m,
                Err(Fail::Other(m)) => return Err(m),
            }
        }
        Err(format!(
            "{last} — check the key (Teslascope → Account → Security). \
             If you're using a personal access token, it needs the \"account\" and \"vehicles\" scopes"
        ))
    }

    /// Vehicles on the account: `[{ publicId, vin, displayName }]`.
    pub fn fetch_vehicles(&self, token: &str) -> Result<Vec<Vehicle>, String> {
        let body = match self.http_get("/api/account", token) {
            Ok(b) => b,
            Err(_) => self.http_get("/api/vehicles", token)?,
        };
        logger::info("teslascope", format!("account/vehicles raw: {}", slice_utf16(&body.to_string(), 1200)));
        let inner = pick(Some(&body), LIST_KEYS).unwrap_or(&body);
        let list = pick_array(Some(inner), LIST_KEYS);
        Ok(list
            .iter()
            .filter_map(|v| {
                let public_id = pick(Some(v), &["public_id", "publicId", "id", "uuid"])?.clone();
                let named = pick(Some(v), &["name", "display_name", "vehicle_name", "nickname"]);
                let display = if truthy(named) {
                    named
                } else {
                    Some(pick(Some(v), &["vin"])).filter(|v| truthy(*v)).flatten()
                };
                Some(Vehicle {
                    public_id,
                    vin: pick(Some(v), &["vin", "VIN"]).cloned(),
                    display_name: display.cloned().unwrap_or_else(|| Value::from("Vehicle")),
                })
            })
            .collect())
    }

    /// Raw drive objects in an optional Unix-seconds window, falling back to
    /// an unfiltered listing filtered locally when the window returns none.
    pub fn fetch_drives(&self, token: &str, public_id: &str, from: Option<&Value>, to: Option<&Value>) -> Result<Vec<Value>, String> {
        let base = format!("/api/vehicle/{}/drives", encode_uri_component(public_id));
        let (from, to) = (present(from), present(to));
        let fetch_all = |with_window: bool| -> Result<Vec<Value>, String> {
            let mut all = Vec::new();
            for page in 1..=MAX_PAGES {
                let mut params: Vec<(&str, String)> = Vec::new();
                if with_window {
                    if let Some(f) = from {
                        params.push(("from", to_date_str(f)));
                    }
                    if let Some(t) = to {
                        params.push(("to", to_date_str(t)));
                    }
                }
                params.push(("limit", PAGE_LIMIT.to_string()));
                if page > 1 {
                    params.push(("page", page.to_string()));
                }
                let body = self.http_get(&format!("{base}?{}", search_params(&params)), token)?;
                let batch = pick_array(Some(&body), DRIVE_LIST_KEYS);
                if page == 1 {
                    logger::info(
                        "teslascope",
                        format!("drives raw ({}, page 1): {}", if with_window { "windowed" } else { "unfiltered" }, slice_utf16(&body.to_string(), 1200)),
                    );
                }
                let n = batch.len();
                all.extend(batch);
                if n < PAGE_LIMIT {
                    break;
                }
                std::thread::sleep(self.page_pause);
            }
            Ok(all)
        };
        let mut drives = fetch_all(true)?;
        logger::info("teslascope", format!("drives count (windowed): {}", drives.len()));
        if drives.is_empty() && (from.is_some() || to.is_some()) {
            let all = fetch_all(false)?;
            let from_ms = from.map_or(f64::NEG_INFINITY, |f| to_number(Some(f)) * 1000.0);
            let to_ms_bound = to.map_or(f64::INFINITY, |t| to_number(Some(t)) * 1000.0);
            let n_all = all.len();
            drives = all
                .into_iter()
                .filter(|d| {
                    let t = to_ms(pick(Some(d), START_KEYS));
                    !t.is_finite() || (t >= from_ms && t <= to_ms_bound)
                })
                .collect();
            logger::info("teslascope", format!("drives count: {n_all} unfiltered → {} in window", drives.len()));
        }
        let first = drives.first().map_or("null".to_string(), |d| d.to_string());
        logger::info("teslascope", format!("first raw drive: {}", slice_utf16(&first, 1200)));
        Ok(drives)
    }

    /// One drive's detail (which may embed the GPS path).
    pub fn fetch_drive_path(&self, token: &str, public_id: &str, drive_id: Option<&Value>) -> Result<Value, String> {
        let path = format!(
            "/api/vehicle/{}/drive/{}",
            encode_uri_component(public_id),
            encode_uri_component(&to_string(drive_id))
        );
        let body = self.http_get(&path, token)?;
        let detail = pick(Some(&body), &["drive", "result", "data"]).cloned().unwrap_or(body);
        logger::info("teslascope", format!("drive detail raw: {}", slice_utf16(&detail.to_string(), 1500)));
        Ok(detail)
    }
}

pub struct Vehicle {
    pub public_id: Value,
    pub vin: Option<Value>,
    pub display_name: Value,
}

/// `new Date(sec * 1000)` as local `YYYY-MM-DD`.
fn to_date_str(sec: &Value) -> String {
    match local_parts(to_number(Some(sec)) * 1000.0) {
        Some((y, m, d, ..)) => format!("{y}-{}-{}", pad2(m), pad2(d)),
        None => "NaN-NaN-NaN".into(),
    }
}

/// First non-null value among candidate keys (exact, then case-insensitive).
pub fn pick<'a>(obj: Option<&'a Value>, names: &[&str]) -> Option<&'a Value> {
    let Some(Value::Object(m)) = obj else { return None };
    for n in names {
        if let Some(v) = present(m.get(*n)) {
            return Some(v);
        }
        let lower = n.to_lowercase();
        if let Some((_, v)) = m.iter().find(|(k, _)| k.to_lowercase() == lower) {
            if !v.is_null() {
                return Some(v);
            }
        }
    }
    None
}

pub fn pick_array(obj: Option<&Value>, names: &[&str]) -> Vec<Value> {
    if let Some(Value::Array(a)) = obj {
        return a.clone();
    }
    match pick(obj, names) {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

/// Unix s, Unix ms, or a date string → epoch ms (NaN when unreadable).
pub fn to_ms(t: Option<&Value>) -> f64 {
    match t {
        None | Some(Value::Null) => f64::NAN,
        Some(Value::Number(n)) => {
            let t = n.as_f64().unwrap_or(f64::NAN);
            if t > 1e12 { t } else { t * 1000.0 }
        }
        Some(v) => date_parse(&to_string(Some(v))),
    }
}

/// `num(v)`: finite number, or a string read with parseFloat.
pub fn num(v: Option<&Value>) -> Option<f64> {
    let n = match v {
        Some(Value::String(s)) => parse_float(s),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// Only explicit engagement states count; missing or ambiguous is off.
pub fn map_autopilot(v: Option<&Value>) -> u8 {
    static AP_ON: OnceLock<Regex> = OnceLock::new();
    match v {
        None | Some(Value::Null) => 0,
        Some(Value::Bool(b)) => u8::from(*b),
        Some(Value::Number(n)) => u8::from(n.as_f64().is_some_and(|x| x > 0.0)),
        Some(v) => {
            let re = AP_ON.get_or_init(|| Regex::new(r"(?i-u)^(on|active|engaged|autopilot|autosteer|fsd|true|1)$").expect("valid regex"));
            u8::from(re.is_match(js_trim(&to_string(Some(v)))))
        }
    }
}

/// A normalized path point (`{ latitude, longitude, timestamp, speed, autopilot }`).
#[derive(Clone, Debug)]
pub struct Point {
    pub latitude: f64,
    pub longitude: f64,
    pub timestamp: f64,
    pub speed: Option<f64>,
    /// "Active" / "Off".
    pub autopilot: &'static str,
}

/// normalizeDrive's output (`undefined` fields are None, NaN stays NaN).
#[derive(Clone, Debug)]
pub struct Drive {
    pub id: Option<Value>,
    pub started_at: f64,
    pub ended_at: f64,
    pub distance_mi: f64,
    pub autopilot_distance_mi: f64,
    pub starting_odometer: Option<f64>,
    pub start_lat: Option<f64>,
    pub start_lng: Option<f64>,
    pub end_lat: Option<f64>,
    pub end_lng: Option<f64>,
    pub points: Vec<Point>,
}

impl Drive {
    pub fn to_api(&self) -> ApiDrive {
        ApiDrive {
            started_at: Some(self.started_at),
            ended_at: Some(self.ended_at),
            distance_mi: self.distance_mi,
            autopilot_distance_mi: self.autopilot_distance_mi,
            starting_odometer: Odo::from_opt(self.starting_odometer),
            start_lat: self.start_lat,
            start_lng: self.start_lng,
            end_lat: self.end_lat,
            end_lng: self.end_lng,
            points: self
                .points
                .iter()
                .map(|p| ApiPoint {
                    latitude: Some(p.latitude),
                    longitude: Some(p.longitude),
                    timestamp: p.timestamp,
                    speed: p.speed,
                    ap_state: map_autopilot_string(Some(&Value::from(p.autopilot))),
                })
                .collect(),
        }
    }
}

/// `{ ...(v || {}) }` entries.
fn spread_into(out: &mut Map<String, Value>, v: Option<&Value>) {
    if !truthy(v) {
        return;
    }
    match v {
        Some(Value::Object(m)) => {
            for (k, v) in m {
                out.insert(k.clone(), v.clone());
            }
        }
        Some(Value::Array(a)) => {
            for (i, v) in a.iter().enumerate() {
                out.insert(i.to_string(), v.clone());
            }
        }
        Some(Value::String(s)) => {
            for (i, c) in s.chars().enumerate() {
                out.insert(i.to_string(), Value::from(c.to_string()));
            }
        }
        _ => {}
    }
}

fn extract_points(d: &Value) -> Vec<Point> {
    pick_array(Some(d), POINT_KEYS)
        .iter()
        .filter_map(|p| {
            let (lat, lng, ts, speed, ap) = if let Value::Array(t) = p {
                (num(t.first()), num(t.get(1)), to_ms(t.get(2)), num(t.get(3)), None)
            } else {
                (
                    num(pick(Some(p), &["latitude", "lat"])),
                    num(pick(Some(p), &["longitude", "lng", "lon", "long"])),
                    to_ms(pick(Some(p), &["timestamp", "time", "date", "recorded_at", "created_at", "t"])),
                    num(pick(Some(p), &["speed", "speed_mph", "velocity"])),
                    pick(Some(p), &["autopilot", "autopilot_state", "state", "ap"]),
                )
            };
            Some(Point {
                latitude: lat?,
                longitude: lng?,
                timestamp: ts,
                speed,
                autopilot: if map_autopilot(ap) == 1 { "Active" } else { "Off" },
            })
        })
        .collect()
}

/// normalizeDrive: a raw list entry plus an optional detail response.
pub fn normalize_drive(raw: Option<&Value>, detail: Option<&Value>) -> Drive {
    let mut m = Map::new();
    spread_into(&mut m, raw);
    spread_into(&mut m, detail);
    let d = Value::Object(m);
    let d = Some(&d);
    let started_at = to_ms(pick(d, START_KEYS));
    let mut ended_at = to_ms(pick(d, END_KEYS));
    let duration_sec = num(pick(d, &["duration", "duration_sec", "duration_seconds"]));
    if let (false, true, Some(dur)) = (ended_at.is_finite(), started_at.is_finite(), duration_sec) {
        ended_at = started_at + dur * 1000.0;
    }
    let distance_mi = num(pick(d, &["distance", "distance_miles", "distance_mi", "miles", "odometer_distance"])).unwrap_or(0.0);
    let sd_start = num(pick(d, &["self_driving_miles_start"]));
    let sd_end = num(pick(d, &["self_driving_miles_end"]));
    let ap = num(pick(d, &["autopilot_distance", "autopilot_distance_miles", "fsd_distance", "autopilotDistanceMi"])).unwrap_or(
        match (sd_start, sd_end) {
            (Some(s), Some(e)) if e >= s => e - s,
            _ => 0.0,
        },
    );
    Drive {
        id: pick(d, &["id", "drive_id", "uuid", "public_id"]).cloned(),
        started_at,
        ended_at,
        distance_mi,
        autopilot_distance_mi: ap,
        starting_odometer: num(pick(d, &["starting_odometer", "start_odometer", "odometer_start", "startingOdometer"])),
        start_lat: num(pick(d, &["latitude_start", "starting_latitude", "start_latitude", "start_lat", "from_latitude"])),
        start_lng: num(pick(d, &["longitude_start", "starting_longitude", "start_longitude", "start_lng", "from_longitude"])),
        end_lat: num(pick(d, &["latitude_end", "ending_latitude", "end_latitude", "end_lat", "to_latitude"])),
        end_lng: num(pick(d, &["longitude_end", "ending_longitude", "end_longitude", "end_lng", "to_longitude"])),
        points: d.map(extract_points).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_match_js() {
        let (p, h) = request("/api/vehicle/a%20b/drives?limit=100", "k y", true);
        assert_eq!(p, "/api/vehicle/a%20b/drives?limit=100&api_key=k%20y");
        assert_eq!(h.len(), 2);
        let (p, h) = request("/api/account", "tok", false);
        assert_eq!(p, "/api/account");
        assert_eq!(h[2], ("Authorization", "Bearer tok".to_string()));
        let (p, _) = request("/api/account", "tok", true);
        assert_eq!(p, "/api/account?api_key=tok");
    }

    #[test]
    fn envelope_and_pick() {
        assert_eq!(unwrap_envelope(json!({ "response": { "result": [1] } })), json!([1]));
        assert_eq!(unwrap_envelope(json!({ "response": null, "x": 1 })), json!({ "response": null, "x": 1 }));
        let v = json!({ "Start_Date": null, "START_date": "x", "id": 0 });
        assert_eq!(pick(Some(&v), &["start_date"]), None);
        assert_eq!(pick(Some(&v), &["id"]), Some(&json!(0)));
        assert_eq!(handle_response(403, "").unwrap_err(), ("Unauthorized (HTTP 403)".to_string(), true));
    }

    #[test]
    fn autopilot_strings() {
        assert_eq!(map_autopilot(Some(&json!(" Active "))), 1);
        assert_eq!(map_autopilot(Some(&json!("FSD"))), 1);
        assert_eq!(map_autopilot(Some(&json!("standby"))), 0);
        assert_eq!(map_autopilot(Some(&json!(2))), 1);
        assert_eq!(map_autopilot(Some(&json!(false))), 0);
    }

    #[test]
    fn normalize_list_entry() {
        let raw = json!({
            "id": 7, "created_at": "2024-01-05T10:00:00Z", "duration": "600",
            "distance": "5.25", "self_driving_miles_start": "10", "self_driving_miles_end": 12.5,
            "latitude_start": "39.7", "longitude_start": "-105.0",
        });
        let d = normalize_drive(Some(&raw), None);
        assert_eq!(d.started_at, 1_704_448_800_000.0);
        assert_eq!(d.ended_at, 1_704_449_400_000.0);
        assert_eq!(d.distance_mi, 5.25);
        assert_eq!(d.autopilot_distance_mi, 2.5);
        assert_eq!(d.start_lat, Some(39.7));
        assert_eq!(d.end_lat, None);
    }
}
