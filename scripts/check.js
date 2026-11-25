'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ejs = require('ejs');
const root = path.resolve(__dirname, '..');
function walk(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target, extension) : entry.isFile() && target.endsWith(extension) ? [target] : [];
  });
}
const scripts = ['src', 'scripts', 'tests', 'public/js'].flatMap(directory => walk(path.join(root, directory), '.js'));
const templates = walk(path.join(root, 'views'), '.ejs');
let failed = false;
for (const filename of scripts) {
  const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.error?.message || `Unable to check ${filename}\n`);
  }
}
for (const filename of templates) {
  try { ejs.compile(fs.readFileSync(filename, 'utf8'), { filename }); }
  catch (error) { failed = true; process.stderr.write(`${path.relative(root, filename)}: ${error.message}\n`); }
}
if (failed) process.exitCode = 1;
else console.log(`Syntax checked ${scripts.length} JavaScript files and ${templates.length} EJS templates.`);
