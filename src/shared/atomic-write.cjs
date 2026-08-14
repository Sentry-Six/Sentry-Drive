'use strict';
// Integrity checks used before atomically replacing drive-data.json.
const fs = require('fs');

// Windows FlushFileBuffers requires a writable handle. Callers tolerate fsync
// failures on network filesystems; tempLooksComplete remains mandatory.
async function fsyncFile(filePath) {
  const fh = await fs.promises.open(filePath, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Detect truncated serializer output without reparsing a potentially huge file.
// This intentionally does not detect mid-file corruption: append-only writers
// do not produce it, while a complete reparse would double save-time I/O.
function tempLooksComplete(filePath) {
  let fd;
  try {
    const { size } = fs.statSync(filePath);
    // The smallest valid serializer output is roughly 45 bytes.
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
