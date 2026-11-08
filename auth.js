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

module.exports = { sign, verify, hash, compare, checkPassword };
