//! Port of `src/main/drive-index.cjs` and `src/main/disk-drive-grouper.cjs`.
//!
//! drive-data.json is streamed once (it can exceed 1 GB) into a throwaway
//! SQLite index: routes are parsed straight into compact typed records, never
//! materialised as a whole document. Drives are then grouped window by window
//! from the index, exactly as the Electron utility process does.

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
    Ok(Parsed::Route { normalized, ts, payload: bincode::serialize(&route)? })
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

// ── disk-drive-grouper.cjs ──────────────────────────────────────────────────

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
        let routes = payloads.iter().map(|p| bincode::deserialize(p)).collect::<Result<Vec<Route>, _>>()?;
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
            for r in parallel_map(pending, &prepare_window) {
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
