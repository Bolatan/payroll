const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  return s;
};
const sign = (u) => jwt.sign({ sub: String(u._id), tv: u.tokenVersion }, secret(), { expiresIn: '8h' });
const verify = (token) => jwt.verify(token, secret());
const hash = (p) => bcrypt.hash(p, 10);
const compare = (p, h) => bcrypt.compare(p, h);
const checkPassword = (p) =>
  typeof p === 'string' && p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p)
    ? null : 'Password must be at least 10 characters and include a letter and a number.';

// Base32 RFC 4648 alphabet for standard TOTP
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Generate a random base32 encoded secret for RFC 6238 TOTP MFA
 */
function generateMfaSecret(length = 20) {
  const buf = crypto.randomBytes(length);
  return base32Encode(buf);
}

/**
 * Generate a TOTP code for a given secret and counter/time (RFC 6238 / RFC 4226)
 */
function generateTotp(secretKey, counter) {
  const key = base32Decode(secretKey);
  const buf = Buffer.alloc(8);
  let tmp = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = tmp & 0xff;
    tmp = Math.floor(tmp / 256);
  }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1000000;
  return String(code).padStart(6, '0');
}

/**
 * Verify a TOTP code for a secretKey with optional time-step window (default ±1 window of 30s)
 */
function verifyTotp(token, secretKey, window = 1, stepSec = 30) {
  if (!token || !secretKey) return false;
  const cleanToken = String(token).trim();
  if (cleanToken.length !== 6) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  const currentStep = Math.floor(nowSec / stepSec);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const expected = generateTotp(secretKey, currentStep + errorWindow);
    if (expected === cleanToken) return true;
  }
  return false;
}

module.exports = {
  sign,
  verify,
  hash,
  compare,
  checkPassword,
  generateMfaSecret,
  generateTotp,
  verifyTotp,
  base32Encode,
  base32Decode,
};
