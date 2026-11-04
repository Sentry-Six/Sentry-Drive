//! JavaScript semantics the import code relies on: coercions, `Date.UTC` /
//! `Date.parse` / local `Date` getters, `toFixed`, `encodeURIComponent`,
//! `URLSearchParams` and V8's `Array.prototype.sort`.

use std::sync::OnceLock;

use chrono::{Datelike, Local, LocalResult, NaiveDate, TimeZone, Timelike};
use regex::Regex;
use serde_json::Value;

use crate::loader::route::local_naive_to_ms;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// JS truthiness of a property read (`undefined` is `None`).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `v != null`.
pub fn present(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// `obj.key` on a parsed JSON value: throws like V8 on `null`, and reads
/// `undefined` from primitives.
pub fn prop<'a>(v: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    match v {
        Value::Null => Err(format!("Cannot read properties of null (reading '{key}')")),
        Value::Object(m) => Ok(m.get(key)),
        _ => Ok(None),
    }
}

/// `obj?.key`.
pub fn opt_prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(key),
        _ => None,
    }
}

/// `String(value)`.
pub fn to_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|x| if x.is_null() { String::new() } else { to_string(Some(x)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String(number)`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if !(1e-6..1e21).contains(&a) {
        let s = format!("{x:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    format!("{x}")
}

/// ECMAScript WhiteSpace + LineTerminator (what `trim` strips).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number(value)`.
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(items)) => match items.len() {
            0 => 0.0,
            1 => string_to_number(&to_string(items.first())),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

pub fn string_to_number(s: &str) -> f64 {
    static DEC: OnceLock<Regex> = OnceLock::new();
    let s = js_trim(s);
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes.iter().find_map(|p| s.strip_prefix(p)) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)));
        }
    }
    if re(&DEC, r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").is_match(s) {
        s.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `parseFloat(string)`.
pub fn parse_float(s: &str) -> f64 {
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    let s = s.trim_start_matches(is_js_space);
    let Some(m) = re(&PREFIX, r"^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)").find(s) else {
        return f64::NAN;
    };
    match m.as_str().trim_start_matches(['+', '-']) {
        "Infinity" if m.as_str().starts_with('-') => f64::NEG_INFINITY,
        "Infinity" => f64::INFINITY,
        _ => m.as_str().parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// `x.toFixed(digits)` (|x| < 1e21). Rust's fixed formatting rounds exact
/// binary ties to even; JS picks the larger magnitude.
pub fn to_fixed(x: f64, digits: i32) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_to_string(x);
    }
    let x = if x == 0.0 { 0.0 } else { x };
    let scale = 10f64.powi(digits);
    let scaled = x * scale;
    // A true decimal tie is a multiple of 2^-(digits+1), which makes both
    // products below exact.
    let exact_tie = (x * 2f64.powi(digits + 1)).fract() == 0.0 && scaled.fract().abs() == 0.5;
    if !exact_tie {
        let s = format!("{:.*}", digits as usize, x);
        return s;
    }
    let n = (scaled.abs().floor() + 1.0) as u128;
    let width = digits as usize + 1;
    let s = format!("{n:0width$}");
    let (int, frac) = s.split_at(s.len() - digits as usize);
    let sign = if x < 0.0 { "-" } else { "" };
    if digits == 0 { format!("{sign}{int}") } else { format!("{sign}{int}.{frac}") }
}

/// Serialize a JS number the way `JSON.stringify` would (integers without a
/// trailing `.0`, `-0` as `0`, non-finite as `null`).
pub fn num(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        return Value::from(x as i64);
    }
    Value::from(x)
}

/// `Math.max(0, x)`.
pub fn max0(x: f64) -> f64 {
    // NaN propagates; -0 becomes +0.
    if x.is_nan() || x > 0.0 { x } else { 0.0 }
}

/// `Math.max(lo, Math.min(hi, x))`.
pub fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    if x.is_nan() {
        return x;
    }
    x.min(hi).max(lo)
}

/// `str.slice(0, n)` counted in UTF-16 code units.
pub fn slice_utf16(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// `String(n).padStart(2, '0')` for a non-negative integer.
pub fn pad2(n: impl std::fmt::Display) -> String {
    format!("{n:0>2}")
}

// ── Dates ──────────────────────────────────────────────────────────────────

const MS_PER_DAY: f64 = 86_400_000.0;

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// ECMAScript MakeDay (month is 0-based and may overflow).
fn make_day(y: f64, m: f64, d: f64) -> f64 {
    if !(y.is_finite() && m.is_finite() && d.is_finite()) {
        return f64::NAN;
    }
    let ym = y + (m / 12.0).floor();
    if ym.abs() > 400_000.0 {
        return f64::NAN;
    }
    let mn = m.rem_euclid(12.0);
    days_from_civil(ym as i64, mn as i64 + 1, 1) as f64 + d - 1.0
}

fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > 8.64e15 {
        return f64::NAN;
    }
    t.trunc() + 0.0
}

/// `Date.UTC(y, m, d, h, mi, s)` with integer arguments.
pub fn date_utc(y: f64, m: f64, d: f64, h: f64, mi: f64, s: f64) -> f64 {
    let y = if (0.0..=99.0).contains(&y) { 1900.0 + y } else { y };
    time_clip(make_day(y, m, d) * MS_PER_DAY + h * 3_600_000.0 + mi * 60_000.0 + s * 1000.0)
}

/// Local wall-clock fields of `new Date(ms)`: (year, month 1-12, day, h, m, s).
pub fn local_parts(ms: f64) -> Option<(i32, u32, u32, u32, u32, u32)> {
    if !ms.is_finite() {
        return None;
    }
    match Local.timestamp_millis_opt(ms.trunc() as i64) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => {
            Some((t.year(), t.month(), t.day(), t.hour(), t.minute(), t.second()))
        }
        LocalResult::None => None,
    }
}

/// Local midnight-relative instant for a wall-clock date-time whose day may
/// overflow the month (the legacy parser accepts `2024-02-30`).
fn local_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> Option<f64> {
    let days = days_from_civil(y, mo, 1) + d - 1;
    let date = NaiveDate::from_num_days_from_ce_opt((days + 719_163) as i32)?;
    let base = date.and_hms_opt(0, 0, 0)?;
    let naive = base + chrono::Duration::milliseconds(((h * 60 + mi) * 60 + s) * 1000 + ms);
    Some(local_naive_to_ms(naive) as f64)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    days_from_civil(if m == 12 { y + 1 } else { y }, if m == 12 { 1 } else { m + 1 }, 1) - days_from_civil(y, m, 1)
}

fn frac_ms(f: Option<&str>) -> i64 {
    f.map(|f| {
        let mut digits: String = f.chars().take(3).collect();
        while digits.len() < 3 {
            digits.push('0');
        }
        digits.parse::<i64>().unwrap_or(0)
    })
    .unwrap_or(0)
}

fn zone_offset_ms(z: &str) -> Option<i64> {
    let z = z.trim();
    if z.eq_ignore_ascii_case("z") || z.eq_ignore_ascii_case("utc") || z.eq_ignore_ascii_case("gmt") {
        return Some(0);
    }
    let sign = if z.starts_with('-') { -1 } else { 1 };
    let digits: String = z[1..].chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 4 {
        return None;
    }
    let h: i64 = digits[..2].parse().ok()?;
    let m: i64 = digits[2..].parse().ok()?;
    Some(sign * (h * 60 + m) * 60_000)
}

/// `Date.parse(s)` for the ISO-8601 forms the spec defines plus V8's legacy
/// `YYYY-M-D[ HH:MM[:SS[.fff]]][ Z|UTC|GMT|±HHMM]` form. Anything else
/// (month names, RFC 2822) returns NaN, where V8 might still parse it.
pub fn date_parse(s: &str) -> f64 {
    static ISO: OnceLock<Regex> = OnceLock::new();
    static LEGACY: OnceLock<Regex> = OnceLock::new();
    let iso = re(
        &ISO,
        r"^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:[0-9]{2})?)?$",
    );
    if let Some(c) = iso.captures(s) {
        let g = |i: usize| c.get(i).map(|m| m.as_str());
        let n = |i: usize, dflt: i64| g(i).map_or(Some(dflt), |v| v.parse::<i64>().ok());
        let ok = (|| {
            if g(1) == Some("-000000") {
                return None;
            }
            let y = n(1, 0)?;
            let (mo, d) = (n(2, 1)?, n(3, 1)?);
            let (h, mi, sec) = (n(4, 0)?, n(5, 0)?, n(6, 0)?);
            let ms = frac_ms(g(7));
            let valid = (1..=12).contains(&mo)
                && d >= 1
                && d <= days_in_month(y, mo)
                && mi <= 59
                && sec <= 59
                && (h <= 23 || (h == 24 && mi == 0 && sec == 0 && ms == 0));
            if !valid {
                return None;
            }
            if g(4).is_none() {
                return Some(date_utc_full(y, mo, d, 0, 0, 0, 0));
            }
            match g(8) {
                Some(z) => Some(date_utc_full(y, mo, d, h, mi, sec, ms) - zone_offset_ms(z)? as f64),
                None => local_ms(y, mo, d, h, mi, sec, ms),
            }
        })();
        if let Some(v) = ok {
            return time_clip(v);
        }
    }
    let legacy = re(
        &LEGACY,
        r"^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[ Tt]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?)?(?: ?([Zz]|UTC|GMT|[+-][0-9]{2}:?[0-9]{2}))?$",
    );
    let Some(c) = legacy.captures(s) else { return f64::NAN };
    let g = |i: usize| c.get(i).map(|m| m.as_str());
    let n = |i: usize| g(i).map_or(0, |v| v.parse::<i64>().unwrap_or(0));
    let (y, mo, d, h, mi, sec) = (n(1), n(2), n(3), n(4), n(5), n(6));
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || sec > 59 {
        return f64::NAN;
    }
    let ms = frac_ms(g(7));
    let v = match g(8) {
        Some(z) => match zone_offset_ms(z) {
            Some(off) => date_utc_full(y, mo, d, h, mi, sec, ms) - off as f64,
            None => return f64::NAN,
        },
        None => match local_ms(y, mo, d, h, mi, sec, ms) {
            Some(v) => v,
            None => return f64::NAN,
        },
    };
    time_clip(v)
}

fn date_utc_full(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> f64 {
    make_day(y as f64, (mo - 1) as f64, d as f64) * MS_PER_DAY + ((h * 60 + mi) * 60 + s) as f64 * 1000.0 + ms as f64
}

// ── URLs ───────────────────────────────────────────────────────────────────

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `new URLSearchParams(pairs).toString()`.
pub fn search_params(pairs: &[(&str, String)]) -> String {
    let enc = |s: &str| {
        let mut out = String::with_capacity(s.len());
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || b"*-._".contains(&b) {
                out.push(b as char);
            } else if b == b' ' {
                out.push('+');
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    };
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

// ── Array.prototype.sort ───────────────────────────────────────────────────

/// `arr.sort((a, b) => key(a) - key(b))` as V8 runs it. With finite keys the
/// comparator is consistent and any stable sort matches V8's TimSort. NaN or
/// infinite keys make it inconsistent; V8's run detection plus binary
/// insertion is then reproduced exactly for arrays shorter than 64 (longer
/// ones merge the insertion-sorted runs stably, an approximation).
pub fn v8_sort_by_key<T>(v: &mut [T], key: impl Fn(&T) -> f64) {
    if v.iter().all(|x| key(x).is_finite()) {
        v.sort_by(|a, b| key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal));
        return;
    }
    // V8's SortCompareUserFn maps a NaN comparator result to 0.
    let cmp = |a: &T, b: &T| {
        let d = key(a) - key(b);
        if d.is_nan() { 0.0 } else { d }
    };
    let n = v.len();
    if n < 2 {
        return;
    }
    let min_run = {
        let (mut m, mut r) = (n, 0);
        while m >= 64 {
            r |= m & 1;
            m >>= 1;
        }
        m + r
    };
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut low = 0;
    while low < n {
        let high = n;
        let mut run = if low + 1 == high {
            1
        } else {
            let desc = cmp(&v[low + 1], &v[low]) < 0.0;
            let mut len = 2;
            let mut prev = low + 1;
            for idx in low + 2..high {
                let o = cmp(&v[idx], &v[prev]);
                if (desc && o >= 0.0) || (!desc && o < 0.0) {
                    break;
                }
                prev = idx;
                len += 1;
            }
            if desc {
                v[low..low + len].reverse();
            }
            len
        };
        if run < min_run {
            let forced = min_run.min(n - low);
            for start in low + run..low + forced {
                let (mut left, mut right) = (low, start);
                while left < right {
                    let mid = left + ((right - left) >> 1);
                    if cmp(&v[start], &v[mid]) < 0.0 {
                        right = mid;
                    } else {
                        left = mid + 1;
                    }
                }
                v[left..=start].rotate_right(1);
            }
            run = forced;
        }
        runs.push((low, run));
        low += run;
    }
    // Merge runs left to right (stable: take from the right only when less).
    while runs.len() > 1 {
        let (a0, alen) = runs[0];
        let (_, blen) = runs[1];
        let mut i = a0;
        let mut j = a0 + alen;
        let end = a0 + alen + blen;
        while i < j && j < end {
            if cmp(&v[j], &v[i]) < 0.0 {
                v[i..=j].rotate_right(1);
                j += 1;
            }
            i += 1;
        }
        runs[0] = (a0, alen + blen);
        runs.remove(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn to_fixed_matches_js_rounding() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(-0.125, 2), "-0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(12345.675, 2), "12345.67");
        assert_eq!(to_fixed(12345.125, 2), "12345.13");
        assert_eq!(to_fixed(0.005, 2), "0.01");
        assert_eq!(to_fixed(0.015, 2), "0.01");
        assert_eq!(to_fixed(99999.995, 2), "99999.99");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
    }

    #[test]
    fn coercions_match_js() {
        assert_eq!(to_number(Some(&json!(" 12 "))), 12.0);
        assert_eq!(to_number(Some(&json!(""))), 0.0);
        assert!(to_number(Some(&json!("abc"))).is_nan());
        assert!(to_number(Some(&json!("1e"))).is_nan());
        assert_eq!(to_number(Some(&json!("0x1F"))), 31.0);
        assert!(to_number(None).is_nan());
        assert_eq!(to_number(Some(&Value::Null)), 0.0);
        assert_eq!(parse_float("  12.5abc"), 12.5);
        assert_eq!(parse_float("1e5x"), 100000.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert_eq!(parse_float(".5"), 0.5);
        assert!(parse_float("abc").is_nan());
        assert_eq!(number_to_string(1.0), "1");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(28_745_123.0), "28745123");
        assert_eq!(num(-0.0), json!(0));
    }

    #[test]
    fn date_utc_overflows_like_js() {
        assert_eq!(date_utc(2024.0, 0.0, 5.0, 10.0, 0.0, 0.0), 1_704_448_800_000.0);
        assert_eq!(date_utc(2024.0, 12.0, 1.0, 0.0, 0.0, 0.0), date_utc(2025.0, 0.0, 1.0, 0.0, 0.0, 0.0));
        assert_eq!(date_utc(2024.0, 1.0, 30.0, 0.0, 0.0, 0.0), date_utc(2024.0, 2.0, 1.0, 0.0, 0.0, 0.0));
        assert_eq!(date_utc(99.0, 0.0, 1.0, 0.0, 0.0, 0.0), date_utc(1999.0, 0.0, 1.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn date_parse_utc_forms() {
        assert_eq!(date_parse("2024-01-05T10:00:00Z"), 1_704_448_800_000.0);
        assert_eq!(date_parse("2024-01-05T10:00:00.123456Z"), 1_704_448_800_123.0);
        assert_eq!(date_parse("2024-01-05 10:00:00 UTC"), 1_704_448_800_000.0);
        assert_eq!(date_parse("2024-01-05T10:00:00+02:00"), 1_704_441_600_000.0);
        assert_eq!(date_parse("2024-01-05"), 1_704_412_800_000.0);
        assert_eq!(date_parse("2024-02-30T10:00:00Z"), 1_709_287_200_000.0);
        assert!(date_parse("2024-01-05T10:00:60Z").is_nan());
        assert!(date_parse("  2024-01-05T10:00:00Z  ").is_nan());
        assert!(date_parse("1700000000").is_nan());
    }

    #[test]
    fn url_encoding_matches_js() {
        assert_eq!(encode_uri_component("a b/c?d=é!'()*~"), "a%20b%2Fc%3Fd%3D%C3%A9!'()*~");
        assert_eq!(search_params(&[("a", "x y".into()), ("b", "1!".into())]), "a=x+y&b=1%21");
    }

    #[test]
    fn v8_sort_with_nan_keys() {
        // Node 22: [3,NaN,1,2] stays put; [4,3,NaN,1,2] → [1,2,3,4,NaN];
        // [NaN,3,1,2,0] → [NaN,0,1,2,3].
        let fmt = |v: Vec<f64>| { let mut v = v; v8_sort_by_key(&mut v, |x| *x); format!("{v:?}") };
        assert_eq!(fmt(vec![3.0, f64::NAN, 1.0, 2.0]), "[3.0, NaN, 1.0, 2.0]");
        assert_eq!(fmt(vec![4.0, 3.0, f64::NAN, 1.0, 2.0]), "[1.0, 2.0, 3.0, 4.0, NaN]");
        assert_eq!(fmt(vec![f64::NAN, 3.0, 1.0, 2.0, 0.0]), "[NaN, 0.0, 1.0, 2.0, 3.0]");
        let mut v = vec![5.0, 4.0, 1.0, 2.0];
        v8_sort_by_key(&mut v, |x| *x);
        assert_eq!(v, vec![1.0, 2.0, 4.0, 5.0]);
    }
}
