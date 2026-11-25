'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const dataDirectory = path.join(root, '.local', 'mysql-data');
const configFile = path.join(dataDirectory, 'my.ini');

function normalize(filename) {
  return path.resolve(filename).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

async function probe() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      connectTimeout: 1000
    });
    const [rows] = await connection.query({ sql: 'SELECT @@datadir AS directory', timeout: 1000 });
    if (normalize(rows[0].directory) !== normalize(dataDirectory)) {
      throw new Error('The configured database port belongs to another MySQL instance. Check DB_PORT in .env.');
    }
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') return false;
    throw error;
  } finally {
    if (connection) await connection.end();
  }
}

async function start() {
  if (!fs.existsSync(configFile)) {
    if (process.argv.includes('--if-configured')) return;
    throw new Error('No separate local database is installed. Start your configured MySQL service instead.');
  }
  if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST || '127.0.0.1')) {
    throw new Error('The separate database requires a local DB_HOST in .env.');
  }
  const config = fs.readFileSync(configFile, 'utf8');
  const configuredPort = Number(config.match(/^port\s*=\s*(\d+)\s*$/m)?.[1]);
  if (configuredPort !== Number(process.env.DB_PORT || 3306)) {
    throw new Error('DB_PORT in .env must match the port in .local/mysql-data/my.ini.');
  }
  if (await probe()) {
    console.log(`Local MySQL is ready on port ${configuredPort}.`);
    return;
  }

  const executable = path.join(process.env.LOCAL_MYSQL_BIN || 'C:/xampp/mysql/bin', 'mysqld.exe');
  if (!fs.existsSync(executable)) throw new Error('Cannot find mysqld.exe. Set LOCAL_MYSQL_BIN to your MySQL bin directory.');
  const logPath = path.join(root, '.local', 'mysql-console.log');
  const log = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(executable, [`--defaults-file=${configFile}`, '--console'], {
      cwd: dataDirectory, detached: true, windowsHide: true, stdio: ['ignore', log, log]
    });
  } finally {
    fs.closeSync(log);
  }
  let failure;
  child.on('error', error => { failure = error; });
  child.on('exit', code => { failure = new Error(`MySQL exited (${code}). Check ${logPath}.`); });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (failure) throw failure;
    if (await probe()) {
      console.log(`Started local MySQL on port ${configuredPort}.`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`MySQL did not become ready. Check ${logPath}.`);
}

start().catch(error => {
  console.error(`Local database startup failed: ${error.message}`);
  process.exitCode = 1;
});
