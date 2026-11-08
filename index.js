const express = require('express');
const connect = require('../lib/db');
const { User, Employee, Attendance, Loan, Adjustment, PayrollRun, Audit } = require('../lib/models');
const { calcLine, hoursBetween } = require('../lib/payroll');
const { r2 } = require('../lib/tax');
const { sign, verify, hash, compare, checkPassword } = require('../lib/auth');

const app = express();
app.use(express.json());

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Authentication: signed token (Authorization: Bearer) -> user loaded from MongoDB on every request,
// so deactivation, role changes and password resets take effect immediately.
const makeAuth = (roles, allowPasswordChange) => wrap(async (req, res, next) => {
  let p;
  try { p = verify((req.get('authorization') || '').replace(/^Bearer /, '')); }
  catch { return res.status(401).json({ error: 'Please sign in again.' }); }
  const u = await User.findById(p.sub).lean();
  if (!u || !u.active || u.tokenVersion !== p.tv) return res.status(401).json({ error: 'Please sign in again.' });
  if (u.mustChangePassword && !allowPasswordChange)
    return res.status(403).json({ error: 'Change your password to continue.', code: 'PASSWORD_CHANGE_REQUIRED' });
  if (roles.length && u.role !== 'admin' && !roles.includes(u.role))
    return res.status(403).json({ error: `Your role (${u.role}) cannot do this.` });
  req.user = { id: String(u._id), name: u.username, displayName: u.name, role: u.role, mustChangePassword: u.mustChangePassword };
  next();
});
const auth = (...roles) => makeAuth(roles, false);
const log = (req, action, entity, entityId, details) =>
  Audit.create({ user: req.user.name, action, entity, entityId: String(entityId), details });

const periodRange = (p) => {
  const [y, m] = p.split('-').map(Number);
  return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))];
};
const validPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p);

app.use('/api', wrap(async (req, res, next) => { await connect(); next(); }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
const audit = (user, action, entity, entityId, details) => Audit.create({ user, action, entity, entityId: String(entityId), details });

// First administrator comes from ADMIN_USERNAME / ADMIN_PASSWORD, only while no users exist. Remove them afterwards.
async function bootstrapAdmin() {
  const { ADMIN_USERNAME: un, ADMIN_PASSWORD: pw } = process.env;
  if (!un || !pw || checkPassword(pw) || (await User.estimatedDocumentCount()) > 0) return;
  try {
    await User.create({ username: un, name: process.env.ADMIN_NAME || 'Administrator', role: 'admin', passwordHash: await hash(pw), mustChangePassword: true });
    await audit('system', 'bootstrap_admin', 'User', un, {});
  } catch (e) { if (e.code !== 11000) throw e; }
}
const MAX_FAILS = 5, LOCK_MINUTES = 15;

app.post('/api/auth/login', wrap(async (req, res) => {
  await bootstrapAdmin();
  const username = String(req.body.username || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const u = await User.findOne({ username }).select('+passwordHash');
  if (!u || !u.active) {
    await compare(password, '$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5BoVDCT3o2n5H1X3x0pP5L4i6p9bK'); // equalise timing
    await audit(username || 'unknown', 'login_failed', 'User', username, {});
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (u.lockUntil && u.lockUntil > new Date())
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.` });
  if (!(await compare(password, u.passwordHash))) {
    u.failedLogins += 1;
    if (u.failedLogins >= MAX_FAILS) { u.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60000); u.failedLogins = 0; }
    await u.save();
    await audit(u.username, 'login_failed', 'User', u.username, {});
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  u.failedLogins = 0; u.lockUntil = undefined; u.lastLogin = new Date();
  await u.save();
  await audit(u.username, 'login', 'User', u.username, {});
  res.json({ token: sign(u), user: { id: String(u._id), username: u.username, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword } });
}));

app.get('/api/me', makeAuth([], true), (req, res) =>
  res.json({ id: req.user.id, username: req.user.name, name: req.user.displayName, role: req.user.role, mustChangePassword: req.user.mustChangePassword }));

app.post('/api/auth/change-password', makeAuth([], true), wrap(async (req, res) => {
  const { current, next } = req.body;
  const problem = checkPassword(next);
  if (problem) return res.status(400).json({ error: problem });
  const u = await User.findById(req.user.id).select('+passwordHash');
  if (!(await compare(String(current || ''), u.passwordHash))) return res.status(400).json({ error: 'Your current password is incorrect.' });
  if (current === next) return res.status(400).json({ error: 'The new password must be different.' });
  u.passwordHash = await hash(next); u.mustChangePassword = false; u.tokenVersion += 1;
  await u.save();
  await audit(u.username, 'change_password', 'User', u.username, {});
  res.json({ token: sign(u) });
}));

// ---- User management (admin) ----
app.get('/api/users', auth('admin'), wrap(async (req, res) => res.json(await User.find().sort('username').lean())));
app.post('/api/users', auth('admin'), wrap(async (req, res) => {
  const { username, name, role, password } = req.body;
  const problem = checkPassword(password);
  if (problem) return res.status(400).json({ error: problem });
  const u = await User.create({ username, name, role, passwordHash: await hash(password), mustChangePassword: true });
  await log(req, 'create', 'User', u.username, { role: u.role });
  res.status(201).json({ id: u._id, username: u.username });
}));
app.put('/api/users/:id', auth('admin'), wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role or status.' });
  const change = {};
  for (const k of ['name', 'role', 'active']) if (k in req.body) change[k] = req.body[k];
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const before = { name: u.name, role: u.role, active: u.active };
  u.set(change);
  if (change.role !== undefined || change.active === false) u.tokenVersion += 1; // sign them out
  await u.save();
  await log(req, 'update', 'User', u.username, { before, after: change });
  res.json({ id: u._id });
}));
app.post('/api/users/:id/reset-password', auth('admin'), wrap(async (req, res) => {
  const problem = checkPassword(req.body.password);
  if (problem) return res.status(400).json({ error: problem });
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  u.passwordHash = await hash(req.body.password); u.mustChangePassword = true; u.tokenVersion += 1; u.failedLogins = 0; u.lockUntil = undefined;
  await u.save();
  await log(req, 'reset_password', 'User', u.username, {});
  res.json({ ok: true });
}));


// ---- Employees (HR) ----
app.get('/api/employees', auth('hr', 'payroll', 'approver'), wrap(async (req, res) =>
  res.json(await Employee.find().sort('empId').lean())));
app.post('/api/employees', auth('hr'), wrap(async (req, res) => {
  const e = await Employee.create(req.body);
  await log(req, 'create', 'Employee', e.empId, req.body);
  res.status(201).json(e);
}));
app.put('/api/employees/:id', auth('hr'), wrap(async (req, res) => {
  const old = await Employee.findOne({ empId: req.params.id });
  if (!old) return res.status(404).json({ error: 'Employee not found.' });
  const before = old.toObject();
  old.set(req.body);
  await old.save();
  await log(req, 'update', 'Employee', old.empId, { before, after: old.toObject() });
  res.json(old);
}));

// ---- Attendance (payroll enters, approver approves overtime) ----
app.get('/api/attendance', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const q = req.query.period && validPeriod(req.query.period)
    ? { date: { $gte: periodRange(req.query.period)[0], $lt: periodRange(req.query.period)[1] } } : {};
  res.json(await Attendance.find(q).sort('-date').limit(500).lean());
}));
app.post('/api/attendance', auth('payroll'), wrap(async (req, res) => {
  const b = req.body;
  if (!(await Employee.exists({ empId: b.empId, status: { $in: ['Active', 'On Leave'] } })))
    return res.status(400).json({ error: 'Employee not found or not active.' });
  if (!/^\d{2}:\d{2}$/.test(b.clockIn || '') || !/^\d{2}:\d{2}$/.test(b.clockOut || ''))
    return res.status(400).json({ error: 'Clock times must be HH:MM.' });
  const hoursWorked = hoursBetween(b.clockIn, b.clockOut, Number(b.breakHours) || 0);
  if (hoursWorked <= 0 || hoursWorked > 24) return res.status(400).json({ error: 'Hours worked must be between 0 and 24.' });
  const a = await Attendance.create({ ...b, hoursWorked, approved: false, createdBy: req.user.name });
  await log(req, 'create', 'Attendance', a._id, { empId: a.empId, date: a.date, hoursWorked });
  res.status(201).json(a);
}));
app.post('/api/attendance/:id/approve', auth('approver'), wrap(async (req, res) => {
  const a = await Attendance.findByIdAndUpdate(req.params.id, { approved: true, approvedBy: req.user.name }, { new: true });
  if (!a) return res.status(404).json({ error: 'Entry not found.' });
  await log(req, 'approve', 'Attendance', a._id, {});
  res.json(a);
}));

// ---- Loans ----
app.get('/api/loans', auth('payroll', 'approver', 'hr'), wrap(async (req, res) =>
  res.json(await Loan.find().sort('-createdAt').lean())));
app.post('/api/loans', auth('payroll', 'hr'), wrap(async (req, res) => {
  const { empId, amount, termMonths, startPeriod } = req.body;
  if (!(await Employee.exists({ empId }))) return res.status(400).json({ error: 'Employee not found.' });
  const l = await Loan.create({
    empId, amount, termMonths, startPeriod, monthly: r2(amount / termMonths), outstanding: amount,
    status: 'Pending', createdBy: req.user.name,
  });
  await log(req, 'create', 'Loan', l._id, req.body);
  res.status(201).json(l);
}));
app.post('/api/loans/:id/approve', auth('approver'), wrap(async (req, res) => {
  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  if (l.createdBy === req.user.name) return res.status(403).json({ error: 'You cannot approve a loan you created.' });
  l.status = 'Active'; l.approvedBy = req.user.name;
  await l.save();
  await log(req, 'approve', 'Loan', l._id, {});
  res.json(l);
}));

// ---- Adjustments: bonuses, earnings, other deductions ----
app.get('/api/adjustments', auth('payroll', 'approver', 'hr'), wrap(async (req, res) =>
  res.json(await Adjustment.find().sort('-createdAt').limit(500).lean())));
app.post('/api/adjustments', auth('payroll', 'hr'), wrap(async (req, res) => {
  if (!(await Employee.exists({ empId: req.body.empId }))) return res.status(400).json({ error: 'Employee not found.' });
  const j = await Adjustment.create({ ...req.body, approved: false, createdBy: req.user.name });
  await log(req, 'create', 'Adjustment', j._id, req.body);
  res.status(201).json(j);
}));
app.post('/api/adjustments/:id/approve', auth('approver'), wrap(async (req, res) => {
  const j = await Adjustment.findById(req.params.id);
  if (!j) return res.status(404).json({ error: 'Adjustment not found.' });
  if (j.createdBy === req.user.name) return res.status(403).json({ error: 'You cannot approve an entry you created.' });
  j.approved = true; j.approvedBy = req.user.name;
  await j.save();
  await log(req, 'approve', 'Adjustment', j._id, {});
  res.json(j);
}));

// ---- Payroll ----
app.post('/api/payroll/:period/calculate', auth('payroll'), wrap(async (req, res) => {
  const { period } = req.params;
  if (!validPeriod(period)) return res.status(400).json({ error: 'Period must look like 2026-11.' });
  const existing = await PayrollRun.findOne({ period });
  if (existing?.status === 'Approved') return res.status(409).json({ error: 'This period is approved and locked.' });

  const [from, to] = periodRange(period);
  const [emps, att, adj, loans] = await Promise.all([
    Employee.find({ status: { $in: ['Active', 'On Leave'] } }).sort('empId').lean(),
    Attendance.find({ date: { $gte: from, $lt: to } }).lean(),
    Adjustment.find({ period }).lean(),
    Loan.find({ status: 'Active' }).lean(),
  ]);
  const by = (arr, f = () => true) => arr.reduce((m, x) => ((f(x) && (m[x.empId] ||= []).push(x)), m), {});
  const attBy = by(att, (x) => x.approved), adjBy = by(adj, (x) => x.approved), loanBy = by(loans);

  const warnings = [];
  const pendingOT = att.filter((x) => !x.approved).length;
  const pendingAdj = adj.filter((x) => !x.approved).length;
  if (pendingOT) warnings.push(`${pendingOT} unapproved attendance entries were excluded.`);
  if (pendingAdj) warnings.push(`${pendingAdj} unapproved adjustments were excluded.`);

  const lines = emps.map((e) => calcLine(e, { attendance: attBy[e.empId], adjustments: adjBy[e.empId], loans: loanBy[e.empId] }, period));
  const sum = (k) => r2(lines.reduce((s, l) => s + l[k], 0));
  const totals = {
    employees: lines.length, gross: sum('gross'), paye: sum('paye'), pension: sum('pension'), nhf: sum('nhf'),
    loans: sum('loanDeduction'), net: sum('netPay'), employerPension: sum('employerPension'), otPay: sum('otPay'),
  };
  const run = await PayrollRun.findOneAndUpdate({ period }, {
    status: 'Draft', preparedBy: req.user.name, lines, warnings, totals,
  }, { upsert: true, new: true, setDefaultsOnInsert: true });
  await log(req, 'calculate', 'PayrollRun', period, totals);
  res.json(run);
}));

app.get('/api/payroll/:period', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'No payroll has been calculated for this period.' });
  res.json(run);
}));

app.post('/api/payroll/:period/approve', auth('approver'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period });
  if (!run) return res.status(404).json({ error: 'No payroll has been calculated for this period.' });
  if (run.status === 'Approved') return res.status(409).json({ error: 'Already approved.' });
  if (run.preparedBy === req.user.name) return res.status(403).json({ error: 'The person who calculated payroll cannot approve it.' });
  const blocking = run.lines.filter((l) => l.flags.length);
  if (blocking.length)
    return res.status(409).json({ error: 'Fix blocking exceptions before approval.', exceptions: blocking.map((l) => ({ empId: l.empId, flags: l.flags })) });

  // Claim the run first so a double click cannot deduct loans twice
  const claimed = await PayrollRun.findOneAndUpdate(
    { period: run.period, status: 'Draft' },
    { status: 'Approved', approvedBy: req.user.name, approvedAt: new Date() }, { new: true });
  if (!claimed) return res.status(409).json({ error: 'Already approved.' });

  for (const l of run.lines) for (const lb of l.loanBreakdown) {
    const loan = await Loan.findByIdAndUpdate(lb.loanId, { $inc: { outstanding: -lb.amount } }, { new: true });
    if (loan && loan.outstanding <= 0.005) { loan.status = 'Closed'; loan.outstanding = 0; await loan.save(); }
  }
  await log(req, 'approve', 'PayrollRun', run.period, run.totals);
  res.json(claimed);
}));

app.get('/api/payroll/:period/payslip/:empId', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  const line = run?.lines.find((l) => l.empId === req.params.empId);
  if (!line) return res.status(404).json({ error: 'Payslip not found.' });
  res.json({ period: run.period, status: run.status, ...line });
}));

app.get('/api/payroll/:period/bank.csv', auth('payroll', 'approver'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run || run.status !== 'Approved') return res.status(409).json({ error: 'The bank file is available only after approval.' });
  const pay = run.lines.filter((l) => l.netPay > 0);
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = ['EmpID,EmployeeName,Bank,AccountNo,NetPay,Narration',
    ...pay.map((l) => [l.empId, q(l.name), q(l.bank), l.accountNo, l.netPay.toFixed(2), q(`Salary ${run.period}`)].join(',')),
    `TOTAL,${pay.length} payments,,,${r2(pay.reduce((s, l) => s + l.netPay, 0)).toFixed(2)},`];
  await log(req, 'export', 'BankFile', run.period, { count: pay.length });
  res.type('text/csv').attachment(`bank-${run.period}.csv`).send(rows.join('\n'));
}));

app.get('/api/audit', auth('approver'), wrap(async (req, res) =>
  res.json(await Audit.find().sort('-ts').limit(300).lean())));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.name === 'ValidationError') return res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join(' ') });
  if (err.code === 11000) return res.status(409).json({ error: 'A record with this ID already exists.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

module.exports = app;
