//! Known places: manual corrections, privacy-zone names, and learned Tesla
//! labels (port of src/processing/known-places.cjs).

use std::path::PathBuf;

use serde_json::{json, Value};

use super::js;
use super::matching::round1;
use crate::fsutil::{atomic_write, read_json};
use crate::loader::calc::geodesic_m;

const STORE_VERSION: f64 = 1.0;
const MAX_ENTRIES: usize = 1000;

fn source_priority(source: &str) -> u8 {
    match source {
        "manual" => 3,
        "zone" => 2,
        "tesla" => 1,
        _ => 0,
    }
}

fn finite_coordinate(lat: f64, lng: f64) -> bool {
    lat.is_finite() && lng.is_finite() && (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lng)
}

/// `label.trim().slice(0, 160)` (UTF-16 units, cut at a char boundary).
fn clean_label(label: Option<&Value>) -> String {
    let Some(Value::String(s)) = label else { return String::new() };
    let mut units = 0;
    s.trim()
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 160
        })
        .collect()
}

fn default_radius(source: &str) -> f64 {
    match source {
        "zone" => 150.0,
        "manual" => 40.0,
        _ => 25.0,
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `Math.random().toString(36).slice(2, 9)`-style suffix.
fn random_suffix() -> String {
    let mut n = uuid::Uuid::new_v4().as_u128();
    (0..7)
        .map(|_| {
            let d = (n % 36) as u32;
            n /= 36;
            char::from_digit(d, 36).unwrap_or('0')
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub lat: f64,
    pub lng: f64,
    pub radius_m: f64,
    pub source: &'static str,
    pub updated_at: f64,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "lat": js::num(self.lat),
            "lng": js::num(self.lng),
            "radiusM": js::num(self.radius_m),
            "source": self.source,
            "updatedAt": js::num(self.updated_at),
        })
    }
}

fn clean_entry(entry: &Value) -> Option<Entry> {
    let lat = js::to_number(entry.get("lat"));
    let lng = js::to_number(entry.get("lng"));
    let label = clean_label(entry.get("label"));
    let source: &'static str = match entry.get("source").and_then(Value::as_str) {
        Some("manual") => "manual",
        Some("zone") => "zone",
        Some("tesla") => "tesla",
        _ => return None,
    };
    if !finite_coordinate(lat, lng) || label.is_empty() {
        return None;
    }
    let max_radius = if source == "zone" { 1000.0 } else { 100.0 };
    let requested = js::to_number(entry.get("radiusM"));
    let requested = if requested == 0.0 || requested.is_nan() { default_radius(source) } else { requested };
    let radius_m = requested.max(5.0).min(max_radius);
    let id = match entry.get("id") {
        Some(Value::String(id)) if !id.is_empty() => id.clone(),
        _ => format!("{source}-{}-{}", now_ms(), random_suffix()),
    };
    let updated_at = entry.get("updatedAt").and_then(Value::as_f64).unwrap_or(now_ms() as f64);
    Some(Entry { id, label, lat, lng, radius_m, source, updated_at })
}

/// A matched entry plus its distance to the query (rounded to 0.1 m).
#[derive(Clone, Debug)]
pub struct Found {
    pub entry: Entry,
    pub distance_m: f64,
}

pub struct KnownPlaceStore {
    path: PathBuf,
    entries: Vec<Entry>,
}

impl KnownPlaceStore {
    pub fn load(path: PathBuf) -> Self {
        let entries = read_json(&path)
            .filter(|raw| raw.get("__v").and_then(Value::as_f64) == Some(STORE_VERSION))
            .and_then(|raw| raw.get("entries").and_then(Value::as_array).map(|a| a.iter().filter_map(clean_entry).collect()))
            .unwrap_or_default();
        Self { path, entries }
    }

    fn save(&self) {
        let body = json!({
            "__v": 1,
            "entries": self.entries.iter().map(Entry::to_json).collect::<Vec<_>>(),
        });
        if let Err(e) = atomic_write(&self.path, body.to_string().as_bytes()) {
            crate::logger::warn("geocode", format!("known places not saved: {e:#}"));
        }
    }

    fn trim_learned_entries(&mut self) {
        if self.entries.len() <= MAX_ENTRIES {
            return;
        }
        let (protected, mut learned): (Vec<Entry>, Vec<Entry>) =
            self.entries.drain(..).partition(|e| e.source != "tesla");
        learned.sort_by(|a, b| b.updated_at.partial_cmp(&a.updated_at).unwrap_or(std::cmp::Ordering::Equal));
        learned.truncate(MAX_ENTRIES.saturating_sub(protected.len()));
        self.entries = protected;
        self.entries.extend(learned);
    }

    /// Highest-priority source wins; ties go to the nearer entry.
    pub fn find(&self, lat: f64, lng: f64) -> Option<Found> {
        if !finite_coordinate(lat, lng) {
            return None;
        }
        let mut best: Option<Found> = None;
        for entry in &self.entries {
            let distance_m = geodesic_m(lat, lng, entry.lat, entry.lng);
            if distance_m > entry.radius_m {
                continue;
            }
            let candidate = Found { entry: entry.clone(), distance_m: round1(distance_m) };
            let better = match &best {
                None => true,
                Some(b) => {
                    let (cp, bp) = (source_priority(candidate.entry.source), source_priority(b.entry.source));
                    cp > bp || (cp == bp && candidate.distance_m < b.distance_m)
                }
            };
            if better {
                best = Some(candidate);
            }
        }
        best
    }

    pub fn upsert(&mut self, input: &Value) -> Option<Entry> {
        let next = clean_entry(input)?;
        let mut index = match input.get("id") {
            Some(Value::String(id)) if !id.is_empty() => self.entries.iter().position(|e| e.id == *id),
            _ => None,
        };
        if index.is_none() {
            let label = next.label.to_lowercase();
            index = self.entries.iter().position(|e| {
                e.source == next.source
                    && e.label.to_lowercase() == label
                    && geodesic_m(e.lat, e.lng, next.lat, next.lng) <= e.radius_m.max(next.radius_m)
            });
        }
        let saved = match index {
            Some(i) => {
                let id = std::mem::take(&mut self.entries[i].id);
                self.entries[i] = Entry { id, updated_at: now_ms() as f64, ..next };
                self.entries[i].clone()
            }
            None => {
                self.entries.push(next.clone());
                next
            }
        };
        self.trim_learned_entries();
        self.save();
        Some(saved)
    }

    pub fn remove_near(&mut self, lat: f64, lng: f64, source: Option<&str>, max_distance_m: f64) -> bool {
        if !finite_coordinate(lat, lng) {
            return false;
        }
        let mut best: Option<(usize, f64)> = None;
        for (i, e) in self.entries.iter().enumerate() {
            if source.is_some_and(|s| e.source != s) {
                continue;
            }
            let d = geodesic_m(lat, lng, e.lat, e.lng);
            if d <= max_distance_m && best.is_none_or(|(_, bd)| d < bd) {
                best = Some((i, d));
            }
        }
        let Some((i, _)) = best else { return false };
        self.entries.remove(i);
        self.save();
        true
    }

    /// Replace every zone-sourced entry; returns the number of zones kept.
    pub fn replace_zones(&mut self, zones: Option<&Value>) -> usize {
        self.entries.retain(|e| e.source != "zone");
        for zone in zones.and_then(Value::as_array).into_iter().flatten() {
            let Value::Object(fields) = zone else { continue };
            let mut fields = fields.clone();
            fields.insert("id".into(), json!(format!("zone-{}", js::to_string(zone.get("id")))));
            fields.insert("source".into(), json!("zone"));
            if let Some(entry) = clean_entry(&Value::Object(fields)) {
                self.entries.push(entry);
            }
        }
        self.trim_learned_entries();
        self.save();
        self.entries.iter().filter(|e| e.source == "zone").count()
    }

    #[cfg(test)]
    pub fn list(&self) -> Vec<Entry> {
        self.entries.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_store() -> (TempDir, KnownPlaceStore) {
        let dir = std::env::temp_dir().join(format!("sentry-drive-known-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = KnownPlaceStore::load(dir.join("known-places.json"));
        (TempDir(dir), store)
    }

    fn label_at(store: &KnownPlaceStore, lat: f64, lng: f64) -> Option<String> {
        store.find(lat, lng).map(|f| f.entry.label)
    }

    #[test]
    fn prefers_manual_then_zones_then_tesla() {
        let (_dir, mut store) = temp_store();
        store.upsert(&json!({ "lat": 40, "lng": -76, "label": "Tesla label", "source": "tesla" }));
        store.replace_zones(Some(&json!([{ "id": "home", "lat": 40, "lng": -76, "label": "Home", "radiusM": 150 }])));
        store.upsert(&json!({ "lat": 40, "lng": -76, "label": "My driveway", "source": "manual" }));

        assert_eq!(label_at(&store, 40.00001, -76.0).as_deref(), Some("My driveway"));
        store.remove_near(40.0, -76.0, Some("manual"), 100.0);
        assert_eq!(label_at(&store, 40.00001, -76.0).as_deref(), Some("Home"));
        store.replace_zones(Some(&json!([])));
        assert_eq!(label_at(&store, 40.00001, -76.0).as_deref(), Some("Tesla label"));
    }

    #[test]
    fn persists_merges_repeated_tesla_labels_and_respects_radius() {
        let (dir, mut store) = temp_store();
        store.upsert(&json!({ "lat": 40, "lng": -76, "label": "Office", "source": "tesla", "radiusM": 25 }));
        store.upsert(&json!({ "lat": 40.00001, "lng": -76, "label": "Office", "source": "tesla", "radiusM": 25 }));

        assert_eq!(store.list().len(), 1);
        let reloaded = KnownPlaceStore::load(dir.0.join("known-places.json"));
        assert_eq!(label_at(&reloaded, 40.0, -76.0).as_deref(), Some("Office"));
        assert_eq!(label_at(&reloaded, 40.001, -76.0), None);
    }

    #[test]
    fn zone_ids_radius_clamps_and_invalid_input() {
        let (_dir, mut store) = temp_store();
        let kept = store.replace_zones(Some(&json!([
            { "id": 7, "lat": 10, "lng": 10, "label": "  Work  ", "radiusM": 5000 },
            { "id": "bad", "lat": 95, "lng": 10, "label": "Nope" },
            { "id": "blank", "lat": 1, "lng": 1, "label": "   " },
            null,
        ])));
        assert_eq!(kept, 1);
        let zone = &store.list()[0];
        assert_eq!(zone.id, "zone-7");
        assert_eq!(zone.label, "Work");
        assert_eq!(zone.radius_m, 1000.0);
        assert!(store.upsert(&json!({ "lat": 1, "lng": 1, "label": "x", "source": "other" })).is_none());
        let manual = store.upsert(&json!({ "lat": "1", "lng": 1, "label": "x", "source": "manual", "radiusM": 0 })).unwrap();
        assert_eq!(manual.radius_m, 40.0);
        assert!(manual.id.starts_with("manual-"));
        assert!(!store.remove_near(1.0, 1.0, Some("tesla"), 100.0));
        assert!(store.remove_near(1.0, 1.0, Some("manual"), 100.0));
    }
}
