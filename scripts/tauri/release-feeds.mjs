#!/usr/bin/env node
// Write the update feeds for a release from its built artifacts.
//
//   node scripts/tauri/release-feeds.mjs <artifactsDir> <version> <downloadBase> [notesFile]
//
// <downloadBase> is where the files will live, e.g.
// https://github.com/Sentry-Six/Sentry-Drive/releases/download/v1.7.0
//
// Writes into <artifactsDir>:
// - latest.json: tauri-plugin-updater's manifest (Tauri builds update from it)
// - latest-mac.yml, latest.yml, latest-linux.yml: electron-updater's feeds,
//   pointing at the Tauri artifacts, so Electron installs that check for
//   updates move straight to the Tauri build.
//
// Expected artifact names (the release workflow renames Tauri's output to
// these): Sentry-Drive-<v>-universal.app.tar.gz(.sig),
// Sentry-Drive-<v>-universal.zip, Sentry-Drive-Setup-<v>.exe(.sig),
// Sentry-Drive-<v>.AppImage(.sig), sentry-drive_<v>_amd64.deb(.sig).
// Missing platforms are left out of the feeds with a warning.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [dir, version, base, notesFile] = process.argv.slice(2);
if (!dir || !version || !base) {
  console.error('usage: release-feeds.mjs <artifactsDir> <version> <downloadBase> [notesFile]');
  process.exit(2);
}
const at = (name) => path.join(dir, name);
const has = (name) => fs.existsSync(at(name));
const url = (name) => `${base.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
const sig = (name) => fs.readFileSync(at(`${name}.sig`), 'utf8').trim();
const releaseDate = new Date().toISOString();

const names = {
  macUpdater: `Sentry-Drive-${version}-universal.app.tar.gz`,
  macZip: `Sentry-Drive-${version}-universal.zip`,
  macDmg: `Sentry-Drive-${version}-universal.dmg`,
  winSetup: `Sentry-Drive-Setup-${version}.exe`,
  appImage: `Sentry-Drive-${version}.AppImage`,
  deb: `sentry-drive_${version}_amd64.deb`,
};

// ── latest.json ─────────────────────────────────────────────────────────────
const platforms = {};
const add = (keys, name) => {
  if (!has(name) || !has(`${name}.sig`)) {
    console.warn(`warning: ${name} or its .sig is missing; left out of latest.json`);
    return;
  }
  for (const k of keys) platforms[k] = { signature: sig(name), url: url(name) };
};
add(['darwin-aarch64', 'darwin-x86_64', 'darwin-aarch64-app', 'darwin-x86_64-app'], names.macUpdater);
add(['windows-x86_64', 'windows-x86_64-nsis'], names.winSetup);
add(['linux-x86_64', 'linux-x86_64-appimage'], names.appImage);
if (has(`${names.deb}.sig`)) add(['linux-x86_64-deb'], names.deb);
if (Object.keys(platforms).length === 0) {
  console.error('no signed updater artifacts found');
  process.exit(1);
}
const notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : `Sentry Drive ${version}`;
fs.writeFileSync(at('latest.json'), JSON.stringify({ version, notes, pub_date: releaseDate, platforms }, null, 2) + '\n');

// ── electron-updater feeds ──────────────────────────────────────────────────
const sha512 = (name) => crypto.createHash('sha512').update(fs.readFileSync(at(name))).digest('base64');
const yml = (files) => {
  const lines = [`version: ${version}`, 'files:'];
  for (const f of files) {
    lines.push(`  - url: ${f}`, `    sha512: ${sha512(f)}`, `    size: ${fs.statSync(at(f)).size}`);
  }
  lines.push(`path: ${files[0]}`, `sha512: ${sha512(files[0])}`, `releaseDate: '${releaseDate}'`);
  return lines.join('\n') + '\n';
};
const feed = (file, files) => {
  const present = files.filter(has);
  if (present.length === 0) {
    console.warn(`warning: no artifacts for ${file}; not written`);
    return;
  }
  fs.writeFileSync(at(file), yml(present));
};
// Squirrel.Mac installs the zip (same bundle id and Developer ID team, so its
// code-signature check passes); the DMG is listed for completeness.
feed('latest-mac.yml', [names.macZip, names.macDmg]);
feed('latest.yml', [names.winSetup]);
feed('latest-linux.yml', [names.appImage, names.deb]);

console.log(`feeds written for ${version}: ${Object.keys(platforms).join(', ')}`);
