//! Reverse geocoding + known places (port of src/processing/geocode.cjs and
//! known-places.cjs).
//!
//! Nominatim client with policy-compliant identification, one request per
//! 1.1 s across the app, request coalescing, and a debounced disk cache keyed
//! by five-decimal coordinates. Known places (manual corrections, privacy
//! zones, learned Tesla labels) win over provider lookups.

mod js;
mod known_places;
mod matching;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::fsutil::{atomic_write, read_json};
use crate::loader::calc::js_round;
use known_places::{now_ms, KnownPlaceStore};
use matching::{
    build_reverse_url, cache_record, cache_record_is_fresh, choose_better_match, city_match, key_for,
    known_place_match, label_match, normalize_endpoint, normalize_language, result_layer, Match,
    DEFAULT_ENDPOINT,
};

/// At most one request per second per Nominatim policy, plus margin.
const RATE: Duration = Duration::from_millis(1100);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(12_000);
const MAX_RESPONSE_BYTES: u64 = 5 * 1024 * 1024;
const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);
const UA: &str = "Sentry-Drive/1.0 (https://github.com/Sentry-Six/Sentry-Drive)";
/// v5 namespaces records by provider and includes query-accuracy evidence.
const CACHE_VERSION: u32 = 5;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ------------------------------------------------------------------ state

/// Managed state. The service (and its disk cache) loads on first use, like
/// the Electron main process.
pub struct GeocodeState {
    inner: Arc<LazyService>,
}

struct LazyService {
    user_data: PathBuf,
    service: OnceLock<Arc<Service>>,
}

impl LazyService {
    fn get(&self) -> Arc<Service> {
        self.service.get_or_init(|| Arc::new(Service::init(&self.user_data, &system_locale()))).clone()
    }
}

impl GeocodeState {
    pub fn new(user_data: &Path) -> Self {
        Self { inner: Arc::new(LazyService { user_data: user_data.to_path_buf(), service: OnceLock::new() }) }
    }
}

/// Equivalent of Electron's `app.getLocale()` (e.g. `en-US`).
fn system_locale() -> String {
    sys_locale::get_locale()
        .or_else(|| {
            let lang = std::env::var("LC_ALL").or_else(|_| std::env::var("LANG")).ok()?;
            let base = lang.split(['.', '@']).next()?.replace('_', "-");
            (!base.is_empty() && base != "C" && base != "POSIX").then_some(base)
        })
        .unwrap_or_default()
}

struct Settings {
    endpoint: String,
    language: String,
}

type FlightResult = watch::Receiver<Option<Value>>;

struct Core {
    settings: Settings,
    system_language: String,
    cache: Map<String, Value>,
    known: KnownPlaceStore,
    /// request key -> (flight id, result channel) for coalescing.
    inflight: HashMap<String, (u64, FlightResult)>,
    save_pending: bool,
}

struct Service {
    cache_file: PathBuf,
    settings_file: PathBuf,
    core: Mutex<Core>,
    /// Serializes provider requests (FIFO) and remembers the last start time.
    gate: tokio::sync::Mutex<Option<Instant>>,
    save_lock: Mutex<()>,
    next_flight: AtomicU64,
    agent: ureq::Agent,
}

#[derive(Serialize)]
struct CacheFile<'a> {
    #[serde(rename = "__v")]
    version: u32,
    entries: &'a Map<String, Value>,
}

struct Query {
    lat: f64,
    lng: f64,
    accuracy_m: f64,
    tesla_label: String,
}

impl Query {
    /// `{ lat, lng, accuracyM, teslaLabel }`; `None` when the coordinates are
    /// not finite numbers (the JS service returns `null` then).
    fn from_args(args: Option<&Value>) -> Option<Self> {
        let args = args?;
        let lat = args.get("lat").and_then(Value::as_f64)?;
        let lng = args.get("lng").and_then(Value::as_f64)?;
        let accuracy = js::to_number(args.get("accuracyM"));
        let accuracy_m = if accuracy.is_nan() { 0.0 } else { accuracy.max(0.0) };
        let tesla_label = args.get("teslaLabel").and_then(Value::as_str).map(str::trim).unwrap_or("").to_owned();
        Some(Self { lat, lng, accuracy_m, tesla_label })
    }
}

enum Step {
    Done(Value),
    Follow(FlightResult),
    Lead(Flight),
}

/// The leader of a coalesced lookup. Dropping it without `finish` (panic)
/// clears the in-flight slot so later lookups can retry.
struct Flight {
    svc: Arc<Service>,
    request_key: String,
    id: u64,
    key: String,
    cached: Option<Value>,
    tx: watch::Sender<Option<Value>>,
    finished: bool,
}

impl Flight {
    fn release(&mut self, core: &mut Core) {
        if matches!(core.inflight.get(&self.request_key), Some((id, _)) if *id == self.id) {
            core.inflight.remove(&self.request_key);
        }
        self.finished = true;
    }

    /// Transport failure: keep the miss retryable and serve any stale label.
    fn fail(mut self) -> Value {
        let stale = match self.cached.take() {
            Some(c) if c.get("label").is_some_and(|l| !l.is_null()) => c,
            _ => Value::Null,
        };
        let svc = self.svc.clone();
        self.release(&mut lock(&svc.core));
        self.tx.send_replace(Some(stale.clone()));
        stale
    }

    /// Provider answered: cache the result (including a miss) and publish it.
    fn succeed(mut self, m: Option<Match>) -> Value {
        let svc = self.svc.clone();
        let record = {
            let mut core = lock(&svc.core);
            self.release(&mut core);
            let record = cache_record(m.as_ref(), now_ms(), &core.settings.endpoint);
            core.cache.insert(std::mem::take(&mut self.key), record.clone());
            svc.schedule_save(&mut core);
            record
        };
        self.tx.send_replace(Some(record.clone()));
        record
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        if !self.finished {
            let svc = self.svc.clone();
            self.release(&mut lock(&svc.core));
        }
    }
}

impl Service {
    fn init(user_data: &Path, locale: &str) -> Self {
        let cache_file = user_data.join("geocode-cache.json");
        let settings_file = user_data.join("geocode-settings.json");
        let raw = read_json(&settings_file);
        let settings = Settings {
            endpoint: normalize_endpoint(raw.as_ref().and_then(|r| r.get("endpoint"))),
            language: normalize_language(raw.as_ref().and_then(|r| r.get("language")), ""),
        };
        let cache = match read_json(&cache_file) {
            Some(Value::Object(mut raw)) if raw.get("__v").and_then(Value::as_f64) == Some(f64::from(CACHE_VERSION)) => {
                match raw.remove("entries") {
                    Some(Value::Object(entries)) => entries,
                    _ => Map::new(),
                }
            }
            _ => Map::new(),
        };
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_TIMEOUT))
            .http_status_as_error(false)
            .max_redirects(0)
            .user_agent(UA)
            .build()
            .new_agent();
        Self {
            core: Mutex::new(Core {
                settings,
                system_language: normalize_language(Some(&Value::String(locale.to_owned())), ""),
                cache,
                known: KnownPlaceStore::load(user_data.join("known-places.json")),
                inflight: HashMap::new(),
                save_pending: false,
            }),
            cache_file,
            settings_file,
            gate: tokio::sync::Mutex::new(None),
            save_lock: Mutex::new(()),
            next_flight: AtomicU64::new(1),
            agent,
        }
    }

    fn settings_json(settings: &Settings) -> Value {
        json!({ "endpoint": settings.endpoint, "language": settings.language, "defaultEndpoint": DEFAULT_ENDPOINT })
    }

    fn get_settings(&self) -> Value {
        Self::settings_json(&lock(&self.core).settings)
    }

    fn configure(&self, next: Option<&Value>) -> Value {
        let settings = Settings {
            endpoint: normalize_endpoint(next.and_then(|n| n.get("endpoint"))),
            language: normalize_language(next.and_then(|n| n.get("language")), ""),
        };
        let body = json!({ "endpoint": settings.endpoint, "language": settings.language });
        if let Err(e) = atomic_write(&self.settings_file, body.to_string().as_bytes()) {
            crate::logger::warn("geocode", format!("settings not saved: {e:#}"));
        }
        let mut core = lock(&self.core);
        core.settings = settings;
        Self::settings_json(&core.settings)
    }

    fn schedule_save(self: &Arc<Self>, core: &mut Core) {
        if core.save_pending {
            return;
        }
        core.save_pending = true;
        let svc = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SAVE_DEBOUNCE);
            let _writer = lock(&svc.save_lock);
            let bytes = {
                let mut core = lock(&svc.core);
                core.save_pending = false;
                serde_json::to_vec(&CacheFile { version: CACHE_VERSION, entries: &core.cache })
            };
            if let Err(e) = bytes.map_err(anyhow::Error::from).and_then(|b| atomic_write(&svc.cache_file, &b)) {
                crate::logger::warn("geocode", format!("geocode cache not saved: {e:#}"));
            }
        });
    }

    /// Synchronous part of a lookup: learned Tesla label, known places,
    /// fresh cache, then join or start the in-flight provider lookup.
    fn begin(self: &Arc<Self>, q: &Query) -> Step {
        let mut core = lock(&self.core);
        if !q.tesla_label.is_empty() {
            core.known.upsert(&json!({
                "lat": q.lat,
                "lng": q.lng,
                "label": q.tesla_label,
                "source": "tesla",
                "radiusM": (q.accuracy_m + 10.0).max(25.0).min(50.0),
            }));
        }
        if let Some(place) = core.known.find(q.lat, q.lng) {
            return Step::Done(known_place_match(&place.entry.label, place.distance_m, place.entry.source, q.accuracy_m));
        }
        let key = key_for(q.lat, q.lng);
        let cached = core.cache.get(&key).cloned();
        if cache_record_is_fresh(cached.as_ref(), now_ms(), &core.settings.endpoint) {
            return Step::Done(cached.unwrap_or(Value::Null));
        }
        let request_key = format!(
            "{}|{}|{}",
            core.settings.endpoint,
            key,
            js::number_to_string(js_round(q.accuracy_m / 5.0))
        );
        if let Some((_, rx)) = core.inflight.get(&request_key) {
            return Step::Follow(rx.clone());
        }
        let (tx, rx) = watch::channel(None);
        let id = self.next_flight.fetch_add(1, Ordering::Relaxed);
        core.inflight.insert(request_key.clone(), (id, rx));
        Step::Lead(Flight { svc: self.clone(), request_key, id, key, cached, tx, finished: false })
    }

    async fn reverse_geocode_detailed(self: Arc<Self>, q: Query) -> Value {
        let (svc, lat, lng, acc) = (self.clone(), q.lat, q.lng, q.accuracy_m);
        let step = match tauri::async_runtime::spawn_blocking(move || svc.begin(&q)).await {
            Ok(step) => step,
            Err(_) => return json!({ "label": null }),
        };
        let flight = match step {
            Step::Done(v) => return v,
            Step::Follow(mut rx) => {
                let result = rx.wait_for(Option::is_some).await.map(|v| v.clone());
                return match result {
                    Ok(v) => v.unwrap_or(Value::Null),
                    Err(_) => json!({ "label": null }),
                };
            }
            Step::Lead(flight) => flight,
        };

        // Street-level detail first.
        let Some(street) = self.fetch(lat, lng, 18, Some("address,poi")).await else { return flight.fail() };
        let mut m = label_match(&street, lat, lng, acc);
        // Nominatim reverse returns one object; when it is not a confident
        // match, compare it once with the opposite address/POI layer.
        if m.as_ref().map(|m| m.confidence) != Some("high") {
            let alternate_layer = if result_layer(&street) == "poi" { "address" } else { "poi" };
            if let Some(alternate) = self.fetch(lat, lng, 18, Some(alternate_layer)).await {
                m = choose_better_match(m, label_match(&alternate, lat, lng, acc));
            }
        }
        if m.is_none() {
            let Some(city) = self.fetch(lat, lng, 10, None).await else { return flight.fail() };
            m = city_match(&city, lat, lng, acc);
        }
        flight.succeed(m)
    }

    /// One provider request, queued FIFO behind every other request and
    /// started at least `RATE` after the previous one. `None` on transport
    /// error, timeout, oversized body, non-2xx, or unparseable JSON.
    async fn fetch(self: &Arc<Self>, lat: f64, lng: f64, zoom: u8, layer: Option<&'static str>) -> Option<Value> {
        let mut last_start = self.gate.lock().await;
        let previous = *last_start;
        let svc = self.clone();
        let (started, result) = tauri::async_runtime::spawn_blocking(move || {
            if let Some(wait) = previous.and_then(|p| RATE.checked_sub(p.elapsed())) {
                std::thread::sleep(wait);
            }
            let started = Instant::now();
            (started, svc.request(lat, lng, zoom, layer))
        })
        .await
        .ok()?;
        *last_start = Some(started);
        result
    }

    fn request(&self, lat: f64, lng: f64, zoom: u8, layer: Option<&str>) -> Option<Value> {
        let (endpoint, language) = {
            let core = lock(&self.core);
            let language = if core.settings.language.is_empty() {
                core.system_language.clone()
            } else {
                core.settings.language.clone()
            };
            (core.settings.endpoint.clone(), language)
        };
        let url = build_reverse_url(&endpoint, lat, lng, zoom, layer)?;
        let mut req = self.agent.get(url.as_str()).header("User-Agent", UA).header("Accept", "application/json");
        if !language.is_empty() {
            req = req.header("Accept-Language", &language);
        }
        let mut response = req.call().ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.body_mut().with_config().limit(MAX_RESPONSE_BYTES).read_json::<Value>().ok()
    }
}

// --------------------------------------------------------------- commands

/// Run `f` against the (lazily initialized) service off the async runtime;
/// a panic yields `fallback`, mirroring the Electron handlers' try/catch.
async fn with_service<T: Send + 'static>(
    app: &AppHandle,
    fallback: T,
    f: impl FnOnce(Arc<Service>) -> T + Send + 'static,
) -> T {
    let lazy = app.state::<GeocodeState>().inner.clone();
    tauri::async_runtime::spawn_blocking(move || f(lazy.get())).await.unwrap_or(fallback)
}

#[tauri::command]
pub async fn reverse_geocode(app: AppHandle, args: Option<Value>) -> Value {
    let Some(query) = Query::from_args(args.as_ref()) else { return Value::Null };
    let Some(svc) = with_service(&app, None, Some).await else { return json!({ "label": null }) };
    svc.reverse_geocode_detailed(query).await
}

#[tauri::command]
pub async fn get_geocode_settings(app: AppHandle) -> Value {
    with_service(&app, Value::Null, |svc| svc.get_settings()).await
}

#[tauri::command]
pub async fn set_geocode_settings(app: AppHandle, settings: Option<Value>) -> Value {
    with_service(&app, Value::Null, move |svc| svc.configure(settings.as_ref())).await
}

#[tauri::command]
pub async fn remember_known_place(app: AppHandle, place: Option<Value>) -> Value {
    with_service(&app, Value::Null, move |svc| {
        let place = place.unwrap_or(Value::Null);
        lock(&svc.core).known.upsert(&place).map_or(Value::Null, |e| e.to_json())
    })
    .await
}

#[tauri::command]
pub async fn remove_known_place(app: AppHandle, place: Option<Value>) -> bool {
    with_service(&app, false, move |svc| {
        let input = place.unwrap_or(Value::Null);
        let source = match input.get("source") {
            v if js::truthy(v) => js::to_string(v),
            _ => "manual".to_owned(),
        };
        let max = js::to_number(input.get("maxDistanceM"));
        let max = if max == 0.0 || max.is_nan() { 100.0 } else { max };
        let (lat, lng) = (js::to_number(input.get("lat")), js::to_number(input.get("lng")));
        lock(&svc.core).known.remove_near(lat, lng, Some(&source), max)
    })
    .await
}

#[tauri::command]
pub async fn sync_known_place_zones(app: AppHandle, args: Option<Value>) -> u64 {
    with_service(&app, 0, move |svc| {
        let zones = args.as_ref().and_then(|a| a.get("zones"));
        lock(&svc.core).known.replace_zones(zones) as u64
    })
    .await
}
