//! Port of `src/main/drive-data-writer.cjs`: rewrite drive-data.json section
//! by section. Untouched top-level sections are byte-copied from the one open
//! source handle (so an external atomic replace can't splice offsets), and
//! the result is written to a temp file, integrity-checked, fsynced and
//! renamed into place.
//!
//! Unlike the Electron build, a filtered `routes`/`processedFiles` section is
//! also streamed: each array element is copied verbatim or dropped, so removing
//! a drive from a 1 GB file never materialises the whole document.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use anyhow::{anyhow, bail, Result};
use serde_json::Value;

use crate::fsutil;

pub const MAX_SELECTED_SECTION_BYTES: u64 = 64 * 1024 * 1024;
const MUTABLE: [&str; 3] = ["processedFiles", "routes", "driveTags"];

#[derive(Debug, Clone)]
pub struct Section {
    pub key: String,
    pub start: u64,
    pub end: u64,
}

fn ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// Byte ranges of every top-level value (scanTopLevelSectionsFromStream).
pub fn scan_sections<R: Read>(reader: R) -> Result<Vec<Section>> {
    #[derive(PartialEq)]
    enum P { Root, Key, KeyStr, Colon, Value, ValStr, ValCont, ValPrim, After, Done }
    let mut sections = Vec::new();
    let mut phase = P::Root;
    let mut pos: u64 = 0;
    let mut key_bytes: Vec<u8> = Vec::new();
    let mut current_key = String::new();
    let (mut escaped, mut in_str) = (false, false);
    let mut depth = 0usize;
    let mut value_start = 0u64;
    let mut last_prim = 0u64;
    let mut reader = BufReader::with_capacity(1 << 20, reader);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            match phase {
                P::Root => {
                    if !ws(b) {
                        if b != b'{' {
                            bail!("drive-data root must be a JSON object");
                        }
                        phase = P::Key;
                    }
                }
                P::Key => {
                    if ws(b) || b == b',' {
                    } else if b == b'}' {
                        phase = P::Done;
                    } else if b == b'"' {
                        key_bytes = vec![b];
                        escaped = false;
                        phase = P::KeyStr;
                    } else {
                        bail!("invalid top-level JSON key");
                    }
                }
                P::KeyStr => {
                    key_bytes.push(b);
                    if escaped {
                        escaped = false;
                    } else if b == b'\\' {
                        escaped = true;
                    } else if b == b'"' {
                        current_key = serde_json::from_slice(&key_bytes)?;
                        phase = P::Colon;
                    }
                }
                P::Colon => {
                    if !ws(b) {
                        if b != b':' {
                            bail!("missing colon after top-level JSON key");
                        }
                        phase = P::Value;
                    }
                }
                P::Value => {
                    if !ws(b) {
                        value_start = pos;
                        if b == b'"' {
                            escaped = false;
                            phase = P::ValStr;
                        } else if b == b'{' || b == b'[' {
                            depth = 1;
                            in_str = false;
                            escaped = false;
                            phase = P::ValCont;
                        } else {
                            last_prim = pos;
                            phase = P::ValPrim;
                        }
                    }
                }
                P::ValStr => {
                    if escaped {
                        escaped = false;
                    } else if b == b'\\' {
                        escaped = true;
                    } else if b == b'"' {
                        sections.push(Section { key: std::mem::take(&mut current_key), start: value_start, end: pos + 1 });
                        phase = P::After;
                    }
                }
                P::ValCont => {
                    if in_str {
                        if escaped {
                            escaped = false;
                        } else if b == b'\\' {
                            escaped = true;
                        } else if b == b'"' {
                            in_str = false;
                        }
                    } else if b == b'"' {
                        in_str = true;
                    } else if b == b'{' || b == b'[' {
                        depth += 1;
                    } else if b == b'}' || b == b']' {
                        depth -= 1;
                        if depth == 0 {
                            sections.push(Section { key: std::mem::take(&mut current_key), start: value_start, end: pos + 1 });
                            phase = P::After;
                        }
                    }
                }
                P::ValPrim => {
                    if b == b',' || b == b'}' {
                        sections.push(Section { key: std::mem::take(&mut current_key), start: value_start, end: last_prim + 1 });
                        phase = if b == b'}' { P::Done } else { P::Key };
                    } else if !ws(b) {
                        last_prim = pos;
                    }
                }
                P::After => {
                    if !ws(b) {
                        if b == b',' {
                            phase = P::Key;
                        } else if b == b'}' {
                            phase = P::Done;
                        } else {
                            bail!("invalid separator after top-level JSON value");
                        }
                    }
                }
                P::Done => {
                    if !ws(b) {
                        bail!("unexpected data after drive-data JSON object");
                    }
                }
            }
            pos += 1;
        }
    }
    if phase != P::Done {
        bail!("incomplete drive-data JSON object");
    }
    Ok(sections)
}

pub fn read_range(f: &mut File, s: &Section) -> Result<Vec<u8>> {
    f.seek(SeekFrom::Start(s.start))?;
    let mut buf = vec![0u8; (s.end - s.start) as usize];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Parse only the named top-level values (readTopLevelValues).
pub fn read_top_level_values(path: &Path, keys: &[&str]) -> Result<serde_json::Map<String, Value>> {
    let mut f = File::open(path)?;
    let sections = scan_sections(f.try_clone()?)?;
    let mut out = serde_json::Map::new();
    for s in sections.iter().filter(|s| keys.contains(&s.key.as_str())) {
        if s.end - s.start > MAX_SELECTED_SECTION_BYTES {
            bail!("Top-level section \"{}\" exceeds the read limit", s.key);
        }
        out.insert(s.key.clone(), serde_json::from_slice(&read_range(&mut f, s)?)?);
    }
    Ok(out)
}

/// Stream the elements of a JSON array stored at `s` in `f`, yielding each
/// element's raw bytes (surrounding whitespace trimmed).
pub fn for_each_array_element(f: &mut File, s: &Section, mut each: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
    f.seek(SeekFrom::Start(s.start))?;
    let mut reader = BufReader::with_capacity(1 << 20, f.take(s.end - s.start));
    let mut first = [0u8; 1];
    reader.read_exact(&mut first)?;
    if first[0] != b'[' {
        return Ok(()); // not an array: nothing to filter
    }
    let mut elem: Vec<u8> = Vec::with_capacity(64 * 1024);
    let (mut depth, mut in_str, mut escaped) = (0usize, false, false);
    let mut buf = vec![0u8; 1 << 20];
    let flush = |elem: &mut Vec<u8>, each: &mut dyn FnMut(&[u8]) -> Result<()>| -> Result<()> {
        let start = elem.iter().position(|&b| !ws(b)).unwrap_or(elem.len());
        let end = elem.iter().rposition(|&b| !ws(b)).map_or(start, |i| i + 1);
        if end > start {
            each(&elem[start..end])?;
        }
        elem.clear();
        Ok(())
    };
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if in_str {
                elem.push(b);
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    in_str = false;
                }
                continue;
            }
            match b {
                b'"' => {
                    in_str = true;
                    elem.push(b);
                }
                b'{' | b'[' => {
                    depth += 1;
                    elem.push(b);
                }
                b'}' | b']' if depth > 0 => {
                    depth -= 1;
                    elem.push(b);
                }
                b']' => {
                    flush(&mut elem, &mut each)?;
                    return Ok(());
                }
                b',' if depth == 0 => flush(&mut elem, &mut each)?,
                _ => elem.push(b),
            }
        }
    }
    Err(anyhow!("unterminated array in drive-data section \"{}\"", s.key))
}

pub enum Replacement {
    /// JSON.stringify(value).
    Value(Value),
    /// Keep the existing array's elements for which the predicate holds,
    /// then append `extra` raw elements. `pretty` selects the routes layout.
    Filter {
        keep: Box<dyn FnMut(&[u8]) -> Result<bool> + Send>,
        extra: Vec<Vec<u8>>,
        pretty: bool,
    },
    /// Rewrite elements in place: `edit` returns replacement bytes for an
    /// element, or None to keep it unchanged.
    Map {
        edit: Box<dyn FnMut(&[u8]) -> Result<Option<Vec<u8>>> + Send>,
        pretty: bool,
    },
}

fn write_array<W: Write>(out: &mut W, items: &mut dyn Iterator<Item = Result<Vec<u8>>>, pretty: bool) -> Result<()> {
    out.write_all(b"[")?;
    let mut any = false;
    for item in items {
        let item = item?;
        if pretty {
            out.write_all(if any { b",\n    " } else { b"\n    " })?;
        } else if any {
            out.write_all(b",")?;
        }
        out.write_all(&item)?;
        any = true;
    }
    if pretty && any {
        out.write_all(b"\n  ")?;
    }
    out.write_all(b"]")?;
    Ok(())
}

/// writeDriveDataJSON. `commit` is consulted after the temp file is complete:
/// returning false discards it and leaves the original untouched.
pub fn write_drive_data(
    path: &Path,
    mut replacements: Vec<(&'static str, Replacement)>,
    commit: &dyn Fn() -> bool,
) -> Result<bool> {
    let mut source = match File::open(path) {
        Ok(f) => Some(f),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let sections = match source.as_ref() {
        Some(f) => scan_sections(f.try_clone()?)?,
        None => Vec::new(),
    };
    if source.is_none() {
        for key in MUTABLE {
            if !replacements.iter().any(|(k, _)| *k == key) {
                let empty = if key == "driveTags" { serde_json::json!({}) } else { serde_json::json!([]) };
                replacements.push((key, Replacement::Value(empty)));
            }
        }
    }
    let tmp = fsutil::temp_path_for(path);
    let result = (|| -> Result<bool> {
        let mut out = BufWriter::with_capacity(1 << 20, File::create(&tmp)?);
        let mut first = true;
        let mut prefix = |out: &mut BufWriter<File>, key: &str| -> Result<()> {
            out.write_all(if first { b"{\n  " } else { b",\n  " })?;
            first = false;
            out.write_all(serde_json::to_string(key)?.as_bytes())?;
            out.write_all(b": ")?;
            Ok(())
        };
        let write_replacement = |out: &mut BufWriter<File>, key: &str, rep: Replacement, existing: Option<&Section>, src: Option<&mut File>| -> Result<()> {
            match rep {
                Replacement::Value(v) => out.write_all(serde_json::to_string(&v)?.as_bytes())?,
                Replacement::Map { mut edit, pretty } => {
                    let mut any = false;
                    out.write_all(b"[")?;
                    if let (Some(sec), Some(src)) = (existing, src) {
                        for_each_array_element(src, sec, |el| {
                            out.write_all(match (pretty, any) {
                                (true, true) => b",\n    ".as_slice(),
                                (true, false) => b"\n    ".as_slice(),
                                (false, true) => b",".as_slice(),
                                (false, false) => b"".as_slice(),
                            })?;
                            match edit(el)? {
                                Some(bytes) => out.write_all(&bytes)?,
                                None => out.write_all(el)?,
                            }
                            any = true;
                            Ok(())
                        })?;
                    }
                    if pretty && any {
                        out.write_all(b"\n  ")?;
                    }
                    out.write_all(b"]")?;
                }
                Replacement::Filter { mut keep, extra, pretty } => {
                    // Streamed straight into `out` to keep memory flat.
                    let mut any = false;
                    out.write_all(b"[")?;
                    let mut emit = |out: &mut BufWriter<File>, bytes: &[u8]| -> Result<()> {
                        if pretty {
                            out.write_all(if any { b",\n    " } else { b"\n    " })?;
                        } else if any {
                            out.write_all(b",")?;
                        }
                        out.write_all(bytes)?;
                        any = true;
                        Ok(())
                    };
                    if let (Some(sec), Some(src)) = (existing, src) {
                        for_each_array_element(src, sec, |el| {
                            if keep(el)? {
                                emit(out, el)?;
                            }
                            Ok(())
                        })?;
                    }
                    for el in extra {
                        emit(out, &el)?;
                    }
                    if pretty && any {
                        out.write_all(b"\n  ")?;
                    }
                    out.write_all(b"]")?;
                }
            }
            let _ = key;
            Ok(())
        };
        let mut pending: Vec<(&'static str, Replacement)> = replacements;
        for s in &sections {
            if let Some(i) = pending.iter().position(|(k, _)| *k == s.key) {
                let (key, rep) = pending.remove(i);
                prefix(&mut out, key)?;
                write_replacement(&mut out, key, rep, Some(s), source.as_mut())?;
            } else {
                prefix(&mut out, &s.key)?;
                let src = source.as_mut().unwrap();
                src.seek(SeekFrom::Start(s.start))?;
                std::io::copy(&mut (&mut *src).take(s.end - s.start), &mut out)?;
            }
        }
        for (key, rep) in pending {
            prefix(&mut out, key)?;
            write_replacement(&mut out, key, rep, None, None)?;
        }
        out.write_all(b"\n}\n")?;
        out.flush()?;
        drop(out);
        drop(source.take());
        let _ = fsutil::fsync_file(&tmp);
        if !fsutil::temp_looks_complete(&tmp) {
            bail!("drive-data write failed its integrity check (incomplete temp); original file left intact");
        }
        if !commit() {
            let _ = std::fs::remove_file(&tmp);
            return Ok(false);
        }
        fsutil::rename_with_retry(&tmp, path)?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// Kept for API symmetry with the JS writer (used by tests).
#[allow(dead_code)]
pub fn write_array_to<W: Write>(out: &mut W, items: Vec<Vec<u8>>, pretty: bool) -> Result<()> {
    write_array(out, &mut items.into_iter().map(Ok), pretty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_tags_and_filters_routes_preserving_other_sections() {
        let dir = std::env::temp_dir().join(format!("sd-writer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("drive-data.json");
        std::fs::write(
            &p,
            r#"{"processedFiles":["a.mp4","b.mp4"],"routes":[{"file":"a.mp4","x":[1,2]},{"file":"b.mp4","s":"]},"}],"extra":{"keep":"me"},"driveTags":{}}"#,
        )
        .unwrap();
        let ok = write_drive_data(
            &p,
            vec![
                ("driveTags", Replacement::Value(serde_json::json!({"2026-01-01T00:00:00": ["work"]}))),
                (
                    "routes",
                    Replacement::Filter {
                        keep: Box::new(|el: &[u8]| Ok(!String::from_utf8_lossy(el).contains("\"b.mp4\""))),
                        extra: vec![],
                        pretty: true,
                    },
                ),
            ],
            &|| true,
        )
        .unwrap();
        assert!(ok);
        let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(v["routes"].as_array().unwrap().len(), 1);
        assert_eq!(v["extra"]["keep"], "me");
        assert_eq!(v["driveTags"]["2026-01-01T00:00:00"][0], "work");
        assert_eq!(v["processedFiles"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
