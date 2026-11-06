#!/usr/bin/env node
// Assemble the Tauri frontend (tauri-dist/) from src/renderer. Paths keep their repo layout (src/renderer/index.html still
// reaches ../../assets/...), tests are left out, and the HTML's CSP <meta> is
// removed because the Tauri build sets the same policy from tauri.conf.json —
// where Tauri can add its IPC origin to connect-src.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'tauri-dist');

fs.rmSync(out, { recursive: true, force: true });

function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst, filter);
    else if (filter(entry.name)) fs.copyFileSync(src, dst);
  }
}

copyDir(path.join(root, 'src', 'renderer'), path.join(out, 'src', 'renderer'), (name) => !name.endsWith('.test.js'));
for (const dir of ['vendor', 'map-ui', 'integrations-ui']) {
  copyDir(path.join(root, 'assets', dir), path.join(out, 'assets', dir));
}

const indexPath = path.join(out, 'src', 'renderer', 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const stripped = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/i, '');
if (stripped === html) throw new Error('CSP meta tag not found in index.html — update prepare-frontend.mjs');
fs.writeFileSync(indexPath, stripped);

console.log(`tauri-dist ready: ${path.relative(root, out)}`);
