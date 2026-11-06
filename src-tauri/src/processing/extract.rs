//! Tesla MP4 SEI metadata extraction (port of src/processing/extract.js) plus
//! the per-file worker step (worker.js) and the run-length helpers from
//! src/shared/drive-calc.cjs (computeGearRuns / computeFlagRuns /
//! computeApRuns).
//!
//! The byte walk mirrors the JavaScript exactly, including its quirks: the
//! varint decoder uses 32-bit JS bit operations, and reads past the end of a
//! truncated buffer behave like `Buffer` (indexing yields `undefined`, while
//! `readUInt32BE` throws and fails the whole file).

use std::io;
use std::path::Path;

use crate::loader::calc::{js_round, ApRun, FlagRun, GearRun};

const FLAG_BLINKER_LEFT: i64 = 1;
const FLAG_BLINKER_RIGHT: i64 = 2;
const FLAG_BRAKE: i64 = 4;
const FLAG_ACCEL: i64 = 8;

/// Raw per-frame telemetry for one clip (extractGPSFromFile's result).
#[derive(Debug, Default)]
pub struct Extracted {
    pub points: Vec<[f64; 2]>,
    pub gears: Vec<u8>,
    pub ap_states: Vec<u8>,
    pub speeds: Vec<f64>,
    pub accel_positions: Vec<f64>,
    pub flags: Vec<i64>,
}

fn out_of_range(offset: usize, len: usize) -> io::Error {
    io::Error::new(
        io::ErrorKind::UnexpectedEof,
        format!("The value of \"offset\" is out of range. It must be >= 0 and <= {}. Received {}", len.saturating_sub(4), offset),
    )
}

fn read_u32_be(buf: &[u8], pos: usize) -> io::Result<u32> {
    match buf.get(pos..pos.saturating_add(4)) {
        Some(b) => Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]])),
        None => Err(out_of_range(pos, buf.len())),
    }
}

/// extractGPSFromFile: `Ok(None)` when the file has no mdat box.
pub fn extract_gps_from_file(path: &Path) -> io::Result<Option<Extracted>> {
    let buf = std::fs::read(path)?;
    extract_gps_from_buffer(&buf)
}

pub fn extract_gps_from_buffer(buf: &[u8]) -> io::Result<Option<Extracted>> {
    match find_mdat_box(buf)? {
        Some((offset, size)) => extract_from_mdat(buf, offset, size).map(Some),
        None => Ok(None),
    }
}

/// findMdatBox: (payload offset, payload size). Sizes are i128 so oversized
/// 64-bit boxes and negative payload sizes behave like JS Numbers.
fn find_mdat_box(buf: &[u8]) -> io::Result<Option<(i128, i128)>> {
    let file_size = buf.len() as i128;
    let mut pos: i128 = 0;
    while pos + 8 <= file_size {
        let p = pos as usize;
        let mut box_size = read_u32_be(buf, p)? as i128;
        let box_type = &buf[p + 4..p + 8];
        let mut header_size = 8;
        if box_size == 1 {
            if pos + 16 > file_size {
                return Ok(None);
            }
            let mut b = [0u8; 8];
            b.copy_from_slice(&buf[p + 8..p + 16]);
            box_size = u64::from_be_bytes(b) as i128;
            header_size = 16;
        } else if box_size == 0 {
            box_size = file_size - pos;
        }
        if box_type == b"mdat" {
            return Ok(Some((pos + header_size, box_size - header_size)));
        }
        if box_size < 8 {
            break;
        }
        pos += box_size;
    }
    Ok(None)
}

fn extract_from_mdat(buf: &[u8], offset: i128, size: i128) -> io::Result<Extracted> {
    let mut out = Extracted::default();
    let end = offset + size;
    let mut cursor = offset;
    while cursor + 4 <= end {
        let nal_size = read_u32_be(buf, cursor as usize)? as i128;
        cursor += 4;
        if nal_size < 2 || cursor + nal_size > end {
            break;
        }
        // buf[cursor] past the end is `undefined`, and `undefined & 0x1f` is 0.
        let nal_type = buf.get(cursor as usize).copied().unwrap_or(0) & 0x1f;
        if nal_type == 6 && nal_size <= 65536 {
            if let Some(r) = parse_tesla_sei(buf, cursor as usize, nal_size as usize) {
                out.points.push([js_round(r.lat * 1e6) / 1e6, js_round(r.lon * 1e6) / 1e6]);
                out.gears.push(r.gear);
                out.ap_states.push(r.ap_state);
                out.speeds.push(js_round(r.speed * 10.0) / 10.0);
                out.accel_positions.push(js_round(r.accel_pos * 100.0) / 100.0);
                out.flags.push(
                    (if r.blinker_left { FLAG_BLINKER_LEFT } else { 0 })
                        | (if r.blinker_right { FLAG_BLINKER_RIGHT } else { 0 })
                        | (if r.brake { FLAG_BRAKE } else { 0 })
                        | (if r.accel_pos > 0.0 { FLAG_ACCEL } else { 0 }),
                );
            }
        }
        cursor += nal_size;
    }
    Ok(out)
}

struct Sei {
    lat: f64,
    lon: f64,
    gear: u8,
    ap_state: u8,
    speed: f64,
    accel_pos: f64,
    blinker_left: bool,
    blinker_right: bool,
    brake: bool,
}

fn parse_tesla_sei(buf: &[u8], nal_offset: usize, nal_size: usize) -> Option<Sei> {
    let at = |i: usize| buf.get(i).copied();
    let nal_end = nal_offset + nal_size;
    let mut i = nal_offset + 3;
    while i < nal_end && at(i) == Some(0x42) {
        i += 1;
    }
    if i <= nal_offset + 3 || i + 1 >= nal_end || at(i) != Some(0x69) {
        return None;
    }
    let payload_start = i + 1;
    let payload_end = nal_end - 1;
    if payload_end <= payload_start {
        return None;
    }
    let stripped = strip_emulation_bytes(buf, payload_start, payload_end);
    decode_sei_gps(&stripped)
}

/// Remove H.264 emulation prevention bytes (0x00 0x00 0x03 → 0x00 0x00).
fn strip_emulation_bytes(buf: &[u8], start: usize, end: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(end - start);
    let mut zeros = 0;
    for i in start..end {
        match buf.get(i).copied() {
            Some(b) => {
                if zeros >= 2 && b == 0x03 {
                    zeros = 0;
                    continue;
                }
                out.push(b);
                zeros = if b == 0 { zeros + 1 } else { 0 };
            }
            // Buffer stores `undefined` as 0, and `undefined === 0` is false.
            None => {
                out.push(0);
                zeros = 0;
            }
        }
    }
    out
}

/// decodeVarint with JS semantics: `|=` and `<<` operate on int32 (shift
/// counts are taken mod 32) and the result is `>>> 0`. (value, consumed).
fn decode_varint(data: &[u8], offset: usize) -> (u32, usize) {
    let mut val: u32 = 0;
    let mut shift: u32 = 0;
    for j in 0..10 {
        let Some(&b) = data.get(offset + j) else { return (0, 0) };
        val |= ((b & 0x7f) as u32).wrapping_shl(shift % 32);
        if b < 0x80 {
            return (val, j + 1);
        }
        shift += 7;
    }
    (0, 0)
}

fn decode_sei_gps(data: &[u8]) -> Option<Sei> {
    let len = data.len();
    let mut i = 0usize;
    let (mut lat, mut lon, mut speed, mut accel_pos) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut gear, mut ap_state) = (0u8, 0u8);
    let (mut blinker_left, mut blinker_right, mut brake) = (false, false, false);

    while i < len {
        let (tag, n) = decode_varint(data, i);
        if n == 0 {
            break;
        }
        i += n;
        let field_num = (tag as i32) >> 3;
        let wire_type = tag & 0x7;
        match wire_type {
            0 => {
                let (val, vn) = decode_varint(data, i);
                if vn == 0 {
                    return None;
                }
                i += vn;
                match field_num {
                    2 => gear = (val & 0xff) as u8,
                    7 => blinker_left = val != 0,
                    8 => blinker_right = val != 0,
                    9 => brake = val != 0,
                    10 => ap_state = (val & 0xff) as u8,
                    _ => {}
                }
            }
            1 => {
                if i + 8 > len {
                    return None;
                }
                let mut b = [0u8; 8];
                b.copy_from_slice(&data[i..i + 8]);
                let val = f64::from_le_bytes(b);
                i += 8;
                if field_num == 11 {
                    lat = val;
                } else if field_num == 12 {
                    lon = val;
                }
            }
            2 => {
                let (length, vn) = decode_varint(data, i);
                if vn == 0 {
                    return None;
                }
                i = i.saturating_add(vn).saturating_add(length as usize);
            }
            5 => {
                if i + 4 > len {
                    return None;
                }
                let mut b = [0u8; 4];
                b.copy_from_slice(&data[i..i + 4]);
                let val = f32::from_le_bytes(b) as f64;
                if field_num == 4 {
                    speed = val;
                } else if field_num == 5 {
                    accel_pos = val;
                }
                i += 4;
            }
            _ => return None,
        }
    }

    let ok = lat.is_finite() && lon.is_finite() && !(lat == 0.0 && lon == 0.0) && lat.abs() <= 90.0 && lon.abs() <= 180.0;
    if !ok {
        return None;
    }
    Some(Sei { lat, lon, gear, ap_state, speed, accel_pos, blinker_left, blinker_right, brake })
}

// ── drive-calc.cjs run-length helpers ───────────────────────────────────────

pub fn compute_gear_runs(gears: &[u8]) -> Vec<GearRun> {
    rle(gears).into_iter().map(|(g, n)| GearRun { gear: Some(g as i64), frames: n as f64 }).collect()
}

pub fn compute_ap_runs(ap_states: &[u8]) -> Vec<ApRun> {
    rle(ap_states).into_iter().map(|(a, n)| ApRun { ap: Some(a as i64), frames: n as f64 }).collect()
}

fn rle(values: &[u8]) -> Vec<(u8, usize)> {
    let mut runs: Vec<(u8, usize)> = Vec::new();
    for &v in values {
        match runs.last_mut() {
            Some((cur, n)) if *cur == v => *n += 1,
            _ => runs.push((v, 1)),
        }
    }
    runs
}

/// computeFlagRuns(flags, speeds) with speeds present: every run carries the
/// rounded max |speed| over its frames. NaN behaves as in JS (a NaN first
/// frame sticks, because `a > NaN` is false).
pub fn compute_flag_runs(flags: &[i64], speeds: &[f64]) -> Vec<FlagRun> {
    let mut runs = Vec::new();
    if flags.is_empty() {
        return runs;
    }
    let r1 = |v: f64| js_round(v * 10.0) / 10.0;
    let speed_at = |i: usize| speeds.get(i).copied().unwrap_or(0.0).abs();
    let mut current = flags[0];
    let mut count = 1usize;
    let mut max_abs = speed_at(0);
    for (i, &flag) in flags.iter().enumerate().skip(1) {
        if flag == current {
            count += 1;
            let a = speed_at(i);
            if a > max_abs {
                max_abs = a;
            }
        } else {
            runs.push(FlagRun { flags: current, frames: count as f64, max_mps: Some(r1(max_abs)) });
            current = flag;
            count = 1;
            max_abs = speed_at(i);
        }
    }
    runs.push(FlagRun { flags: current, frames: count as f64, max_mps: Some(r1(max_abs)) });
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sei_nal(payload: &[u8]) -> Vec<u8> {
        // NAL header (type 6), SEI type/size bytes, 0x42 marker run, 0x69, payload, trailing byte.
        let mut nal = vec![0x06, 0x05, 0x10, 0x42, 0x42, 0x42, 0x69];
        nal.extend_from_slice(payload);
        nal.push(0x80);
        nal
    }

    fn proto(lat: f64, lon: f64, gear: u8, speed: f32, accel: f32) -> Vec<u8> {
        let mut p = vec![0x10, gear]; // field 2 varint
        p.push(0x25); // field 4, wire 5
        p.extend_from_slice(&speed.to_le_bytes());
        p.push(0x2d); // field 5, wire 5
        p.extend_from_slice(&accel.to_le_bytes());
        p.extend_from_slice(&[0x38, 0x01]); // field 7 blinker left
        p.extend_from_slice(&[0x50, 0x01]); // field 10 ap = FSD
        p.push(0x59); // field 11, wire 1
        p.extend_from_slice(&lat.to_le_bytes());
        p.push(0x61); // field 12, wire 1
        p.extend_from_slice(&lon.to_le_bytes());
        p
    }

    fn mp4(nals: &[Vec<u8>]) -> Vec<u8> {
        let mut mdat = Vec::new();
        for n in nals {
            mdat.extend_from_slice(&(n.len() as u32).to_be_bytes());
            mdat.extend_from_slice(n);
        }
        let mut file = Vec::new();
        file.extend_from_slice(&16u32.to_be_bytes());
        file.extend_from_slice(b"ftypisom\0\0\0\0");
        file.extend_from_slice(&((mdat.len() + 8) as u32).to_be_bytes());
        file.extend_from_slice(b"mdat");
        file.extend_from_slice(&mdat);
        file
    }

    #[test]
    fn decodes_sei_frames_and_skips_other_nals() {
        let f = mp4(&[
            vec![0x65, 1, 2, 3],
            sei_nal(&proto(53.5461234567, -113.4938765432, 1, 12.345, 0.256)),
            sei_nal(&proto(0.0, 0.0, 0, 0.0, 0.0)), // null island: dropped
        ]);
        let x = extract_gps_from_buffer(&f).unwrap().unwrap();
        assert_eq!(x.points, vec![[53.546123, -113.493877]]);
        assert_eq!(x.gears, vec![1]);
        assert_eq!(x.ap_states, vec![1]);
        assert_eq!(x.speeds, vec![12.3]);
        assert_eq!(x.accel_positions, vec![0.26]);
        assert_eq!(x.flags, vec![FLAG_BLINKER_LEFT | FLAG_ACCEL]);
    }

    #[test]
    fn truncated_mdat_fails_like_buffer_read() {
        let mut f = mp4(&[vec![0x65, 1, 2, 3], vec![0x65, 1, 2, 3]]);
        // Claim a larger mdat than the file holds.
        let mdat_at = 16;
        f[mdat_at..mdat_at + 4].copy_from_slice(&1000u32.to_be_bytes());
        f.truncate(f.len() - 2);
        assert!(extract_gps_from_buffer(&f).is_err());
        assert!(extract_gps_from_buffer(b"no boxes here").unwrap().is_none());
    }

    #[test]
    fn varint_uses_int32_shift_semantics() {
        // 5-byte varint: bits beyond 32 wrap like JS `<<`.
        assert_eq!(decode_varint(&[0xff, 0xff, 0xff, 0xff, 0x7f], 0), (u32::MAX, 5));
        assert_eq!(decode_varint(&[0x80], 0), (0, 0));
    }

    #[test]
    fn run_length_helpers_match_drive_calc() {
        let g = compute_gear_runs(&[0, 0, 1, 1, 1, 0]);
        assert_eq!(g.iter().map(|r| (r.gear.unwrap(), r.frames)).collect::<Vec<_>>(), vec![(0, 2.0), (1, 3.0), (0, 1.0)]);
        let f = compute_flag_runs(&[1, 1, 4], &[0.25, -3.04, 2.0]);
        assert_eq!(f.iter().map(|r| (r.flags, r.frames, r.max_mps.unwrap())).collect::<Vec<_>>(), vec![(1, 2.0, 3.0), (4, 1.0, 2.0)]);
        assert!(compute_ap_runs(&[]).is_empty());
    }
}
