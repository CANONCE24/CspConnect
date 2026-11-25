'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const bcrypt=require('bcrypt');

const PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 });

async function derive(password, salt) {
  return scrypt(password, salt, PARAMETERS.keyLength, {
    N: PARAMETERS.N, r: PARAMETERS.r, p: PARAMETERS.p, maxmem: PARAMETERS.maxmem
  });
}

async function createHash(password) {
  if(typeof password!=='string'||Buffer.byteLength(password,'utf8')>72)throw new Error('Passwords must use at most 72 UTF-8 bytes.');
  return bcrypt.hash(password,12);
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string') return false;
  if(typeof encoded==='string' && /^\$2[ab]\$(?:1[0-5])\$[./A-Za-z0-9]{53}$/.test(encoded)){
    if(Buffer.byteLength(password,'utf8')>72)return false;
    return bcrypt.compare(password,encoded);
  }
  const parts = typeof encoded === 'string' ? encoded.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt' ||
      Number(parts[1]) !== PARAMETERS.N || Number(parts[2]) !== PARAMETERS.r || Number(parts[3]) !== PARAMETERS.p) {
    await derive(password, DUMMY_SALT);
    return false;
  }
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (salt.length !== 16 || expected.length !== PARAMETERS.keyLength) {
      await derive(password, DUMMY_SALT);
      return false;
    }
    const actual = await derive(password, salt);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    await derive(password, DUMMY_SALT);
    return false;
  }
}

const DUMMY_SALT = crypto.createHash('sha256').update('cspc-email-auth-dummy-salt').digest().subarray(0, 16);

function isPasswordHash(value){return typeof value==='string' && (/^\$2[ab]\$(?:1[0-5])\$[./A-Za-z0-9]{53}$/.test(value)||/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{20,24}\$[A-Za-z0-9_-]{80,90}$/.test(value));}
module.exports = { createHash, verifyPassword,isPasswordHash };
