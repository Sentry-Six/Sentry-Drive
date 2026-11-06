//! Terminal, memory-ring and capped session-file logging, plus the redacted
//! export used by "Download logs".

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_ENTRIES: usize = 5000;
const MAX_ENTRY_LEN: usize = 10000;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const PREV_EXPORT_BYTES: u64 = 256 * 1024;

struct State {
    entries: std::collections::VecDeque<String>,
    log_file: Option<PathBuf>,
    prev_file: Option<PathBuf>,
    file_bytes: u64,
    version: String,
    os_build: String,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(State {
            entries: Default::default(),
            log_file: None,
            prev_file: None,
            file_bytes: 0,
            version: "?".into(),
            os_build: String::new(),
        })
    })
}

pub fn set_app_info(version: &str, os_build: &str) {
    let mut s = state().lock().unwrap();
    s.version = version.into();
    s.os_build = os_build.into();
}

pub fn init_file_sink(dir: PathBuf) {
    let mut s = state().lock().unwrap();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let log = dir.join("session.log");
    let prev = dir.join("previous-session.log");
    if log.exists() {
        let _ = fs::remove_file(&prev);
        let _ = fs::rename(&log, &prev);
    }
    if fs::write(&log, "").is_ok() {
        s.log_file = Some(log);
        s.prev_file = Some(prev);
        s.file_bytes = 0;
    }
}

fn ts() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

fn ascii_punct(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\u{2012}'..='\u{2015}' | '\u{2500}' | '\u{2501}' => out.push('-'),
            '\u{2018}' | '\u{2019}' => out.push('\''),
            '\u{201C}' | '\u{201D}' => out.push('"'),
            '\u{2026}' => out.push_str("..."),
            '\u{2192}' | '\u{27A1}' => out.push_str("->"),
            '\u{2022}' | '\u{00B7}' => out.push('*'),
            '\u{00A0}' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

pub fn log(level: &str, scope: &str, text: &str) {
    let text: String = ascii_punct(text).chars().take(MAX_ENTRY_LEN).collect();
    let line = format!("[{}] [{:<5}] [{}] {}", ts(), level.to_uppercase(), scope, text);
    // Line-buffered stdout keeps arrival times meaningful for benchmarks.
    if level == "error" || level == "warn" {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }
    let mut s = state().lock().unwrap();
    s.entries.push_back(line.clone());
    while s.entries.len() > MAX_ENTRIES {
        s.entries.pop_front();
    }
    if let Some(path) = s.log_file.clone() {
        if s.file_bytes < MAX_FILE_BYTES {
            if let Ok(mut f) = OpenOptions::new().append(true).open(&path) {
                let mut bytes = format!("{line}\n");
                if s.file_bytes + bytes.len() as u64 >= MAX_FILE_BYTES {
                    bytes.push_str("(log file size cap reached - further entries kept in memory only)\n");
                }
                if f.write_all(bytes.as_bytes()).is_ok() {
                    s.file_bytes += bytes.len() as u64;
                }
            }
        }
    }
}

pub fn info(scope: &str, text: impl AsRef<str>) {
    log("info", scope, text.as_ref());
}
pub fn warn(scope: &str, text: impl AsRef<str>) {
    log("warn", scope, text.as_ref());
}
pub fn error(scope: &str, text: impl AsRef<str>) {
    log("error", scope, text.as_ref());
}

/// Scrub paths, tokens and other personal details from exported logs.
fn redact(text: &str) -> String {
    text.lines().map(redact_line).collect::<Vec<_>>().join("\n")
}

fn redact_line(line: &str) -> String {
    use regex::Regex;
    static RES: OnceLock<[Regex; 3]> = OnceLock::new();
    let [creds, coords, places] = RES.get_or_init(|| {
        [
            Regex::new(r#"(?i)((?:token|api[_-]?key|apikey|authorization|bearer|secret)"?\s*[:=]\s*"?)[A-Za-z0-9._\-]{8,}"#).unwrap(),
            Regex::new(r#"(?i)("(?:lat|lng|latitude|longitude)[a-z_]*"\s*:\s*)"?-?\d+\.\d+"?"#).unwrap(),
            Regex::new(r#"(?i)("(?:starting_|ending_)?(?:saved_)?location"\s*:\s*)"[^"]*""#).unwrap(),
        ]
    });
    let out = creds.replace_all(line, "${1}[redacted]");
    let out = coords.replace_all(&out, "${1}[coord]");
    let out = places.replace_all(&out, "${1}\"[location]\"").into_owned();
    // Free-standing coordinates: signed decimals with 4+ fractional digits.
    let chars: Vec<char> = out.chars().collect();
    let mut result = String::with_capacity(out.len());
    let mut i = 0;
    while i < chars.len() {
        let prev_ok = i == 0 || !(chars[i - 1].is_ascii_digit() || chars[i - 1] == '.');
        let mut j = i;
        if prev_ok && j < chars.len() && chars[j] == '-' {
            j += 1;
        }
        let int_start = j;
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
        let int_len = j - int_start;
        if prev_ok && (1..=3).contains(&int_len) && j < chars.len() && chars[j] == '.' {
            let frac_start = j + 1;
            let mut k = frac_start;
            while k < chars.len() && chars[k].is_ascii_digit() {
                k += 1;
            }
            if k - frac_start >= 4 {
                result.push_str("[coord]");
                i = k;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

pub fn log_text() -> String {
    let s = state().lock().unwrap();
    let mut parts = vec![
        format!("Sentry Drive logs - exported {}", ts()),
        format!(
            "version {} | {} {}{} | tauri {} | webview {}",
            s.version,
            std::env::consts::OS,
            std::env::consts::ARCH,
            if s.os_build.is_empty() { String::new() } else { format!(" ({})", s.os_build) },
            tauri::VERSION,
            tauri::webview_version().unwrap_or_else(|_| "?".into()),
        ),
        "GPS coordinates, addresses, and any tokens are redacted from this export.".into(),
    ];
    if let Some(prev) = &s.prev_file {
        if let Ok(meta) = fs::metadata(prev) {
            if meta.len() > 0 {
                if let Ok(bytes) = fs::read(prev) {
                    let len = (meta.len().min(PREV_EXPORT_BYTES)) as usize;
                    let tail = String::from_utf8_lossy(&bytes[bytes.len() - len..]).to_string();
                    parts.push("-".repeat(78));
                    parts.push(format!("PREVIOUS SESSION{}:", if meta.len() > len as u64 { " (tail)" } else { "" }));
                    parts.push(redact(tail.trim_end()));
                }
            }
        }
    }
    parts.push("-".repeat(78));
    parts.push("CURRENT SESSION:".into());
    parts.push(redact(&s.entries.iter().cloned().collect::<Vec<_>>().join("\n")));
    parts.push(String::new());
    parts.join("\n")
}
