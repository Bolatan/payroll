const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'x'.repeat(40);
const { sign, verify, hash, compare, checkPassword } = require('../lib/auth');

test('password policy', () => {
  assert.ok(checkPassword('short1'));
  assert.ok(checkPassword('onlyletterslong'));
  assert.ok(checkPassword('1234567890123'));
  assert.strictEqual(checkPassword('Factory2026pay'), null);
});

test('passwords are hashed and verified', async () => {
  const h = await hash('Factory2026pay');
  assert.notStrictEqual(h, 'Factory2026pay');
  assert.ok(await compare('Factory2026pay', h));
  assert.ok(!(await compare('wrong-password1', h)));
});

test('token round trip carries user id and token version', () => {
  const t = verify(sign({ _id: 'abc123', tokenVersion: 3 }));
  assert.strictEqual(t.sub, 'abc123');
  assert.strictEqual(t.tv, 3);
});

test('tampered or unsigned token is rejected', () => {
  const t = sign({ _id: 'abc', tokenVersion: 0 });
  assert.throws(() => verify(t.slice(0, -2) + 'xx'));
  assert.throws(() => verify('garbage'));
});

test('a weak JWT_SECRET is refused', () => {
  process.env.JWT_SECRET = 'short';
  assert.throws(() => sign({ _id: 'a', tokenVersion: 0 }), /JWT_SECRET/);
  process.env.JWT_SECRET = 'x'.repeat(40);
});
