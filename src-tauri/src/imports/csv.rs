//! Tessie CSV exports (port of the parsing half of
//! `src/processing/tessie-import.cjs`).

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use super::clips::{Drive, StatePoint};
use super::js::{date_utc, js_trim, parse_float};

/// RFC 4180 subset: quoted fields with commas and doubled quotes; CR dropped.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut field = String::new();
    let mut row: Vec<String> = Vec::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
            continue;
        }
        match ch {
            '"' => in_quotes = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(ch),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

pub struct Records {
    pub headers: Vec<String>,
    pub records: Vec<HashMap<String, String>>,
}

impl Records {
    /// `r[key]`; a missing column reads as `undefined`, which every caller
    /// treats like an empty string.
    fn get<'a>(r: &'a HashMap<String, String>, key: &str) -> &'a str {
        r.get(key).map_or("", String::as_str)
    }
}

fn rows_to_objects(rows: Vec<Vec<String>>) -> Records {
    let mut it = rows.into_iter();
    let Some(headers) = it.next() else {
        return Records { headers: Vec::new(), records: Vec::new() };
    };
    let mut records = Vec::new();
    for row in it {
        if row.len() == 1 && row[0].is_empty() {
            continue;
        }
        let mut obj = HashMap::with_capacity(headers.len());
        for (c, h) in headers.iter().enumerate() {
            obj.insert(h.clone(), row.get(c).cloned().unwrap_or_default());
        }
        records.push(obj);
    }
    Records { headers, records }
}

fn tz_offset_hours(tz: &str) -> Option<f64> {
    Some(match tz {
        "UTC" | "GMT" => 0.0,
        "EDT" => -4.0,
        "EST" => -5.0,
        "CDT" => -5.0,
        "CST" => -6.0,
        "MDT" => -6.0,
        "MST" => -7.0,
        "PDT" => -7.0,
        "PST" => -8.0,
        "AKDT" => -8.0,
        "AKST" => -9.0,
        "HDT" => -9.0,
        "HST" => -10.0,
        "ADT" => -3.0,
        "AST" => -4.0,
        "NDT" => -2.5,
        "NST" => -3.5,
        "BST" => 1.0,
        "WET" => 0.0,
        "WEST" => 1.0,
        "CET" => 1.0,
        "CEST" => 2.0,
        "EET" => 2.0,
        "EEST" => 3.0,
        "MSK" => 3.0,
        "SAST" => 2.0,
        "WAT" => 1.0,
        "CAT" => 2.0,
        "EAT" => 3.0,
        "GST" => 4.0,
        "PKT" => 5.0,
        "ICT" => 7.0,
        "WIB" => 7.0,
        "SGT" => 8.0,
        "HKT" => 8.0,
        "PHT" => 8.0,
        "KST" => 9.0,
        "JST" => 9.0,
        "AWST" => 8.0,
        "ACST" => 9.5,
        "ACDT" => 10.5,
        "AEST" => 10.0,
        "AEDT" => 11.0,
        "NZST" => 12.0,
        "NZDT" => 13.0,
        _ => return None,
    })
}

/// Offset (ms) from the `(ZONE)` marker in the "Started At" header.
pub fn extract_tz_offset_ms(header: Option<&str>) -> Result<f64, String> {
    static TZ: OnceLock<Regex> = OnceLock::new();
    let re = TZ.get_or_init(|| Regex::new(r"\(([A-Z]{2,5})\)").expect("valid regex"));
    let Some(c) = re.captures(header.unwrap_or("")) else {
        // Legacy exports without a zone marker: historical US-Eastern assumption.
        return Ok(-4.0 * 3_600_000.0);
    };
    let tz = &c[1];
    match tz_offset_hours(tz) {
        Some(h) => Ok(h * 3_600_000.0),
        None => Err(format!(
            "Unrecognized timezone \"{tz}\" in the CSV header — cannot convert drive times. \
             Re-export with a supported timezone or a UTC/GMT-labeled export."
        )),
    }
}

fn timestamp_utc(s: &str) -> f64 {
    static TS: OnceLock<Regex> = OnceLock::new();
    let re = TS.get_or_init(|| {
        Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$").expect("valid regex")
    });
    if s.is_empty() {
        return f64::NAN;
    }
    let Some(c) = re.captures(js_trim(s)) else { return f64::NAN };
    let n = |i: usize| c.get(i).map_or(0.0, |m| m.as_str().parse::<f64>().unwrap_or(0.0));
    date_utc(n(1), n(2) - 1.0, n(3), n(4), n(5), n(6))
}

/// "2024-09-08 19:19[:30]" in a fixed-offset zone → epoch ms.
pub fn parse_local_timestamp(s: &str, offset_ms: f64) -> f64 {
    timestamp_utc(s) - offset_ms
}

pub fn parse_utc_timestamp(s: &str) -> f64 {
    timestamp_utc(s)
}

fn finite(x: f64) -> Option<f64> {
    x.is_finite().then_some(x)
}

pub fn parse_drives_csv(text: &str) -> Result<Vec<Drive>, String> {
    let Records { headers, records } = rows_to_objects(parse_csv(text));
    let start_col = headers.iter().find(|h| h.starts_with("Started At")).map(String::as_str);
    let end_col = headers.iter().find(|h| h.starts_with("Ended At")).map(String::as_str);
    let offset_ms = extract_tz_offset_ms(start_col)?;
    let col = |r: &HashMap<String, String>, name: &str| parse_float(Records::get(r, name));

    let mut out = Vec::new();
    for r in &records {
        // `r[undefined]` reads a column literally named "undefined".
        let started_at = parse_local_timestamp(Records::get(r, start_col.unwrap_or("undefined")), offset_ms);
        let ended_at = parse_local_timestamp(Records::get(r, end_col.unwrap_or("undefined")), offset_ms);
        if !started_at.is_finite() || !ended_at.is_finite() {
            continue;
        }
        out.push(Drive {
            started_at,
            ended_at,
            duration_ms: ended_at - started_at,
            distance_mi: finite(col(r, "Distance (mi)")).unwrap_or(0.0),
            autopilot_distance_mi: finite(col(r, "Autopilot Distance (mi)")).unwrap_or(0.0),
            starting_odometer: finite(col(r, "Starting Odometer (mi)")),
            ending_odometer: finite(col(r, "Ending Odometer (mi)")),
            start_lat: finite(col(r, "Starting Latitude")),
            start_lng: finite(col(r, "Starting Longitude")),
            end_lat: finite(col(r, "Ending Latitude")),
            end_lng: finite(col(r, "Ending Longitude")),
            tz_shift_ms: None,
        });
    }
    Ok(out)
}

pub fn parse_driving_states_csv(text: &str) -> Vec<StatePoint> {
    let Records { records, .. } = rows_to_objects(parse_csv(text));
    let mut out = Vec::new();
    for r in &records {
        let time_ms = parse_utc_timestamp(Records::get(r, "Timestamp (UTC)"));
        let lat = parse_float(Records::get(r, "Latitude"));
        let lng = parse_float(Records::get(r, "Longitude"));
        if !time_ms.is_finite() || !lat.is_finite() || !lng.is_finite() {
            continue;
        }
        let speed_mph = parse_float(Records::get(r, "Speed (mph)"));
        let odometer = parse_float(Records::get(r, "Odometer (mi)"));
        out.push(StatePoint {
            time_ms,
            lat,
            lng,
            shift: js_trim(Records::get(r, "Shift State")).to_uppercase(),
            speed_mph: finite(speed_mph).unwrap_or(0.0),
            odometer: finite(odometer),
        });
    }
    out.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quotes_and_crlf() {
        let rows = parse_csv("a,\"b,c\",\"d\"\"e\"\r\n1,2\n\n");
        assert_eq!(rows, vec![vec!["a", "b,c", "d\"e"], vec!["1", "2"], vec![""]]);
        assert_eq!(parse_csv("x,y"), vec![vec!["x", "y"]]);
    }

    #[test]
    fn tz_marker() {
        assert_eq!(extract_tz_offset_ms(Some("Started At (MDT)")).unwrap(), -6.0 * 3_600_000.0);
        assert_eq!(extract_tz_offset_ms(Some("Started At")).unwrap(), -4.0 * 3_600_000.0);
        assert_eq!(extract_tz_offset_ms(None).unwrap(), -4.0 * 3_600_000.0);
        assert!(extract_tz_offset_ms(Some("Started At (IST)")).unwrap_err().starts_with("Unrecognized timezone \"IST\""));
        assert_eq!(parse_local_timestamp("2024-07-15 08:00", -6.0 * 3_600_000.0), 1_721_052_000_000.0);
        assert!(parse_utc_timestamp("2024-07-15").is_nan());
    }
}
