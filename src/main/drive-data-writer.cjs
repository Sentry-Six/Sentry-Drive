'use strict';

const fs = require('node:fs');
const { finished } = require('node:stream/promises');
const { fsyncFile, tempLooksComplete } = require('../shared/atomic-write.cjs');

const MUTABLE_SECTIONS = new Set(['processedFiles', 'routes', 'driveTags']);
const MAX_SELECTED_SECTION_BYTES = 64 * 1024 * 1024;
let writeSequence = 0;

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

async function scanTopLevelSections(filePath) {
  const sections = [];
  let phase = 'root';
  let position = 0;
  let currentKey = null;
  let valueStart = null;
  let keyBytes = [];
  let escaped = false;
  let containerDepth = 0;
  let inContainerString = false;
  let lastPrimitiveByte = null;

  const record = (end) => {
    sections.push({ key: currentKey, start: valueStart, end });
    currentKey = null;
    valueStart = null;
    phase = 'after-value';
  };

  for await (const chunk of fs.createReadStream(filePath)) {
    for (let offset = 0; offset < chunk.length; offset++, position++) {
      const byte = chunk[offset];

      if (phase === 'root') {
        if (isWhitespace(byte)) continue;
        if (byte !== 0x7b) throw new SyntaxError('drive-data root must be a JSON object');
        phase = 'key';
        continue;
      }

      if (phase === 'key') {
        if (isWhitespace(byte) || byte === 0x2c) continue;
        if (byte === 0x7d) {
          phase = 'done';
          continue;
        }
        if (byte !== 0x22) throw new SyntaxError('invalid top-level JSON key');
        keyBytes = [byte];
        escaped = false;
        phase = 'key-string';
        continue;
      }

      if (phase === 'key-string') {
        keyBytes.push(byte);
        if (escaped) {
          escaped = false;
        } else if (byte === 0x5c) {
          escaped = true;
        } else if (byte === 0x22) {
          currentKey = JSON.parse(Buffer.from(keyBytes).toString('utf8'));
          phase = 'colon';
        }
        continue;
      }

      if (phase === 'colon') {
        if (isWhitespace(byte)) continue;
        if (byte !== 0x3a) throw new SyntaxError('missing colon after top-level JSON key');
        phase = 'value';
        continue;
      }

      if (phase === 'value') {
        if (isWhitespace(byte)) continue;
        valueStart = position;
        if (byte === 0x22) {
          escaped = false;
          phase = 'value-string';
        } else if (byte === 0x7b || byte === 0x5b) {
          containerDepth = 1;
          inContainerString = false;
          escaped = false;
          phase = 'value-container';
        } else {
          lastPrimitiveByte = position;
          phase = 'value-primitive';
        }
        continue;
      }

      if (phase === 'value-string') {
        if (escaped) {
          escaped = false;
        } else if (byte === 0x5c) {
          escaped = true;
        } else if (byte === 0x22) {
          record(position + 1);
        }
        continue;
      }

      if (phase === 'value-container') {
        if (inContainerString) {
          if (escaped) {
            escaped = false;
          } else if (byte === 0x5c) {
            escaped = true;
          } else if (byte === 0x22) {
            inContainerString = false;
          }
        } else if (byte === 0x22) {
          inContainerString = true;
        } else if (byte === 0x7b || byte === 0x5b) {
          containerDepth++;
        } else if (byte === 0x7d || byte === 0x5d) {
          containerDepth--;
          if (containerDepth === 0) record(position + 1);
        }
        continue;
      }

      if (phase === 'value-primitive') {
        if (byte === 0x2c || byte === 0x7d) {
          record(lastPrimitiveByte + 1);
          phase = byte === 0x7d ? 'done' : 'key';
        } else if (!isWhitespace(byte)) {
          lastPrimitiveByte = position;
        }
        continue;
      }

      if (phase === 'after-value') {
        if (isWhitespace(byte)) continue;
        if (byte === 0x2c) {
          phase = 'key';
        } else if (byte === 0x7d) {
          phase = 'done';
        } else {
          throw new SyntaxError('invalid separator after top-level JSON value');
        }
        continue;
      }

      if (phase === 'done' && !isWhitespace(byte)) {
        throw new SyntaxError('unexpected data after drive-data JSON object');
      }
    }
  }

  if (phase !== 'done') throw new SyntaxError('incomplete drive-data JSON object');
  return sections;
}

function writeChunk(stream, chunk) {
  if (stream.errored) return Promise.reject(stream.errored);
  if (stream.destroyed) return Promise.reject(new Error('drive-data output stream closed early'));
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function copyRange(sourcePath, section, output) {
  const stream = fs.createReadStream(sourcePath, {
    start: section.start,
    end: section.end - 1,
  });
  for await (const chunk of stream) await writeChunk(output, chunk);
}

async function readTopLevelValues(filePath, keys, options = {}) {
  const wanted = new Set(keys);
  const maxBytes = options.maxBytes ?? MAX_SELECTED_SECTION_BYTES;
  const sections = await scanTopLevelSections(filePath);
  const values = {};
  const file = await fs.promises.open(filePath, 'r');
  try {
    for (const section of sections) {
      if (!wanted.has(section.key)) continue;
      const length = section.end - section.start;
      if (length > maxBytes) {
        throw new RangeError(`Top-level section "${section.key}" exceeds the read limit`);
      }
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const result = await file.read(
          buffer,
          offset,
          length - offset,
          section.start + offset,
        );
        if (result.bytesRead === 0) throw new Error('Unexpected end of drive-data section');
        offset += result.bytesRead;
      }
      values[section.key] = JSON.parse(buffer.toString('utf8'));
    }
  } finally {
    await file.close();
  }
  return { sections, values };
}

async function renameWithRetry(from, to, attempts = 12) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const transient = error.code === 'EPERM'
        || error.code === 'EBUSY'
        || error.code === 'EACCES';
      if (!transient || attempt >= attempts) throw error;
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(1_500, 40 * 2 ** attempt));
      });
    }
  }
}

async function writeDriveDataJSON(filePath, data, options = {}) {
  const preserveFrom = options.preserveFrom ?? filePath;
  const sourceExists = fs.existsSync(preserveFrom);
  const sourceSections = sourceExists
    ? (options.sourceSections ?? await scanTopLevelSections(preserveFrom))
    : [];
  const replacementKeys = new Set(
    [...MUTABLE_SECTIONS].filter((key) => Object.prototype.hasOwnProperty.call(data, key)),
  );
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${++writeSequence}.tmp`;
  const output = fs.createWriteStream(tempPath);
  const outputDone = finished(output);
  outputDone.catch(() => {});

  try {
    let first = true;
    const writtenReplacements = new Set();
    const writePrefix = async (key) => {
      await writeChunk(output, first ? '{\n  ' : ',\n  ');
      first = false;
      await writeChunk(output, `${JSON.stringify(key)}: `);
    };
    const writeReplacement = async (key) => {
      await writePrefix(key);
      writtenReplacements.add(key);
      if (key !== 'routes') {
        await writeChunk(output, JSON.stringify(data[key] ?? (key === 'driveTags' ? {} : [])));
        return;
      }
      await writeChunk(output, '[');
      const routes = Array.isArray(data.routes) ? data.routes : [];
      for (let index = 0; index < routes.length; index++) {
        const route = options.routeTransform
          ? await options.routeTransform(routes[index])
          : routes[index];
        await writeChunk(output, index === 0 ? '\n    ' : ',\n    ');
        await writeChunk(output, JSON.stringify(route));
      }
      if (routes.length > 0) await writeChunk(output, '\n  ');
      await writeChunk(output, ']');
    };

    if (!sourceExists) {
      for (const key of MUTABLE_SECTIONS) {
        replacementKeys.add(key);
        await writeReplacement(key);
      }
    } else {
      for (const section of sourceSections) {
        if (replacementKeys.has(section.key)) {
          await writeReplacement(section.key);
        } else {
          await writePrefix(section.key);
          await copyRange(preserveFrom, section, output);
        }
      }
      for (const key of replacementKeys) {
        if (!writtenReplacements.has(key)) await writeReplacement(key);
      }
    }
    await writeChunk(output, '\n}\n');
    output.end();
    await outputDone;

    try {
      await fsyncFile(tempPath);
    } catch {
      // Some network shares do not support fsync; structural validation remains mandatory.
    }
    if (!tempLooksComplete(tempPath)) {
      throw new Error(
        'drive-data write failed its integrity check (incomplete temp); original file left intact',
      );
    }
    await renameWithRetry(tempPath, filePath);
    options.onRenamed?.(filePath);
  } catch (error) {
    output.destroy();
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

module.exports = {
  MAX_SELECTED_SECTION_BYTES,
  MUTABLE_SECTIONS,
  readTopLevelValues,
  renameWithRetry,
  scanTopLevelSections,
  writeDriveDataJSON,
};
