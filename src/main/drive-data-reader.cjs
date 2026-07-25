// Shared reader for drive-data.json — the single entry point for every read.
//
// Two strategies, picked by file size:
//
//   • FAST (≤ FAST_PARSE_LIMIT_BYTES): stream the raw bytes into memory (so a
//     progress bar can run), then one native JSON.parse. ~16x faster than
//     token streaming (measured: 130 MB in 1.2 s vs 18.8 s).
//   • STREAMING (above the limit): stream-json token pipeline, building one
//     route at a time. Slower, but never materializes the file as a single
//     V8 string — strings cap at ~512 MiB, which is exactly why the fast
//     path can't be used for everything.
//
// Both paths return the same shape:
//   { processedFiles, processedFileCount, routes, driveTags }
// `processedFiles` is only populated when `wantProcessedFiles: true` (write
// paths need it preserved for writeDriveDataJSON; the load/display path only
// needs the count). The streaming path skips collecting the strings unless
// asked, matching the old behavior.
//
// This module replaced the JSON.parse(readFileSync(...)) calls scattered
// through electron-main.cjs — those crashed outright on >512 MiB files
// (ERR_STRING_TOO_LONG) because they predated the streaming loader.

const fs = require('fs');
const { chain } = require('stream-chain');
// stream-json 3.x is ESM-only; require() returns the module namespace, so
// destructure the factory/class. The root default is parserStream (a Duplex
// factory), not the chain-stage parser — don't use it here.
const { parser } = require('stream-json/parser.js');
// The Assembler export shape changed across stream-json releases: newer
// builds export the class as the module itself (with an `assembler` factory
// attached), older ones as a named export. Accept both so a dependency bump
// can't silently break the streaming fallback again.
const AssemblerModule = require('stream-json/assembler.js');
const Assembler = AssemblerModule.Assembler ?? AssemblerModule;

// Safely below V8's ~512 MiB max-string-length, with margin for multi-byte
// UTF-8 (byte size >= char count, so a 480 MB file is always parseable).
const FAST_PARSE_LIMIT_BYTES = 480 * 1024 * 1024;

// Stream the file into buffer chunks (driving onProgress), then parse natively.
function readFast(filePath, totalBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytesRead = 0;
    let lastEmit = 0;
    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => {
      chunks.push(chunk);
      bytesRead += chunk.length;
      if (onProgress) {
        const now = Date.now();
        if (now - lastEmit >= 100) {
          lastEmit = now;
          onProgress(bytesRead, totalBytes);
        }
      }
    });
    rs.on('end', () => {
      try {
        // The final parse is synchronous (~1-4 s at the size cap); the
        // renderer lives in its own process so the UI stays responsive.
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        chunks.length = 0;
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
    rs.on('error', reject);
  });
}

// Token-streaming reader (the original OOM-safe path), one stream, one pass.
function readStreaming(filePath, totalBytes, onProgress, wantProcessedFiles) {
  return new Promise((resolve, reject) => {
    let processedFileCount = 0;
    const processedFiles = wantProcessedFiles ? [] : null;
    const routes = [];
    let driveTags = {};

    // depth: 1 = inside top-level object; 2 = inside a top-level field's
    // value (array or object); 3 = inside a route element.
    let depth = 0;
    let currentTopKey = null;
    let asm = null;             // sub-assembler for current route or driveTags
    let asmExitDepth = -1;      // depth at which asm completes

    let bytesRead = 0;
    let lastEmit = 0;

    const readStream = fs.createReadStream(filePath);
    if (onProgress) {
      readStream.on('data', (chunk) => {
        bytesRead += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 100) {
          lastEmit = now;
          onProgress(bytesRead, totalBytes);
        }
      });
    }

    const pipeline = chain([
      readStream,
      parser({ packKeys: true, packStrings: true, packNumbers: true }),
    ]);

    pipeline.on('data', (token) => {
      const name = token.name;

      if (asm) {
        asm.consume(token);
        if (name === 'startObject' || name === 'startArray') depth++;
        else if (name === 'endObject' || name === 'endArray') {
          depth--;
          if (depth === asmExitDepth) {
            if (currentTopKey === 'routes') routes.push(asm.current);
            else if (currentTopKey === 'driveTags') driveTags = asm.current;
            asm = null;
          }
        }
        return;
      }

      if (name === 'startObject' || name === 'startArray') {
        const before = depth;
        depth++;
        // Start assembling a route element (object at depth 3, inside routes array).
        if (before === 2 && name === 'startObject' && currentTopKey === 'routes') {
          asm = new Assembler();
          asmExitDepth = before;
          asm.consume(token);
        }
        // Start assembling the driveTags object (object at depth 2, value of driveTags key).
        else if (before === 1 && name === 'startObject' && currentTopKey === 'driveTags') {
          asm = new Assembler();
          asmExitDepth = before;
          asm.consume(token);
        }
      } else if (name === 'endObject' || name === 'endArray') {
        depth--;
        if (depth === 1) currentTopKey = null;
      } else if (name === 'keyValue' && depth === 1) {
        currentTopKey = token.value;
      } else if (name === 'stringValue' && depth === 2 && currentTopKey === 'processedFiles') {
        processedFileCount++;
        if (processedFiles) processedFiles.push(token.value);
      }
    });

    pipeline.on('end', () => {
      resolve({
        processedFiles: processedFiles ?? [],
        processedFileCount,
        routes,
        driveTags,
      });
    });
    pipeline.on('error', reject);
  });
}

/**
 * Read drive-data.json with the fastest safe strategy for its size.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {boolean} [opts.wantProcessedFiles] include the processedFiles array
 *   (required by every path that rewrites the file). Default false.
 * @param {(bytesRead: number, totalBytes: number) => void} [opts.onProgress]
 * @param {boolean} [opts.forceStreaming] test hook — exercise the streaming
 *   path on small fixtures.
 * @returns {Promise<{processedFiles: string[], processedFileCount: number,
 *   routes: object[], driveTags: object}>}
 */
async function readDriveData(filePath, opts = {}) {
  const { wantProcessedFiles = false, onProgress, forceStreaming = false } = opts;
  const totalBytes = fs.statSync(filePath).size;

  let result;
  if (!forceStreaming && totalBytes <= FAST_PARSE_LIMIT_BYTES) {
    const data = await readFast(filePath, totalBytes, onProgress);
    const processedFiles = Array.isArray(data.processedFiles) ? data.processedFiles : [];
    result = {
      processedFiles: wantProcessedFiles ? processedFiles : [],
      processedFileCount: processedFiles.length,
      routes: Array.isArray(data.routes) ? data.routes : [],
      driveTags: data.driveTags && typeof data.driveTags === 'object' ? data.driveTags : {},
    };
  } else {
    result = await readStreaming(filePath, totalBytes, onProgress, wantProcessedFiles);
  }

  if (onProgress && totalBytes > 0) onProgress(totalBytes, totalBytes);
  return result;
}

module.exports = { readDriveData, FAST_PARSE_LIMIT_BYTES };
