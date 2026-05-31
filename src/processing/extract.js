// extract.js - MP4 parsing and GPS extraction from Tesla SEI metadata
// Faithful port of Sentry-USB server/drives/extract.go
// Optimized: reads entire file into memory for fast NAS access

import { readFile } from "node:fs/promises";

// Gear and autopilot enums are defined once in the shared single-source calc
// module; re-export them here so existing `./extract.js` importers (grouper.js,
// worker.js) keep working unchanged.
export {
  GEAR_PARK,
  GEAR_DRIVE,
  GEAR_REVERSE,
  GEAR_NEUTRAL,
  AUTOPILOT_OFF,
  AUTOPILOT_FSD,
  AUTOPILOT_AUTOSTEER,
  AUTOPILOT_TACC,
} from "../shared/drive-calc.cjs";

/**
 * Extract GPS points, gear states, autopilot states, speeds, and accel positions
 * from a Tesla dashcam front-camera MP4 file.
 */
export async function extractGPSFromFile(path) {
  const buf = await readFile(path);
  const fileSize = buf.length;

  const mdat = findMdatBox(buf, fileSize);
  if (!mdat) return null;

  return extractFromMdat(buf, mdat.offset, mdat.size);
}

/**
 * Scan MP4 top-level boxes to find the mdat box.
 */
function findMdatBox(buf, fileSize) {
  let pos = 0;

  while (pos + 8 <= fileSize) {
    let boxSize = buf.readUInt32BE(pos);
    const boxType = buf.toString("ascii", pos + 4, pos + 8);
    let headerSize = 8;

    if (boxSize === 1) {
      if (pos + 16 > fileSize) return null;
      boxSize = Number(buf.readBigUInt64BE(pos + 8));
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = fileSize - pos;
    }

    if (boxType === "mdat") {
      return { offset: pos + headerSize, size: boxSize - headerSize };
    }

    if (boxSize < 8) break;
    pos += boxSize;
  }

  return null;
}

/**
 * Read through the mdat box parsing NAL units and extracting GPS from SEI.
 */
function extractFromMdat(buf, offset, size) {
  const points = [];
  const gears = [];
  const apStates = [];
  const speeds = [];
  const accelPositions = [];

  const end = offset + size;
  let cursor = offset;

  while (cursor + 4 <= end) {
    const nalSize = buf.readUInt32BE(cursor);
    cursor += 4;

    if (nalSize < 2 || cursor + nalSize > end) break;

    const nalType = buf[cursor] & 0x1f;

    // NAL type 6 = SEI
    if (nalType === 6 && nalSize <= 65536) {
      const result = parseTeslaSEI(buf, cursor, nalSize);
      if (result) {
        points.push([
          Math.round(result.lat * 1e6) / 1e6,
          Math.round(result.lon * 1e6) / 1e6,
        ]);
        gears.push(result.gear);
        apStates.push(result.apState);
        speeds.push(Math.round(result.speed * 10) / 10);
        accelPositions.push(Math.round(result.accelPos * 100) / 100);
      }
    }

    cursor += nalSize;
  }

  return { points, gears, apStates, speeds, accelPositions };
}

/**
 * Find Tesla magic bytes (0x42...0x69) in a SEI NAL and decode GPS + gear + autopilot + speed + accel.
 */
function parseTeslaSEI(buf, nalOffset, nalSize) {
  // Skip NAL header, look for 0x42 sequence followed by 0x69
  let i = nalOffset + 3;
  const nalEnd = nalOffset + nalSize;
  while (i < nalEnd && buf[i] === 0x42) {
    i++;
  }
  if (i <= nalOffset + 3 || i + 1 >= nalEnd || buf[i] !== 0x69) {
    return null;
  }

  // Payload starts after 0x69, ends before trailing byte
  const payloadStart = i + 1;
  const payloadEnd = nalEnd - 1;
  if (payloadEnd <= payloadStart) return null;

  const stripped = stripEmulationBytes(buf, payloadStart, payloadEnd);
  return decodeSeiGPS(stripped);
}

/**
 * Remove H.264 emulation prevention bytes (0x00 0x00 0x03 → 0x00 0x00).
 */
function stripEmulationBytes(buf, start, end) {
  const out = Buffer.allocUnsafe(end - start);
  let outLen = 0;
  let zeros = 0;
  for (let i = start; i < end; i++) {
    const b = buf[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out[outLen++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, outLen);
}

/**
 * Decode protobuf SeiMetadata to extract lat (field 11), lon (field 12),
 * gear_state (field 2), autopilot_state (field 10), vehicle_speed_mps (field 4),
 * accelerator_pedal_position (field 5).
 */
function decodeSeiGPS(data) {
  let i = 0;
  let lat = 0, lon = 0, gear = 0, apState = 0, speed = 0, accelPos = 0;
  const len = data.length;

  while (i < len) {
    const [tag, n] = decodeVarint(data, i, len);
    if (n === 0) break;
    i += n;

    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;

    switch (wireType) {
      case 0: { // varint
        const [val, vn] = decodeVarint(data, i, len);
        if (vn === 0) return null;
        i += vn;
        if (fieldNum === 2) gear = val & 0xff;
        else if (fieldNum === 10) apState = val & 0xff;
        break;
      }
      case 1: { // 64-bit (fixed64, double)
        if (i + 8 > len) return null;
        const val = data.readDoubleLE(i);
        i += 8;
        if (fieldNum === 11) lat = val;
        else if (fieldNum === 12) lon = val;
        break;
      }
      case 2: { // length-delimited
        const [length, vn] = decodeVarint(data, i, len);
        if (vn === 0) return null;
        i += vn + Number(length);
        break;
      }
      case 5: { // 32-bit (fixed32, float)
        if (i + 4 > len) return null;
        if (fieldNum === 4) speed = data.readFloatLE(i);
        else if (fieldNum === 5) accelPos = data.readFloatLE(i);
        i += 4;
        break;
      }
      default:
        return null;
    }
  }

  const ok =
    !Number.isNaN(lat) && !Number.isNaN(lon) &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    !(lat === 0 && lon === 0) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  if (!ok) return null;
  return { lat, lon, gear, apState, speed, accelPos };
}

/**
 * Decode a protobuf varint. Returns [value, bytesConsumed].
 */
function decodeVarint(data, offset, dataLen) {
  let val = 0;
  let shift = 0;
  for (let j = 0; j < 10; j++) {
    if (offset + j >= dataLen) return [0, 0];
    const b = data[offset + j];
    val |= (b & 0x7f) << shift;
    if (b < 0x80) {
      return [val >>> 0, j + 1];
    }
    shift += 7;
  }
  return [0, 0];
}
