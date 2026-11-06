//! Clip discovery: find RecentClips front-camera clips plus the
//! SavedClips/SentryClips event clips that fill RecentClips holes.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use crate::loader::route::{is_event_folder_path, normalize_clip_path, parse_clip_timestamp_ms, select_gap_fill, GapCandidate};

#[derive(Clone, Debug)]
pub struct ClipFile {
    pub relative_path: String,
    pub full_path: PathBuf,
    pub date_dir: String,
}

#[derive(Debug)]
pub struct Discovery {
    pub files: Vec<ClipFile>,
    pub recent_count: usize,
    pub gap_fill_count: usize,
}

struct Found {
    file: ClipFile,
    timestamp_ms: i64,
}

fn resolve_roots(clips_dir: &Path) -> (PathBuf, PathBuf) {
    let resolved = std::path::absolute(clips_dir).unwrap_or_else(|_| clips_dir.to_path_buf());
    let base = resolved.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if base == "recentclips" {
        let parent = resolved.parent().map(Path::to_path_buf).unwrap_or_else(|| resolved.clone());
        return (resolved, parent);
    }
    let nested = resolved.join("RecentClips");
    if nested.is_dir() {
        return (nested, resolved);
    }
    (resolved.clone(), resolved)
}

fn is_date_prefix(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

/// Sort by timestamp, then path. (JS breaks ties with localeCompare; paths
/// with equal timestamps differ only in folder names, compared here bytewise.)
fn sort_found(files: &mut [Found]) {
    files.sort_by(|a, b| a.timestamp_ms.cmp(&b.timestamp_ms).then_with(|| a.file.relative_path.cmp(&b.file.relative_path)));
}

/// walkFrontFiles. `rel_prefix` is the path of `root` relative to the
/// `relativeTo` directory ("" or "SavedClips"/"SentryClips").
fn walk_front_files(root: &Path, rel_prefix: &str, cutoff_date: &str, skip_event_dirs: bool, optional: bool) -> io::Result<Vec<Found>> {
    let mut files = Vec::new();
    let root_entries = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) => {
            if optional {
                return Ok(files);
            }
            return Err(e);
        }
    };

    fn walk(dir_entries: std::fs::ReadDir, rel: &str, cutoff: &str, skip_event_dirs: bool, files: &mut Vec<Found>) {
        for entry in dir_entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let full_path = entry.path();
            let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            // Dirent semantics: symlinks are neither files nor directories.
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if skip_event_dirs && (name == "SavedClips" || name == "SentryClips") {
                    continue;
                }
                if let Ok(children) = std::fs::read_dir(&full_path) {
                    walk(children, &rel_path, cutoff, skip_event_dirs, files);
                }
                continue;
            }
            if !ft.is_file() || !name.ends_with("-front.mp4") {
                continue;
            }
            let date_dir: String = name.chars().take(10).collect();
            if !is_date_prefix(&date_dir) || date_dir.as_str() < cutoff {
                continue;
            }
            let relative_path = normalize_clip_path(&rel_path);
            let Some(timestamp_ms) = parse_clip_timestamp_ms(&relative_path) else { continue };
            files.push(Found { file: ClipFile { relative_path, full_path, date_dir }, timestamp_ms });
        }
    }

    walk(root_entries, rel_prefix, cutoff_date, skip_event_dirs, &mut files);
    sort_found(&mut files);
    Ok(files)
}

/// discoverProcessingFiles. `on_progress(current, total)` fires once after
/// the RecentClips walk, as in JS.
pub fn discover_processing_files(
    clips_dir: &Path,
    cutoff_date: &str,
    processed_files: &[String],
    on_progress: &mut dyn FnMut(usize, usize),
) -> io::Result<Discovery> {
    let (recent_root, tesla_cam_root) = resolve_roots(clips_dir);
    let recent_files = walk_front_files(&recent_root, "", cutoff_date, true, false)?;
    on_progress(recent_files.len(), recent_files.len());

    let processed: HashSet<String> = processed_files.iter().map(|f| normalize_clip_path(f)).collect();
    let mut recent_ms: Vec<i64> = recent_files.iter().map(|f| f.timestamp_ms).collect();
    for file in &processed {
        if is_event_folder_path(file) {
            continue;
        }
        if let Some(ts) = parse_clip_timestamp_ms(file) {
            recent_ms.push(ts);
        }
    }
    recent_ms.sort_unstable();
    recent_ms.dedup();

    let mut event_files: Vec<Found> = Vec::new();
    for folder in ["SavedClips", "SentryClips"] {
        let found = walk_front_files(&tesla_cam_root.join(folder), folder, cutoff_date, false, true)?;
        event_files.extend(found.into_iter().filter(|f| !processed.contains(&f.file.relative_path)));
    }
    sort_found(&mut event_files);

    let candidates: Vec<GapCandidate> = event_files
        .iter()
        .map(|f| GapCandidate { timestamp_ms: f.timestamp_ms, file: f.file.relative_path.clone(), driving: true })
        .collect();
    let selected = select_gap_fill(&recent_ms, &candidates);
    let gap_fill_count = selected.len();
    let recent_count = recent_files.len();

    let mut chosen: Vec<Option<Found>> = event_files.into_iter().map(Some).collect();
    let mut files: Vec<Found> = recent_files;
    for ci in selected {
        if let Some(f) = chosen[ci].take() {
            files.push(f);
        }
    }
    sort_found(&mut files);

    Ok(Discovery { files: files.into_iter().map(|f| f.file).collect(), recent_count, gap_fill_count })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    fn rels(d: &Discovery) -> Vec<&str> {
        d.files.iter().map(|f| f.relative_path.as_str()).collect()
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sd-discovery-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn discovers_the_same_bounded_gap_fill_from_recentclips_and_teslacam_roots() {
        let root = scratch("a");
        for rel in [
            "RecentClips/2025-11-30/2025-11-30_09-00-00-front.mp4",
            "RecentClips/2026-07-27/2026-07-27_14-01-02-front.mp4",
            "RecentClips/2026-07-27/2026-07-27_14-03-02-front.mp4",
            "SavedClips/2025-11-30_09-05-00/2025-11-30_09-01-00-front.mp4",
            "SavedClips/2026-07-27_14-12-29/2026-07-27_14-02-02-front.mp4",
            "SentryClips/2026-07-27_17-10-00/2026-07-27_17-00-00-front.mp4",
            "SentryClips/2026-07-27_17-10-00/2026-07-27_17-01-00-front.mp4",
        ] {
            touch(&root, rel);
        }
        let expected = vec![
            "2026-07-27/2026-07-27_14-01-02-front.mp4",
            "SavedClips/2026-07-27_14-12-29/2026-07-27_14-02-02-front.mp4",
            "2026-07-27/2026-07-27_14-03-02-front.mp4",
        ];
        let mut progress = Vec::new();
        let direct = discover_processing_files(&root.join("RecentClips"), "2025-12-01", &[], &mut |c, t| progress.push((c, t))).unwrap();
        let tesla_cam = discover_processing_files(&root, "2025-12-01", &[], &mut |_, _| {}).unwrap();
        assert_eq!(rels(&direct), expected);
        assert_eq!(rels(&tesla_cam), expected);
        assert_eq!(progress, vec![(2, 2)]);
        assert_eq!(direct.recent_count, 2);
        assert_eq!(direct.gap_fill_count, 1);
        assert_eq!(direct.files[1].date_dir, "2026-07-27");
        assert_eq!(direct.files[1].full_path, root.join("SavedClips/2026-07-27_14-12-29/2026-07-27_14-02-02-front.mp4"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn processed_normal_paths_anchor_holes_after_their_clips_rotate_off_disk() {
        let root = scratch("b");
        touch(&root, "RecentClips/2026-07-27/2026-07-27_10-02-00-front.mp4");
        touch(&root, "SavedClips/2026-07-27_10-03-00/2026-07-27_10-01-00-front.mp4");
        let processed = vec!["RecentClips\\2026-07-27\\2026-07-27_10-00-00-front.mp4".to_string()];
        let found = discover_processing_files(&root, "2025-12-01", &processed, &mut |_, _| {}).unwrap();
        assert_eq!(
            rels(&found),
            vec!["SavedClips/2026-07-27_10-03-00/2026-07-27_10-01-00-front.mp4", "2026-07-27/2026-07-27_10-02-00-front.mp4"]
        );
        assert_eq!(found.gap_fill_count, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn already_processed_event_candidates_are_not_selected_again() {
        let root = scratch("c");
        touch(&root, "RecentClips/2026-07-27/2026-07-27_10-00-00-front.mp4");
        touch(&root, "RecentClips/2026-07-27/2026-07-27_10-02-00-front.mp4");
        touch(&root, "SavedClips/2026-07-27_10-03-00/2026-07-27_10-01-00-front.mp4");
        let processed = vec!["SavedClips\\2026-07-27_10-03-00\\2026-07-27_10-01-00-front.mp4".to_string()];
        let found = discover_processing_files(&root, "2025-12-01", &processed, &mut |_, _| {}).unwrap();
        assert_eq!(rels(&found), vec!["2026-07-27/2026-07-27_10-00-00-front.mp4", "2026-07-27/2026-07-27_10-02-00-front.mp4"]);
        assert_eq!(found.gap_fill_count, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_optional_event_roots_do_not_prevent_normal_discovery() {
        let root = scratch("d");
        touch(&root, "RecentClips/2026-07-27/2026-07-27_10-00-00-front.mp4");
        std::fs::write(root.join("SavedClips"), b"").unwrap();
        let found = discover_processing_files(&root.join("RecentClips"), "2025-12-01", &[], &mut |_, _| {}).unwrap();
        assert_eq!(rels(&found), vec!["2026-07-27/2026-07-27_10-00-00-front.mp4"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_recent_root_is_an_error() {
        let root = scratch("e").join("nope");
        assert!(discover_processing_files(&root, "2025-12-01", &[], &mut |_, _| {}).is_err());
    }
}
