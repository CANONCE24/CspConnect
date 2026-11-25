'use strict';
// Dedicated guardhouse browser profile: audible incoming alarms without an audio setup button.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../src/config/env');
const config = loadConfig();
const target = new URL('/security', config.appUrl);
const executable = process.env.BROWSER_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(file => fs.existsSync(file));
if (!executable) throw new Error('Set BROWSER_PATH to the Chrome or Edge executable.');
const profile = path.resolve(__dirname, '../.local/security-monitor-browser');
fs.mkdirSync(profile, { recursive: true });
const child = spawn(executable, [
  '--user-data-dir=' + profile, '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', '--app=' + target.href
], { detached: true, stdio: 'ignore', windowsHide: true });
child.on('error', error => { console.error('Guardhouse monitor could not open:', error.message); process.exitCode = 1; });
child.unref();
console.log('Guardhouse monitor opened. Sign in using a security account. Incoming reports sound automatically.');
