'use strict';
// Integrity guards for the atomic drive-data.json writers — the streaming
// writer in src/processing/process.js and writeDriveDataJSON in
// src/main/electron-main.cjs. Both serialize a single JSON object to a temp
// file and then rename it over the real file. These two helpers run BETWEEN
// the write and the rename, so a power loss or a truncated write cannot
// replace good drive data with a corrupt file.
//
// CommonJS (like drive-calc.cjs) so the CJS main process can `require` it and
// the ESM processing scripts can `import` it.
const fs = require('fs');

// Flush a file's buffered data to physical disk. Reopened with write access
// ('r+') because Windows FlushFileBuffers needs a writable handle. Async so a
// large flush over a network share never blocks Electron's main thread.
//
// Best-effort: some network filesystems reject fsync, so callers treat a
// rejection as non-fatal — tempLooksComplete() below is the hard guard.
async function fsyncFile(filePath) {
  const fh = await fs.promises.open(filePath, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Cheap structural check that a freshly written temp holds a COMPLETE JSON
// object: non-trivial size, opens with "{", and — ignoring trailing
// whitespace — ends with "}". The drive-data serializers always emit exactly
// that shape, so a write truncated by a full disk or a dropped network share
// (cut off before the closing brace) is caught here without re-parsing a file
// that can exceed 100 MB.
//
// It deliberately does NOT detect mid-file corruption: an append-only stream
// writer doesn't produce that, and a full re-parse would cost a second read
// of the whole file on every save. Truncation is the realistic failure mode.
function tempLooksComplete(filePath) {
  let fd;
  try {
    const { size } = fs.statSync(filePath);
    // The smallest document the serializers emit (everything empty) is ~45
    // bytes; anything under 20 is an empty/near-empty truncated write.
    if (size < 20) return false;
    fd = fs.openSync(filePath, 'r');
    const first = Buffer.alloc(1);
    fs.readSync(fd, first, 0, 1, 0);
    if (first.toString('utf8') !== '{') return false;
    const tailLen = Math.min(16, size);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    return tail.toString('utf8').replace(/\s+$/, '').endsWith('}');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }
}

module.exports = { fsyncFile, tempLooksComplete };
