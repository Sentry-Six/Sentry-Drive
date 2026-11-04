#!/usr/bin/env node
// Build src-tauri/target/squirrel-shim/Squirrel.framework (macOS only): the
// stand-in for Squirrel.Mac's ShipIt that relaunches the app after the
// Electron build's updater installs the Tauri build (see ShipIt.c).
// Runs as Tauri's beforeBundleCommand. Signs with APPLE_SIGNING_IDENTITY when
// set (hardened runtime + timestamp, as notarization requires), else ad hoc.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin') process.exit(0);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const src = path.join(root, 'src-tauri/macos/squirrel-shim');
const fw = path.join(root, 'src-tauri/target/squirrel-shim/Squirrel.framework');
const ver = path.join(fw, 'Versions/A');
fs.rmSync(fw, { recursive: true, force: true });
fs.mkdirSync(path.join(ver, 'Resources'), { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const arch = ['-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0', '-O2'];
run('clang', [...arch, '-o', path.join(ver, 'Resources/ShipIt'), path.join(src, 'ShipIt.c')]);
run('clang', [...arch, '-dynamiclib', '-install_name', '@rpath/Squirrel.framework/Versions/A/Squirrel',
  '-o', path.join(ver, 'Squirrel'), path.join(src, 'Squirrel.c')]);
fs.writeFileSync(path.join(ver, 'Resources/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.jefffromtheirs.sentry-drive.relaunch</string>
  <key>CFBundleName</key><string>Squirrel</string>
  <key>CFBundleExecutable</key><string>Squirrel</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
`);
fs.symlinkSync('A', path.join(fw, 'Versions/Current'));
fs.symlinkSync('Versions/Current/Resources', path.join(fw, 'Resources'));
fs.symlinkSync('Versions/Current/Squirrel', path.join(fw, 'Squirrel'));
const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
const sign = identity === '-' ? ['--sign', '-'] : ['--sign', identity, '--options', 'runtime', '--timestamp'];
run('codesign', ['--force', ...sign, path.join(ver, 'Resources/ShipIt')]);
run('codesign', ['--force', ...sign, fw]);
console.log(`squirrel shim: ${path.relative(root, fw)} (signed ${identity === '-' ? 'ad hoc' : 'with ' + identity})`);
