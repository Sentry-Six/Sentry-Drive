//! The drive index.
//!
//! drive-data.json is streamed once (it can exceed 1 GB) into a throwaway
//! SQLite index: routes are parsed straight into compact typed records, never
//! materialised as a whole document. Drives are then grouped window by window
//! from the index.

use std::fs::File;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::de::IgnoredAny;
use serde_json::{json, Map, Value};

use super::calc;
use super::charging::{group_charging_sites, ChargingSessionBuilder};
use super::grouper::group_into_drives;
use super::route::{normalize_clip_path, parse_clip_timestamp_ms, parse_local_iso, Route, RouteJson};
use crate::drive_data::{for_each_array_element, read_range, scan_sections};

pub struct Progress {
    pub phase: &'static str,
    pub current: u64,
    pub total: u64,
}

pub type ProgressFn<'a> = &'a (dyn Fn(Progress) + Sync);

pub struct DriveIndex {
    pub db: Connection,
    pub source_path: PathBuf,
}

#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub processed_file_count: u64,
    pub route_count: u64,
    pub dropped_count: u64,
    pub duplicate_count: u64,
    pub charging_session_count: u64,
    pub charging_site_count: u64,
}

fn canceled() -> anyhow::Error {
    anyhow!("Drive data indexing canceled").context("ABORT_ERR")
}

/// `|tag|tag|` lower-cased tag set for whole-tag LIKE filtering.
fn encode_tag_set(tags: &[Value]) -> String {
    let clean: Vec<String> = tags
        .iter()
        .map(|t| match t {
            Value::String(s) => s.trim().to_lowercase(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_lowercase(),
        })
        .filter(|s| !s.is_empty())
        .collect();
    if clean.is_empty() { String::new() } else { format!("|{}|", clean.join("|")) }
}

fn next_day_string(date: &str) -> Option<String> {
    let d = chrono::NaiveDate::parse_from_str(date.get(..10)?, "%Y-%m-%d").ok()?;
    Some(d.succ_opt()?.format("%Y-%m-%d").to_string())
}

impl DriveIndex {
    pub fn create(db_path: &Path, source_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(db_path)?;
        db.execute_batch(
            "PRAGMA journal_mode=OFF;
             PRAGMA synchronous=OFF;
             PRAGMA temp_store=FILE;
             PRAGMA cache_size=-32768;
             CREATE TABLE IF NOT EXISTS routes (
               id INTEGER PRIMARY KEY,
               sequence INTEGER NOT NULL,
               normalized_file TEXT NOT NULL UNIQUE,
               timestamp_ms INTEGER NOT NULL,
               payload BLOB NOT NULL);
             CREATE INDEX IF NOT EXISTS routes_timestamp ON routes(timestamp_ms, sequence);
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS drives (
               id INTEGER PRIMARY KEY,
               start_time TEXT NOT NULL,
               source TEXT NOT NULL,
               tags TEXT NOT NULL DEFAULT '',
               summary TEXT NOT NULL,
               detail BLOB NOT NULL);
             CREATE INDEX IF NOT EXISTS drives_start_time ON drives(start_time DESC, id DESC);
             CREATE TABLE IF NOT EXISTS charging_sites (
               site_id TEXT PRIMARY KEY,
               visit_count INTEGER NOT NULL,
               latest_visit TEXT,
               summary TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS charging_sites_order ON charging_sites(visit_count DESC, latest_visit DESC);
             CREATE TABLE IF NOT EXISTS charging_sessions (
               session_id TEXT PRIMARY KEY,
               site_id TEXT NOT NULL,
               start_timestamp REAL NOT NULL,
               summary TEXT NOT NULL,
               detail TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS charging_sessions_site_time ON charging_sessions(site_id, start_timestamp DESC);",
        )?;
        Ok(Self { db, source_path: source_path.to_path_buf() })
    }

    pub fn set_meta(&self, key: &str, value: &Value) -> Result<()> {
        self.db.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        Ok(raw.map(|s| serde_json::from_str(&s)).transpose()?)
    }

    pub fn drive_tags(&self) -> Result<Map<String, Value>> {
        Ok(match self.get_meta("driveTags")? {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        })
    }

    pub fn list_drive_summaries(&self, query: &Value) -> Result<Value> {
        let num = |k: &str, d: f64| query.get(k).and_then(Value::as_f64).filter(|v| *v != 0.0).unwrap_or(d);
        let limit = num("limit", 250.0).clamp(1.0, 1000.0) as i64;
        let offset = num("offset", 0.0).max(0.0) as i64;
        let s = |k: &str| query.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let mut wheres: Vec<&str> = Vec::new();
        let mut binds: Vec<String> = Vec::new();
        let tag = s("tag").trim().to_lowercase();
        if !tag.is_empty() {
            wheres.push("tags LIKE ?");
            binds.push(format!("%|{tag}|%"));
        }
        let start = s("startDate");
        if !start.is_empty() {
            wheres.push("start_time >= ?");
            binds.push(start.chars().take(10).collect());
        }
        let end = s("endDate");
        if !end.is_empty() {
            if let Some(stop) = next_day_string(&end) {
                wheres.push("start_time < ?");
                binds.push(stop);
            }
        }
        let clause = if wheres.is_empty() { String::new() } else { format!("WHERE {}", wheres.join(" AND ")) };
        let total: i64 = self
            .db
            .query_row(&format!("SELECT COUNT(*) FROM drives {clause}"), params_from_iter(binds.iter()), |r| r.get(0))?;
        let mut stmt = self.db.prepare(&format!(
            "SELECT summary FROM drives {clause} ORDER BY start_time DESC, id DESC LIMIT {limit} OFFSET {offset}"
        ))?;
        let rows = stmt.query_map(params_from_iter(binds.iter()), |r| r.get::<_, String>(0))?;
        let mut drives = Vec::new();
        for row in rows {
            drives.push(serde_json::from_str::<Value>(&row?)?);
        }
        Ok(json!({ "total": total, "offset": offset, "limit": limit, "drives": drives }))
    }

    pub fn get_drive_detail(&self, id: i64, max_points: f64) -> Result<Option<Value>> {
        let raw: Option<Vec<u8>> = self
            .db
            .query_row("SELECT detail FROM drives WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        let Some(raw) = raw else { return Ok(None) };
        let mut detail: Map<String, Value> = serde_json::from_slice(&raw)?;
        let full = detail.get("points").and_then(Value::as_array).map_or(0, Vec::len);
        let budget = (if max_points.is_finite() && max_points != 0.0 { max_points } else { 200_000.0 }).clamp(2.0, 200_000.0) as usize;
        if full <= budget {
            detail.insert("fullPointCount".into(), json!(full));
            detail.insert("displayPointCount".into(), json!(full));
            detail.insert("downsampled".into(), json!(false));
            return Ok(Some(Value::Object(detail)));
        }
        let step = (full - 1) as f64 / (budget - 1) as f64;
        let indices: Vec<usize> = (0..budget).map(|i| calc::js_round(i as f64 * step) as usize).collect();
        for key in ["points", "fsdStates", "gearStates"] {
            if let Some(Value::Array(values)) = detail.get(key) {
                let picked: Vec<Value> = indices.iter().map(|&i| values.get(i).cloned().unwrap_or(Value::Null)).collect();
                detail.insert(key.into(), Value::Array(picked));
            }
        }
        detail.insert("fullPointCount".into(), json!(full));
        detail.insert("displayPointCount".into(), json!(indices.len()));
        detail.insert("downsampled".into(), json!(true));
        Ok(Some(Value::Object(detail)))
    }

    pub fn list_charging_sites(&self) -> Result<Vec<Value>> {
        let mut stmt = self.db.prepare("SELECT summary FROM charging_sites ORDER BY visit_count DESC, latest_visit DESC, site_id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn list_charging_sessions(&self, site_id: &str) -> Result<Vec<Value>> {
        let mut stmt = self.db.prepare(
            "SELECT summary FROM charging_sessions WHERE site_id = ?1 ORDER BY start_timestamp DESC, session_id DESC",
        )?;
        let rows = stmt.query_map([site_id], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn get_charging_session(&self, session_id: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT detail FROM charging_sessions WHERE session_id = ?1", [session_id], |r| r.get(0))
            .optional()?;
        Ok(raw.map(|s| serde_json::from_str(&s)).transpose()?)
    }

    /// Keep tag filtering consistent with an in-session tag edit.
    pub fn set_drive_tags(&self, start_time: &str, tags: &[Value]) -> Result<()> {
        let summary: Option<String> = self
            .db
            .query_row("SELECT summary FROM drives WHERE start_time = ?1", [start_time], |r| r.get(0))
            .optional()?;
        let is_summon = summary
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("summon").and_then(Value::as_bool))
            .unwrap_or(false);
        let mut filter = tags.to_vec();
        if is_summon {
            filter.push(json!("summon"));
        }
        self.db.execute("UPDATE drives SET tags = ?1 WHERE start_time = ?2", params![encode_tag_set(&filter), start_time])?;
        let mut all = self.drive_tags()?;
        if tags.is_empty() {
            all.remove(start_time);
        } else {
            all.insert(start_time.into(), Value::Array(tags.to_vec()));
        }
        self.set_meta("driveTags", &Value::Object(all))
    }

    pub fn delete_drives_by_start_times(&self, start_times: &[String]) -> Result<u64> {
        let mut deleted = 0;
        let mut tags = self.drive_tags()?;
        let mut changed = false;
        for st in start_times {
            deleted += self.db.execute("DELETE FROM drives WHERE start_time = ?1", [st])? as u64;
            if tags.remove(st).is_some() {
                changed = true;
            }
        }
        if changed {
            self.set_meta("driveTags", &Value::Object(tags))?;
        }
        Ok(deleted)
    }

    /// Route files and summaries of the drives that start at the given times.
    pub fn drives_by_start_times(&self, start_times: &[String]) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut stmt = self.db.prepare("SELECT summary FROM drives WHERE start_time = ?1")?;
        for st in start_times {
            let rows = stmt.query_map([st], |r| r.get::<_, String>(0))?;
            for row in rows {
                out.push(serde_json::from_str(&row?)?);
            }
        }
        Ok(out)
    }
}

// ── Index build ─────────────────────────────────────────────────────────────
//
// A byte scanner splits drive-data.json into its top-level sections and the
// routes array into raw elements (which also gives exact byte progress).
// Batches of elements are parsed in parallel with serde's fast slice parser,
// then inserted strictly in file order, so duplicate handling (first
// occurrence wins) and `sequence` match the JS token reader exactly.

const ROUTE_BATCH: usize = 1024;

/// Map `f` over `items` on all cores, preserving order.
pub fn parallel_map<T: Send, R: Send>(items: Vec<T>, f: impl Fn(T) -> R + Sync) -> Vec<R> {
    // Leave a core for the UI and the rest of the system.
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).saturating_sub(1).max(1);
    if items.len() < 2 || threads < 2 {
        return items.into_iter().map(f).collect();
    }
    let per = items.len().div_ceil(threads);
    let mut chunks: Vec<Vec<T>> = Vec::new();
    let mut it = items.into_iter();
    loop {
        let c: Vec<T> = it.by_ref().take(per).collect();
        if c.is_empty() {
            break;
        }
        chunks.push(c);
    }
    let f = &f;
    std::thread::scope(|s| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|c| s.spawn(move || c.into_iter().map(f).collect::<Vec<R>>()))
            .collect();
        handles.into_iter().flat_map(|h| h.join().expect("loader worker panicked")).collect()
    })
}

enum Parsed {
    Route { normalized: String, ts: i64, payload: Vec<u8> },
    Dropped,
    Skip,
}

fn invalid(e: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("drive-data.json is not valid JSON: {e}")
}

fn prepare_route(el: &[u8]) -> Result<Parsed> {
    if el.first() != Some(&b'{') {
        // Non-object elements are skipped, like the JS token reader does.
        serde_json::from_slice::<IgnoredAny>(el).map_err(invalid)?;
        return Ok(Parsed::Skip);
    }
    let mut route = serde_json::from_slice::<RouteJson>(el).map_err(invalid)?.into_route();
    let normalized = normalize_clip_path(&route.file);
    if normalized.is_empty() {
        return Ok(Parsed::Dropped);
    }
    let Some(ts) = parse_clip_timestamp_ms(&normalized) else { return Ok(Parsed::Dropped) };
    route.file = normalized.clone();
    Ok(Parsed::Route { normalized, ts, payload: postcard::to_stdvec(&route)? })
}

/// Stream drive-data.json into the index. Mirrors `indexDriveData`.
pub fn index_drive_data(index: &DriveIndex, progress: ProgressFn, cancel: &AtomicBool) -> Result<Counts> {
    let mut file = File::open(&index.source_path).with_context(|| format!("open {}", index.source_path.display()))?;
    let total = file.metadata()?.len();
    progress(Progress { phase: "reading", current: 0, total });
    let sections = scan_sections(file.try_clone()?).map_err(invalid)?;

    index.db.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<Counts> {
        let mut insert = index.db.prepare(
            "INSERT OR IGNORE INTO routes (sequence, normalized_file, timestamp_ms, payload) VALUES (?1, ?2, ?3, ?4)",
        )?;
        let mut counts = Counts::default();
        let mut sequence: i64 = 0;
        let (mut drive_tags, mut charge_costs, mut charge_tags) = (json!({}), json!({}), json!({}));
        let mut charging = ChargingSessionBuilder::new();
        let mut last_emit = Instant::now();

        for section in &sections {
            if cancel.load(Ordering::Relaxed) {
                return Err(canceled());
            }
            match section.key.as_str() {
                "processedFiles" => {
                    for_each_array_element(&mut file, section, |el| {
                        if el.first() == Some(&b'"') {
                            counts.processed_file_count += 1;
                        }
                        Ok(())
                    })?;
                }
                "routes" => {
                    let mut batch: Vec<Vec<u8>> = Vec::with_capacity(ROUTE_BATCH);
                    let mut consumed = section.start;
                    let mut flush = |batch: Vec<Vec<u8>>| -> Result<()> {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(canceled());
                        }
                        for parsed in parallel_map(batch, |el| prepare_route(&el)) {
                            match parsed? {
                                Parsed::Skip => {}
                                Parsed::Dropped => {
                                    sequence += 1;
                                    counts.dropped_count += 1;
                                }
                                Parsed::Route { normalized, ts, payload } => {
                                    let n = insert.execute(params![sequence, normalized, ts, payload])?;
                                    sequence += 1;
                                    if n == 1 {
                                        counts.route_count += 1;
                                    } else {
                                        counts.duplicate_count += 1;
                                    }
                                }
                            }
                        }
                        Ok(())
                    };
                    for_each_array_element(&mut file, section, |el| {
                        consumed += el.len() as u64 + 1;
                        batch.push(el.to_vec());
                        if batch.len() >= ROUTE_BATCH {
                            flush(std::mem::replace(&mut batch, Vec::with_capacity(ROUTE_BATCH)))?;
                            if last_emit.elapsed().as_millis() >= 100 {
                                last_emit = Instant::now();
                                progress(Progress { phase: "reading", current: consumed.min(total), total });
                            }
                        }
                        Ok(())
                    })?;
                    flush(batch)?;
                }
                "telemetrySamples" => {
                    for_each_array_element(&mut file, section, |el| {
                        if el.first() == Some(&b'{') {
                            charging.add(&serde_json::from_slice::<Value>(el).map_err(invalid)?);
                        }
                        Ok(())
                    })?;
                }
                key @ ("driveTags" | "chargeCosts" | "chargeTags") => {
                    let v: Value = serde_json::from_slice(&read_range(&mut file, section)?).map_err(invalid)?;
                    if v.is_object() {
                        match key {
                            "driveTags" => drive_tags = v,
                            "chargeCosts" => charge_costs = v,
                            _ => charge_tags = v,
                        }
                    }
                }
                _ => {}
            }
        }
        let history = group_charging_sites(charging.finish(&charge_costs, &charge_tags));
        put_charging_history(index, &history)?;
        counts.charging_session_count = history.sessions.len() as u64;
        counts.charging_site_count = history.sites.len() as u64;
        index.set_meta("counts", &serde_json::to_value(&counts)?)?;
        index.set_meta("driveTags", &drive_tags)?;
        Ok(counts)
    })();
    match result {
        Ok(counts) => {
            index.db.execute_batch("COMMIT")?;
            progress(Progress { phase: "reading", current: total, total });
            Ok(counts)
        }
        Err(e) => {
            let _ = index.db.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn put_charging_history(index: &DriveIndex, h: &super::charging::ChargingHistory) -> Result<()> {
    let mut site_stmt = index
        .db
        .prepare("INSERT INTO charging_sites(site_id, visit_count, latest_visit, summary) VALUES (?1, ?2, ?3, ?4)")?;
    for site in &h.sites {
        site_stmt.execute(params![
            site.get("siteId").and_then(Value::as_str),
            site.get("visitCount").and_then(Value::as_i64),
            site.get("latestVisit").and_then(Value::as_str),
            Value::Object(site.clone()).to_string(),
        ])?;
    }
    let mut sess_stmt = index.db.prepare(
        "INSERT INTO charging_sessions(session_id, site_id, start_timestamp, summary, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for s in &h.sessions {
        let detail = Value::Object(s.fields.clone());
        let mut summary = s.fields.clone();
        summary.remove("chargeRateSamples");
        sess_stmt.execute(params![
            s.fields.get("sessionId").and_then(Value::as_str),
            s.site_id,
            s.start_timestamp,
            Value::Object(summary).to_string(),
            detail.to_string(),
        ])?;
    }
    Ok(())
}

// ── Windowed grouping ───────────────────────────────────────────────────────

fn downsample_overview(points: &[[f64; 4]], max: usize) -> Vec<[f64; 2]> {
    if points.is_empty() {
        return Vec::new();
    }
    if points.len() <= max {
        return points.iter().map(|p| [p[0], p[1]]).collect();
    }
    let step = (points.len() - 1) as f64 / (max - 1) as f64;
    (0..max)
        .map(|i| {
            let p = points[calc::js_round(i as f64 * step) as usize];
            [p[0], p[1]]
        })
        .collect()
}

pub fn group_indexed_drives(index: &DriveIndex, progress: ProgressFn, cancel: &AtomicBool) -> Result<Value> {
    let counts: Counts = index
        .get_meta("counts")?
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    let drive_tags = index.drive_tags()?;
    index.db.execute_batch("DELETE FROM drives; BEGIN")?;

    let mut next_id: i64 = 0;
    let mut time_group_count = 0usize;
    let mut route_count = 0usize;
    let mut grouper_dropped = 0usize;

    struct Prepared {
        start_time: String,
        source: String,
        tag_set: String,
        summary: Map<String, Value>,
        detail: Vec<u8>,
    }
    // Windows are independent: group and encode them on all cores, then assign
    // ids and insert in time order.
    let prepare_window = |payloads: Vec<Vec<u8>>| -> Result<(usize, usize, usize, Vec<Prepared>)> {
        let routes = payloads.iter().map(|p| postcard::from_bytes(p)).collect::<Result<Vec<Route>, _>>()?;
        drop(payloads);
        let grouped = group_into_drives(routes);
        let mut out = Vec::with_capacity(grouped.drives.len());
        for d in grouped.drives {
            let mut detail = Map::new();
            detail.insert("points".into(), json!(d.points));
            if let Some(v) = &d.fsd_states {
                detail.insert("fsdStates".into(), json!(v));
            }
            if let Some(v) = &d.gear_states {
                detail.insert("gearStates".into(), json!(v));
            }
            if let Some(v) = &d.fsd_events {
                detail.insert("fsdEvents".into(), json!(v));
            }
            let tags: Vec<Value> = drive_tags.get(&d.start_time).and_then(Value::as_array).cloned().unwrap_or_default();
            let mut summary = d.fields;
            summary.insert("tags".into(), Value::Array(tags.clone()));
            summary.insert("bridged".into(), json!(d.route_files.iter().any(|f| f.contains("-front-bridge.mp4"))));
            summary.insert("overviewPoints".into(), json!(downsample_overview(&d.points, 120)));
            let mut filter_tags = tags;
            if d.summon {
                filter_tags.push(json!("summon"));
            }
            out.push(Prepared {
                start_time: d.start_time,
                source: d.source,
                tag_set: encode_tag_set(&filter_tags),
                summary,
                detail: serde_json::to_vec(&Value::Object(detail))?,
            });
        }
        Ok((grouped.time_group_count, grouped.route_count, grouped.dropped_count, out))
    };

    let result = (|| -> Result<()> {
        let mut insert = index
            .db
            .prepare("INSERT INTO drives(id, start_time, source, tags, summary, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
        let mut stmt = index.db.prepare("SELECT timestamp_ms, payload FROM routes ORDER BY timestamp_ms, sequence")?;
        let mut rows = stmt.query([])?;
        let mut window: Vec<Vec<u8>> = Vec::new();
        let mut pending: Vec<Vec<Vec<u8>>> = Vec::new();
        let mut pending_routes = 0usize;
        let mut previous: Option<i64> = None;

        let mut flush = |pending: Vec<Vec<Vec<u8>>>| -> Result<()> {
            if cancel.load(Ordering::Relaxed) {
                return Err(canceled());
            }
            for r in parallel_map(pending, prepare_window) {
                let (tg, rc, dc, drives) = r?;
                time_group_count += tg;
                route_count += rc;
                grouper_dropped += dc;
                for p in drives {
                    let id = next_id;
                    next_id += 1;
                    let mut summary = Map::new();
                    summary.insert("id".into(), json!(id));
                    summary.extend(p.summary);
                    insert.execute(params![id, p.start_time, p.source, p.tag_set, Value::Object(summary).to_string(), p.detail])?;
                }
            }
            progress(Progress { phase: "grouping", current: route_count as u64, total: counts.route_count });
            Ok(())
        };

        while let Some(row) = rows.next()? {
            let ts: i64 = row.get(0)?;
            if let Some(prev) = previous {
                if ts - prev > calc::GAP_FILL_MAX_MS {
                    pending_routes += window.len();
                    pending.push(std::mem::take(&mut window));
                    if pending_routes >= 4096 {
                        flush(std::mem::take(&mut pending))?;
                        pending_routes = 0;
                    }
                }
            }
            window.push(row.get(1)?);
            previous = Some(ts);
        }
        if !window.is_empty() {
            pending.push(window);
        }
        if !pending.is_empty() {
            flush(pending)?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = index.db.execute_batch("ROLLBACK");
        return Err(e);
    }

    // Aggregates over every grouped drive (before imported duplicates are hidden).
    let mut agg = Map::new();
    let (mut total_mi, mut total_ms, mut sei_m, mut fsd_m, mut auto_m, mut tacc_m) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut diseng, mut pushes, mut fsd_ms, mut fsd_pct_sum) = (0.0, 0.0, 0.0, 0.0);
    let (mut sei_count, mut imported_count, mut summon_count) = (0u64, 0u64, 0u64);
    let mut sei_ranges: Vec<(i64, i64)> = Vec::new();
    let mut imported: Vec<(i64, Value)> = Vec::new();
    {
        let mut stmt = index.db.prepare("SELECT id, summary FROM drives ORDER BY start_time DESC, id DESC")?;
        let mut rows = stmt.query([])?;
        let f = |d: &Value, k: &str| d.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let d: Value = serde_json::from_str(&row.get::<_, String>(1)?)?;
            total_mi += f(&d, "distanceMi");
            total_ms += f(&d, "durationMs");
            let source = d.get("source").and_then(Value::as_str).unwrap_or("");
            if d.get("summon").and_then(Value::as_bool).unwrap_or(false) {
                summon_count += 1;
            } else if source == "sei" {
                let s = d.get("startTime").and_then(Value::as_str).and_then(parse_local_iso);
                let e = d.get("endTime").and_then(Value::as_str).and_then(parse_local_iso);
                if let (Some(s), Some(e)) = (s, e) {
                    if e > s {
                        sei_ranges.push((s, e));
                    }
                }
                sei_count += 1;
                sei_m += f(&d, "distanceKm") * 1000.0;
                fsd_m += f(&d, "fsdDistanceKm") * 1000.0;
                auto_m += f(&d, "autosteerDistanceKm") * 1000.0;
                tacc_m += f(&d, "taccDistanceKm") * 1000.0;
                diseng += f(&d, "fsdDisengagements");
                pushes += f(&d, "fsdAccelPushes");
                fsd_ms += f(&d, "fsdEngagedMs");
                fsd_pct_sum += f(&d, "fsdPercent");
            } else {
                imported_count += 1;
            }
            if source != "sei" {
                imported.push((id, d));
            }
        }
    }
    agg.insert("totalDriveCount".into(), json!(next_id));
    agg.insert("totalDistanceMi".into(), json!(total_mi));
    agg.insert("totalDurationMs".into(), json!(total_ms));
    agg.insert("seiDistanceM".into(), json!(sei_m));
    agg.insert("fsdDistanceM".into(), json!(fsd_m));
    agg.insert("autosteerDistanceM".into(), json!(auto_m));
    agg.insert("taccDistanceM".into(), json!(tacc_m));
    agg.insert("fsdDisengagements".into(), json!(diseng));
    agg.insert("fsdAccelPushes".into(), json!(pushes));
    agg.insert("fsdEngagedMs".into(), json!(fsd_ms));
    agg.insert("fsdPercentSum".into(), json!(fsd_pct_sum));
    agg.insert("seiDriveCount".into(), json!(sei_count));
    agg.insert("importedDriveCount".into(), json!(imported_count));
    agg.insert("summonDriveCount".into(), json!(summon_count));
    sei_ranges.sort_by_key(|r| r.0);
    let aggregates = Value::Object(agg);
    index.set_meta("aggregates", &aggregates)?;

    // Hide imported drives that overlap dashcam footage.
    let mut hidden_ids = Vec::new();
    let mut hidden = Vec::new();
    for (id, d) in imported {
        let s = d.get("startTime").and_then(Value::as_str).and_then(parse_local_iso);
        let e = d.get("endTime").and_then(Value::as_str).and_then(parse_local_iso);
        let (Some(s), Some(e)) = (s, e) else { continue };
        if e <= s {
            continue;
        }
        let mut overlaps = false;
        for &(rs, re) in &sei_ranges {
            if re <= s {
                continue;
            }
            if rs >= e {
                break;
            }
            overlaps = true;
            break;
        }
        if !overlaps {
            continue;
        }
        hidden_ids.push(id);
        hidden.push(json!({
            "startTime": d.get("startTime"),
            "endTime": d.get("endTime"),
            "distanceMi": d.get("distanceMi"),
            "source": d.get("source"),
        }));
    }
    for id in &hidden_ids {
        index.db.execute("DELETE FROM drives WHERE id = ?1", [id])?;
    }
    index.db.execute_batch("COMMIT")?;

    let mut out = serde_json::to_value(&counts)?.as_object().cloned().unwrap_or_default();
    out.insert("totalRoutes".into(), json!(counts.route_count));
    out.insert("totalDriveCount".into(), json!(next_id - hidden_ids.len() as i64));
    out.insert("groupedDriveCount".into(), json!(next_id));
    out.insert("timeGroupCount".into(), json!(time_group_count));
    out.insert("routeCount".into(), json!(route_count));
    out.insert("droppedCount".into(), json!(counts.dropped_count + grouper_dropped as u64));
    out.insert("driveTags".into(), Value::Object(drive_tags));
    out.insert("hiddenTessieCount".into(), json!(hidden_ids.len()));
    out.insert("hiddenTessieDrives".into(), Value::Array(hidden));
    out.insert("aggregates".into(), aggregates);
    Ok(Value::Object(out))
}

/// Hand every time window of indexed routes (split where consecutive clips are
/// more than GAP_FILL_MAX apart, exactly as `group_indexed_drives` does) to
/// `each`. Grouping a window gives the same drives as grouping every route at
/// once, without holding the whole file in memory.
pub fn for_each_route_window(index: &DriveIndex, mut each: impl FnMut(Vec<Route>) -> Result<()>) -> Result<()> {
    let mut stmt = index.db.prepare("SELECT timestamp_ms, payload FROM routes ORDER BY timestamp_ms, sequence")?;
    let mut rows = stmt.query([])?;
    let mut window: Vec<Route> = Vec::new();
    let mut previous: Option<i64> = None;
    while let Some(row) = rows.next()? {
        let ts: i64 = row.get(0)?;
        if previous.is_some_and(|prev| ts - prev > calc::GAP_FILL_MAX_MS) {
            each(std::mem::take(&mut window))?;
        }
        let payload: Vec<u8> = row.get(1)?;
        window.push(postcard::from_bytes(&payload)?);
        previous = Some(ts);
    }
    if !window.is_empty() {
        each(window)?;
    }
    Ok(())
}

/// Index and windowed-grouping tests, against temp directories holding
/// small drive-data.json files. Drive start times are local wall-clock
/// strings derived from clip names, so the assertions hold in any zone.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fixture {
        dir: PathBuf,
        index: DriveIndex,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(doc: &Value) -> Fixture {
        let dir = std::env::temp_dir().join(format!("sd-index-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("drive-data.json");
        std::fs::write(&source, doc.to_string()).unwrap();
        let index = DriveIndex::create(&dir.join("index.sqlite"), &source).unwrap();
        Fixture { dir, index }
    }

    fn no_progress() -> impl Fn(Progress) + Sync {
        |_| {}
    }

    fn index_all(f: &Fixture) -> Counts {
        index_drive_data(&f.index, &no_progress(), &AtomicBool::new(false)).unwrap()
    }

    fn group_all(f: &Fixture) -> Value {
        group_indexed_drives(&f.index, &no_progress(), &AtomicBool::new(false)).unwrap()
    }

    fn total(f: &Fixture, query: Value) -> i64 {
        f.index.list_drive_summaries(&query).unwrap()["total"].as_i64().unwrap()
    }

    // ── Index ───────────────────────────────────────────────────────────────

    fn index_fixture() -> Value {
        let route = |file: &str, lat: f64| {
            json!({
                "file": file,
                "date": &file[file.len() - 29..file.len() - 10],
                "points": [[lat, -76.7], [lat + 0.001, -76.701]],
                "speeds": [1, 2],
            })
        };
        json!({
            "driveTags": { "2026-07-28T10:00:00": ["Work", "Unicode ✓"] },
            "routes": [
                route("RecentClips/2026-07-28/2026-07-28_10-00-00-front.mp4", 39.1),
                route("RecentClips\\2026-07-28\\2026-07-28_10-00-00-front.mp4", 39.2),
                route("2026-07-28/2026-07-28_10-00-00-front.mp4", 39.25),
                route("SavedClips/2026-07-28_10-30-00/2026-07-28_10-01-00-front.mp4", 39.3),
                route("RecentClips/2026-07-28/2026-07-28_11-00-00-front.mp4", 39.4),
            ],
            "processedFiles": ["one.mp4", "two.mp4"],
        })
    }

    #[test]
    fn indexes_routes_with_normalized_dedup_and_bounded_time_windows() {
        let f = fixture(&index_fixture());
        let counts = index_all(&f);
        assert_eq!(
            serde_json::to_value(&counts).unwrap(),
            json!({
                "processedFileCount": 2, "routeCount": 3, "droppedCount": 0,
                "duplicateCount": 2, "chargingSessionCount": 0, "chargingSiteCount": 0,
            })
        );
        // Windows split at GAP_FILL_MAX_MS, not at a fillable recording gap.
        let mut windows: Vec<Vec<String>> = Vec::new();
        for_each_route_window(&f.index, |w| {
            windows.push(w.into_iter().map(|r| r.file).collect());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            windows,
            vec![
                vec![
                    "2026-07-28/2026-07-28_10-00-00-front.mp4".to_string(),
                    "SavedClips/2026-07-28_10-30-00/2026-07-28_10-01-00-front.mp4".to_string(),
                ],
                vec!["2026-07-28/2026-07-28_11-00-00-front.mp4".to_string()],
            ]
        );
        assert_eq!(Value::Object(f.index.drive_tags().unwrap()), json!({ "2026-07-28T10:00:00": ["Work", "Unicode ✓"] }));
    }

    #[test]
    fn reports_progress_and_cancellation_without_partial_success() {
        let f = fixture(&index_fixture());
        let cancel = AtomicBool::new(false);
        let calls = Mutex::new(Vec::new());
        let progress = |p: Progress| {
            calls.lock().unwrap().push((p.current, p.total));
            cancel.store(true, Ordering::Relaxed);
        };
        let err = index_drive_data(&f.index, &progress, &cancel).err().expect("canceled");
        assert!(format!("{err:#}").contains("ABORT_ERR"), "{err:#}");
        assert!(!calls.lock().unwrap().is_empty());
        // Rolled back: nothing from the partial run is visible.
        let routes: i64 = f.index.db.query_row("SELECT COUNT(*) FROM routes", [], |r| r.get(0)).unwrap();
        assert_eq!(routes, 0);
        assert!(f.index.get_meta("counts").unwrap().is_none());
    }

    #[test]
    fn indexes_charging_summaries_separately_from_detailed_curve_samples() {
        let f = fixture(&json!({
            "processedFiles": [],
            "routes": [],
            "driveTags": {},
            "telemetrySamples": [
                { "ts": 1_000, "lat": 40, "lng": -76, "locationName": "North charger", "batteryPct": 10 },
                { "ts": 1_010, "chargingState": "charging", "chargeEnergyAddedKwh": 0.1 },
                { "ts": 1_020, "chargerPowerKw": 50, "chargeRateMph": 220, "chargeEnergyAddedKwh": 2, "batteryPct": 25 },
                { "ts": 1_030, "chargingState": "complete", "batteryPct": 30 },
                { "ts": 2_000, "lat": 40.0006, "lng": -76.0004, "locationName": "North charger" },
                { "ts": 2_010, "chargingState": "charging", "chargeEnergyAddedKwh": 1 },
                { "ts": 2_020, "chargingState": "stopped" },
                { "ts": 3_000, "chargingState": "charging", "chargeEnergyAddedKwh": 3 },
                { "ts": 3_010, "chargingState": "complete" },
            ],
            "chargeCosts": { "1010": { "amount": 4.5, "currency": "$" } },
        }));
        let counts = index_all(&f);
        assert_eq!(counts.charging_session_count, 3);
        assert_eq!(counts.charging_site_count, 2);

        let sites: Vec<(String, i64)> = f
            .index
            .list_charging_sites()
            .unwrap()
            .iter()
            .map(|s| (s["siteId"].as_str().unwrap().to_string(), s["visitCount"].as_i64().unwrap()))
            .collect();
        assert_eq!(sites, vec![("site-charge-1010-1".to_string(), 2), ("unknown".to_string(), 1)]);

        let summaries = f.index.list_charging_sessions("site-charge-1010-1").unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0]["sessionId"], "charge-2010-2");
        assert!(summaries[0].get("chargeRateSamples").is_none());

        let detail = f.index.get_charging_session("charge-1010-1").unwrap().unwrap();
        assert_eq!(detail["cost"]["amount"].as_f64(), Some(4.5));
        assert_eq!(detail["chargeRateSamples"].as_array().unwrap().len(), 2);
        assert!(f.index.get_charging_session("missing").unwrap().is_none());
    }

    /// Insert one drive row directly: the synthetic Summon tag lives only in
    /// the filter column (group_indexed_drives does the same inline).
    fn put_drive(index: &DriveIndex, id: i64, start_time: &str, tags: &[&str], summon: bool) {
        let tags: Vec<Value> = tags.iter().map(|t| json!(t)).collect();
        let mut filter = tags.clone();
        let mut summary = json!({ "id": id, "startTime": start_time, "source": "sei", "tags": tags });
        if summon {
            filter.push(json!("summon"));
            summary["summon"] = json!(true);
        }
        index
            .db
            .execute(
                "INSERT INTO drives(id, start_time, source, tags, summary, detail) VALUES (?1, ?2, 'sei', ?3, ?4, ?5)",
                params![id, start_time, encode_tag_set(&filter), summary.to_string(), br#"{"points":[]}"#.to_vec()],
            )
            .unwrap();
    }

    #[test]
    fn list_drive_summaries_filters_by_tag_and_inclusive_date_range() {
        let f = fixture(&json!({}));
        put_drive(&f.index, 1, "2026-07-10T08:00:00", &["Home"], false);
        put_drive(&f.index, 2, "2026-07-15T09:30:00", &["Work", "Road Trip"], false);
        put_drive(&f.index, 3, "2026-07-15T18:00:00", &[], false);
        put_drive(&f.index, 4, "2026-07-20T12:00:00", &["home"], false);

        assert_eq!(total(&f, json!({})), 4);
        // Whole-tag matching is case-insensitive and rejects substrings.
        assert_eq!(total(&f, json!({ "tag": "Home" })), 2);
        assert_eq!(total(&f, json!({ "tag": "work" })), 1);
        assert_eq!(total(&f, json!({ "tag": "Road Trip" })), 1);
        assert_eq!(total(&f, json!({ "tag": "o" })), 0);

        assert_eq!(total(&f, json!({ "startDate": "2026-07-15" })), 3);
        assert_eq!(total(&f, json!({ "endDate": "2026-07-15" })), 3);
        assert_eq!(total(&f, json!({ "startDate": "2026-07-15", "endDate": "2026-07-15" })), 2);
        assert_eq!(total(&f, json!({ "startDate": "2026-07-16", "endDate": "2026-07-19" })), 0);

        let combo = f.index.list_drive_summaries(&json!({ "tag": "home", "startDate": "2026-07-11" })).unwrap();
        assert_eq!(combo["total"], json!(1));
        assert_eq!(combo["drives"][0]["id"], json!(4));
    }

    #[test]
    fn set_drive_tags_keeps_tag_filtering_truthful_after_an_edit() {
        let f = fixture(&json!({}));
        put_drive(&f.index, 1, "2026-07-15T09:30:00", &[], false);
        assert_eq!(total(&f, json!({ "tag": "errand" })), 0);

        f.index.set_drive_tags("2026-07-15T09:30:00", &[json!("Errand")]).unwrap();
        assert_eq!(total(&f, json!({ "tag": "errand" })), 1);
        assert_eq!(Value::Object(f.index.drive_tags().unwrap()), json!({ "2026-07-15T09:30:00": ["Errand"] }));

        f.index.set_drive_tags("2026-07-15T09:30:00", &[]).unwrap();
        assert_eq!(total(&f, json!({ "tag": "errand" })), 0);
        assert!(f.index.drive_tags().unwrap().is_empty());
    }

    #[test]
    fn summon_drives_filter_via_the_synthetic_tag_and_survive_tag_edits() {
        let f = fixture(&json!({}));
        put_drive(&f.index, 1, "2026-07-15T20:49:56", &[], true);
        put_drive(&f.index, 2, "2026-07-15T21:00:00", &["Work"], false);

        let page = f.index.list_drive_summaries(&json!({ "tag": "summon" })).unwrap();
        assert_eq!(page["total"], json!(1));
        assert_eq!(page["drives"][0]["id"], json!(1));
        assert_eq!(page["drives"][0]["tags"], json!([]));

        f.index.set_drive_tags("2026-07-15T20:49:56", &[json!("Errand")]).unwrap();
        assert_eq!(total(&f, json!({ "tag": "summon" })), 1);
        assert_eq!(total(&f, json!({ "tag": "Errand" })), 1);

        f.index.set_drive_tags("2026-07-15T21:00:00", &[]).unwrap();
        assert_eq!(total(&f, json!({ "tag": "summon" })), 1);
    }

    // ── Windowed grouping ───────────────────────────────────────────────────

    fn route(file: &str, lat: f64, extra: Value) -> Value {
        let date = regex::Regex::new(r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}").unwrap().find(file).map(|m| m.as_str().to_string());
        let mut r = json!({
            "file": file,
            "points": [[lat, -76.7], [lat + 0.001, -76.701], [lat + 0.002, -76.702]],
            "speeds": [1, 2, 3],
        });
        if let Some(d) = date {
            r["date"] = json!(d);
        }
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            r[k] = v;
        }
        r
    }

    fn doc(routes: &[Value], drive_tags: Value) -> Value {
        json!({ "processedFiles": [], "routes": routes, "driveTags": drive_tags })
    }

    /// What the in-memory grouper produces for the same routes. The routes go
    /// through JSON text first, as the indexed copy does: without serde_json's
    /// `float_roundtrip` feature a 17-digit literal such as 39.102000000000004
    /// can parse one ULP away from the f64 that produced it (JSON.parse is
    /// exact), so comparing against the in-memory values would differ there.
    fn expected_drives(routes: &[Value]) -> Vec<super::super::grouper::GroupedDrive> {
        let parsed = routes
            .iter()
            .map(|r| serde_json::from_str::<RouteJson>(&r.to_string()).unwrap().into_route())
            .collect();
        group_into_drives(parsed).drives
    }

    fn listed(f: &Fixture) -> Value {
        f.index.list_drive_summaries(&json!({ "offset": 0, "limit": 10 })).unwrap()
    }

    #[test]
    fn disk_grouping_preserves_grouper_summaries_and_stores_detail_separately() {
        let routes = vec![
            route("RecentClips/2026-07-28_10-00-00-front.mp4", 39.1, json!({})),
            route("RecentClips/2026-07-28_10-01-00-front.mp4", 39.2, json!({})),
            route("RecentClips/2026-07-28_11-00-00-front.mp4", 39.4, json!({})),
        ];
        let expected = expected_drives(&routes);
        let f = fixture(&doc(&routes, json!({ expected[0].start_time.clone(): ["Morning"] })));
        index_all(&f);
        let result = group_all(&f);
        let page = listed(&f);

        assert_eq!(result["totalDriveCount"], json!(expected.len()));
        assert_eq!(page["total"], json!(expected.len()));
        let mut by_id = page["drives"].as_array().unwrap().clone();
        by_id.sort_by_key(|d| d["id"].as_i64().unwrap());
        for (i, (got, want)) in by_id.iter().zip(&expected).enumerate() {
            let mut got = got.as_object().unwrap().clone();
            assert_eq!(got.remove("id"), Some(json!(i)));
            for k in ["overviewPoints", "tags", "bridged"] {
                got.remove(k);
            }
            assert_eq!(Value::Object(got), Value::Object(want.fields.clone()), "drive {i}");
        }
        assert_eq!(by_id[0]["tags"], json!(["Morning"]));
        assert!(by_id.iter().all(|d| d["overviewPoints"].as_array().unwrap().len() <= 120));

        let detail = f.index.get_drive_detail(0, 1000.0).unwrap().unwrap();
        assert_eq!(detail["points"], json!(expected[0].points));
        assert_eq!(detail["downsampled"], json!(false));
        assert_eq!(detail["fullPointCount"], json!(expected[0].points.len()));
    }

    #[test]
    fn disk_grouping_preserves_driving_savedclips_that_fill_a_manual_save_gap() {
        let mut routes = vec![route("2026-07-27/2026-07-27_14-01-02-front.mp4", 39.0, json!({}))];
        let saved = [
            "14-02-02", "14-03-02", "14-04-03", "14-05-03", "14-06-03", "14-07-03", "14-08-04", "14-09-04", "14-10-04",
            "14-11-04", "14-12-05",
        ];
        for (i, time) in saved.iter().enumerate() {
            routes.push(route(
                &format!("SavedClips/2026-07-27_14-12-29/2026-07-27_{time}-front.mp4"),
                39.001 + i as f64 * 0.001,
                json!({}),
            ));
        }
        routes.push(route("2026-07-27/2026-07-27_14-12-26-front.mp4", 39.013, json!({})));
        let f = fixture(&doc(&routes, json!({})));
        index_all(&f);
        let result = group_all(&f);
        let page = listed(&f);

        assert_eq!(result["totalRoutes"], json!(13));
        assert_eq!(result["routeCount"], json!(13));
        assert_eq!(result["totalDriveCount"], json!(1));
        assert_eq!(page["total"], json!(1));
        let files = page["drives"][0]["routeFiles"].as_array().unwrap();
        assert_eq!(files.len(), 13);
        assert_eq!(files.iter().filter(|f| f.as_str().unwrap().starts_with("SavedClips/")).count(), 11);
    }

    #[test]
    fn disk_grouping_hides_imported_drives_overlapping_sei_while_keeping_stable_ids() {
        let routes = vec![
            route("RecentClips/2026-07-28_10-00-00-front.mp4", 39.1, json!({})),
            route(
                "Imported/2026-07-28_10-00-00-front.mp4",
                39.2,
                json!({
                    "source": "tessie", "externalSignature": "tessie:overlap",
                    "points": [[39.2, -76.7], [39.2, -76.7]], "speeds": [1, 1],
                }),
            ),
            route(
                "Imported/2026-07-28_10-01-00-front.mp4",
                39.3,
                json!({ "source": "teslascope", "externalSignature": "teslascope:touching" }),
            ),
            route(
                "Imported/2026-07-28_11-00-00-front.mp4",
                39.4,
                json!({ "source": "tessie", "externalSignature": "tessie:later" }),
            ),
        ];
        let f = fixture(&doc(&routes, json!({})));
        index_all(&f);
        let result = group_all(&f);
        let page = listed(&f);

        assert_eq!(result["groupedDriveCount"], json!(4));
        assert_eq!(result["totalDriveCount"], json!(3));
        assert_eq!(result["hiddenTessieCount"], json!(1));
        assert_eq!(result["aggregates"]["totalDriveCount"], json!(4));
        assert_eq!(page["total"], json!(3));
        let mut ids: Vec<i64> = page["drives"].as_array().unwrap().iter().map(|d| d["id"].as_i64().unwrap()).collect();
        ids.sort();
        assert_eq!(ids, vec![0, 2, 3]);
        assert!(f.index.get_drive_detail(1, 1000.0).unwrap().is_none());
        assert!(f.index.get_drive_detail(2, 1000.0).unwrap().is_some());

        let hidden = result["hiddenTessieDrives"].as_array().unwrap();
        assert_eq!(hidden.len(), 1);
        assert_eq!(hidden[0]["startTime"], "2026-07-28T10:00:00");
        assert_eq!(hidden[0]["endTime"], "2026-07-28T10:01:00");
        assert_eq!(hidden[0]["distanceMi"].as_f64(), Some(0.0));
        assert_eq!(hidden[0]["source"], "tessie");
    }

    #[test]
    fn detail_query_enforces_a_point_budget_and_keeps_state_arrays_aligned() {
        let points: Vec<Value> = (0..101).map(|i| json!([39.0 + i as f64 / 1000.0, -76.0])).collect();
        let routes = vec![route(
            "RecentClips/2026-07-28_10-00-00-front.mp4",
            39.0,
            json!({
                "points": points,
                "gearStates": (0..101).map(|i| i % 2).collect::<Vec<_>>(),
                "autopilotStates": (0..101).map(|i| i % 4).collect::<Vec<_>>(),
                "speeds": vec![2; 101],
            }),
        )];
        let expected = expected_drives(&routes);
        let f = fixture(&doc(&routes, json!({})));
        index_all(&f);
        group_all(&f);

        let detail = f.index.get_drive_detail(0, 12.0).unwrap().unwrap();
        assert_eq!(detail["downsampled"], json!(true));
        assert_eq!(detail["fullPointCount"], json!(101));
        let pts = detail["points"].as_array().unwrap();
        assert_eq!(pts.len(), 12);
        let full = &expected[0].points;
        assert_eq!(pts[0], json!(full[0]));
        assert_eq!(pts[11], json!(full[full.len() - 1]));
        assert_eq!(detail["gearStates"].as_array().unwrap().len(), 12);
        assert_eq!(detail["fsdStates"].as_array().unwrap().len(), 12);
    }

    #[test]
    fn summon_drives_count_in_totals_but_are_excluded_from_fsd_aggregates() {
        let n = 100;
        let summon_route = json!({
            "file": "RecentClips/2026-07-28_12-00-00-front.mp4",
            "date": "2026-07-28_12-00-00",
            "points": (0..n).map(|i| json!([39.1 + i as f64 * 1e-6, -76.7])).collect::<Vec<_>>(),
            "speeds": vec![1.5; n],
            "gearRuns": [{ "gear": 0, "frames": 90 }, { "gear": 1, "frames": 300 }, { "gear": 0, "frames": 60 }],
            "rawFrameCount": 450,
            "rawParkCount": 150,
            "flagRuns": [{ "flags": 3, "frames": 120 }, { "flags": 0, "frames": 240 }, { "flags": 3, "frames": 90 }],
        });
        let routes = vec![summon_route, route("RecentClips/2026-07-28_13-00-00-front.mp4", 39.4, json!({}))];
        let f = fixture(&doc(&routes, json!({})));
        index_all(&f);
        let result = group_all(&f);
        let page = listed(&f);
        let drives = page["drives"].as_array().unwrap();
        let summon = drives.iter().find(|d| d["summon"] == json!(true)).expect("summon drive must exist and be tagged");
        let normal = drives.iter().find(|d| d.get("summon").is_none()).expect("normal drive must exist");

        let num = |v: &Value| v.as_f64().unwrap_or(0.0);
        let agg = &result["aggregates"];
        assert_eq!(agg["summonDriveCount"], json!(1));
        assert_eq!(agg["seiDriveCount"], json!(1));
        assert_eq!(num(&agg["seiDistanceM"]), num(&normal["distanceKm"]) * 1000.0);
        assert_eq!(num(&agg["fsdPercentSum"]), num(&normal["fsdPercent"]));
        assert_eq!(num(&agg["totalDistanceMi"]), num(&summon["distanceMi"]) + num(&normal["distanceMi"]));
    }
}
