const express = require('express');
const connect = require('../lib/db');
const { Employee, Attendance, Loan, Adjustment, PayrollRun, Audit } = require('../lib/models');
const { calcLine, hoursBetween } = require('../lib/payroll');
const { r2 } = require('../lib/tax');

const app = express();
app.use(express.json());

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const users = () => { try { return JSON.parse(process.env.USERS || '[]'); } catch { return []; } };

// Authentication: x-api-key identifies the user; role decides permissions.
const auth = (...roles) => (req, res, next) => {
  const u = users().find((x) => x.key && x.key === req.get('x-api-key'));
  if (!u) return res.status(401).json({ error: 'Sign in with a valid access key.' });
  if (roles.length && u.role !== 'admin' && !roles.includes(u.role))
    return res.status(403).json({ error: `Your role (${u.role}) cannot do this.` });
  req.user = u;
  next();
};
const log = (req, action, entity, entityId, details) =>
  Audit.create({ user: req.user.name, action, entity, entityId: String(entityId), details });

const periodRange = (p) => {
  const [y, m] = p.split('-').map(Number);
  return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))];
};
const validPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p);

app.use('/api', wrap(async (req, res, next) => { await connect(); next(); }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/me', auth(), (req, res) => res.json({ name: req.user.name, role: req.user.role }));

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
