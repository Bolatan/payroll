const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  return s;
};
const sign = (u, claims = {}) => jwt.sign({ sub: String(u._id), tv: u.tokenVersion, ...claims }, secret(), { expiresIn: '8h' });
const verify = (token) => jwt.verify(token, secret());
const hash = (p) => bcrypt.hash(p, 10);
const compare = (p, h) => bcrypt.compare(p, h);
const checkPassword = (p) =>
  typeof p === 'string' && p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p)
    ? null : 'Password must be at least 10 characters and include a letter and a number.';

// Base32 helper for TOTP secrets (RFC 4648)
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_CHARS.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateMfaSecret(length = 20) {
  return base32Encode(crypto.randomBytes(length));
}

function generateTotp(secretBase32, timeStepSeconds = 30, timeMs = Date.now()) {
  const key = base32Decode(secretBase32);
  const epoch = Math.floor(timeMs / 1000);
  const counter = Math.floor(epoch / timeStepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) |
               ((hmac[offset + 1] & 0xff) << 16) |
               ((hmac[offset + 2] & 0xff) << 8) |
               (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotp(token, secretBase32, window = 1, timeStepSeconds = 30, timeMs = Date.now()) {
  if (!token || !secretBase32) return false;
  const cleanToken = String(token).trim();
  for (let step = -window; step <= window; step++) {
    const checkTime = timeMs + step * timeStepSeconds * 1000;
    if (generateTotp(secretBase32, timeStepSeconds, checkTime) === cleanToken) {
      return true;
    }
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
