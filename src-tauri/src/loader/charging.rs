//! Port of `src/shared/charging-history.cjs`: charging sessions from BLE
//! telemetry samples, grouped into charging sites.

use serde_json::{json, Map, Value};

use super::calc::haversine_metres;

const SESSION_GAP_SECONDS: f64 = 30.0 * 60.0;
const LOCATION_FALLBACK_SECONDS: f64 = 15.0 * 60.0;
const SUSTAINED_POWER_SECONDS: f64 = 60.0;
const SITE_GROUPING_METRES: f64 = 150.0;
const HOME_TAG: &str = "home";
pub const UNKNOWN_SITE_LABEL: &str = "Unknown location";
pub const UNNAMED_SITE_LABEL: &str = "Charging location";

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

fn normalize_timestamp(v: Option<&Value>) -> Option<f64> {
    let n = finite(v)?;
    if n < 0.0 {
        return None;
    }
    Some(if n > 10_000_000_000.0 { n / 1000.0 } else { n })
}

/// `new Date(seconds * 1000).toISOString()`.
fn iso_timestamp(seconds: f64) -> String {
    let ms = (seconds * 1000.0).trunc() as i64;
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// JavaScript `String(number)` for the values that appear here.
pub fn js_number_string(n: f64) -> String {
    if n.is_finite() && n == n.trunc() && n.abs() < 1e21 {
        format!("{}", n as i128)
    } else {
        format!("{n}")
    }
}

/// `String(value)` for a raw sample timestamp (number or string).
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                js_number_string(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn normalized_state(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(|s| {
        s.trim().to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
    })
}

fn trimmed_name(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

struct Active {
    session_id: String,
    cost_key: String,
    start_timestamp: f64,
    last_timestamp: f64,
    start_battery_pct: Option<f64>,
    end_battery_pct: Option<f64>,
    energy_added_kwh: Option<f64>,
    peak_power_kw: Option<f64>,
    powered_streak_start: Option<f64>,
    max_powered_duration: f64,
    latitude: Option<f64>,
    longitude: Option<f64>,
    location_name: Option<String>,
    charge_rate_samples: Vec<Value>,
}

pub struct Session {
    pub fields: Map<String, Value>,
    cost_key: String,
    pub start_timestamp: f64,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub location_name: Option<String>,
    pub peak_power_kw: Option<f64>,
    pub start_time: String,
    pub tags: Vec<Value>,
    pub site_id: String,
}

#[derive(Default)]
pub struct ChargingSessionBuilder {
    completed: Vec<Session>,
    sequence: u64,
    active: Option<Active>,
    last_timestamp: Option<f64>,
    battery_pct: Option<f64>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    coordinate_ts: Option<f64>,
    location_name: Option<String>,
    location_name_ts: Option<f64>,
}

impl ChargingSessionBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    fn update_sparse(&mut self, s: &Map<String, Value>, ts: f64) {
        if let Some(b) = finite(s.get("batteryPct")) {
            self.battery_pct = Some(b);
        }
        let lat = finite(s.get("lat").filter(|v| !v.is_null()).or(s.get("latitude")));
        let lng = finite(s.get("lng").filter(|v| !v.is_null()).or(s.get("longitude")));
        if let (Some(a), Some(b)) = (lat, lng) {
            self.latitude = Some(a);
            self.longitude = Some(b);
            self.coordinate_ts = Some(ts);
        }
        if let Some(name) = trimmed_name(s.get("locationName")) {
            self.location_name = Some(name);
            self.location_name_ts = Some(ts);
        }
    }

    fn begin(&mut self, ts: f64, cost_key: &Value) {
        let fresh_coords = self.coordinate_ts.is_some_and(|c| ts - c <= LOCATION_FALLBACK_SECONDS);
        let fresh_name = self.location_name_ts.is_some_and(|c| ts - c <= LOCATION_FALLBACK_SECONDS);
        self.sequence += 1;
        self.active = Some(Active {
            session_id: format!("charge-{}-{}", js_number_string(ts), self.sequence),
            cost_key: js_string(cost_key),
            start_timestamp: ts,
            last_timestamp: ts,
            start_battery_pct: self.battery_pct,
            end_battery_pct: self.battery_pct,
            energy_added_kwh: None,
            peak_power_kw: None,
            powered_streak_start: None,
            max_powered_duration: 0.0,
            latitude: if fresh_coords { self.latitude } else { None },
            longitude: if fresh_coords { self.longitude } else { None },
            location_name: if fresh_name { self.location_name.clone() } else { None },
            charge_rate_samples: Vec::new(),
        });
    }

    fn close(&mut self, end_ts: f64, reason: &str) {
        let Some(a) = self.active.take() else { return };
        let meaningful = a.energy_added_kwh.is_some_and(|e| e > 0.0) || a.max_powered_duration >= SUSTAINED_POWER_SECONDS;
        if !meaningful {
            return;
        }
        let start_time = iso_timestamp(a.start_timestamp);
        let mut f = Map::new();
        f.insert("sessionId".into(), json!(a.session_id));
        f.insert("startTimestamp".into(), json!(a.start_timestamp));
        f.insert("endTimestamp".into(), json!(end_ts));
        f.insert("startTime".into(), json!(start_time));
        f.insert("endTime".into(), json!(iso_timestamp(end_ts)));
        f.insert("durationSeconds".into(), json!((end_ts - a.start_timestamp).max(0.0)));
        f.insert("startBatteryPct".into(), json!(a.start_battery_pct));
        f.insert("endBatteryPct".into(), json!(a.end_battery_pct));
        f.insert("energyAddedKwh".into(), json!(a.energy_added_kwh));
        f.insert("peakPowerKw".into(), json!(a.peak_power_kw));
        f.insert("latitude".into(), json!(a.latitude));
        f.insert("longitude".into(), json!(a.longitude));
        f.insert("locationName".into(), json!(a.location_name));
        f.insert("endReason".into(), json!(reason));
        f.insert("cost".into(), Value::Null);
        f.insert("chargeRateSamples".into(), Value::Array(a.charge_rate_samples));
        self.completed.push(Session {
            fields: f,
            cost_key: a.cost_key,
            start_timestamp: a.start_timestamp,
            latitude: a.latitude,
            longitude: a.longitude,
            location_name: a.location_name,
            peak_power_kw: a.peak_power_kw,
            start_time,
            tags: Vec::new(),
            site_id: String::new(),
        });
    }

    pub fn add(&mut self, sample: &Value) {
        let Some(s) = sample.as_object() else { return };
        let raw = s.get("ts").filter(|v| !v.is_null()).or(s.get("timestamp"));
        let Some(ts) = normalize_timestamp(raw) else { return };
        let raw = raw.cloned().unwrap_or(Value::Null);
        if self.active.is_some() {
            if let Some(last) = self.last_timestamp {
                if ts - last > SESSION_GAP_SECONDS {
                    self.close(last, "data-gap");
                }
            }
        }
        self.update_sparse(s, ts);
        let state = normalized_state(s.get("chargingState"));
        let is_active_state = matches!(state.as_deref(), Some("starting") | Some("charging"));
        if self.active.is_none() && is_active_state {
            self.begin(ts, &raw);
        }
        if let Some(a) = self.active.as_mut() {
            a.last_timestamp = ts;
            if self.battery_pct.is_some() {
                a.end_battery_pct = self.battery_pct;
            }
            let lat = finite(s.get("lat").filter(|v| !v.is_null()).or(s.get("latitude")));
            let lng = finite(s.get("lng").filter(|v| !v.is_null()).or(s.get("longitude")));
            if let (Some(x), Some(y)) = (lat, lng) {
                a.latitude = Some(x);
                a.longitude = Some(y);
            }
            if let Some(name) = trimmed_name(s.get("locationName")) {
                a.location_name = Some(name);
            }
            let energy = finite(s.get("chargeEnergyAddedKwh"));
            if let Some(e) = energy {
                a.energy_added_kwh = Some(a.energy_added_kwh.unwrap_or(0.0).max(e));
            }
            let power = finite(s.get("chargerPowerKw"));
            if let Some(p) = power {
                a.peak_power_kw = Some(a.peak_power_kw.unwrap_or(p).max(p));
                if p > 0.0 {
                    let start = *a.powered_streak_start.get_or_insert(ts);
                    a.max_powered_duration = a.max_powered_duration.max(ts - start);
                } else {
                    a.powered_streak_start = None;
                }
            }
            let rate = finite(s.get("chargeRateMph"));
            if power.is_some() || energy.is_some() || rate.is_some() {
                let mut c = Map::new();
                c.insert("timestamp".into(), json!(ts));
                if let Some(p) = power {
                    c.insert("powerKw".into(), json!(p));
                }
                if let Some(r) = rate {
                    c.insert("chargeRateMph".into(), json!(r));
                }
                if let Some(e) = energy {
                    c.insert("energyAddedKwh".into(), json!(e));
                }
                if let Some(b) = self.battery_pct {
                    c.insert("batteryPct".into(), json!(b));
                }
                a.charge_rate_samples.push(Value::Object(c));
            }
        }
        if self.active.is_some() {
            if let Some(st) = state.as_deref() {
                if matches!(st, "complete" | "stopped" | "disconnected" | "nopower") {
                    self.close(ts, st);
                }
            }
        }
        self.last_timestamp = Some(ts);
    }

    pub fn finish(mut self, charge_costs: &Value, charge_tags: &Value) -> Vec<Session> {
        if let Some(last) = self.active.as_ref().map(|a| a.last_timestamp) {
            self.close(last, "end-of-file");
        }
        let empty = Map::new();
        let costs = charge_costs.as_object().unwrap_or(&empty);
        let tags = charge_tags.as_object().unwrap_or(&empty);
        let mut out = self.completed;
        for s in &mut out {
            let t = tags.get(&s.cost_key);
            s.tags = match t {
                Some(Value::Array(a)) => a.clone(),
                None | Some(Value::Null) => Vec::new(),
                Some(other) => vec![other.clone()],
            };
            s.fields.insert("cost".into(), costs.get(&s.cost_key).cloned().unwrap_or(Value::Null));
            s.fields.insert("tags".into(), Value::Array(s.tags.clone()));
        }
        out
    }
}

pub struct ChargingHistory {
    pub sites: Vec<Map<String, Value>>,
    /// (session_id, site_id, start_timestamp, summary, detail)
    pub sessions: Vec<Session>,
}

struct Site {
    site_id: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
    display_name: String,
    sessions: Vec<usize>,
    coordinate_count: f64,
}

pub fn group_charging_sites(mut sessions: Vec<Session>) -> ChargingHistory {
    sessions.sort_by(|a, b| a.start_timestamp.partial_cmp(&b.start_timestamp).unwrap_or(std::cmp::Ordering::Equal));
    let mut sites: Vec<Site> = Vec::new();
    let mut unknown: Option<usize> = None;
    for (si, s) in sessions.iter_mut().enumerate() {
        let idx = match (s.latitude, s.longitude) {
            (Some(lat), Some(lng)) => {
                let found = sites.iter().position(|c| {
                    c.latitude.is_some()
                        && haversine_metres(lat, lng, c.latitude.unwrap(), c.longitude.unwrap_or(f64::NAN)) <= SITE_GROUPING_METRES
                });
                let idx = match found {
                    Some(i) => i,
                    None => {
                        sites.push(Site {
                            site_id: format!("site-{}", s.fields.get("sessionId").and_then(Value::as_str).unwrap_or("")),
                            latitude: Some(lat),
                            longitude: Some(lng),
                            display_name: s.location_name.clone().unwrap_or_else(|| UNNAMED_SITE_LABEL.into()),
                            sessions: Vec::new(),
                            coordinate_count: 0.0,
                        });
                        sites.len() - 1
                    }
                };
                let site = &mut sites[idx];
                let next = site.coordinate_count + 1.0;
                site.latitude = Some((site.latitude.unwrap() * site.coordinate_count + lat) / next);
                site.longitude = Some((site.longitude.unwrap() * site.coordinate_count + lng) / next);
                site.coordinate_count = next;
                if let Some(name) = &s.location_name {
                    site.display_name = name.clone();
                }
                idx
            }
            _ => *unknown.get_or_insert_with(|| {
                sites.push(Site {
                    site_id: "unknown".into(),
                    latitude: None,
                    longitude: None,
                    display_name: UNKNOWN_SITE_LABEL.into(),
                    sessions: Vec::new(),
                    coordinate_count: 0.0,
                });
                sites.len() - 1
            }),
        };
        s.site_id = sites[idx].site_id.clone();
        s.fields.insert("siteId".into(), json!(s.site_id));
        sites[idx].sessions.push(si);
    }

    let mut summaries: Vec<Map<String, Value>> = sites
        .iter_mut()
        .map(|site| {
            site.sessions.sort_by(|&a, &b| {
                sessions[b].start_timestamp.partial_cmp(&sessions[a].start_timestamp).unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut tags: Vec<Value> = Vec::new();
            for &si in &site.sessions {
                for t in &sessions[si].tags {
                    if !tags.contains(t) {
                        tags.push(t.clone());
                    }
                }
            }
            let mut peak: Option<f64> = None;
            for &si in &site.sessions {
                if let Some(p) = sessions[si].peak_power_kw.filter(|p| p.is_finite()) {
                    if p > peak.unwrap_or(f64::NEG_INFINITY) {
                        peak = Some(p);
                    }
                }
            }
            let is_home = tags.iter().any(|t| {
                let s = match t {
                    Value::String(s) => s.clone(),
                    other => js_string(other),
                };
                s.trim().to_lowercase() == HOME_TAG
            });
            let mut m = Map::new();
            m.insert("siteId".into(), json!(site.site_id));
            m.insert("latitude".into(), json!(site.latitude));
            m.insert("longitude".into(), json!(site.longitude));
            m.insert("displayName".into(), json!(site.display_name));
            m.insert("visitCount".into(), json!(site.sessions.len()));
            m.insert(
                "latestVisit".into(),
                site.sessions.first().map_or(Value::Null, |&si| json!(sessions[si].start_time)),
            );
            m.insert("peakPowerKw".into(), json!(peak));
            m.insert("tags".into(), Value::Array(tags));
            m.insert("isHome".into(), json!(is_home));
            m
        })
        .collect();
    let latest = |m: &Map<String, Value>| match m.get("latestVisit") {
        Some(Value::String(s)) => s.clone(),
        _ => "null".into(),
    };
    summaries.sort_by(|a, b| {
        let va = a.get("visitCount").and_then(Value::as_u64).unwrap_or(0);
        let vb = b.get("visitCount").and_then(Value::as_u64).unwrap_or(0);
        vb.cmp(&va).then_with(|| latest(b).cmp(&latest(a)))
    });
    sessions.sort_by(|a, b| b.start_timestamp.partial_cmp(&a.start_timestamp).unwrap_or(std::cmp::Ordering::Equal));
    ChargingHistory { sites: summaries, sessions }
}
