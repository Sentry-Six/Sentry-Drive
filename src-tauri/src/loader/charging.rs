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

/// Ports of `src/shared/charging-history.test.js`. Timestamps are epoch
/// seconds rendered in UTC, so nothing here depends on the local zone.
#[cfg(test)]
mod tests {
    use super::*;

    fn collect_with(samples: &[Value], costs: Value, tags: Value) -> Vec<Session> {
        let mut builder = ChargingSessionBuilder::new();
        for s in samples {
            builder.add(s);
        }
        builder.finish(&costs, &tags)
    }

    fn collect(samples: &[Value], costs: Value) -> Vec<Session> {
        collect_with(samples, costs, json!({}))
    }

    fn get<'a>(s: &'a Session, key: &str) -> &'a Value {
        s.fields.get(key).unwrap_or_else(|| panic!("session has no {key}"))
    }

    fn reasons(sessions: &[Session]) -> Vec<&str> {
        sessions.iter().map(|s| get(s, "endReason").as_str().unwrap()).collect()
    }

    #[test]
    fn builds_a_sparse_charging_session_and_matches_its_exact_start_cost() {
        let sessions = collect(
            &[
                json!({ "ts": 1_000, "batteryPct": 20, "lat": 39, "lng": -77, "locationName": "Old place" }),
                json!({ "ts": 1_060, "chargingState": "starting" }),
                json!({ "ts": 1_070, "chargerPowerKw": 5, "chargeEnergyAddedKwh": 0.2 }),
                json!({
                    "ts": 1_080, "lat": 40.1, "lng": -76.2, "locationName": "Market Street",
                    "chargerPowerKw": 25, "chargeRateMph": 110, "batteryPct": 25, "chargeEnergyAddedKwh": 1.5,
                }),
                json!({
                    "ts": 1_120, "lat": 40.1004, "lng": -76.2003, "chargerPowerKw": 48,
                    "batteryPct": 35, "chargeEnergyAddedKwh": 4.25,
                }),
                json!({ "ts": 1_180, "chargingState": "complete", "batteryPct": 41 }),
            ],
            json!({ "1060": { "amount": 8.75, "currency": "$" }, "1059": { "amount": 99, "currency": "$" } }),
        );
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            Value::Object(sessions[0].fields.clone()),
            json!({
                "sessionId": "charge-1060-1",
                "startTimestamp": 1060.0,
                "endTimestamp": 1180.0,
                "startTime": "1970-01-01T00:17:40.000Z",
                "endTime": "1970-01-01T00:19:40.000Z",
                "durationSeconds": 120.0,
                "startBatteryPct": 20.0,
                "endBatteryPct": 41.0,
                "energyAddedKwh": 4.25,
                "peakPowerKw": 48.0,
                "latitude": 40.1004,
                "longitude": -76.2003,
                "locationName": "Market Street",
                "endReason": "complete",
                "cost": { "amount": 8.75, "currency": "$" },
                "tags": [],
                "chargeRateSamples": [
                    { "timestamp": 1070.0, "powerKw": 5.0, "energyAddedKwh": 0.2, "batteryPct": 20.0 },
                    { "timestamp": 1080.0, "powerKw": 25.0, "chargeRateMph": 110.0, "energyAddedKwh": 1.5, "batteryPct": 25.0 },
                    { "timestamp": 1120.0, "powerKw": 48.0, "energyAddedKwh": 4.25, "batteryPct": 35.0 },
                ],
            })
        );
    }

    #[test]
    fn rejects_a_short_false_start_without_energy_or_sustained_power() {
        let sessions = collect(
            &[
                json!({ "ts": 2_000, "chargingState": "starting" }),
                json!({ "ts": 2_010, "chargingState": "charging", "chargerPowerKw": 3 }),
                json!({ "ts": 2_025, "chargingState": "stopped", "chargerPowerKw": 0 }),
            ],
            json!({}),
        );
        assert!(sessions.is_empty());
    }

    #[test]
    fn counts_sustained_nonzero_power_even_when_cumulative_energy_is_absent() {
        let sessions = collect(
            &[
                json!({ "ts": 3_000, "chargingState": "charging", "chargerPowerKw": 7 }),
                json!({ "ts": 3_061, "chargingState": "charging", "chargerPowerKw": 6 }),
                json!({ "ts": 3_080, "chargingState": "disconnected" }),
            ],
            json!({}),
        );
        assert_eq!(sessions.len(), 1);
        assert_eq!(get(&sessions[0], "energyAddedKwh"), &Value::Null);
        assert_eq!(reasons(&sessions), vec!["disconnected"]);
    }

    #[test]
    fn requires_one_uninterrupted_nonzero_power_streak() {
        let sessions = collect(
            &[
                json!({ "ts": 3_500, "chargingState": "charging", "chargerPowerKw": 7 }),
                json!({ "ts": 3_540, "chargingState": "charging", "chargerPowerKw": 0 }),
                json!({ "ts": 3_570, "chargingState": "charging", "chargerPowerKw": 6 }),
                json!({ "ts": 3_590, "chargingState": "stopped", "chargerPowerKw": 0 }),
            ],
            json!({}),
        );
        assert!(sessions.is_empty());
    }

    #[test]
    fn matches_a_millisecond_timestamp_cost_without_changing_its_lookup_key() {
        let start_ms: i64 = 12_000_000_000;
        let sessions = collect(
            &[
                json!({ "ts": start_ms, "chargingState": "charging", "chargeEnergyAddedKwh": 1 }),
                json!({ "ts": start_ms + 60_000, "chargingState": "complete" }),
            ],
            json!({ start_ms.to_string(): { "amount": 3.25, "currency": "$" } }),
        );
        assert_eq!(get(&sessions[0], "startTimestamp").as_f64(), Some(start_ms as f64 / 1000.0));
        assert_eq!(get(&sessions[0], "cost"), &json!({ "amount": 3.25, "currency": "$" }));
    }

    #[test]
    fn closes_sessions_at_a_30_minute_gap_and_at_end_of_file() {
        let sessions = collect(
            &[
                json!({ "ts": 4_000, "chargingState": "charging", "chargeEnergyAddedKwh": 1 }),
                json!({ "ts": 5_801, "chargingState": "charging", "chargeEnergyAddedKwh": 2 }),
            ],
            json!({}),
        );
        assert_eq!(sessions.len(), 2);
        assert_eq!(get(&sessions[0], "endTimestamp").as_f64(), Some(4_000.0));
        assert_eq!(get(&sessions[1], "endTimestamp").as_f64(), Some(5_801.0));
        assert_eq!(reasons(&sessions), vec!["data-gap", "end-of-file"]);
    }

    #[test]
    fn uses_only_a_coordinate_fallback_observed_within_15_minutes_before_charging() {
        let sessions = collect(
            &[
                json!({ "ts": 5_000, "lat": 38, "lng": -75, "locationName": "Too old" }),
                json!({ "ts": 5_901, "chargingState": "charging", "chargeEnergyAddedKwh": 1 }),
                json!({ "ts": 5_920, "chargingState": "complete" }),
                json!({ "ts": 7_000, "lat": 39, "lng": -76, "locationName": "Fresh place" }),
                json!({ "ts": 7_899, "chargingState": "charging", "chargeEnergyAddedKwh": 2 }),
                json!({ "ts": 7_920, "chargingState": "nopower" }),
            ],
            json!({}),
        );
        assert_eq!(get(&sessions[0], "latitude"), &Value::Null);
        assert_eq!(get(&sessions[0], "longitude"), &Value::Null);
        assert_eq!(get(&sessions[1], "latitude").as_f64(), Some(39.0));
        assert_eq!(get(&sessions[1], "longitude").as_f64(), Some(-76.0));
        assert_eq!(get(&sessions[1], "locationName"), "Fresh place");
    }

    #[test]
    fn ignores_malformed_timestamps_and_ends_on_every_terminal_charging_state() {
        let sessions = collect(
            &[
                json!({ "ts": "bad", "chargingState": "charging", "chargeEnergyAddedKwh": 99 }),
                json!({ "ts": 8_000, "chargingState": "charging", "chargeEnergyAddedKwh": 1 }),
                json!({ "ts": 8_010, "chargingState": "stopped" }),
                json!({ "ts": 9_000, "chargingState": "charging", "chargeEnergyAddedKwh": 1 }),
                json!({ "ts": 9_010, "chargingState": "disconnected" }),
                json!({ "ts": 10_000, "chargingState": "charging", "chargeEnergyAddedKwh": 1 }),
                json!({ "ts": 10_010, "chargingState": "no-power" }),
            ],
            json!({}),
        );
        assert_eq!(reasons(&sessions), vec!["stopped", "disconnected", "nopower"]);
    }

    fn make_session(
        id: &str,
        start: f64,
        coords: Option<(f64, f64)>,
        name: Option<&str>,
        peak_power_kw: Option<f64>,
    ) -> Session {
        let start_time = iso_timestamp(start);
        let mut fields = Map::new();
        fields.insert("sessionId".into(), json!(id));
        fields.insert("startTimestamp".into(), json!(start));
        fields.insert("startTime".into(), json!(start_time));
        fields.insert("endTimestamp".into(), json!(start + 60.0));
        Session {
            fields,
            cost_key: String::new(),
            start_timestamp: start,
            latitude: coords.map(|c| c.0),
            longitude: coords.map(|c| c.1),
            location_name: name.map(String::from),
            peak_power_kw,
            start_time,
            tags: Vec::new(),
            site_id: String::new(),
        }
    }

    #[test]
    fn groups_repeated_visits_within_150_metres_and_keeps_unknown_sessions_listable() {
        let grouped = group_charging_sites(vec![
            make_session("a", 100.0, Some((40.0, -76.0)), Some("First label"), None),
            make_session("b", 300.0, Some((40.0007, -76.0004)), Some("New label"), None),
            make_session("c", 200.0, Some((40.003, -76.0)), Some("Nearby but distinct"), None),
            make_session("d", 400.0, None, Some("Garage"), None),
        ]);
        let summary: Vec<Value> = grouped
            .sites
            .iter()
            .map(|s| {
                json!({
                    "siteId": s["siteId"], "displayName": s["displayName"], "visitCount": s["visitCount"],
                    "latestVisit": s["latestVisit"], "latitude": s["latitude"],
                })
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                json!({
                    "siteId": "site-a", "displayName": "New label", "visitCount": 2,
                    "latestVisit": "1970-01-01T00:05:00.000Z", "latitude": 40.00035,
                }),
                json!({
                    "siteId": "unknown", "displayName": "Unknown location", "visitCount": 1,
                    "latestVisit": "1970-01-01T00:06:40.000Z", "latitude": null,
                }),
                json!({
                    "siteId": "site-c", "displayName": "Nearby but distinct", "visitCount": 1,
                    "latestVisit": "1970-01-01T00:03:20.000Z", "latitude": 40.003,
                }),
            ]
        );
        let site_a: Vec<&str> = grouped
            .sessions
            .iter()
            .filter(|s| s.site_id == "site-a")
            .map(|s| get(s, "sessionId").as_str().unwrap())
            .collect();
        assert_eq!(site_a, vec!["b", "a"]);
    }

    #[test]
    fn charge_tags_attach_by_session_start_key_and_mark_a_site_as_home() {
        let sessions = collect_with(
            &[
                json!({ "ts": 1_000, "lat": 40, "lng": -76, "locationName": "Driveway", "batteryPct": 20 }),
                json!({ "ts": 1_010, "chargingState": "charging", "chargerPowerKw": 7, "chargeEnergyAddedKwh": 0.5 }),
                json!({ "ts": 1_120, "chargingState": "complete", "batteryPct": 40 }),
                json!({ "ts": 9_000, "lat": 40, "lng": -76, "locationName": "Driveway", "batteryPct": 30 }),
                json!({ "ts": 9_010, "chargingState": "charging", "chargerPowerKw": 7, "chargeEnergyAddedKwh": 0.5 }),
                json!({ "ts": 9_120, "chargingState": "complete", "batteryPct": 50 }),
                json!({ "ts": 90_000, "lat": 41, "lng": -77, "locationName": "Supercharger", "batteryPct": 20 }),
                json!({ "ts": 90_010, "chargingState": "charging", "chargerPowerKw": 150, "chargeEnergyAddedKwh": 5 }),
                json!({ "ts": 90_120, "chargingState": "complete", "batteryPct": 60 }),
            ],
            json!({}),
            json!({ "1010": ["HOME"], "90010": ["Road Trip"] }),
        );
        let mut tags: Vec<Value> = sessions.iter().map(|s| get(s, "tags").clone()).collect();
        // Array.prototype.sort compares String(array): "", "HOME", "Road Trip".
        tags.sort_by_key(|t| t.as_array().unwrap().iter().map(|v| v.as_str().unwrap_or("")).collect::<Vec<_>>().join(","));
        assert_eq!(tags, vec![json!([]), json!(["HOME"]), json!(["Road Trip"])]);

        let ChargingHistory { sites, .. } = group_charging_sites(sessions);
        let driveway = sites.iter().find(|s| s["displayName"] == "Driveway").unwrap();
        let away = sites.iter().find(|s| s["displayName"] == "Supercharger").unwrap();
        assert_eq!(driveway["visitCount"], json!(2));
        assert_eq!(driveway["tags"], json!(["HOME"]));
        assert_eq!(driveway["isHome"], json!(true));
        assert_eq!(away["tags"], json!(["Road Trip"]));
        assert_eq!(away["isHome"], json!(false));
    }

    #[test]
    fn a_scalar_charge_tag_is_accepted_and_no_tags_means_no_home_flag() {
        let build = |tag_map: Value| {
            let sessions = collect_with(
                &[
                    json!({ "ts": 1_000, "lat": 40, "lng": -76, "locationName": "Spot", "batteryPct": 20 }),
                    json!({ "ts": 1_010, "chargingState": "charging", "chargerPowerKw": 7, "chargeEnergyAddedKwh": 0.5 }),
                    json!({ "ts": 1_120, "chargingState": "complete", "batteryPct": 40 }),
                ],
                json!({}),
                tag_map,
            );
            group_charging_sites(sessions).sites.remove(0)
        };
        assert_eq!(build(json!({ "1010": "Home" }))["isHome"], json!(true));
        assert_eq!(build(json!({ "1010": ["  home  "] }))["isHome"], json!(true));
        assert_eq!(build(json!({}))["isHome"], json!(false));
        assert_eq!(build(json!({}))["tags"], json!([]));
        assert_eq!(build(json!({ "5555": ["Home"] }))["isHome"], json!(false));
    }

    #[test]
    fn site_summary_carries_the_fastest_charge_recorded_there() {
        let s = |id: &str, start: f64, peak: Option<f64>| make_session(id, start, Some((40.0, -76.0)), Some("Spot"), peak);
        let sites = group_charging_sites(vec![s("a", 100.0, Some(7.0)), s("b", 200.0, Some(142.0)), s("c", 300.0, Some(48.0))]).sites;
        assert_eq!(sites[0]["peakPowerKw"].as_f64(), Some(142.0));

        let partial = group_charging_sites(vec![s("a", 100.0, None), s("b", 200.0, Some(11.0))]).sites;
        assert_eq!(partial[0]["peakPowerKw"].as_f64(), Some(11.0));

        let none = group_charging_sites(vec![s("a", 100.0, None)]).sites;
        assert_eq!(none[0]["peakPowerKw"], Value::Null);
    }
}
