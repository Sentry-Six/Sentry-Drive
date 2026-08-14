// Uses native JSON.parse below the safe V8 string limit and token streaming
// above it. Both paths return:
//   { processedFiles, processedFileCount, routes, driveTags, extraSections }
// Writers request `processedFiles`; display-only reads retain only its count.
// Unknown top-level sections must round-trip verbatim for exporter compatibility.

const fs = require('fs');
const { chain } = require('stream-chain');
// stream-json 3.x exposes the chain-stage parser as a named export.
const { parser } = require('stream-json/parser.js');
// Support both Assembler export shapes.
const AssemblerModule = require('stream-json/assembler.js');
const Assembler = AssemblerModule.Assembler ?? AssemblerModule;

// Margin below V8's roughly 512 MiB maximum string length.
const FAST_PARSE_LIMIT_BYTES = 480 * 1024 * 1024;

// Preallocation avoids a second full-size copy. Sizing through the open handle
// is safe across atomic replacement; a post-read stat catches in-place changes.
// An unstable read retries once. OVERSIZED selects the streaming path when the
// file grows beyond the cap between the caller's stat and this open.
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
        if (n === 0) break; // File shrank after fstat.
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
        // Release the buffer before JSON.parse builds the object graph.
        str = buf.toString('utf8');
      }
      buf = null;
    } finally {
      await fh.close().catch(() => {});
    }
    if (str !== null) {
      return JSON.parse(str);
    }
    // Retry one concurrent modification, then fail instead of parsing partial data.
    if (attempt >= 1) throw new Error('drive-data.json changed while being read');
  }
}

// Top-level keys with dedicated handling; everything else is an extra section.
const KNOWN_TOP_KEYS = new Set(['processedFiles', 'routes', 'driveTags']);

// OOM-safe, single-pass token reader.
function readStreaming(filePath, totalBytes, onProgress, wantProcessedFiles) {
  return new Promise((resolve, reject) => {
    let processedFileCount = 0;
    const processedFiles = wantProcessedFiles ? [] : null;
    const routes = [];
    let driveTags = {};
    const extraSections = {};

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
            else extraSections[currentTopKey] = asm.current;
            asm = null;
          }
        }
        return;
      }

      if (name === 'startObject' || name === 'startArray') {
        const before = depth;
        depth++;
        // A route object at depth 3.
        if (before === 2 && name === 'startObject' && currentTopKey === 'routes') {
          asm = new Assembler();
          asmExitDepth = before;
          asm.consume(token);
        }
        // Assemble driveTags or an unmodeled top-level section.
        else if (before === 1 && currentTopKey && currentTopKey !== 'routes' &&
                 currentTopKey !== 'processedFiles') {
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
      } else if (depth === 1 && currentTopKey && !KNOWN_TOP_KEYS.has(currentTopKey)) {
        // Scalar-valued extra section.
        if (name === 'stringValue' || name === 'numberValue') {
          extraSections[currentTopKey] = name === 'numberValue' ? Number(token.value) : token.value;
          currentTopKey = null;
        } else if (name === 'trueValue' || name === 'falseValue') {
          extraSections[currentTopKey] = name === 'trueValue';
          currentTopKey = null;
        } else if (name === 'nullValue') {
          extraSections[currentTopKey] = null;
          currentTopKey = null;
        }
      }
    });

    pipeline.on('end', () => {
      resolve({
        processedFiles: processedFiles ?? [],
        processedFileCount,
        routes,
        driveTags,
        extraSections,
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
 *   routes: object[], driveTags: object, extraSections: object}>}
 */
async function readDriveData(filePath, opts = {}) {
  const { wantProcessedFiles = false, onProgress, forceStreaming = false } = opts;
  const totalBytes = fs.statSync(filePath).size;

  let result;
  let data = OVERSIZED;
  if (!forceStreaming && totalBytes <= FAST_PARSE_LIMIT_BYTES) {
    // readFast rechecks size on its own handle and may select streaming.
    data = await readFast(filePath, onProgress);
  }
  if (data !== OVERSIZED) {
    const processedFiles = Array.isArray(data.processedFiles) ? data.processedFiles : [];
    const extraSections = {};
    for (const key of Object.keys(data)) {
      if (!KNOWN_TOP_KEYS.has(key)) extraSections[key] = data[key];
    }
    result = {
      processedFiles: wantProcessedFiles ? processedFiles : [],
      processedFileCount: processedFiles.length,
      routes: Array.isArray(data.routes) ? data.routes : [],
      driveTags: data.driveTags && typeof data.driveTags === 'object' ? data.driveTags : {},
      extraSections,
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
