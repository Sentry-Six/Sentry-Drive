//! Tessie REST client (port of `src/processing/tessie-api.cjs`) plus the
//! handler-level `normalizeApiDrive`.

use serde_json::Value;

use super::clips::{ApiDrive, ApiPoint, Odo};
use super::http::Http;
use super::js::{encode_uri_component, opt_prop, present, prop, search_params, slice_utf16, to_number, to_string};
use crate::logger;

pub const API_HOST: &str = "api.tessie.com";

pub fn request_headers(token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("Authorization", format!("Bearer {token}")),
        ("Accept", "application/json".into()),
        ("User-Agent", "Sentry-Drive".into()),
    ]
}

/// Status/body → parsed JSON or the Electron error message.
pub fn handle_response(status: u16, body: &str) -> Result<Value, String> {
    match status {
        200..=299 => serde_json::from_str(body).map_err(|e| format!("Parse error: {e}")),
        401 | 403 => Err(format!("Unauthorized (HTTP {status}) — check your token")),
        429 => Err("Rate-limited by Tessie (HTTP 429) — slow down or try later".into()),
        _ => Err(format!("HTTP {status}: {}", slice_utf16(body, 200))),
    }
}

fn http_get(http: &dyn Http, path: &str, token: &str) -> Result<Value, String> {
    let (status, body) = http.get(API_HOST, path, &request_headers(token))?;
    handle_response(status, &body)
}

/// `Array.isArray(body.results) ? body.results : []`.
fn results(body: &Value) -> Result<Vec<Value>, String> {
    Ok(match prop(body, "results")? {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    })
}

pub fn fetch_vehicles(http: &dyn Http, token: &str) -> Result<Vec<Value>, String> {
    let vehicles = results(&http_get(http, "/vehicles", token)?)?;
    logger::info("tessie", format!("vehicles fetched: {}", vehicles.len()));
    Ok(vehicles)
}

/// A window bound as the renderer sent it (`from != null` sets the param).
pub fn window_param(v: Option<&Value>) -> Option<String> {
    present(v).map(|v| to_string(Some(v)))
}

pub fn drives_path(vin: &str, from: Option<&Value>, to: Option<&Value>) -> String {
    let mut params = vec![("distance_format", "mi".to_string())];
    if let Some(f) = window_param(from) {
        params.push(("from", f));
    }
    if let Some(t) = window_param(to) {
        params.push(("to", t));
    }
    format!("/{}/drives?{}", encode_uri_component(vin), search_params(&params))
}

pub fn fetch_drives(http: &dyn Http, token: &str, vin: &str, from: Option<&Value>, to: Option<&Value>) -> Result<Vec<Value>, String> {
    let drives = results(&http_get(http, &drives_path(vin, from, to), token)?)?;
    let first = drives.first().map_or("null".to_string(), |d| d.to_string());
    logger::info("tessie", format!("drives fetched: {} | first raw: {}", drives.len(), slice_utf16(&first, 600)));
    Ok(drives)
}

/// `/path` for one drive window (`separate=true`, `simplify=false`,
/// `details=true`). `from`/`to` are the raw drive fields, stringified.
pub fn path_path(vin: &str, from: Option<&Value>, to: Option<&Value>) -> String {
    let params = vec![
        ("from", to_string(from)),
        ("to", to_string(to)),
        ("separate", "true".to_string()),
        ("simplify", "false".to_string()),
        ("details", "true".to_string()),
    ];
    format!("/{}/path?{}", encode_uri_component(vin), search_params(&params))
}

/// fetchPath: normalize the response shapes to an array of point arrays.
pub fn normalize_path_body(body: &Value) -> Result<Vec<Vec<Value>>, String> {
    let mut out = Vec::new();
    if let Some(Value::Array(results)) = prop(body, "results")? {
        for r in results {
            if let Value::Array(a) = r {
                out.push(a.clone());
            } else if let Some(Value::Array(a)) = opt_prop(Some(r), "path") {
                out.push(a.clone());
            } else if let Some(Value::Array(a)) = opt_prop(Some(r), "points") {
                out.push(a.clone());
            }
        }
        // Flat list: the whole result is one drive's points.
        if out.is_empty() && !results.is_empty() && present(opt_prop(results.first(), "latitude")).is_some() {
            out.push(results.clone());
        }
    }
    Ok(out)
}

pub fn fetch_path(http: &dyn Http, token: &str, vin: &str, from: Option<&Value>, to: Option<&Value>) -> Result<Vec<Vec<Value>>, String> {
    normalize_path_body(&http_get(http, &path_path(vin, from, to), token)?)
}

/// Tessie's path field flags FSD engagement only; everything but these
/// values counts as engaged.
pub fn map_autopilot_string(v: Option<&Value>) -> u8 {
    match v {
        None | Some(Value::Null) => 0,
        Some(Value::String(s)) if matches!(s.as_str(), "Unavailable" | "Standby" | "Off" | "") => 0,
        _ => 1,
    }
}

/// `Number.isFinite(x) ? x : fallback` for a raw JSON field.
fn finite_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        _ => None,
    }
}

/// A raw Tessie path point as buildClipsForApiDrive reads it (throws like
/// V8 on a `null` point).
pub fn api_point(p: &Value) -> Result<ApiPoint, String> {
    Ok(ApiPoint {
        latitude: finite_number(prop(p, "latitude")?),
        longitude: finite_number(prop(p, "longitude")?),
        timestamp: to_number(prop(p, "timestamp")?),
        speed: finite_number(prop(p, "speed")?),
        ap_state: map_autopilot_string(prop(p, "autopilot")?),
    })
}

/// `a || b` on raw JSON values.
fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if super::js::truthy(a) { a } else { b }
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    present(a).or(b)
}

/// normalizeApiDrive: `/drives` metadata merged with the `/path` points.
pub fn normalize_api_drive(entry: &Value, pts: &[Value]) -> Result<ApiDrive, String> {
    let first = pts.first();
    let last = pts.last();
    let started_sec = or(prop(entry, "started_at")?, present(opt_prop(first, "timestamp")));
    let ended_sec = or(prop(entry, "ended_at")?, present(opt_prop(last, "timestamp")));
    let coord = |key: &str, from: Option<&Value>, pkey: &str| -> Result<Option<f64>, String> {
        Ok(present(nullish(prop(entry, key)?, opt_prop(from, pkey))).map(|v| to_number(Some(v))))
    };
    Ok(ApiDrive {
        started_at: present(started_sec).map(|v| to_number(Some(v)) * 1000.0),
        ended_at: present(ended_sec).map(|v| to_number(Some(v)) * 1000.0),
        distance_mi: finite_number(prop(entry, "odometer_distance")?).unwrap_or(0.0),
        autopilot_distance_mi: finite_number(prop(entry, "autopilot_distance")?).unwrap_or(0.0),
        starting_odometer: Odo::from_value(prop(entry, "starting_odometer")?),
        start_lat: coord("starting_latitude", first, "latitude")?,
        start_lng: coord("starting_longitude", first, "longitude")?,
        end_lat: coord("ending_latitude", last, "latitude")?,
        end_lng: coord("ending_longitude", last, "longitude")?,
        points: pts.iter().map(api_point).collect::<Result<_, _>>()?,
    })
}

/// The `{ startedAt, endedAt, startingOdometer }` key the preview/import
/// handlers build from a raw `/drives` entry.
pub fn overlap_key(d: &Value) -> Result<(f64, f64, Odo), String> {
    let num0 = |v: Option<&Value>| to_number(Some(present(v).unwrap_or(&Value::from(0))));
    Ok((
        num0(prop(d, "started_at")?) * 1000.0,
        num0(prop(d, "ended_at")?) * 1000.0,
        Odo::from_value(prop(d, "starting_odometer")?),
    ))
}

/// tessie-api-validate's vehicle mapping.
pub fn vehicle_summaries(vehicles: &[Value]) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for v in vehicles {
        let own_vin = prop(v, "vin")?;
        let ls = prop(v, "last_state")?;
        let vin = or(own_vin, opt_prop(opt_prop(ls, "vehicle_state"), "vin"));
        let display = or(opt_prop(ls, "display_name"), opt_prop(opt_prop(ls, "vehicle_state"), "vehicle_name"));
        if !super::js::truthy(vin) {
            continue;
        }
        let mut m = serde_json::Map::new();
        m.insert("vin".into(), vin.cloned().unwrap_or(Value::Null));
        m.insert("displayName".into(), if super::js::truthy(display) { display.cloned().unwrap_or_default() } else { Value::from("") });
        out.push(Value::Object(m));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_urls_match_js() {
        assert_eq!(
            drives_path("5YJ 3/x", Some(&json!(1_720_000_000)), Some(&json!(1_720_086_399))),
            "/5YJ%203%2Fx/drives?distance_format=mi&from=1720000000&to=1720086399"
        );
        assert_eq!(drives_path("V", None, Some(&Value::Null)), "/V/drives?distance_format=mi");
        assert_eq!(
            path_path("V", Some(&json!(1_720_000_000)), None),
            "/V/path?from=1720000000&to=undefined&separate=true&simplify=false&details=true"
        );
        let h = request_headers("tok");
        assert_eq!(h[0], ("Authorization", "Bearer tok".to_string()));
        assert_eq!(h[2], ("User-Agent", "Sentry-Drive".to_string()));
    }

    #[test]
    fn response_errors_match_js() {
        assert_eq!(handle_response(401, "").unwrap_err(), "Unauthorized (HTTP 401) — check your token");
        assert_eq!(handle_response(429, "").unwrap_err(), "Rate-limited by Tessie (HTTP 429) — slow down or try later");
        assert_eq!(handle_response(500, &"x".repeat(300)).unwrap_err(), format!("HTTP 500: {}", "x".repeat(200)));
        assert!(handle_response(200, "<html>").unwrap_err().starts_with("Parse error: "));
    }

    #[test]
    fn path_shapes() {
        let p = json!({ "latitude": 1.0, "longitude": 2.0, "timestamp": 3 });
        assert_eq!(normalize_path_body(&json!({ "results": [{ "path": [p] }] })).unwrap().len(), 1);
        assert_eq!(normalize_path_body(&json!({ "results": [[p], [p]] })).unwrap().len(), 2);
        assert_eq!(normalize_path_body(&json!({ "results": [p, p] })).unwrap()[0].len(), 2);
        assert!(normalize_path_body(&Value::Null).is_err());
    }
}
