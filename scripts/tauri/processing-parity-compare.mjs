// Processing parity: compare a drive-data.json written by src/processing/process.js
// with one written by the Rust port.  node processing-parity-compare.mjs <js.json> <rust.json>
import fs from 'node:fs';
import assert from 'node:assert/strict';

const [jsPath, rsPath] = process.argv.slice(2);
const jsText = fs.readFileSync(jsPath, 'utf8');
const rsText = fs.readFileSync(rsPath, 'utf8');
const js = JSON.parse(jsText);
const rs = JSON.parse(rsText);

console.log('top-level keys js:', Object.keys(js).join(','), '| rust:', Object.keys(rs).join(','));
const pfJs = [...js.processedFiles].sort();
const pfRs = [...rs.processedFiles].sort();
let diffs = 0;
try { assert.deepEqual(pfRs, pfJs); console.log(`processedFiles: ${pfJs.length} identical (as sets)`); }
catch (e) { diffs++; console.log('processedFiles DIFFER', pfJs, pfRs); }
try { assert.deepEqual(rs.driveTags, js.driveTags); } catch { diffs++; console.log('driveTags DIFFER'); }

const byFile = (routes) => new Map(routes.map((r) => [r.file, r]));
const mj = byFile(js.routes);
const mr = byFile(rs.routes);
console.log(`routes: js=${mj.size} rust=${mr.size}`);
for (const f of new Set([...mj.keys(), ...mr.keys()])) {
  const a = mj.get(f); const b = mr.get(f);
  if (!a || !b) { diffs++; console.log(`  only in ${a ? 'js' : 'rust'}: ${f}`); continue; }
  try { assert.deepEqual(b, a); }
  catch {
    diffs++;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log(`  ${f}: field ${k} differs`);
    }
  }
  if (JSON.stringify(Object.keys(a)) !== JSON.stringify(Object.keys(b))) { diffs++; console.log(`  ${f}: key order differs`); }
}
// Byte-level: each route line as written.
const lines = (t) => t.split('\n').filter((l) => l.startsWith('    {')).map((l) => l.trim().replace(/,$/, '')).sort();
const lj = lines(jsText); const lr = lines(rsText);
const sameBytes = lj.length === lr.length && lj.every((l, i) => l === lr[i]);
console.log(`route lines byte-identical: ${sameBytes} (${lj.length} lines)`);
if (!sameBytes) diffs++;
let pts = 0; for (const r of mj.values()) pts += r.points.length;
console.log(`total points (js): ${pts}`);
console.log(diffs === 0 ? 'PARITY OK' : `DIFFERENCES: ${diffs}`);
