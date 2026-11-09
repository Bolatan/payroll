const express = require('express');
const connect = require('./db');
const {
  User, Employee, Attendance, ShiftSetup, PublicHoliday, Loan, RepaymentLedger, DeductionRegister,
  Adjustment, PayrollRun, Audit, Candidate, Appraisal, LeaveRequest, GLJournal, PaymentBatch,
  ExchangeRate, TimeClockDevice, PunchLog,
} = require('./models');
const {
  calcLine, calculateLoanMonthlyDeduction, hoursBetween, timeToMinutes, evaluateAttendanceEntry, summarizePeriodAttendance,
  generateGLJournal, processBankPaymentSimulation, pairTimeClockPunches, CBN_BANKS, CFG
} = require('./payroll');
const { r2 } = require('./tax');
const { sign, verify, hash, compare, checkPassword } = require('./auth');

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
  req.user = { id: String(u._id), name: u.username, displayName: u.name, role: u.role, empId: u.empId, mustChangePassword: u.mustChangePassword };
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

// Health checks run before the database connection so they work even when MongoDB is misconfigured.
app.get('/api/health', (req, res) => res.json({
  ok: true,
  config: { MONGODB_URI: !!process.env.MONGODB_URI, JWT_SECRET: (process.env.JWT_SECRET || '').length >= 32 },
}));
app.get('/api/health/db', async (req, res) => {
  try { await connect(); res.json({ ok: true, database: 'connected' }); }
  catch (e) { res.status(503).json({ ok: false, database: 'failed', error: e.message }); }
});

app.use('/api', wrap(async (req, res, next) => { await connect(); next(); }));
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
  res.json({ token: sign(u), user: { id: String(u._id), username: u.username, name: u.name, role: u.role, empId: u.empId, mustChangePassword: u.mustChangePassword } });
}));

app.get('/api/me', makeAuth([], true), (req, res) =>
  res.json({ id: req.user.id, username: req.user.name, name: req.user.displayName, role: req.user.role, empId: req.user.empId, mustChangePassword: req.user.mustChangePassword }));

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
  const { username, name, role, empId, password } = req.body;
  const problem = checkPassword(password);
  if (problem) return res.status(400).json({ error: problem });
  const u = await User.create({ username, name, role, empId, passwordHash: await hash(password), mustChangePassword: true });
  await log(req, 'create', 'User', u.username, { role: u.role, empId: u.empId });
  res.status(201).json({ id: u._id, username: u.username });
}));
app.put('/api/users/:id', auth('admin'), wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role or status.' });
  const change = {};
  for (const k of ['name', 'role', 'empId', 'active']) if (k in req.body) change[k] = req.body[k];
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const before = { name: u.name, role: u.role, empId: u.empId, active: u.active };
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

// ---- Helper: validate employee master payload ----
async function validateAndPrepareEmployee(data, existingEmpId = null, userRole = 'hr', userName = 'system') {
  const errors = [];
  const clean = { ...data };

  // FR-EMP-02: EmpID system-generated or validated unique
  if (!clean.empId || !String(clean.empId).trim()) {
    // Generate unique EmpID
    const count = await Employee.countDocuments();
    let candidateId = `EMP${String(count + 1).padStart(4, '0')}`;
    while (await Employee.exists({ empId: candidateId })) {
      candidateId = `EMP${Math.floor(1000 + Math.random() * 9000)}`;
    }
    clean.empId = candidateId;
  } else {
    clean.empId = String(clean.empId).trim();
    const query = { empId: clean.empId };
    if (existingEmpId) query.empId = { $eq: clean.empId, $ne: existingEmpId };
    if (await Employee.exists(query)) {
      errors.push(`EmpID ${clean.empId} is already in use.`);
    }
  }

  // FR-EMP-03: Status controlled list
  const validStatuses = ['Active', 'On Leave', 'Suspended', 'Terminated'];
  if (clean.status && !validStatuses.includes(clean.status)) {
    errors.push(`Status must be one of: ${validStatuses.join(', ')}.`);
  }

  // FR-EMP-04: HourlyRate derived as BasicSalary / standard monthly hours
  const basic = Number(clean.basic);
  if (isNaN(basic) || basic < 0) {
    errors.push('Basic salary must be a positive number.');
  } else {
    const stdHours = CFG.HOURS();
    const derivedRate = r2(basic / stdHours);
    if (clean.hourlyRate !== undefined && clean.hourlyRate !== null && clean.hourlyRate !== '') {
      const explicitRate = Number(clean.hourlyRate);
      if (Math.abs(explicitRate - derivedRate) > 0.01 && !clean.hourlyRateOverrideReason) {
        errors.push('Manual override of HourlyRate requires a reason.');
      }
      clean.hourlyRate = r2(explicitRate);
    } else {
      clean.hourlyRate = derivedRate;
    }
  }

  // FR-EMP-05: Pension% and NHF% default from statutory reference data, editable only by HR Manager/HR role
  if (clean.pensionPct === undefined || clean.pensionPct === null || clean.pensionPct === '') {
    clean.pensionPct = 0.08;
  } else {
    clean.pensionPct = Number(clean.pensionPct);
  }

  if (clean.nhfPct === undefined || clean.nhfPct === null || clean.nhfPct === '') {
    clean.nhfPct = 0.025;
  } else {
    clean.nhfPct = Number(clean.nhfPct);
  }

  // FR-EMP-08: Bank name chosen from maintained CBN list; AccountNo validated as 10 digits (NUBAN) & unique
  if (clean.bank) {
    const foundBank = CBN_BANKS.find(
      (b) => b.name.toLowerCase() === String(clean.bank).toLowerCase() || b.code === String(clean.bankCode || clean.bank)
    );
    if (foundBank) {
      clean.bank = foundBank.name;
      clean.bankCode = foundBank.code;
    }
  }

  if (clean.accountNo) {
    clean.accountNo = String(clean.accountNo).trim();
    if (!/^\d{10}$/.test(clean.accountNo)) {
      errors.push('Account number must be exactly 10 digits (NUBAN).');
    } else {
      // Check account uniqueness
      const accQuery = { accountNo: clean.accountNo };
      if (existingEmpId) accQuery.empId = { $ne: existingEmpId };
      if (await Employee.exists(accQuery)) {
        errors.push(`Account number ${clean.accountNo} is already assigned to another employee.`);
      }
    }
  }

  // FR-EMP-06: Pay components
  if (clean.payComponents && Array.isArray(clean.payComponents)) {
    clean.payComponents = clean.payComponents.map((c) => ({
      name: String(c.name || '').trim(),
      amount: r2(Number(c.amount) || 0),
      taxable: c.taxable !== false,
      pensionable: c.pensionable !== false,
      recurring: c.recurring !== false,
    })).filter((c) => c.name.length > 0);
  }

  return { clean, errors };
}

// Maintain banks endpoint
app.get('/api/banks', auth('hr', 'payroll', 'approver', 'admin'), (req, res) => res.json(CBN_BANKS));

// ---- Employees (HR) ----
app.get('/api/employees', auth('hr', 'payroll', 'approver'), wrap(async (req, res) =>
  res.json(await Employee.find().sort('empId').lean())));

app.get('/api/employees/export', auth('hr', 'payroll', 'approver'), wrap(async (req, res) => {
  const emps = await Employee.find().sort('empId').lean();
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const headers = [
    'EmpID', 'Surname', 'FirstName', 'Department', 'Position', 'HireDate', 'BasicSalary',
    'HourlyRate', 'HourlyRateOverrideReason', 'PensionPct', 'NHFPct', 'NHFEnrolled', 'Bank', 'BankCode',
    'AccountNo', 'Status', 'EmploymentType', 'PayFrequency', 'State', 'TIN', 'PensionPIN', 'PFA',
    'NHFNumber', 'AnnualRent', 'RentEvidenceRef', 'DOB', 'Phone', 'Email', 'EmergencyContact'
  ];
  const rows = [
    headers.join(','),
    ...emps.map((e) => [
      e.empId, q(e.surname), q(e.firstName), q(e.department), q(e.position),
      e.hireDate ? new Date(e.hireDate).toISOString().slice(0, 10) : '',
      e.basic, e.hourlyRate, q(e.hourlyRateOverrideReason), e.pensionPct, e.nhfPct,
      e.nhfEnrolled ? 'Yes' : 'No', q(e.bank), e.bankCode, e.accountNo, e.status,
      e.employmentType, e.payFrequency, q(e.state), q(e.tin), q(e.pensionPin), q(e.pfa),
      q(e.nhfNumber), e.annualRent, q(e.rentEvidenceRef),
      e.dob ? new Date(e.dob).toISOString().slice(0, 10) : '',
      q(e.phone), q(e.email), q(e.emergencyContact)
    ].join(','))
  ];
  res.type('text/csv').attachment(`employees-${new Date().toISOString().slice(0, 10)}.csv`).send(rows.join('\n'));
}));

app.post('/api/employees/bulk-import', auth('hr'), wrap(async (req, res) => {
  // FR-EMP-10: Bulk import with row-level validation reporting
  const records = Array.isArray(req.body) ? req.body : req.body.employees || [];
  if (!records.length) return res.status(400).json({ error: 'No employee records provided for import.' });

  const results = {
    total: records.length,
    imported: 0,
    failed: 0,
    report: [],
  };

  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    const rowNum = i + 1;
    const { clean, errors } = await validateAndPrepareEmployee(raw, null, req.user.role, req.user.name);

    if (errors.length) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId || 'N/A', status: 'Failed', errors });
    } else {
      try {
        clean.salaryHistory = [{
          effectiveDate: clean.hireDate ? new Date(clean.hireDate) : new Date(),
          basic: clean.basic,
          housing: clean.housing || 0,
          transport: clean.transport || 0,
          otherAllowance: clean.otherAllowance || 0,
          hourlyRate: clean.hourlyRate,
          reason: 'Bulk import initial record',
          changedBy: req.user.name,
        }];
        const emp = await Employee.create(clean);
        await log(req, 'create', 'Employee', emp.empId, { source: 'bulk-import' });
        results.imported++;
        results.report.push({ row: rowNum, empId: emp.empId, status: 'Success' });
      } catch (err) {
        results.failed++;
        results.report.push({ row: rowNum, empId: raw.empId || 'N/A', status: 'Failed', errors: [err.message] });
      }
    }
  }

  await log(req, 'bulk_import', 'Employee', 'batch', { imported: results.imported, failed: results.failed });
  res.json(results);
}));

app.post('/api/employees', auth('hr'), wrap(async (req, res) => {
  const { clean, errors } = await validateAndPrepareEmployee(req.body, null, req.user.role, req.user.name);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  // Initial salary history entry (FR-EMP-09)
  clean.salaryHistory = [{
    effectiveDate: clean.hireDate ? new Date(clean.hireDate) : new Date(),
    basic: clean.basic,
    housing: clean.housing || 0,
    transport: clean.transport || 0,
    otherAllowance: clean.otherAllowance || 0,
    hourlyRate: clean.hourlyRate,
    reason: clean.salaryChangeReason || 'Initial salary on hiring',
    changedBy: req.user.name,
  }];

  const e = await Employee.create(clean);
  await log(req, 'create', 'Employee', e.empId, clean);
  res.status(201).json(e);
}));

app.put('/api/employees/:id', auth('hr'), wrap(async (req, res) => {
  const old = await Employee.findOne({ empId: req.params.id });
  if (!old) return res.status(404).json({ error: 'Employee not found.' });

  // FR-EMP-05: verify pension% / nhf% changes and log them
  const isPensionChanged = req.body.pensionPct !== undefined && Number(req.body.pensionPct) !== old.pensionPct;
  const isNHFChanged = req.body.nhfPct !== undefined && Number(req.body.nhfPct) !== old.nhfPct;

  const { clean, errors } = await validateAndPrepareEmployee(req.body, old.empId, req.user.role, req.user.name);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  // FR-EMP-09: Maintain salary history (effective-dated)
  const isSalaryChanged = clean.basic !== old.basic || clean.housing !== old.housing ||
    clean.transport !== old.transport || clean.otherAllowance !== old.otherAllowance ||
    clean.hourlyRate !== old.hourlyRate;

  if (isSalaryChanged) {
    const historyEntry = {
      effectiveDate: req.body.effectiveDate ? new Date(req.body.effectiveDate) : new Date(),
      basic: clean.basic,
      housing: clean.housing || 0,
      transport: clean.transport || 0,
      otherAllowance: clean.otherAllowance || 0,
      hourlyRate: clean.hourlyRate,
      reason: req.body.salaryChangeReason || 'Salary revision',
      changedBy: req.user.name,
      createdAt: new Date(),
    };
    old.salaryHistory.push(historyEntry);
  }

  const before = old.toObject();
  old.set(clean);
  await old.save();

  if (isPensionChanged) {
    await log(req, 'pension_rate_change', 'Employee', old.empId, { before: before.pensionPct, after: old.pensionPct });
  }
  if (isNHFChanged) {
    await log(req, 'nhf_rate_change', 'Employee', old.empId, { before: before.nhfPct, after: old.nhfPct });
  }

  await log(req, 'update', 'Employee', old.empId, { before, after: old.toObject() });
  res.json(old);
}));

// FR-EMP-01 & FR-EMP-03: Deactivate employee record (Status = Terminated). Terminated records are retained, never deleted!
app.post('/api/employees/:id/deactivate', auth('hr'), wrap(async (req, res) => {
  const old = await Employee.findOne({ empId: req.params.id });
  if (!old) return res.status(404).json({ error: 'Employee not found.' });

  old.status = 'Terminated';
  old.terminationDate = req.body.terminationDate ? new Date(req.body.terminationDate) : new Date();
  await old.save();

  // FR-LN-07: On termination, any outstanding loan balance shall be flagged for recovery from final pay
  const activeLoans = await Loan.find({ empId: old.empId, status: 'Active', outstanding: { $gt: 0 } });
  if (activeLoans.length > 0) {
    await Loan.updateMany(
      { empId: old.empId, status: 'Active', outstanding: { $gt: 0 } },
      { $set: { flaggedForFinalRecovery: true } }
    );
    await log(req, 'flag_termination_loans', 'Employee', old.empId, {
      loanCount: activeLoans.length,
      totalOutstanding: r2(activeLoans.reduce((s, l) => s + (l.outstanding || 0), 0)),
    });
  }

  await log(req, 'deactivate', 'Employee', old.empId, { status: 'Terminated', terminationDate: old.terminationDate });
  res.json({ message: 'Employee deactivated and marked Terminated.', employee: old, flaggedLoans: activeLoans.length });
}));

// ---- Attendance Helpers & Period Locking Check ----
async function assertPeriodNotLocked(date) {
  // FR-ATT-13: Attendance for a locked period shall be read-only
  const d = new Date(date);
  const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const run = await PayrollRun.findOne({ period });
  if (run && run.status === 'Approved') {
    const err = new Error(`Attendance for locked payroll period ${period} is read-only.`);
    err.status = 409;
    throw err;
  }
}

async function isHolidayDate(date) {
  const d = new Date(date);
  const startOfDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const endOfDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return await PublicHoliday.exists({ date: { $gte: startOfDay, $lt: endOfDay } });
}

// ---- Shift Setup & Public Holidays (FR-SHF-01 to FR-SHF-05) ----
app.get('/api/shifts/setup', auth('payroll', 'approver', 'hr', 'admin'), wrap(async (req, res) => {
  let list = await ShiftSetup.find().sort('shift').lean();
  if (!list.length) {
    // Seed defaults
    const defaults = [
      { shift: 'Day', stdHours: 8, multiplier: 1.5, startTime: '08:00', endTime: '17:00', unpaidBreakHours: 1 },
      { shift: 'Night', stdHours: 8, multiplier: 1.75, startTime: '20:00', endTime: '05:00', unpaidBreakHours: 1 },
      { shift: 'Weekend', stdHours: 8, multiplier: 2.0, startTime: '08:00', endTime: '17:00', unpaidBreakHours: 1 },
      { shift: 'Holiday', stdHours: 8, multiplier: 2.5, startTime: '08:00', endTime: '17:00', unpaidBreakHours: 1 },
    ];
    await ShiftSetup.insertMany(defaults);
    list = await ShiftSetup.find().sort('shift').lean();
  }
  res.json(list);
}));

app.post('/api/shifts/setup', auth('admin', 'hr'), wrap(async (req, res) => {
  const { shift, stdHours, multiplier, startTime, endTime, unpaidBreakHours } = req.body;
  if (!shift) return res.status(400).json({ error: 'Shift name is required.' });
  const hours = Number(stdHours);
  const mult = Number(multiplier);
  if (isNaN(hours) || hours < 1 || hours > 24) return res.status(400).json({ error: 'Standard hours must be between 1 and 24.' });
  if (isNaN(mult) || mult < 1.0) return res.status(400).json({ error: 'Shift multiplier must be >= 1.0.' });

  const record = await ShiftSetup.findOneAndUpdate(
    { shift },
    { stdHours: hours, multiplier: mult, startTime, endTime, unpaidBreakHours: Number(unpaidBreakHours) || 0, effectiveDate: new Date() },
    { upsert: true, new: true }
  );
  await log(req, 'update_shift_setup', 'ShiftSetup', shift, req.body);
  res.status(201).json(record);
}));

app.get('/api/holidays', auth('payroll', 'approver', 'hr', 'admin'), wrap(async (req, res) => {
  res.json(await PublicHoliday.find().sort('date').lean());
}));

app.post('/api/holidays', auth('admin', 'hr'), wrap(async (req, res) => {
  const { date, name } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'Date and holiday name are required.' });
  const h = await PublicHoliday.create({ date: new Date(date), name: String(name).trim() });
  await log(req, 'create', 'PublicHoliday', h._id, { date, name });
  res.status(201).json(h);
}));

// ---- Attendance (payroll enters, approver approves overtime) ----
app.get('/api/attendance', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const q = req.query.period && validPeriod(req.query.period)
    ? { date: { $gte: periodRange(req.query.period)[0], $lt: periodRange(req.query.period)[1] } } : {};
  if (req.query.empId) q.empId = req.query.empId;
  res.json(await Attendance.find(q).sort('-date').limit(500).lean());
}));

app.post('/api/attendance', auth('payroll'), wrap(async (req, res) => {
  const b = req.body;
  const attDate = new Date(b.date);
  if (isNaN(attDate.getTime())) return res.status(400).json({ error: 'Valid date is required.' });

  // FR-ATT-13: Read-only in locked period
  await assertPeriodNotLocked(attDate);

  if (!(await Employee.exists({ empId: b.empId, status: { $in: ['Active', 'On Leave'] } })))
    return res.status(400).json({ error: 'Employee not found or not active.' });

  // Check duplicate / overlapping entries for the same employee and date and shift (FR-ATT-03)
  const startOfDay = new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate()));
  const endOfDay = new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate() + 1));
  const existing = await Attendance.findOne({
    empId: b.empId,
    date: { $gte: startOfDay, $lt: endOfDay },
    shift: b.shift,
  });
  if (existing) {
    return res.status(409).json({ error: `Attendance entry already exists for employee ${b.empId} on this date for shift ${b.shift}.` });
  }

  const dayOfWeek = attDate.getUTCDay(); // 0 = Sun, 6 = Sat
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isHoliday = await isHolidayDate(attDate);

  if (b.absent) {
    const a = await Attendance.create({
      empId: b.empId,
      date: startOfDay,
      shift: b.shift || 'Day',
      absent: true,
      absentReason: b.absentReason || 'Absent',
      supervisorOverrideReason: b.supervisorOverrideReason,
      hoursWorked: 0,
      otHours: 0,
      weekendOT: 0,
      holidayOT: 0,
      approved: false,
      createdBy: req.user.name,
      source: b.source || 'manual',
    });
    await log(req, 'create', 'Attendance', a._id, { empId: a.empId, date: a.date, absent: true });
    return res.status(201).json(a);
  }

  if (!/^\d{2}:\d{2}$/.test(b.clockIn || '') || !/^\d{2}:\d{2}$/.test(b.clockOut || ''))
    return res.status(400).json({ error: 'Clock times must be HH:MM.' });

  // Evaluate hours, OT, multipliers, lateness
  const evaluation = evaluateAttendanceEntry({
    shift: b.shift,
    clockIn: b.clockIn,
    clockOut: b.clockOut,
    breakHours: Number(b.breakHours) || 0,
    absent: false,
  }, {
    isWeekend,
    isHoliday,
  });

  if (evaluation.hoursWorked <= 0 || evaluation.hoursWorked > 24)
    return res.status(400).json({ error: 'Hours worked must be between 0 and 24.' });

  const a = await Attendance.create({
    empId: b.empId,
    date: startOfDay,
    shift: b.shift,
    clockIn: b.clockIn,
    clockOut: b.clockOut,
    breakHours: Number(b.breakHours) || 0,
    hoursWorked: evaluation.hoursWorked,
    otHours: evaluation.otHours,
    weekendOT: evaluation.weekendOT,
    holidayOT: evaluation.holidayOT,
    multiplier: evaluation.multiplier,
    lateMinutes: evaluation.lateMinutes,
    earlyDepartureMinutes: evaluation.earlyDepartureMinutes,
    otExceededWarning: evaluation.otExceededWarning,
    source: b.source || 'manual',
    approved: false,
    createdBy: req.user.name,
  });

  await log(req, 'create', 'Attendance', a._id, { empId: a.empId, date: a.date, hoursWorked: a.hoursWorked, otHours: a.otHours });
  res.status(201).json(a);
}));

// FR-ATT-02: Attendance bulk import with row-level error reporting
app.post('/api/attendance/bulk-import', auth('payroll'), wrap(async (req, res) => {
  const entries = Array.isArray(req.body) ? req.body : req.body.entries || [];
  if (!entries.length) return res.status(400).json({ error: 'No attendance records provided.' });

  const results = {
    total: entries.length,
    imported: 0,
    failed: 0,
    report: [],
  };

  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i];
    const rowNum = i + 1;
    const errors = [];

    if (!raw.empId) errors.push('Missing empId.');
    if (!raw.date) errors.push('Missing date.');
    const shift = raw.shift || 'Day';
    if (!['Day', 'Night', 'Weekend', 'Holiday'].includes(shift)) errors.push('Invalid shift type.');

    const attDate = new Date(raw.date);
    if (isNaN(attDate.getTime())) errors.push('Invalid date format.');

    if (errors.length) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId || 'N/A', status: 'Failed', errors });
      continue;
    }

    try {
      await assertPeriodNotLocked(attDate);
    } catch (e) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: [e.message] });
      continue;
    }

    const empExists = await Employee.exists({ empId: raw.empId, status: { $in: ['Active', 'On Leave'] } });
    if (!empExists) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: ['Employee not found or not active.'] });
      continue;
    }

    const startOfDay = new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate()));
    const endOfDay = new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate() + 1));

    // Duplicate check
    const existing = await Attendance.findOne({
      empId: raw.empId,
      date: { $gte: startOfDay, $lt: endOfDay },
      shift,
    });
    if (existing) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: ['Duplicate entry for same employee, date and shift.'] });
      continue;
    }

    const dayOfWeek = attDate.getUTCDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = await isHolidayDate(attDate);

    if (raw.absent) {
      try {
        const a = await Attendance.create({
          empId: raw.empId,
          date: startOfDay,
          shift,
          absent: true,
          absentReason: raw.absentReason || 'Absent',
          supervisorOverrideReason: raw.supervisorOverrideReason,
          hoursWorked: 0,
          otHours: 0,
          weekendOT: 0,
          holidayOT: 0,
          approved: false,
          createdBy: req.user.name,
          source: 'import',
        });
        results.imported++;
        results.report.push({ row: rowNum, empId: raw.empId, status: 'Success', id: a._id });
      } catch (err) {
        results.failed++;
        results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: [err.message] });
      }
      continue;
    }

    if (!/^\d{2}:\d{2}$/.test(raw.clockIn || '') || !/^\d{2}:\d{2}$/.test(raw.clockOut || '')) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: ['Clock times must be HH:MM format.'] });
      continue;
    }

    const evalRes = evaluateAttendanceEntry({
      shift,
      clockIn: raw.clockIn,
      clockOut: raw.clockOut,
      breakHours: Number(raw.breakHours) || 0,
      absent: false,
    }, { isWeekend, isHoliday });

    if (evalRes.hoursWorked <= 0 || evalRes.hoursWorked > 24) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: ['Hours worked must be between 0 and 24.'] });
      continue;
    }

    try {
      const a = await Attendance.create({
        empId: raw.empId,
        date: startOfDay,
        shift,
        clockIn: raw.clockIn,
        clockOut: raw.clockOut,
        breakHours: Number(raw.breakHours) || 0,
        hoursWorked: evalRes.hoursWorked,
        otHours: evalRes.otHours,
        weekendOT: evalRes.weekendOT,
        holidayOT: evalRes.holidayOT,
        multiplier: evalRes.multiplier,
        lateMinutes: evalRes.lateMinutes,
        earlyDepartureMinutes: evalRes.earlyDepartureMinutes,
        otExceededWarning: evalRes.otExceededWarning,
        source: 'import',
        approved: false,
        createdBy: req.user.name,
      });
      results.imported++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Success', id: a._id });
    } catch (err) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: [err.message] });
    }
  }

  await log(req, 'bulk_import', 'Attendance', 'batch', { imported: results.imported, failed: results.failed });
  res.json(results);
}));

// FR-ATT-10: Auto-absent generation for scheduled working days with no attendance and no approved leave
app.post('/api/attendance/auto-absent', auth('payroll', 'approver'), wrap(async (req, res) => {
  const { date, department } = req.body;
  const targetDate = date ? new Date(date) : new Date();
  if (isNaN(targetDate.getTime())) return res.status(400).json({ error: 'Valid date is required.' });

  await assertPeriodNotLocked(targetDate);

  const startOfDay = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate()));
  const endOfDay = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate() + 1));

  // Find active employees
  const empQuery = { status: 'Active' };
  if (department) empQuery.department = department;
  const activeEmps = await Employee.find(empQuery).lean();

  const generated = [];
  for (const emp of activeEmps) {
    // Check if attendance exists
    const hasAtt = await Attendance.exists({
      empId: emp.empId,
      date: { $gte: startOfDay, $lt: endOfDay },
    });
    if (hasAtt) continue;

    // Check if approved leave exists
    const hasLeave = await LeaveRequest.exists({
      empId: emp.empId,
      status: 'Approved',
      startDate: { $lte: endOfDay },
      endDate: { $gte: startOfDay },
    });
    if (hasLeave) continue;

    // Auto mark Absent
    const a = await Attendance.create({
      empId: emp.empId,
      date: startOfDay,
      shift: 'Day',
      absent: true,
      absentReason: 'Auto-marked Absent: No attendance and no approved leave',
      hoursWorked: 0,
      otHours: 0,
      weekendOT: 0,
      holidayOT: 0,
      approved: false,
      createdBy: 'system_auto_absent',
      source: 'auto-absent',
    });
    generated.push(a);
  }

  await log(req, 'auto_absent', 'Attendance', targetDate.toISOString().slice(0, 10), { count: generated.length });
  res.json({ message: `Generated ${generated.length} absence records.`, count: generated.length, records: generated });
}));

// FR-ATT-12: Period attendance summary per employee
app.get('/api/attendance/summary', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const period = req.query.period;
  if (!period || !validPeriod(period)) return res.status(400).json({ error: 'Valid period (YYYY-MM) is required.' });

  const [from, to] = periodRange(period);
  const emps = await Employee.find({ status: { $in: ['Active', 'On Leave', 'Terminated'] } }).sort('empId').lean();
  const allAtt = await Attendance.find({ date: { $gte: from, $lt: to } }).lean();
  const allLeaves = await LeaveRequest.find({
    status: 'Approved',
    startDate: { $lt: to },
    endDate: { $gte: from },
  }).lean();

  const attByEmp = allAtt.reduce((acc, a) => {
    (acc[a.empId] ||= []).push(a);
    return acc;
  }, {});

  const leavesByEmp = allLeaves.reduce((acc, l) => {
    acc[l.empId] = (acc[l.empId] || 0) + (l.days || 1);
    return acc;
  }, {});

  const summaries = emps.map((e) => {
    const records = attByEmp[e.empId] || [];
    const leaveDays = leavesByEmp[e.empId] || 0;
    const stats = summarizePeriodAttendance(records, leaveDays);
    return {
      empId: e.empId,
      name: `${e.surname} ${e.firstName}`,
      department: e.department,
      ...stats,
    };
  });

  res.json({ period, summaries });
}));

// FR-ATT-08 & FR-ATT-09: Attendance Exceptions report (unapproved OT & OT exceeding caps)
app.get('/api/attendance/exceptions', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const period = req.query.period;
  const q = {};
  if (period && validPeriod(period)) {
    const [from, to] = periodRange(period);
    q.date = { $gte: from, $lt: to };
  }

  // Find entries with unapproved OT or warnings
  const records = await Attendance.find(q).sort('-date').lean();
  const unapprovedOT = [];
  const capExceeded = [];

  for (const r of records) {
    const totalOT = (r.otHours || 0) + (r.weekendOT || 0) + (r.holidayOT || 0);
    if (!r.approved && totalOT > 0) {
      unapprovedOT.push(r);
    }
    if (r.otExceededWarning || totalOT > CFG.MAX_DAILY_OT) {
      capExceeded.push(r);
    }
  }

  res.json({
    totalUnapprovedOT: unapprovedOT.length,
    totalCapExceeded: capExceeded.length,
    unapprovedOT,
    capExceeded,
  });
}));

// Supervisor approval of overtime (FR-ATT-08)
app.post('/api/attendance/:id/approve', auth('approver'), wrap(async (req, res) => {
  const a = await Attendance.findById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Entry not found.' });

  // Read-only in locked period
  await assertPeriodNotLocked(a.date);

  a.approved = true;
  a.approvedBy = req.user.name;
  await a.save();
  await log(req, 'approve', 'Attendance', a._id, { empId: a.empId, otHours: a.otHours });
  res.json(a);
}));

// ---- Loans (FR-LN-01 to FR-LN-07) ----
app.get('/api/loans', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.empId) filter.empId = req.query.empId;
  if (req.query.status) filter.status = req.query.status;
  res.json(await Loan.find(filter).sort('-createdAt').lean());
}));

app.post('/api/loans', auth('payroll', 'hr'), wrap(async (req, res) => {
  const {
    loanId, empId, amount, termMonths, startDate, startPeriod, interestRate = 0, interestType = 'none', currency = 'NGN'
  } = req.body;

  if (!empId || !(await Employee.exists({ empId }))) {
    return res.status(400).json({ error: 'Valid Employee ID is required.' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Loan amount must be greater than zero.' });
  }
  if (!termMonths || Number(termMonths) < 1) {
    return res.status(400).json({ error: 'Term months must be at least 1.' });
  }

  // Derive startPeriod from startDate if startPeriod is omitted
  let derivedPeriod = startPeriod;
  let parsedStartDate = startDate ? new Date(startDate) : undefined;
  if (!derivedPeriod && parsedStartDate) {
    derivedPeriod = `${parsedStartDate.getUTCFullYear()}-${String(parsedStartDate.getUTCMonth() + 1).padStart(2, '0')}`;
  } else if (!derivedPeriod) {
    return res.status(400).json({ error: 'StartDate or startPeriod (YYYY-MM) is required.' });
  }

  // FR-LN-01: Calculate MonthlyDeduction (Amount ÷ TermMonths, plus interest if configured)
  const monthly = calculateLoanMonthlyDeduction(amount, termMonths, interestRate, interestType);
  const outstanding = Number(amount);

  const l = await Loan.create({
    loanId: loanId || `LN-${Date.now().toString().slice(-6)}`,
    empId,
    amount,
    termMonths,
    startDate: parsedStartDate,
    startPeriod: derivedPeriod,
    interestRate,
    interestType,
    monthly,
    outstanding,
    currency,
    status: 'Pending',
    createdBy: req.user.name,
  });

  await log(req, 'create', 'Loan', l._id, req.body);
  res.status(201).json(l);
}));

// FR-LN-02: Loans require approval by an authorised approver; approver cannot be the requestor
app.post('/api/loans/:id/approve', auth('approver'), wrap(async (req, res) => {
  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  if (l.createdBy === req.user.name) return res.status(403).json({ error: 'You cannot approve a loan you created.' });
  if (l.status === 'Active') return res.status(400).json({ error: 'Loan is already active.' });

  l.status = 'Active';
  l.approvedBy = req.user.name;
  await l.save();
  await log(req, 'approve', 'Loan', l._id, { empId: l.empId, amount: l.amount });
  res.json(l);
}));

// FR-LN-06: Loan top-up, early settlement, restructuring, and instalment holiday
// 1. Top-up
app.post('/api/loans/:id/topup', auth('payroll', 'hr'), wrap(async (req, res) => {
  const { additionalAmount, additionalTermMonths = 0 } = req.body;
  if (!additionalAmount || Number(additionalAmount) <= 0) {
    return res.status(400).json({ error: 'Additional top-up amount must be greater than zero.' });
  }

  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  if (l.status !== 'Active') return res.status(400).json({ error: 'Only active loans can be topped up.' });

  const change = {
    type: 'topup',
    details: { additionalAmount: Number(additionalAmount), additionalTermMonths: Number(additionalTermMonths) },
    requestedBy: req.user.name,
    requestedAt: new Date(),
    status: 'Pending',
  };
  l.changeRequests.push(change);
  await l.save();
  await log(req, 'request_topup', 'Loan', l._id, change.details);
  res.json({ message: 'Loan top-up requested; awaiting approval.', loan: l, changeRequestId: l.changeRequests[l.changeRequests.length - 1]._id });
}));

// 2. Early Settlement
app.post('/api/loans/:id/settle', auth('payroll', 'hr'), wrap(async (req, res) => {
  const { settlementAmount, reason = 'Early settlement' } = req.body;
  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  if (l.status !== 'Active') return res.status(400).json({ error: 'Only active loans can be settled.' });

  const amt = settlementAmount !== undefined ? Number(settlementAmount) : l.outstanding;
  if (amt <= 0) return res.status(400).json({ error: 'Settlement amount must be positive.' });

  const change = {
    type: 'early_settlement',
    details: { settlementAmount: amt, reason },
    requestedBy: req.user.name,
    requestedAt: new Date(),
    status: 'Pending',
  };
  l.changeRequests.push(change);
  await l.save();
  await log(req, 'request_settlement', 'Loan', l._id, change.details);
  res.json({ message: 'Early settlement requested; awaiting approval.', loan: l, changeRequestId: l.changeRequests[l.changeRequests.length - 1]._id });
}));

// 3. Restructure (term change / monthly recalculation)
app.post('/api/loans/:id/restructure', auth('payroll', 'hr'), wrap(async (req, res) => {
  const { newTermMonths, newMonthly } = req.body;
  if (!newTermMonths && !newMonthly) {
    return res.status(400).json({ error: 'Either newTermMonths or newMonthly is required for restructuring.' });
  }

  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  if (l.status !== 'Active') return res.status(400).json({ error: 'Only active loans can be restructured.' });

  const change = {
    type: 'restructure',
    details: {
      newTermMonths: newTermMonths ? Number(newTermMonths) : undefined,
      newMonthly: newMonthly ? Number(newMonthly) : undefined,
    },
    requestedBy: req.user.name,
    requestedAt: new Date(),
    status: 'Pending',
  };
  l.changeRequests.push(change);
  await l.save();
  await log(req, 'request_restructure', 'Loan', l._id, change.details);
  res.json({ message: 'Loan restructuring requested; awaiting approval.', loan: l, changeRequestId: l.changeRequests[l.changeRequests.length - 1]._id });
}));

// 4. Instalment Holiday (skip deductions for specified periods)
app.post('/api/loans/:id/holiday', auth('payroll', 'hr'), wrap(async (req, res) => {
  const { periods } = req.body; // e.g. ["2026-12"]
  if (!Array.isArray(periods) || periods.length === 0) {
    return res.status(400).json({ error: 'An array of holiday periods (YYYY-MM) is required.' });
  }

  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  if (l.status !== 'Active') return res.status(400).json({ error: 'Only active loans can receive holiday periods.' });

  const change = {
    type: 'holiday',
    details: { periods },
    requestedBy: req.user.name,
    requestedAt: new Date(),
    status: 'Pending',
  };
  l.changeRequests.push(change);
  await l.save();
  await log(req, 'request_holiday', 'Loan', l._id, change.details);
  res.json({ message: 'Loan instalment holiday requested; awaiting approval.', loan: l, changeRequestId: l.changeRequests[l.changeRequests.length - 1]._id });
}));

// Approve or reject a loan change request (FR-LN-06)
app.post('/api/loans/:id/change-requests/:reqId/approve', auth('approver'), wrap(async (req, res) => {
  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  const cr = l.changeRequests.id(req.params.reqId);
  if (!cr) return res.status(404).json({ error: 'Change request not found.' });
  if (cr.status !== 'Pending') return res.status(400).json({ error: `Change request is already ${cr.status}.` });
  if (cr.requestedBy === req.user.name) {
    return res.status(403).json({ error: 'The requestor cannot approve this change request.' });
  }

  cr.status = 'Approved';
  cr.approvedBy = req.user.name;
  cr.approvedAt = new Date();

  // Apply change logic based on type
  if (cr.type === 'topup') {
    const { additionalAmount, additionalTermMonths = 0 } = cr.details;
    l.amount = r2(l.amount + additionalAmount);
    l.outstanding = r2(l.outstanding + additionalAmount);
    l.termMonths += Number(additionalTermMonths || 0);
    l.monthly = calculateLoanMonthlyDeduction(l.outstanding, l.termMonths, l.interestRate, l.interestType);
  } else if (cr.type === 'early_settlement') {
    const { settlementAmount } = cr.details;
    const balanceBefore = l.outstanding;
    const deducted = Math.min(balanceBefore, settlementAmount);
    l.outstanding = r2(Math.max(0, balanceBefore - deducted));
    if (l.outstanding <= 0.005) {
      l.status = 'Closed';
      l.outstanding = 0;
    }
    // Record Repayment Ledger line for early settlement
    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await RepaymentLedger.create({
      loanId: String(l.loanId || l._id),
      empId: l.empId,
      period,
      amountDeducted: deducted,
      balanceBefore,
      balanceAfter: l.outstanding,
      type: 'early_settlement',
      approvedBy: req.user.name,
    });
  } else if (cr.type === 'restructure') {
    const { newTermMonths, newMonthly } = cr.details;
    if (newTermMonths) {
      l.termMonths = newTermMonths;
      l.monthly = calculateLoanMonthlyDeduction(l.outstanding, newTermMonths, l.interestRate, l.interestType);
    }
    if (newMonthly) {
      l.monthly = r2(newMonthly);
    }
  } else if (cr.type === 'holiday') {
    const { periods } = cr.details;
    l.holidayPeriods = Array.from(new Set([...(l.holidayPeriods || []), ...periods]));
  }

  await l.save();
  await log(req, 'approve_change_request', 'Loan', l._id, { type: cr.type, details: cr.details });
  res.json({ message: `Loan ${cr.type} approved and applied successfully.`, loan: l });
}));

// Loan Repayment Ledger endpoint (FR-LN-04)
app.get('/api/loans/:id/ledger', auth('payroll', 'approver', 'hr', 'employee'), wrap(async (req, res) => {
  const l = await Loan.findById(req.params.id).lean();
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  if (req.user.role === 'employee' && req.user.empId !== l.empId) {
    return res.status(403).json({ error: 'You can only view your own loan ledger.' });
  }
  const ledger = await RepaymentLedger.find({
    $or: [{ loanId: String(l._id) }, { loanId: l.loanId }]
  }).sort('timestamp').lean();
  res.json({ loan: l, ledger });
}));

app.get('/api/loans-ledger', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.empId) filter.empId = req.query.empId;
  if (req.query.period) filter.period = req.query.period;
  res.json(await RepaymentLedger.find(filter).sort('-timestamp').limit(500).lean());
}));

// ---- FR-LN-09: Deductions Register ----
app.get('/api/deductions', auth('payroll', 'approver', 'hr'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.empId) filter.empId = req.query.empId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  res.json(await DeductionRegister.find(filter).sort('-createdAt').lean());
}));

app.post('/api/deductions', auth('payroll', 'hr'), wrap(async (req, res) => {
  const { empId, type, title, amount, recurring = false, startPeriod, endPeriod, reason } = req.body;
  if (!empId || !(await Employee.exists({ empId }))) {
    return res.status(400).json({ error: 'Valid Employee ID is required.' });
  }
  if (!type || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Deduction type and positive amount are required.' });
  }
  if (!startPeriod || !validPeriod(startPeriod)) {
    return res.status(400).json({ error: 'Valid startPeriod (YYYY-MM) is required.' });
  }

  const d = await DeductionRegister.create({
    empId,
    type,
    title: title || type,
    amount: r2(Number(amount)),
    recurring: Boolean(recurring),
    startPeriod,
    endPeriod: endPeriod || undefined,
    reason,
    status: 'Pending',
    createdBy: req.user.name,
  });

  await log(req, 'create', 'DeductionRegister', d._id, req.body);
  res.status(201).json(d);
}));

app.post('/api/deductions/:id/approve', auth('approver'), wrap(async (req, res) => {
  const d = await DeductionRegister.findById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Deduction entry not found.' });
  if (d.createdBy === req.user.name) {
    return res.status(403).json({ error: 'You cannot approve a deduction entry you created.' });
  }
  d.status = 'Approved';
  d.approvedBy = req.user.name;
  d.approvedAt = new Date();
  await d.save();

  await log(req, 'approve', 'DeductionRegister', d._id, { empId: d.empId, amount: d.amount });
  res.json(d);
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
  // FR-EMP-11: Include active employees, those on leave, and any leavers terminated in this period
  const [emps, att, adj, loans, deductions] = await Promise.all([
    Employee.find({
      $or: [
        { status: { $in: ['Active', 'On Leave'] } },
        { status: 'Terminated', terminationDate: { $gte: from, $lte: to } },
      ],
    }).sort('empId').lean(),
    Attendance.find({ date: { $gte: from, $lt: to } }).lean(),
    Adjustment.find({ period }).lean(),
    Loan.find({ status: 'Active' }).lean(),
    DeductionRegister.find({
      status: 'Approved',
      startPeriod: { $lte: period },
      $or: [{ endPeriod: null }, { endPeriod: { $gte: period } }, { recurring: false, startPeriod: period }],
    }).lean(),
  ]);
  const by = (arr, f = () => true) => arr.reduce((m, x) => ((f(x) && (m[x.empId] ||= []).push(x)), m), {});
  const attBy = by(att, (x) => x.approved), adjBy = by(adj, (x) => x.approved), loanBy = by(loans), dedBy = by(deductions);

  const warnings = [];
  const pendingOT = att.filter((x) => !x.approved).length;
  const pendingAdj = adj.filter((x) => !x.approved).length;
  if (pendingOT) warnings.push(`${pendingOT} unapproved attendance entries were excluded.`);
  if (pendingAdj) warnings.push(`${pendingAdj} unapproved adjustments were excluded.`);

  const prorationMethod = req.body?.prorationMethod || 'calendar';
  const lines = emps.map((e) => calcLine(e, {
    attendance: attBy[e.empId],
    adjustments: adjBy[e.empId],
    loans: loanBy[e.empId],
    deductions: dedBy[e.empId],
  }, period, { prorationMethod }));

  const sum = (k) => r2(lines.reduce((s, l) => s + l[k], 0));
  const totals = {
    employees: lines.length, gross: sum('gross'), paye: sum('paye'), pension: sum('pension'), nhf: sum('nhf'),
    loans: sum('loanDeduction'), net: sum('netPay'), employerPension: sum('employerPension'), otPay: sum('otPay'),
    otherDeductions: sum('otherDeductions'), totalDeductions: sum('totalDeductions'),
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

  // FR-LN-04: Outstanding reduces by amount deducted and repayment-ledger line is written
  for (const l of run.lines) {
    for (const lb of l.loanBreakdown) {
      const loan = await Loan.findById(lb.loanId);
      if (loan) {
        const balanceBefore = loan.outstanding;
        loan.outstanding = r2(Math.max(0, loan.outstanding - lb.amount));
        if (loan.outstanding <= 0.005) {
          loan.status = 'Closed';
          loan.outstanding = 0;
        }
        await loan.save();

        await RepaymentLedger.create({
          loanId: String(loan.loanId || loan._id),
          empId: l.empId,
          period: run.period,
          amountDeducted: lb.amount,
          balanceBefore,
          balanceAfter: loan.outstanding,
          type: 'payroll',
          payrollRunId: String(claimed._id),
          approvedBy: req.user.name,
        });
      }
    }
  }

  await log(req, 'approve', 'PayrollRun', run.period, run.totals);
  res.json(claimed);
}));

app.get('/api/payroll/:period/payslip/:empId', auth('payroll', 'approver', 'hr', 'employee'), wrap(async (req, res) => {
  // If employee role, enforce viewing only their own payslip
  if (req.user.role === 'employee' && req.user.empId !== req.params.empId) {
    return res.status(403).json({ error: 'You can only view your own payslip.' });
  }
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

// =========================================================================
// Extended Capabilities REST APIs
// =========================================================================

// 1. Recruitment & Onboarding (HR)
app.get('/api/recruitment', auth('hr', 'approver'), wrap(async (req, res) =>
  res.json(await Candidate.find().sort('-createdAt').lean())));

app.post('/api/recruitment', auth('hr'), wrap(async (req, res) => {
  const candidateId = `CAN-${Date.now().toString().slice(-5)}`;
  const candidate = await Candidate.create({
    ...req.body,
    candidateId,
    createdBy: req.user.name,
    onboardingChecklist: [
      { task: 'Signed Employment Contract' },
      { task: 'Bank Details and NUBAN Verification' },
      { task: 'Tax Identification Number (TIN) Verification' },
      { task: 'Pension RSA PIN Verification' },
      { task: 'Factory Safety & PPE Induction' },
    ],
  });
  await log(req, 'create', 'Candidate', candidate.candidateId, req.body);
  res.status(201).json(candidate);
}));

app.post('/api/recruitment/:id/hire', auth('hr'), wrap(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });
  if (candidate.stage === 'Hired') return res.status(400).json({ error: 'Candidate is already hired.' });

  const empId = req.body.empId || `EMP${Date.now().toString().slice(-4)}`;
  const [surname, ...firstParts] = candidate.fullName.split(' ');
  const firstName = firstParts.join(' ') || surname;

  // Onboard candidate directly into Employee master data
  const emp = await Employee.create({
    empId,
    surname,
    firstName,
    department: candidate.department,
    position: candidate.position,
    hireDate: candidate.hireDate || new Date(),
    basic: candidate.offeredSalary || req.body.basic || 100000,
    housing: req.body.housing || 0,
    transport: req.body.transport || 0,
    bank: req.body.bank || 'Access Bank',
    accountNo: req.body.accountNo || '0123456789',
    status: 'Active',
  });

  candidate.stage = 'Hired';
  candidate.createdEmployeeId = empId;
  await candidate.save();

  await log(req, 'hire', 'Candidate', candidate.candidateId, { createdEmployeeId: empId });
  res.json({ message: 'Candidate successfully onboarded into Employee master.', employee: emp });
}));

// 2. Performance Appraisal (HR, Approver)
app.get('/api/appraisals', auth('hr', 'approver', 'payroll'), wrap(async (req, res) =>
  res.json(await Appraisal.find().sort('-createdAt').lean())));

app.post('/api/appraisals', auth('hr', 'approver'), wrap(async (req, res) => {
  const appraisal = await Appraisal.create({
    ...req.body,
    reviewer: req.user.name,
    status: 'Draft',
  });
  await log(req, 'create', 'Appraisal', appraisal._id, req.body);
  res.status(201).json(appraisal);
}));

app.post('/api/appraisals/:id/approve', auth('approver'), wrap(async (req, res) => {
  const appraisal = await Appraisal.findById(req.params.id);
  if (!appraisal) return res.status(404).json({ error: 'Appraisal not found.' });
  appraisal.status = 'Approved';
  appraisal.approvedBy = req.user.name;
  await appraisal.save();

  // If there's a recommended bonus, auto-create an adjustment for the current period if requested
  if (appraisal.bonusRecommendation > 0 && req.body.postToBonusPeriod) {
    await Adjustment.create({
      period: req.body.postToBonusPeriod,
      empId: appraisal.empId,
      type: 'bonus',
      amount: appraisal.bonusRecommendation,
      reason: `Performance appraisal bonus cycle ${appraisal.cycle} (Rating: ${appraisal.rating}/5)`,
      approved: true,
      approvedBy: req.user.name,
      createdBy: 'system',
    });
  }

  await log(req, 'approve', 'Appraisal', appraisal._id, { bonus: appraisal.bonusRecommendation });
  res.json(appraisal);
}));

// 3. Employee Self-Service (ESS)
app.get('/api/ess/profile', auth('employee', 'admin', 'hr'), wrap(async (req, res) => {
  const empId = req.user.empId;
  if (!empId) return res.status(400).json({ error: 'No employee profile linked to your user.' });
  const emp = await Employee.findOne({ empId }).lean();
  if (!emp) return res.status(404).json({ error: 'Employee record not found.' });
  res.json(emp);
}));

app.get('/api/ess/payslips', auth('employee', 'admin', 'hr'), wrap(async (req, res) => {
  const empId = req.user.empId;
  if (!empId) return res.status(400).json({ error: 'No employee profile linked to your user.' });
  const runs = await PayrollRun.find({ status: 'Approved' }).sort('-period').lean();
  const slips = [];
  for (const r of runs) {
    const l = r.lines?.find((x) => x.empId === empId);
    if (l) slips.push({ period: r.period, ...l });
  }
  res.json(slips);
}));

app.get('/api/ess/leaves', auth('employee', 'hr', 'approver'), wrap(async (req, res) => {
  const empId = req.user.role === 'employee' ? req.user.empId : req.query.empId;
  const q = empId ? { empId } : {};
  res.json(await LeaveRequest.find(q).sort('-createdAt').lean());
}));

app.post('/api/ess/leaves', auth('employee', 'hr'), wrap(async (req, res) => {
  const empId = req.user.role === 'employee' ? req.user.empId : req.body.empId;
  if (!empId) return res.status(400).json({ error: 'Employee ID required.' });
  const leave = await LeaveRequest.create({
    empId,
    leaveType: req.body.leaveType,
    startDate: new Date(req.body.startDate),
    endDate: new Date(req.body.endDate),
    days: Number(req.body.days) || 1,
    reason: req.body.reason,
    status: 'Pending',
  });
  await log(req, 'create', 'LeaveRequest', leave._id, { empId, days: leave.days });
  res.status(201).json(leave);
}));

app.post('/api/ess/leaves/:id/approve', auth('approver', 'hr'), wrap(async (req, res) => {
  const leave = await LeaveRequest.findById(req.params.id);
  if (!leave) return res.status(404).json({ error: 'Leave request not found.' });
  leave.status = 'Approved';
  leave.approvedBy = req.user.name;
  await leave.save();
  await log(req, 'approve', 'LeaveRequest', leave._id, {});
  res.json(leave);
}));

// 4. General-Ledger Journal Posting
app.get('/api/gl/journals', auth('payroll', 'approver', 'admin'), wrap(async (req, res) =>
  res.json(await GLJournal.find().sort('-postDate').lean())));

app.post('/api/payroll/:period/post-gl', auth('approver', 'payroll'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period });
  if (!run) return res.status(404).json({ error: 'Payroll run not found.' });
  if (run.status !== 'Approved') return res.status(400).json({ error: 'Only approved payroll can be posted to GL.' });

  const journalData = generateGLJournal(run);
  const journal = await GLJournal.create({
    ...journalData,
    postedBy: req.user.name,
    status: 'Posted',
  });

  run.glPosted = true;
  run.glJournalId = journal.journalNumber;
  await run.save();

  await log(req, 'post_gl', 'GLJournal', journal.journalNumber, { period: run.period, total: journal.totalDebit });
  res.json({ message: 'Payroll posted to General Ledger successfully.', journal });
}));

// 5. Direct Bank Payment Integration
app.get('/api/payments/batches', auth('payroll', 'approver'), wrap(async (req, res) =>
  res.json(await PaymentBatch.find().sort('-createdAt').lean())));

app.post('/api/payroll/:period/initiate-bank-payment', auth('approver', 'payroll'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period });
  if (!run) return res.status(404).json({ error: 'Payroll run not found.' });
  if (run.status !== 'Approved') return res.status(400).json({ error: 'Only approved payroll can be sent for direct bank payment.' });

  const channel = req.body.channel || 'NIBSS_INSTANT_PAY';
  const batchData = processBankPaymentSimulation(run, channel);

  const batch = await PaymentBatch.create({
    ...batchData,
    initiatedBy: req.user.name,
  });

  run.bankPaymentInitiated = true;
  run.paymentReference = batch.batchReference;
  await run.save();

  await log(req, 'direct_bank_payment', 'PaymentBatch', batch.batchReference, { channel, amount: batch.totalAmount });
  res.json({ message: 'Direct bank payment batch dispatched successfully.', batch });
}));

// 6. Multi-Currency Exchange Rates
app.get('/api/currencies/rates', auth('payroll', 'approver', 'hr', 'admin'), wrap(async (req, res) =>
  res.json(await ExchangeRate.find().sort('-effectiveDate').lean())));

app.post('/api/currencies/rates', auth('payroll', 'admin'), wrap(async (req, res) => {
  const { targetCurrency, rate, effectiveDate } = req.body;
  const ex = await ExchangeRate.create({
    baseCurrency: 'NGN',
    targetCurrency,
    rate: Number(rate),
    effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
  });
  await log(req, 'create', 'ExchangeRate', ex._id, { targetCurrency, rate });
  res.status(201).json(ex);
}));

// 7. Time-Clock Hardware Integration
app.get('/api/timeclock/devices', auth('payroll', 'admin'), wrap(async (req, res) =>
  res.json(await TimeClockDevice.find().lean())));

app.post('/api/timeclock/devices', auth('admin'), wrap(async (req, res) => {
  const dev = await TimeClockDevice.create(req.body);
  await log(req, 'create', 'TimeClockDevice', dev.deviceId, req.body);
  res.status(201).json(dev);
}));

// Hardware biometric ingestion endpoint
app.post('/api/timeclock/punches', wrap(async (req, res) => {
  // Can be called by device or sync agent
  const punches = Array.isArray(req.body) ? req.body : [req.body];
  const created = await PunchLog.insertMany(punches.map((p) => ({
    deviceId: p.deviceId || 'DEV-DEFAULT',
    empId: p.empId,
    timestamp: new Date(p.timestamp || Date.now()),
    punchType: p.punchType,
    verificationType: p.verificationType || 'Fingerprint',
  })));

  res.status(201).json({ message: `Ingested ${created.length} punch records`, count: created.length });
}));

app.get('/api/timeclock/punches', auth('payroll', 'approver'), wrap(async (req, res) =>
  res.json(await PunchLog.find().sort('-timestamp').limit(500).lean())));

// Synthesize biometric punches into attendance records
app.post('/api/timeclock/process-punches', auth('payroll'), wrap(async (req, res) => {
  const unprocessed = await PunchLog.find({ processed: false }).lean();
  if (!unprocessed.length) return res.json({ message: 'No unprocessed punch logs found.', createdAttendanceCount: 0 });

  const pairedAttendance = pairTimeClockPunches(unprocessed);
  const createdAttendance = [];

  for (const att of pairedAttendance) {
    try {
      const a = await Attendance.create({
        empId: att.empId,
        date: att.date,
        shift: att.shift,
        clockIn: att.clockIn,
        clockOut: att.clockOut,
        breakHours: att.breakHours,
        hoursWorked: att.hoursWorked,
        source: 'timeclock',
        deviceId: att.deviceId,
        approved: false,
        createdBy: 'timeclock_sync',
      });
      createdAttendance.push(a);
    } catch (err) {
      // Ignore duplicates if shift already captured
    }
  }

  await PunchLog.updateMany({ _id: { $in: unprocessed.map((p) => p._id) } }, { processed: true });
  await log(req, 'process_punches', 'TimeClock', 'sync', { count: createdAttendance.length });
  res.json({ message: `Successfully processed punches into ${createdAttendance.length} attendance records.`, count: createdAttendance.length });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.name === 'ValidationError') return res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join(' ') });
  if (err.code === 11000) return res.status(409).json({ error: 'A record with this ID already exists.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

module.exports = app;
