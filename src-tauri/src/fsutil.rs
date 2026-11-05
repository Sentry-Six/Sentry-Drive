//! Atomic-replace helpers (port of `src/shared/atomic-write.cjs` and
//! `renameWithRetry` from drive-data-writer.cjs).

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::Result;

static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn temp_path_for(path: &Path) -> PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{}.{}.{}.tmp", std::process::id(), millis, SEQ.fetch_add(1, Ordering::Relaxed) + 1));
    PathBuf::from(name)
}

pub fn fsync_file(path: &Path) -> std::io::Result<()> {
    OpenOptions::new().read(true).write(true).open(path)?.sync_all()
}

/// Truncation check without reparsing: starts with `{`, ends with `}`.
pub fn temp_looks_complete(path: &Path) -> bool {
    let Ok(mut f) = File::open(path) else { return false };
    let Ok(size) = f.metadata().map(|m| m.len()) else { return false };
    if size < 20 {
        return false;
    }
    let mut first = [0u8; 1];
    if f.read_exact(&mut first).is_err() || first[0] != b'{' {
        return false;
    }
    let tail_len = size.min(16);
    let mut tail = vec![0u8; tail_len as usize];
    if f.seek(SeekFrom::Start(size - tail_len)).is_err() || f.read_exact(&mut tail).is_err() {
        return false;
    }
    String::from_utf8_lossy(&tail).trim_end().ends_with('}')
}

pub fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0u32;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let transient = matches!(e.kind(), std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ResourceBusy);
                if !transient || attempt >= 12 {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis((40u64 << attempt).min(1500)));
                attempt += 1;
            }
        }
    }
}

/// Write via temp file + fsync + rename.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = temp_path_for(path);
    let result = (|| -> Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        let _ = f.sync_all();
        drop(f);
        rename_with_retry(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Best-effort JSON settings read.
pub fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Ports of `src/shared/atomic-write.test.js`, against real temporary files.
#[cfg(test)]
mod tests {
    use super::*;

    struct TmpFile(PathBuf);

    impl Drop for TmpFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn tmp_file(contents: &str) -> TmpFile {
        let p = std::env::temp_dir().join(format!("sd-aw-test-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&p, contents).unwrap();
        TmpFile(p)
    }

    fn missing() -> PathBuf {
        std::env::temp_dir().join(format!("sd-aw-missing-{}.tmp", uuid::Uuid::new_v4()))
    }

    #[test]
    fn temp_looks_complete_accepts_a_complete_pretty_printed_document() {
        let f = tmp_file("{\n  \"processedFiles\": [],\n  \"routes\": [],\n  \"driveTags\": {}\n}\n");
        assert!(temp_looks_complete(&f.0));
    }

    #[test]
    fn temp_looks_complete_accepts_a_compact_document_without_trailing_newline() {
        let f = tmp_file(r#"{"processedFiles":[],"routes":[],"driveTags":{}}"#);
        assert!(temp_looks_complete(&f.0));
    }

    #[test]
    fn temp_looks_complete_accepts_a_populated_document() {
        let f = tmp_file(r#"{"processedFiles":["a/b.mp4"],"routes":[{"file":"a/b.mp4","points":[[1,2]]}],"driveTags":{}}"#);
        assert!(temp_looks_complete(&f.0));
    }

    #[test]
    fn temp_looks_complete_rejects_a_truncated_write() {
        let f = tmp_file(r#"{"processedFiles":[],"routes":[{"file":"a","points":[[1,2],[3,4"#);
        assert!(!temp_looks_complete(&f.0));
    }

    #[test]
    fn temp_looks_complete_rejects_an_empty_file() {
        let f = tmp_file("");
        assert!(!temp_looks_complete(&f.0));
    }

    #[test]
    fn temp_looks_complete_rejects_a_tiny_file_under_the_size_floor() {
        let f = tmp_file("{}");
        assert!(!temp_looks_complete(&f.0));
    }

    #[test]
    fn temp_looks_complete_rejects_content_not_starting_with_a_brace() {
        let f = tmp_file("garbage that happens to be long enough to pass the size floor }");
        assert!(!temp_looks_complete(&f.0));
    }

    #[test]
    fn temp_looks_complete_rejects_a_missing_file() {
        assert!(!temp_looks_complete(&missing()));
    }

    #[test]
    fn fsync_file_flushes_a_real_file() {
        let f = tmp_file(r#"{"processedFiles":[],"routes":[],"driveTags":{}}"#);
        fsync_file(&f.0).expect("fsync");
    }

    #[test]
    fn fsync_file_fails_on_a_missing_file() {
        assert!(fsync_file(&missing()).is_err());
    }
}
