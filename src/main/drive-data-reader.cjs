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

// Read the whole file into ONE preallocated buffer (driving onProgress), then
// parse natively. The old chunk-array + Buffer.concat approach held TWO full
// byte copies of the file at peak (~480 MB of avoidable spike at the size
// cap); reading into an exact-sized buffer holds one. The handle is opened
// first and sized via its own fstat, so an atomic rename-over (Sentry USB
// re-exporting the file) between stat and open can't truncate the read —
// the handle stays on the original inode. A stat after the read catches
// in-place modification during it; any instability retries the whole read
// once from a fresh handle, then fails loudly — partial bytes are never
// parsed. Returns the sentinel OVERSIZED if the handle's own size exceeds
// the fast-parse cap (the file grew past it after the caller's stat) so the
// caller can fall back to the streaming path instead of risking
// ERR_STRING_TOO_LONG.
const OVERSIZED = Symbol('oversized');
async function readFast(filePath, onProgress) {
  for (let attempt = 0; ; attempt++) {
    const fh = await fs.promises.open(filePath, 'r');
    let str = null;
    try {
      const st = await fh.stat();
      const size = st.size;
      if (size > FAST_PARSE_LIMIT_BYTES) return OVERSIZED;
      let buf = Buffer.allocUnsafe(size);
      let bytesRead = 0;
      let lastEmit = 0;
      while (bytesRead < size) {
        const { bytesRead: n } = await fh.read(buf, bytesRead, size - bytesRead, bytesRead);
        if (n === 0) break; // EOF before the fstat'd size — file shrank mid-read
        bytesRead += n;
        if (onProgress) {
          const now = Date.now();
          if (now - lastEmit >= 100) {
            lastEmit = now;
            onProgress(bytesRead, size);
          }
        }
      }
      const after = await fh.stat().catch(() => null);
      const stable = bytesRead === size &&
        after && after.size === st.size && after.mtimeMs === st.mtimeMs;
      if (stable) {
        // Tight lifetimes for the giant intermediates: the buffer is released
        // before JSON.parse builds the object graph.
        str = buf.toString('utf8');
      }
      buf = null;
    } finally {
      await fh.close().catch(() => {});
    }
    if (str !== null) {
      // The parse is synchronous (~1-4 s at the size cap); the renderer lives
      // in its own process so the UI stays responsive.
      return JSON.parse(str);
    }
    // The file changed underneath us — retry once (the writer has usually
    // finished by then), then surface a real error instead of corrupt data.
    if (attempt >= 1) throw new Error('drive-data.json changed while being read');
  }
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
  let data = OVERSIZED; // sentinel doubles as "take the streaming path"
  if (!forceStreaming && totalBytes <= FAST_PARSE_LIMIT_BYTES) {
    // readFast re-checks size on its own handle and answers OVERSIZED if the
    // file grew past the cap between our stat and its open — fall through to
    // streaming in that case rather than risking the V8 string limit.
    data = await readFast(filePath, onProgress);
  }
  if (data !== OVERSIZED) {
    const processedFiles = Array.isArray(data.processedFiles) ? data.processedFiles : [];
    result = {
      processedFiles: wantProcessedFiles ? processedFiles : [],
      processedFileCount: processedFiles.length,
      routes: Array.isArray(data.routes) ? data.routes : [],
      driveTags: data.driveTags && typeof data.driveTags === 'object' ? data.driveTags : {},
    };
    // The load path only needs the count — drop the (one string per clip)
    // array now instead of keeping it alive alongside the routes.
    if (!wantProcessedFiles) data.processedFiles = null;
  } else {
    result = await readStreaming(filePath, totalBytes, onProgress, wantProcessedFiles);
  }

  if (onProgress && totalBytes > 0) onProgress(totalBytes, totalBytes);
  return result;
}

module.exports = { readDriveData, FAST_PARSE_LIMIT_BYTES };
