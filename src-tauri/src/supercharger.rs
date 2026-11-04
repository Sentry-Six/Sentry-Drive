//! Port of `src/main/supercharger-catalog.cjs`: bundled/refreshed OpenStreetMap
//! Supercharger catalog, charging-site matching and Overpass refresh.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value};

use crate::loader::calc::haversine_metres;

const OSM_ATTRIBUTION: &str = "© OpenStreetMap contributors";
const OVERPASS_ENDPOINT: &str = "https://overpass-api.de/api/interpreter";
const SELECTORS: [&str; 5] = [
    r#"nwr["amenity"="charging_station"]["brand"="Tesla Supercharger"];"#,
    r#"nwr["amenity"="charging_station"]["brand:wikidata"="Q17089620"];"#,
    r#"nwr["amenity"="charging_station"]["ref:supercharge_info"];"#,
    r#"nwr["amenity"="charging_station"]["socket:tesla_supercharger"];"#,
    r#"nwr["amenity"="charging_station"]["socket:tesla_supercharger_ccs"];"#,
];
const RETRY_DELAYS_MS: [u64; 3] = [5_000, 20_000, 60_000];
const OVERPASS_MAX_BYTES: u64 = 25 * 1024 * 1024;

pub struct Catalog {
    pub data: Value,
    pub source: &'static str,
    pub last_error: Option<String>,
    cache_path: PathBuf,
}

/// Loaded on first use (like the Electron build), so parsing the 1 MB bundled
/// catalog never delays the first window.
pub struct SuperchargerCatalog {
    inner: Mutex<Option<Catalog>>,
    bundled: PathBuf,
    cache: PathBuf,
}

impl SuperchargerCatalog {
    pub fn new(bundled: PathBuf, cache: PathBuf) -> Self {
        Self { inner: Mutex::new(None), bundled, cache }
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Option<Catalog>> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_none() {
            match Catalog::load(&self.bundled, &self.cache) {
                Ok(c) => *guard = Some(c),
                Err(e) => crate::logger::error("main", format!("supercharger catalog unavailable: {e:#}")),
            }
        }
        guard
    }
}

fn text(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).map(|s| s.trim().to_string()).unwrap_or_default()
}

fn validate(catalog: Value) -> Result<Value> {
    let ok = catalog.get("version").and_then(Value::as_i64) == Some(1)
        && catalog.get("stations").is_some_and(Value::is_array);
    if !ok {
        bail!("Invalid Supercharger catalog");
    }
    for s in catalog["stations"].as_array().unwrap() {
        let lat = s.get("latitude").and_then(Value::as_f64);
        let lng = s.get("longitude").and_then(Value::as_f64);
        let good = !text(s.get("stationId")).is_empty()
            && lat.is_some_and(|v| (-90.0..=90.0).contains(&v))
            && lng.is_some_and(|v| (-180.0..=180.0).contains(&v));
        if !good {
            bail!("Invalid Supercharger catalog station");
        }
    }
    Ok(catalog)
}

fn read_catalog(path: &Path) -> Result<Value> {
    validate(serde_json::from_slice(&std::fs::read(path)?)?)
}

impl Catalog {
    pub fn load(bundled: &Path, cache: &Path) -> Result<Self> {
        let (data, source) = match read_catalog(cache) {
            Ok(c) => (c, "refreshed"),
            Err(_) => (read_catalog(bundled)?, "bundled"),
        };
        Ok(Self { data, source, last_error: None, cache_path: cache.to_path_buf() })
    }

    pub fn status(&self) -> Value {
        json!({
            "source": self.source,
            "generatedAt": self.data.get("generatedAt"),
            "stationCount": self.data["stations"].as_array().map_or(0, Vec::len),
            "attribution": self.data.get("attribution").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(OSM_ATTRIBUTION),
            "lastError": self.last_error,
        })
    }
}

fn preferred_site_name(catalog_name: &str, reported: &str) -> String {
    let generic = catalog_name.to_lowercase().split_whitespace().collect::<Vec<_>>() == ["tesla", "supercharger"];
    if !catalog_name.is_empty() && !generic {
        return catalog_name.into();
    }
    if !reported.is_empty() && reported != crate::loader::charging::UNKNOWN_SITE_LABEL && reported != crate::loader::charging::UNNAMED_SITE_LABEL {
        return reported.into();
    }
    if !catalog_name.is_empty() {
        return catalog_name.into();
    }
    if !reported.is_empty() {
        return reported.into();
    }
    "Tesla Supercharger".into()
}

fn speed_tier(power_kw: Option<f64>) -> i64 {
    match power_kw {
        Some(kw) if kw.is_finite() && kw > 0.0 => {
            if kw >= 250.0 { 3 } else if kw >= 150.0 { 2 } else { 1 }
        }
        _ => 0,
    }
}

pub fn match_charging_sites(sites: Vec<Value>, catalog: &Value) -> Vec<Value> {
    let empty = Vec::new();
    let stations = catalog.get("stations").and_then(Value::as_array).unwrap_or(&empty);
    sites
        .into_iter()
        .map(|site| {
            let mut m: Map<String, Value> = site.as_object().cloned().unwrap_or_default();
            let lat = m.get("latitude").and_then(Value::as_f64);
            let lng = m.get("longitude").and_then(Value::as_f64);
            let (Some(lat), Some(lng)) = (lat, lng) else {
                m.insert("isSupercharger".into(), json!(false));
                m.insert("chargerType".into(), json!("other"));
                return Value::Object(m);
            };
            let mut nearest: Option<&Value> = None;
            let mut best = f64::INFINITY;
            for s in stations {
                let d = haversine_metres(
                    lat,
                    lng,
                    s["latitude"].as_f64().unwrap_or(f64::NAN),
                    s["longitude"].as_f64().unwrap_or(f64::NAN),
                );
                if d < best {
                    nearest = Some(s);
                    best = d;
                }
            }
            match nearest {
                Some(n) if best <= 250.0 => {
                    let reported = text(m.get("displayName"));
                    m.insert("displayName".into(), json!(preferred_site_name(&text(n.get("name")), &reported)));
                    m.insert("isSupercharger".into(), json!(true));
                    m.insert("chargerType".into(), json!("supercharger"));
                    m.insert("catalogStationId".into(), n.get("stationId").cloned().unwrap_or(Value::Null));
                    m.insert("superchargerDistanceM".into(), json!(crate::loader::calc::js_round(best)));
                    let power = n.get("powerKw").and_then(Value::as_f64);
                    m.insert("powerKw".into(), json!(power));
                    m.insert("speedTier".into(), json!(speed_tier(power)));
                }
                _ => {
                    m.insert("isSupercharger".into(), json!(false));
                    m.insert("chargerType".into(), json!("other"));
                }
            }
            Value::Object(m)
        })
        .collect()
}

// ── Refresh from Overpass ───────────────────────────────────────────────────

fn is_tesla_supercharger(tags: &Map<String, Value>) -> bool {
    let t = |k: &str| text(tags.get(k));
    if t("amenity").to_lowercase() != "charging_station" {
        return false;
    }
    let desc = [t("brand"), t("network"), t("operator"), t("name"), t("description")].join(" ").to_lowercase();
    if desc.contains("destination") {
        return false;
    }
    let wikidata: Vec<String> = t("brand:wikidata").split(';').map(|s| s.trim().to_string()).collect();
    let has_socket = ["socket:tesla_supercharger", "socket:tesla_supercharger_ccs"].iter().any(|k| {
        let v = t(k).to_lowercase();
        !v.is_empty() && v != "0" && v != "no"
    });
    t("brand").to_lowercase() == "tesla supercharger"
        || wikidata.iter().any(|w| w == "Q17089620")
        || !t("ref:supercharge_info").is_empty()
        || has_socket
}

fn station_power_kw(tags: &Map<String, Value>) -> Option<f64> {
    let mut best: Option<f64> = None;
    for (k, v) in tags {
        if !(k.starts_with("socket:") && k.ends_with(":output")) {
            continue;
        }
        let s = match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        for part in s.split(';') {
            // Number.parseFloat: leading numeric prefix.
            let p = part.trim_start();
            let end = p
                .char_indices()
                .take_while(|&(i, c)| c.is_ascii_digit() || c == '.' || ((c == '-' || c == '+') && i == 0))
                .map(|(i, c)| i + c.len_utf8())
                .last()
                .unwrap_or(0);
            let Ok(kw) = p[..end].parse::<f64>() else { continue };
            if !(1.0..=1500.0).contains(&kw) {
                continue;
            }
            if kw > best.unwrap_or(0.0) {
                best = Some(kw);
            }
        }
    }
    best
}

fn fetch_elements(selector: &str) -> Result<Vec<Value>> {
    let query = format!("[out:json][timeout:120];{selector}out center tags;");
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(150)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut attempt = 0;
    loop {
        let resp = agent
            .post(OVERPASS_ENDPOINT)
            .header("user-agent", "Sentry Drive Supercharger Catalog/1.0")
            .send_form([("data", query.as_str())]);
        let (status, network_err) = match resp {
            Ok(mut r) if r.status().is_success() => {
                if let Some(len) = r.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()) {
                    if len > OVERPASS_MAX_BYTES {
                        bail!("OpenStreetMap refresh response is too large");
                    }
                }
                let payload: Value = r.body_mut().with_config().limit(OVERPASS_MAX_BYTES).read_json()?;
                let Some(elements) = payload.get("elements").and_then(Value::as_array) else {
                    bail!("Invalid Overpass response: elements must be an array");
                };
                return Ok(elements.clone());
            }
            Ok(r) => (Some(r.status().as_u16()), None),
            Err(e) => (None, Some(e.to_string())),
        };
        let retryable = network_err.is_some() || matches!(status, Some(429 | 500 | 502 | 503 | 504));
        if !retryable || attempt >= RETRY_DELAYS_MS.len() {
            let why = status.map(|s| s.to_string()).or(network_err).unwrap_or_else(|| "no response".into());
            return Err(anyhow!("OpenStreetMap refresh failed ({why})"));
        }
        std::thread::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt]));
        attempt += 1;
    }
}

fn normalize(elements: Vec<Value>, generated_at: String) -> Result<Value> {
    let mut stations: Vec<Map<String, Value>> = Vec::new();
    let mut counts: Vec<f64> = Vec::new();
    for el in elements {
        let Some(tags) = el.get("tags").and_then(Value::as_object) else { continue };
        if !is_tesla_supercharger(tags) {
            continue;
        }
        let lat = el.get("lat").and_then(Value::as_f64).or_else(|| el.pointer("/center/lat").and_then(Value::as_f64));
        let lng = el.get("lon").and_then(Value::as_f64).or_else(|| el.pointer("/center/lon").and_then(Value::as_f64));
        let (Some(lat), Some(lng)) = (lat, lng) else { continue };
        let feature_id = format!(
            "{}/{}",
            el.get("type").and_then(Value::as_str).unwrap_or("undefined"),
            el.get("id").map(|v| v.to_string()).unwrap_or_else(|| "undefined".into())
        );
        let mut name = text(tags.get("name"));
        if name.is_empty() {
            name = text(tags.get("addr:street"));
        }
        if name.is_empty() {
            name = "Tesla Supercharger".into();
        }
        let idx = stations.iter().position(|s| {
            haversine_metres(lat, lng, s["latitude"].as_f64().unwrap(), s["longitude"].as_f64().unwrap()) <= 100.0
        });
        let idx = idx.unwrap_or_else(|| {
            let mut s = Map::new();
            s.insert("stationId".into(), json!(feature_id));
            s.insert("name".into(), json!(name));
            s.insert("latitude".into(), json!(lat));
            s.insert("longitude".into(), json!(lng));
            s.insert("osmFeatures".into(), json!([]));
            stations.push(s);
            counts.push(0.0);
            stations.len() - 1
        });
        let st = &mut stations[idx];
        let c = counts[idx];
        let next = c + 1.0;
        let new_lat = (st["latitude"].as_f64().unwrap() * c + lat) / next;
        let new_lng = (st["longitude"].as_f64().unwrap() * c + lng) / next;
        st.insert("latitude".into(), json!(new_lat));
        st.insert("longitude".into(), json!(new_lng));
        counts[idx] = next;
        if let Some(Value::Array(f)) = st.get_mut("osmFeatures") {
            f.push(json!(feature_id));
        }
        if st["name"].as_str() == Some("Tesla Supercharger") && name != "Tesla Supercharger" {
            st.insert("name".into(), json!(name));
        }
        if let Some(kw) = station_power_kw(tags) {
            if kw > st.get("powerKw").and_then(Value::as_f64).unwrap_or(0.0) {
                st.insert("powerKw".into(), json!(kw));
            }
        }
    }
    validate(json!({
        "version": 1,
        "generatedAt": generated_at,
        "attribution": OSM_ATTRIBUTION,
        "stations": stations,
    }))
}

/// Blocking refresh; returns the IPC result.
pub fn refresh(state: &SuperchargerCatalog) -> Value {
    let cache_path = match state.lock().as_ref() {
        Some(c) => c.cache_path.clone(),
        None => return json!({ "success": false, "error": "Catalog unavailable" }),
    };
    let result = (|| -> Result<Value> {
        let mut elements = Vec::new();
        for sel in SELECTORS {
            elements.extend(fetch_elements(sel)?);
        }
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let refreshed = normalize(elements, now)?;
        if refreshed["stations"].as_array().is_none_or(|s| s.is_empty()) {
            bail!("Invalid Supercharger catalog: refresh returned no stations");
        }
        crate::fsutil::atomic_write(&cache_path, format!("{refreshed}\n").as_bytes())?;
        Ok(refreshed)
    })();
    let mut guard = state.lock();
    let cat = guard.as_mut().unwrap();
    match result {
        Ok(data) => {
            cat.data = data;
            cat.source = "refreshed";
            cat.last_error = None;
            let mut s = cat.status();
            s["success"] = json!(true);
            s
        }
        Err(e) => {
            cat.last_error = Some(format!("{e:#}"));
            let mut s = cat.status();
            s["success"] = json!(false);
            s["error"] = json!(format!("{e:#}"));
            s
        }
    }
}
