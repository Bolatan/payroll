const express = require('express');
const zlib = require('zlib');
const connect = require('./db');
const {
  User, Employee, Attendance, ShiftSetup, PublicHoliday, Loan, RepaymentLedger, DeductionRegister,
  BonusRegister, AllowanceRegister,
  Adjustment, PayrollRun, PayrollInput, PAYROLL_PERIOD_STATES, Audit, Candidate, Appraisal, LeaveRequest, LeaveBalance, GLJournal, PaymentBatch,
  ExchangeRate, TimeClockDevice, PunchLog, PayslipDelivery,
} = require('./models');
const {
  calcLine, calculateLoanMonthlyDeduction, calculateLeaveDays, calculateUnpaidLeaveDeduction,
  calculateLeaveAllowance, resolveEffectiveShiftRule, assembleEmployeePayrollInput, validatePayrollPreCalculation,
  LEAVE_TYPES, hoursBetween, timeToMinutes, evaluateAttendanceEntry, summarizePeriodAttendance,
  generateGLJournal, processBankPaymentSimulation, pairTimeClockPunches, reconcileParallelRun,
  reconcilePayrollRegister, calculatePayrollVariance, CBN_BANKS, CFG,
  suggestAttendanceBonus, parseProductionBonusData, maskAccountNumber, buildEmployeePayslip,
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
const log = (req, action, entity, entityId, details = {}) => {
  const empId = details.empId || (entity === 'Employee' ? entityId : undefined);
  return Audit.create({
    user: req.user.name,
    action,
    entity,
    entityId: String(entityId),
    empId: empId ? String(empId) : undefined,
    details,
  });
};

const periodRange = (p) => {
  const [y, m] = p.split('-').map(Number);
  return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))];
};
const validPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
const qCsv = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const resolveSelfEmpId = (req) => (req.user.empId || req.user.name || '').toUpperCase();

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
const audit = (user, action, entity, entityId, details = {}) => {
  const empId = details.empId || (entity === 'Employee' ? entityId : undefined);
  return Audit.create({
    user,
    action,
    entity,
    entityId: String(entityId),
    empId: empId ? String(empId) : undefined,
    details,
  });
};

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
app.get('/api/employees', auth('hr', 'payroll', 'approver', 'auditor', 'executive'), wrap(async (req, res) =>
  res.json(await Employee.find().sort('empId').lean())));

app.get('/api/employees/export', auth('hr', 'payroll', 'approver'), wrap(async (req, res) => {
  const emps = await Employee.find().sort('empId').lean();
  await log(req, 'export', 'EmployeeMaster', 'all', { count: emps.length });
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

async function getShiftRuleForDate(shiftName, targetDate = new Date()) {
  const doc = await ShiftSetup.findOne({ shift: shiftName }).lean();
  if (!doc) {
    // Fall back to defaults
    const defaultMult = CFG.MULT[shiftName] || 1.0;
    const defaultStart = shiftName === 'Night' ? '20:00' : '08:00';
    const defaultEnd = shiftName === 'Night' ? '05:00' : '17:00';
    return {
      shift: shiftName,
      stdHours: CFG.STD_HOURS,
      multiplier: defaultMult,
      startTime: defaultStart,
      endTime: defaultEnd,
      unpaidBreakHours: 1,
      effectiveDate: new Date(0),
    };
  }
  return resolveEffectiveShiftRule(doc, targetDate);
}

// ---- Shift Setup & Public Holidays (FR-SHF-01 to FR-SHF-05) ----
app.get('/api/shifts/setup', auth('payroll', 'approver', 'hr', 'admin'), wrap(async (req, res) => {
  let list = await ShiftSetup.find().sort('shift').lean();
  if (!list.length) {
    // Seed defaults (FR-SHF-01)
    const defaults = [
      { shift: 'Day', stdHours: 8, multiplier: 1.5, startTime: '08:00', endTime: '17:00', unpaidBreakHours: 1, effectiveDate: new Date('2025-01-01') },
      { shift: 'Night', stdHours: 8, multiplier: 1.75, startTime: '20:00', endTime: '05:00', unpaidBreakHours: 1, effectiveDate: new Date('2025-01-01') },
      { shift: 'Weekend', stdHours: 8, multiplier: 2.0, startTime: '08:00', endTime: '17:00', unpaidBreakHours: 1, effectiveDate: new Date('2025-01-01') },
      { shift: 'Holiday', stdHours: 8, multiplier: 2.5, startTime: '08:00', endTime: '17:00', unpaidBreakHours: 1, effectiveDate: new Date('2025-01-01') },
    ];
    await ShiftSetup.insertMany(defaults);
    list = await ShiftSetup.find().sort('shift').lean();
  }
  // If targetDate or period query parameter provided, resolve effective rules as of date (FR-SHF-03)
  if (req.query.date || req.query.period) {
    const target = req.query.date ? new Date(req.query.date) : periodRange(req.query.period)[0];
    const resolvedList = list.map((doc) => resolveEffectiveShiftRule(doc, target));
    return res.json(resolvedList);
  }
  res.json(list);
}));

app.post('/api/shifts/setup', auth('admin', 'hr'), wrap(async (req, res) => {
  const { shift, stdHours, multiplier, startTime, endTime, unpaidBreakHours, effectiveDate, reason } = req.body;
  if (!shift || !String(shift).trim()) return res.status(400).json({ error: 'Shift name is required.' });
  const shiftName = String(shift).trim();
  const hours = Number(stdHours);
  const mult = Number(multiplier);
  // FR-SHF-05: Shift multipliers validated as >= 1.0 and standard hours as between 1 and 24
  if (isNaN(hours) || hours < 1 || hours > 24) return res.status(400).json({ error: 'Standard hours must be between 1 and 24.' });
  if (isNaN(mult) || mult < 1.0) return res.status(400).json({ error: 'Shift multiplier must be >= 1.0.' });

  const effDate = effectiveDate ? new Date(effectiveDate) : new Date();
  if (isNaN(effDate.getTime())) return res.status(400).json({ error: 'Valid effective-from date is required.' });

  const existing = await ShiftSetup.findOne({ shift: shiftName });
  let record;

  if (existing) {
    // FR-SHF-03: Changes apply prospectively by effective date and be logged
    // Snapshot existing current into history
    existing.history.push({
      effectiveDate: existing.effectiveDate || new Date(),
      stdHours: existing.stdHours,
      multiplier: existing.multiplier,
      startTime: existing.startTime,
      endTime: existing.endTime,
      unpaidBreakHours: existing.unpaidBreakHours,
      changedBy: req.user.name,
      reason: reason || 'Shift configuration updated',
      createdAt: new Date(),
    });

    existing.stdHours = hours;
    existing.multiplier = mult;
    if (startTime) existing.startTime = startTime;
    if (endTime) existing.endTime = endTime;
    if (unpaidBreakHours !== undefined) existing.unpaidBreakHours = Number(unpaidBreakHours) || 0;
    existing.effectiveDate = effDate;
    record = await existing.save();
  } else {
    // Create new shift type (user-defined or default) (FR-SHF-01)
    record = await ShiftSetup.create({
      shift: shiftName,
      stdHours: hours,
      multiplier: mult,
      startTime: startTime || '08:00',
      endTime: endTime || '17:00',
      unpaidBreakHours: Number(unpaidBreakHours) || 0,
      effectiveDate: effDate,
      history: [{
        effectiveDate: effDate,
        stdHours: hours,
        multiplier: mult,
        startTime: startTime || '08:00',
        endTime: endTime || '17:00',
        unpaidBreakHours: Number(unpaidBreakHours) || 0,
        changedBy: req.user.name,
        reason: reason || 'Initial shift creation',
      }],
    });
  }

  await log(req, 'update_shift_setup', 'ShiftSetup', shiftName, req.body);
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
app.get('/api/attendance', auth('payroll', 'approver', 'hr', 'supervisor', 'auditor'), wrap(async (req, res) => {
  const q = req.query.period && validPeriod(req.query.period)
    ? { date: { $gte: periodRange(req.query.period)[0], $lt: periodRange(req.query.period)[1] } } : {};
  if (req.query.empId) q.empId = req.query.empId;
  res.json(await Attendance.find(q).sort('-date').limit(500).lean());
}));

app.post('/api/attendance', auth('payroll', 'supervisor'), wrap(async (req, res) => {
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

  // FR-LV-04: Approved leave days shall not be counted as Absent without supervisor override
  const onApprovedLeave = await LeaveRequest.findOne({
    empId: b.empId,
    status: 'Approved',
    startDate: { $lte: endOfDay },
    endDate: { $gte: startOfDay },
  });

  if (b.absent) {
    if (onApprovedLeave && !b.supervisorOverrideReason) {
      return res.status(400).json({
        error: `Employee is on approved leave (${onApprovedLeave.leaveType}). Marking absent requires supervisor override reason (FR-LV-04).`,
      });
    }

    const a = await Attendance.create({
      empId: b.empId,
      date: startOfDay,
      shift: b.shift || 'Day',
      absent: true,
      absentReason: b.absentReason || (onApprovedLeave ? `Absent override during ${onApprovedLeave.leaveType} leave` : 'Absent'),
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

  // Clock-out time should always be higher than clock-in time
  if (b.clockOut <= b.clockIn) {
    return res.status(400).json({ error: 'Clock-out time must be higher than clock-in time.' });
  }

  // Resolve shift setup as of attendance date for prospective effective rules (FR-SHF-03)
  const shiftRule = await getShiftRuleForDate(b.shift, attDate);

  // Evaluate hours, OT, multipliers, lateness
  const evaluation = evaluateAttendanceEntry({
    shift: b.shift,
    clockIn: b.clockIn,
    clockOut: b.clockOut,
    breakHours: b.breakHours !== undefined ? Number(b.breakHours) : shiftRule.unpaidBreakHours,
    absent: false,
  }, {
    stdHours: shiftRule.stdHours,
    scheduledStart: shiftRule.startTime,
    scheduledEnd: shiftRule.endTime,
    multipliers: { [b.shift]: shiftRule.multiplier },
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
      // FR-LV-04: Approved leave check
      const onApprovedLeave = await LeaveRequest.findOne({
        empId: raw.empId,
        status: 'Approved',
        startDate: { $lte: endOfDay },
        endDate: { $gte: startOfDay },
      });

      if (onApprovedLeave && !raw.supervisorOverrideReason) {
        results.failed++;
        results.report.push({
          row: rowNum,
          empId: raw.empId,
          status: 'Failed',
          errors: [`Employee is on approved leave (${onApprovedLeave.leaveType}). Marking absent requires supervisor override reason.`],
        });
        continue;
      }

      try {
        const a = await Attendance.create({
          empId: raw.empId,
          date: startOfDay,
          shift,
          absent: true,
          absentReason: raw.absentReason || (onApprovedLeave ? `Absent override during ${onApprovedLeave.leaveType} leave` : 'Absent'),
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

    if (raw.clockOut <= raw.clockIn) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: ['Clock-out time must be higher than clock-in time.'] });
      continue;
    }

    if (!/^\d{2}:\d{2}$/.test(raw.clockIn || '') || !/^\d{2}:\d{2}$/.test(raw.clockOut || '')) {
      results.failed++;
      results.report.push({ row: rowNum, empId: raw.empId, status: 'Failed', errors: ['Clock times must be HH:MM format.'] });
      continue;
    }

    const shiftRule = await getShiftRuleForDate(shift, attDate);
    const evalRes = evaluateAttendanceEntry({
      shift,
      clockIn: raw.clockIn,
      clockOut: raw.clockOut,
      breakHours: raw.breakHours !== undefined ? Number(raw.breakHours) : shiftRule.unpaidBreakHours,
      absent: false,
    }, {
      stdHours: shiftRule.stdHours,
      scheduledStart: shiftRule.startTime,
      scheduledEnd: shiftRule.endTime,
      multipliers: { [shift]: shiftRule.multiplier },
      isWeekend,
      isHoliday,
    });

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

// FR-LV-04: Attendance calendar with marked approved leave days and attendance entries
app.get('/api/attendance/calendar', auth('payroll', 'approver', 'hr', 'employee'), wrap(async (req, res) => {
  const period = req.query.period;
  if (!period || !validPeriod(period)) return res.status(400).json({ error: 'Valid period (YYYY-MM) is required.' });

  const empId = req.user.role === 'employee' ? req.user.empId : req.query.empId;
  const [from, to] = periodRange(period);

  const empFilter = {};
  if (empId) empFilter.empId = empId;
  const employees = await Employee.find(empFilter).sort('empId').lean();

  const attFilter = { date: { $gte: from, $lt: to } };
  if (empId) attFilter.empId = empId;
  const attendances = await Attendance.find(attFilter).lean();

  const leaveFilter = {
    status: 'Approved',
    startDate: { $lt: to },
    endDate: { $gte: from },
  };
  if (empId) leaveFilter.empId = empId;
  const leaves = await LeaveRequest.find(leaveFilter).lean();

  // Map by empId
  const attMap = attendances.reduce((acc, a) => {
    (acc[a.empId] ||= []).push(a);
    return acc;
  }, {});

  const leaveMap = leaves.reduce((acc, l) => {
    (acc[l.empId] ||= []).push(l);
    return acc;
  }, {});

  const [y, m] = period.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const calendar = employees.map((emp) => {
    const empAtt = attMap[emp.empId] || [];
    const empLeaves = leaveMap[emp.empId] || [];

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const curDate = new Date(Date.UTC(y, m - 1, d));
      const curDateStr = curDate.toISOString().slice(0, 10);

      // Check if employee has approved leave covering this day
      const approvedLeave = empLeaves.find((l) => {
        const lStart = new Date(l.startDate).toISOString().slice(0, 10);
        const lEnd = new Date(l.endDate).toISOString().slice(0, 10);
        return curDateStr >= lStart && curDateStr <= lEnd;
      });

      // Check attendance
      const dayAtt = empAtt.filter((a) => new Date(a.date).toISOString().slice(0, 10) === curDateStr);

      let status = 'Scheduled';
      const dayOfWeek = curDate.getUTCDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) status = 'Weekend';

      if (approvedLeave) {
        status = `Leave: ${approvedLeave.leaveType}`;
      } else if (dayAtt.length > 0) {
        if (dayAtt.some((a) => a.absent)) status = 'Absent';
        else status = 'Present';
      }

      days.push({
        date: curDateStr,
        dayOfWeek,
        status,
        onLeave: Boolean(approvedLeave),
        leaveType: approvedLeave ? approvedLeave.leaveType : null,
        attendance: dayAtt,
      });
    }

    return {
      empId: emp.empId,
      name: `${emp.surname} ${emp.firstName}`,
      department: emp.department,
      days,
    };
  });

  res.json({ period, calendar });
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
app.post('/api/attendance/:id/approve', auth('approver', 'supervisor'), wrap(async (req, res) => {
  const a = await Attendance.findById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Entry not found.' });
  if (a.createdBy && a.createdBy === req.user.name)
    return res.status(403).json({ error: 'You cannot approve attendance you created.' });

  // Read-only in locked period
  await assertPeriodNotLocked(a.date);

  a.approved = true;
  a.approvedBy = req.user.name;
  await a.save();
  await log(req, 'approve', 'Attendance', a._id, { empId: a.empId, otHours: a.otHours });
  res.json(a);
}));

// ---- Loans (FR-LN-01 to FR-LN-07) ----
app.get('/api/loans', auth('payroll', 'approver', 'hr', 'auditor'), wrap(async (req, res) => {
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

  await log(req, 'create', 'Loan', l._id, { ...req.body, empId: l.empId });
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

app.post('/api/loans/:id/reject', auth('approver'), wrap(async (req, res) => {
  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  if (l.createdBy === req.user.name) return res.status(403).json({ error: 'You cannot reject a loan you created.' });
  if (l.status !== 'Pending') return res.status(400).json({ error: `Cannot reject a loan with status ${l.status}.` });

  l.status = 'Rejected';
  await l.save();
  await log(req, 'reject', 'Loan', l._id, { empId: l.empId, reason: req.body.reason });
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

app.post('/api/loans/:id/change-requests/:reqId/reject', auth('approver'), wrap(async (req, res) => {
  const l = await Loan.findById(req.params.id);
  if (!l) return res.status(404).json({ error: 'Loan not found.' });
  const cr = l.changeRequests.id(req.params.reqId);
  if (!cr) return res.status(404).json({ error: 'Change request not found.' });
  if (cr.status !== 'Pending') return res.status(400).json({ error: `Change request is already ${cr.status}.` });
  if (cr.requestedBy === req.user.name) {
    return res.status(403).json({ error: 'The requestor cannot reject their own change request.' });
  }

  cr.status = 'Rejected';
  cr.rejectionReason = req.body.reason || 'Rejected by approver';
  await l.save();
  await log(req, 'reject_change_request', 'Loan', l._id, { type: cr.type, reason: cr.rejectionReason });
  res.json({ message: `Loan ${cr.type} rejected.`, loan: l });
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

  await log(req, 'create', 'DeductionRegister', d._id, { ...req.body, empId: d.empId });
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

app.post('/api/deductions/:id/reject', auth('approver'), wrap(async (req, res) => {
  const d = await DeductionRegister.findById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Deduction entry not found.' });
  if (d.createdBy === req.user.name) {
    return res.status(403).json({ error: 'You cannot reject a deduction entry you created.' });
  }
  if (d.status !== 'Pending') return res.status(400).json({ error: `Cannot reject deduction with status ${d.status}.` });

  d.status = 'Rejected';
  await d.save();
  await log(req, 'reject', 'DeductionRegister', d._id, { empId: d.empId, reason: req.body.reason });
  res.json(d);
}));

// ---- Bonuses and Allowances (FR-BON-01 to FR-BON-06) ----
app.get('/api/bonuses', auth('payroll', 'approver', 'hr', 'auditor'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.period) filter.period = req.query.period;
  if (req.query.empId) filter.empId = req.query.empId;
  if (req.query.status) filter.status = req.query.status;
  res.json(await BonusRegister.find(filter).sort('-createdAt').limit(500).lean());
}));

app.post('/api/bonuses', auth('payroll', 'hr'), wrap(async (req, res) => {
  const {
    period, empId, performanceBonus = 0, productionBonus = 0,
    attendanceBonus = 0, otherBonus = 0, otherBonusDescription = '',
    flags = {}, comments,
  } = req.body;

  if (!period || !validPeriod(period)) {
    return res.status(400).json({ error: 'Valid period (YYYY-MM) is required.' });
  }
  if (!empId || !(await Employee.exists({ empId }))) {
    return res.status(400).json({ error: 'Valid Employee ID is required.' });
  }

  const perf = r2(Number(performanceBonus) || 0);
  const prod = r2(Number(productionBonus) || 0);
  const att = r2(Number(attendanceBonus) || 0);
  const oth = r2(Number(otherBonus) || 0);
  const total = r2(perf + prod + att + oth);

  if (oth > 0 && !String(otherBonusDescription).trim()) {
    return res.status(400).json({ error: 'Description is required when OtherBonus is specified.' });
  }

  const defaultFlags = {
    performance: { taxable: true, pensionable: false },
    production: { taxable: true, pensionable: false },
    attendance: { taxable: true, pensionable: false },
    other: { taxable: true, pensionable: false },
  };

  const mergedFlags = {
    performance: { ...defaultFlags.performance, ...(flags.performance || {}) },
    production: { ...defaultFlags.production, ...(flags.production || {}) },
    attendance: { ...defaultFlags.attendance, ...(flags.attendance || {}) },
    other: { ...defaultFlags.other, ...(flags.other || {}) },
  };

  const b = await BonusRegister.create({
    period,
    empId,
    performanceBonus: perf,
    productionBonus: prod,
    attendanceBonus: att,
    otherBonus: oth,
    otherBonusDescription: String(otherBonusDescription).trim(),
    totalBonuses: total,
    flags: mergedFlags,
    status: 'Pending',
    createdBy: req.user.name,
    comments,
  });

  await log(req, 'create', 'BonusRegister', b._id, { ...req.body, empId: b.empId });
  res.status(201).json(b);
}));

app.post('/api/bonuses/:id/approve', auth('approver'), wrap(async (req, res) => {
  const b = await BonusRegister.findById(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bonus entry not found.' });
  // FR-BON-02: Approver cannot be creator (segregation of duties)
  if (b.createdBy === req.user.name) {
    return res.status(403).json({ error: 'You cannot approve a bonus entry you created.' });
  }
  b.status = 'Approved';
  b.approvedBy = req.user.name;
  b.approvedAt = new Date();
  await b.save();
  await log(req, 'approve', 'BonusRegister', b._id, { empId: b.empId, totalBonuses: b.totalBonuses });
  res.json(b);
}));

app.post('/api/bonuses/:id/reject', auth('approver'), wrap(async (req, res) => {
  const b = await BonusRegister.findById(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bonus entry not found.' });
  if (b.createdBy === req.user.name) {
    return res.status(403).json({ error: 'You cannot reject a bonus entry you created.' });
  }
  b.status = 'Rejected';
  await b.save();
  await log(req, 'reject', 'BonusRegister', b._id, { empId: b.empId });
  res.json(b);
}));

// FR-BON-03: Auto-suggest attendance bonus endpoint
app.post('/api/bonuses/suggest-attendance', auth('payroll', 'hr'), wrap(async (req, res) => {
  const { period, bonusAmount, maxAbsencesAllowed, maxLatenessAllowed, minDaysPresent } = req.body;
  if (!period || !validPeriod(period)) {
    return res.status(400).json({ error: 'Valid period (YYYY-MM) is required.' });
  }

  const [from, to] = periodRange(period);
  const emps = await Employee.find({ status: { $in: ['Active', 'On Leave'] } }).lean();
  const attendances = await Attendance.find({ date: { $gte: from, $lt: to } }).lean();
  const byEmp = attendances.reduce((m, a) => ((m[a.empId] ||= []).push(a), m), {});

  const suggestions = [];
  for (const emp of emps) {
    const records = byEmp[emp.empId] || [];
    const evaluation = suggestAttendanceBonus(records, {
      bonusAmount: bonusAmount ? Number(bonusAmount) : undefined,
      maxAbsencesAllowed: maxAbsencesAllowed !== undefined ? Number(maxAbsencesAllowed) : undefined,
      maxLatenessAllowed: maxLatenessAllowed !== undefined ? Number(maxLatenessAllowed) : undefined,
      minDaysPresent: minDaysPresent !== undefined ? Number(minDaysPresent) : 1,
    });
    suggestions.push({
      empId: emp.empId,
      name: `${emp.surname} ${emp.firstName}`,
      department: emp.department,
      period,
      ...evaluation,
    });
  }

  res.json(suggestions);
}));

// FR-BON-03: Production bonus import endpoint
app.post('/api/bonuses/import-production', auth('payroll', 'hr'), wrap(async (req, res) => {
  const { period, data } = req.body;
  if (!period || !validPeriod(period)) {
    return res.status(400).json({ error: 'Valid period (YYYY-MM) is required.' });
  }
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'Data must be an array of production records.' });
  }

  const parsed = parseProductionBonusData(data);
  if (parsed.errors.length > 0 && parsed.results.length === 0) {
    return res.status(400).json({ error: 'Import validation failed', errors: parsed.errors });
  }

  const created = [];
  for (const row of parsed.results) {
    if (await Employee.exists({ empId: row.empId })) {
      const b = await BonusRegister.create({
        period,
        empId: row.empId,
        productionBonus: row.productionBonus,
        totalBonuses: row.productionBonus,
        source: 'production_import',
        status: 'Pending',
        createdBy: req.user.name,
      });
      created.push(b);
    }
  }

  await log(req, 'import_production_bonus', 'BonusRegister', period, { importedCount: created.length });
  res.json({ imported: created.length, records: created, errors: parsed.errors });
}));

// FR-BON-06: Allowances management endpoints
app.get('/api/allowances', auth('payroll', 'approver', 'hr', 'auditor'), wrap(async (req, res) => {
  const filter = {};
  if (req.query.empId) filter.empId = req.query.empId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  res.json(await AllowanceRegister.find(filter).sort('-createdAt').limit(500).lean());
}));

app.post('/api/allowances', auth('payroll', 'hr'), wrap(async (req, res) => {
  const {
    empId, type, title, amount, recurring = false,
    startPeriod, endPeriod, taxable = true, pensionable = false, reason,
  } = req.body;

  if (!empId || !(await Employee.exists({ empId }))) {
    return res.status(400).json({ error: 'Valid Employee ID is required.' });
  }
  if (!type || !['shift_allowance', 'hazard', 'meal', 'other'].includes(type)) {
    return res.status(400).json({ error: 'Valid allowance type is required (shift_allowance, hazard, meal, other).' });
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Positive allowance amount is required.' });
  }
  if (!startPeriod || !validPeriod(startPeriod)) {
    return res.status(400).json({ error: 'Valid startPeriod (YYYY-MM) is required.' });
  }

  const al = await AllowanceRegister.create({
    empId,
    type,
    title: title || type,
    amount: r2(Number(amount)),
    recurring: Boolean(recurring),
    startPeriod,
    endPeriod: endPeriod || undefined,
    taxable: Boolean(taxable),
    pensionable: Boolean(pensionable),
    reason,
    status: 'Pending',
    createdBy: req.user.name,
  });

  await log(req, 'create', 'AllowanceRegister', al._id, { ...req.body, empId: al.empId });
  res.status(201).json(al);
}));

app.post('/api/allowances/:id/approve', auth('approver'), wrap(async (req, res) => {
  const al = await AllowanceRegister.findById(req.params.id);
  if (!al) return res.status(404).json({ error: 'Allowance entry not found.' });
  if (al.createdBy === req.user.name) {
    return res.status(403).json({ error: 'You cannot approve an allowance entry you created.' });
  }
  al.status = 'Approved';
  al.approvedBy = req.user.name;
  al.approvedAt = new Date();
  await al.save();
  await log(req, 'approve', 'AllowanceRegister', al._id, { empId: al.empId, amount: al.amount });
  res.json(al);
}));

app.post('/api/allowances/:id/reject', auth('approver'), wrap(async (req, res) => {
  const al = await AllowanceRegister.findById(req.params.id);
  if (!al) return res.status(404).json({ error: 'Allowance entry not found.' });
  if (al.createdBy === req.user.name) {
    return res.status(403).json({ error: 'You cannot reject an allowance entry you created.' });
  }
  al.status = 'Rejected';
  await al.save();
  await log(req, 'reject', 'AllowanceRegister', al._id, { empId: al.empId });
  res.json(al);
}));

// ---- Adjustments: bonuses, earnings, other deductions (FR-INP-03 & FR-INP-06) ----
app.get('/api/adjustments', auth('payroll', 'approver', 'hr', 'auditor'), wrap(async (req, res) =>
  res.json(await Adjustment.find().sort('-createdAt').limit(500).lean())));
app.post('/api/adjustments', auth('payroll', 'hr'), wrap(async (req, res) => {
  if (!req.body.empId) return res.status(400).json({ error: 'Employee ID is required.' });
  if (!(await Employee.exists({ empId: req.body.empId }))) return res.status(400).json({ error: 'Employee not found.' });
  if (!req.body.reason || !String(req.body.reason).trim()) {
    return res.status(400).json({ error: 'A mandatory reason is required for manual adjustments.' });
  }
  const j = await Adjustment.create({
    ...req.body,
    reason: String(req.body.reason).trim(),
    subtype: req.body.subtype || 'general',
    priorPeriod: req.body.priorPeriod || undefined,
    approved: false,
    createdBy: req.user.name,
  });
  await log(req, 'create', 'Adjustment', j._id, {
    empId: j.empId,
    type: j.type,
    amount: j.amount,
    reason: j.reason,
    subtype: j.subtype,
    priorPeriod: j.priorPeriod,
  });
  res.status(201).json(j);
}));
app.post('/api/adjustments/:id/approve', auth('approver'), wrap(async (req, res) => {
  const j = await Adjustment.findById(req.params.id);
  if (!j) return res.status(404).json({ error: 'Adjustment not found.' });
  if (j.createdBy === req.user.name) return res.status(403).json({ error: 'You cannot approve an entry you created.' });
  j.approved = true; j.approvedBy = req.user.name;
  await j.save();
  await log(req, 'approve', 'Adjustment', j._id, { empId: j.empId, amount: j.amount });
  res.json(j);
}));

// Helper to gather period payroll dependencies
async function loadPeriodPayrollData(period) {
  const [from, to] = periodRange(period);
  const [emps, att, adj, loans, deductions, leaves, bonusesList, allowancesList] = await Promise.all([
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
    LeaveRequest.find({
      startDate: { $lt: to },
      endDate: { $gte: from },
    }).lean(),
    BonusRegister.find({ period }).lean(),
    AllowanceRegister.find({
      startPeriod: { $lte: period },
      $or: [{ endPeriod: null }, { endPeriod: { $gte: period } }, { recurring: false, startPeriod: period }],
    }).lean(),
  ]);

  const by = (arr, f = () => true) => arr.reduce((m, x) => ((f(x) && (m[x.empId] ||= []).push(x)), m), {});
  const attBy = by(att, (x) => x.approved);
  const adjBy = by(adj, (x) => x.approved);
  const loanBy = by(loans);
  const dedBy = by(deductions);
  const leaveBy = by(leaves, (x) => x.status === 'Approved');
  const bonBy = by(bonusesList, (x) => x.status === 'Approved');
  const allowBy = by(allowancesList, (x) => x.status === 'Approved');

  const warnings = [];
  const pendingOT = att.filter((x) => !x.approved && !x.absent && (x.hoursWorked > 0 || x.otHours > 0)).length;
  const pendingAdj = adj.filter((x) => !x.approved).length;
  const pendingBon = bonusesList.filter((x) => x.status !== 'Approved').length;
  const pendingAllow = allowancesList.filter((x) => x.status !== 'Approved').length;
  const pendingLeave = leaves.filter((x) => x.status === 'Pending').length;

  if (pendingOT) warnings.push(`${pendingOT} unapproved attendance entries were excluded.`);
  if (pendingAdj) warnings.push(`${pendingAdj} unapproved adjustments were excluded.`);
  if (pendingBon) warnings.push(`${pendingBon} unapproved bonus entries were excluded.`);
  if (pendingAllow) warnings.push(`${pendingAllow} unapproved allowance entries were excluded.`);
  if (pendingLeave) warnings.push(`${pendingLeave} pending leave requests were detected.`);

  return {
    from,
    to,
    emps,
    att,
    adj,
    loans,
    deductions,
    leaves,
    bonusesList,
    allowancesList,
    attBy,
    adjBy,
    loanBy,
    dedBy,
    leaveBy,
    bonBy,
    allowBy,
    warnings,
  };
}

// ---- Payroll Period & Inputs (FR-INP-01 to FR-INP-06) ----

// FR-INP-02: Prepare Inputs
app.post('/api/payroll/:period/prepare-inputs', auth('payroll'), wrap(async (req, res) => {
  const { period } = req.params;
  if (!validPeriod(period)) return res.status(400).json({ error: 'Period must look like 2026-11.' });

  const existing = await PayrollRun.findOne({ period });
  if (existing && ['Approved', 'Paid/Locked'].includes(existing.status)) {
    return res.status(409).json({ error: 'This period is approved and locked. Inputs cannot be prepared.' });
  }

  const data = await loadPeriodPayrollData(period);
  const prorationMethod = req.body?.prorationMethod || 'calendar';

  const assembledInputs = [];
  for (const emp of data.emps) {
    const inp = assembleEmployeePayrollInput(emp, {
      attendance: data.attBy[emp.empId],
      adjustments: data.adjBy[emp.empId],
      loans: data.loanBy[emp.empId],
      deductions: data.dedBy[emp.empId],
      leaves: data.leaveBy[emp.empId],
      bonuses: data.bonBy[emp.empId],
      allowances: data.allowBy[emp.empId],
    }, period, { prorationMethod });

    assembledInputs.push(inp);

    await PayrollInput.findOneAndUpdate(
      { period, empId: emp.empId },
      { ...inp, assembledBy: req.user.name, assembledAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  // Pre-calculation validation (FR-INP-04)
  const validation = validatePayrollPreCalculation({
    employees: data.emps,
    attendance: data.att,
    adjustments: data.adj,
    bonuses: data.bonusesList,
    allowances: data.allowancesList,
    leaves: data.leaves,
    period,
  });

  const nextStatus = req.body?.freeze ? 'Inputs Frozen' : (existing?.status || 'Open');

  const run = await PayrollRun.findOneAndUpdate({ period }, {
    status: nextStatus,
    preparedBy: req.user.name,
    inputs: assembledInputs,
    exceptions: validation.exceptions,
    warnings: data.warnings,
  }, { upsert: true, new: true, setDefaultsOnInsert: true });

  await log(req, 'prepare_inputs', 'PayrollRun', period, {
    count: assembledInputs.length,
    status: run.status,
    exceptionsCount: validation.totalExceptions,
    blockingCount: validation.blockingCount,
  });

  res.json({
    period,
    status: run.status,
    inputsCount: assembledInputs.length,
    inputs: assembledInputs,
    validation,
    warnings: data.warnings,
  });
}));

// Retrieve assembled inputs (FR-INP-02)
app.get('/api/payroll/:period/inputs', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const { period } = req.params;
  const inputs = await PayrollInput.find({ period }).sort('empId').lean();
  res.json(inputs);
}));

// Pre-calculation exceptions endpoint (FR-INP-04)
app.get('/api/payroll/:period/exceptions', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const { period } = req.params;
  const data = await loadPeriodPayrollData(period);
  const validation = validatePayrollPreCalculation({
    employees: data.emps,
    attendance: data.att,
    adjustments: data.adj,
    bonuses: data.bonusesList,
    allowances: data.allowancesList,
    leaves: data.leaves,
    period,
  });
  res.json(validation);
}));

// FR-INP-01: Update Period State
app.post('/api/payroll/:period/status', auth('payroll', 'approver', 'executive'), wrap(async (req, res) => {
  const { period } = req.params;
  const { status } = req.body;
  if (!PAYROLL_PERIOD_STATES.includes(status)) {
    return res.status(400).json({ error: `Invalid status ${status}. Must be one of: ${PAYROLL_PERIOD_STATES.join(', ')}` });
  }

  const run = await PayrollRun.findOne({ period });
  if (!run) return res.status(404).json({ error: 'Payroll run not found for this period.' });

  if (['Approved', 'Paid/Locked'].includes(run.status) && status !== run.status) {
    return res.status(409).json({ error: `Cannot change status once period is ${run.status}.` });
  }

  // Blocking check for moving to Approved
  if (status === 'Approved') {
    if (run.preparedBy === req.user.name) {
      return res.status(403).json({ error: 'The person who calculated payroll cannot approve it.' });
    }
    const blocking = (run.lines || []).filter((l) => l.flags && l.flags.length);
    if (blocking.length) {
      return res.status(409).json({ error: 'Fix blocking exceptions before approval.', exceptions: blocking.map((l) => ({ empId: l.empId, flags: l.flags })) });
    }
  }

  run.status = status;
  if (status === 'Approved') {
    run.approvedBy = req.user.name;
    run.approvedAt = new Date();
    run.version = (run.version || 1);
    run.versionStamp = `v${run.version}-${period}-${Date.now()}`;
  }
  await run.save();

  await log(req, 'update_status', 'PayrollRun', period, { status });
  res.json(run);
}));

// FR-INP-05 & FR-PAY-11: Recalculate any number of times until Approved/Paid/Locked;
// runnable for all employees or a filtered subset (department, employee type)
app.post('/api/payroll/:period/calculate', auth('payroll'), wrap(async (req, res) => {
  const { period } = req.params;
  if (!validPeriod(period)) return res.status(400).json({ error: 'Period must look like 2026-11.' });
  const existing = await PayrollRun.findOne({ period });
  if (existing && ['Approved', 'Paid/Locked'].includes(existing.status)) {
    return res.status(409).json({ error: 'This period is approved and locked.' });
  }

  const data = await loadPeriodPayrollData(period);
  const prorationMethod = req.body?.prorationMethod || 'calendar';
  const filterDepartment = req.body?.department || req.query?.department;
  const filterEmploymentType = req.body?.employmentType || req.query?.employmentType;

  let employeesToCalculate = data.emps;
  if (filterDepartment) {
    employeesToCalculate = employeesToCalculate.filter(
      (e) => (e.department || '').toLowerCase() === String(filterDepartment).toLowerCase()
    );
  }
  if (filterEmploymentType) {
    employeesToCalculate = employeesToCalculate.filter(
      (e) => (e.employmentType || '').toLowerCase() === String(filterEmploymentType).toLowerCase()
    );
  }

  const calculatedLines = employeesToCalculate.map((e) => calcLine(e, {
    attendance: data.attBy[e.empId],
    adjustments: data.adjBy[e.empId],
    loans: data.loanBy[e.empId],
    deductions: data.dedBy[e.empId],
    leaves: data.leaveBy[e.empId],
    bonuses: data.bonBy[e.empId],
    allowances: data.allowBy[e.empId],
  }, period, { prorationMethod }));

  let lines = calculatedLines;
  if ((filterDepartment || filterEmploymentType) && existing?.lines?.length) {
    // Merge calculated subset into existing lines
    const calcMap = new Map(calculatedLines.map((l) => [l.empId, l]));
    lines = existing.lines.map((l) => (calcMap.has(l.empId) ? calcMap.get(l.empId) : l));
    // Include any new employee from subset not previously in existing.lines
    for (const cl of calculatedLines) {
      if (!lines.some((l) => l.empId === cl.empId)) lines.push(cl);
    }
  }

  const assembledInputs = data.emps.map((e) => assembleEmployeePayrollInput(e, {
    attendance: data.attBy[e.empId],
    adjustments: data.adjBy[e.empId],
    loans: data.loanBy[e.empId],
    deductions: data.dedBy[e.empId],
    leaves: data.leaveBy[e.empId],
    bonuses: data.bonBy[e.empId],
    allowances: data.allowBy[e.empId],
  }, period, { prorationMethod }));

  for (const inp of assembledInputs) {
    await PayrollInput.findOneAndUpdate(
      { period, empId: inp.empId },
      { ...inp, assembledBy: req.user.name, assembledAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  // Run pre-calculation validation
  const validation = validatePayrollPreCalculation({
    employees: data.emps,
    attendance: data.att,
    adjustments: data.adj,
    bonuses: data.bonusesList,
    allowances: data.allowancesList,
    leaves: data.leaves,
    period,
  });

  const sum = (k) => r2(lines.reduce((s, l) => s + l[k], 0));
  const totals = {
    employees: lines.length, gross: sum('gross'), paye: sum('paye'), pension: sum('pension'), nhf: sum('nhf'),
    loans: sum('loanDeduction'), net: sum('netPay'), employerPension: sum('employerPension'), otPay: sum('otPay'),
    otherDeductions: sum('otherDeductions'), totalDeductions: sum('totalDeductions'),
  };

  const newStatus = existing?.status === 'Inputs Frozen' ? 'Inputs Frozen' : 'Calculated';

  const run = await PayrollRun.findOneAndUpdate({ period }, {
    status: newStatus,
    preparedBy: req.user.name,
    lines,
    inputs: assembledInputs,
    exceptions: validation.exceptions,
    warnings: data.warnings,
    totals,
  }, { upsert: true, new: true, setDefaultsOnInsert: true });

  await log(req, 'calculate', 'PayrollRun', period, { ...totals, status: newStatus });
  res.json(run);
}));

app.get('/api/payroll/:period', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'No payroll has been calculated for this period.' });
  res.json(run);
}));

app.post('/api/payroll/:period/approve', auth('approver', 'executive'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period });
  if (!run) return res.status(404).json({ error: 'No payroll has been calculated for this period.' });
  if (['Approved', 'Paid/Locked'].includes(run.status)) return res.status(409).json({ error: 'Already approved.' });
  if (run.preparedBy === req.user.name) return res.status(403).json({ error: 'The person who calculated payroll cannot approve it.' });

  // FR-INP-04: Cannot move to Approved with unresolved blocking exceptions
  const blockingFlags = (run.lines || []).filter((l) => l.flags && l.flags.length);
  const data = await loadPeriodPayrollData(run.period);
  const validation = validatePayrollPreCalculation({
    employees: data.emps,
    attendance: data.att,
    adjustments: data.adj,
    bonuses: data.bonusesList,
    allowances: data.allowancesList,
    leaves: data.leaves,
    period: run.period,
  });

  // FR-PAY-09: Register totals shall reconcile: Gross − all deductions = Net at employee and total levels.
  // Any imbalance blocks approval.
  const reconciliation = reconcilePayrollRegister(run.lines || []);
  if (!reconciliation.isReconciled) {
    return res.status(409).json({
      error: 'Payroll register totals imbalance detected. Approval blocked.',
      imbalances: reconciliation.imbalances,
    });
  }

  if (blockingFlags.length || validation.blockingCount > 0) {
    const exceptions = [
      ...blockingFlags.map((l) => ({ empId: l.empId, flags: l.flags })),
      ...validation.blockingExceptions.map((b) => ({ empId: b.empId, message: b.message, type: b.type })),
    ];
    return res.status(409).json({ error: 'Fix blocking exceptions before approval.', exceptions });
  }

  // Claim the run first so a double click cannot deduct loans twice
  const approvedVersion = (run.version || 1);
  const versionStamp = `v${approvedVersion}-${run.period}-${Date.now()}`;
  const claimed = await PayrollRun.findOneAndUpdate(
    { period: run.period, status: { $in: ['Draft', 'Calculated', 'Under Review', 'Inputs Frozen', 'Open'] } },
    { status: 'Approved', approvedBy: req.user.name, approvedAt: new Date(), version: approvedVersion, versionStamp }, { new: true });
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

// Helper to calculate YTD figures for an employee up to a period (FR-PAY-12)
async function calculateEmployeeYTD(empId, currentPeriod) {
  const [yearStr] = currentPeriod.split('-');
  const startOfYearPeriod = `${yearStr}-01`;
  const approvedRuns = await PayrollRun.find({
    status: 'Approved',
    period: { $gte: startOfYearPeriod, $lte: currentPeriod },
  }).sort('period').lean();

  let ytdGross = 0;
  let ytdTaxablePay = 0;
  let ytdPaye = 0;
  let ytdPension = 0;
  let ytdNhf = 0;
  let ytdEmployerPension = 0;

  for (const r of approvedRuns) {
    const line = r.lines?.find((l) => (l.empId || '').toUpperCase() === empId.toUpperCase());
    if (line) {
      ytdGross = r2(ytdGross + (line.gross || 0));
      ytdTaxablePay = r2(ytdTaxablePay + (line.taxablePay ?? line.chargeable ?? 0));
      ytdPaye = r2(ytdPaye + (line.paye || 0));
      ytdPension = r2(ytdPension + (line.pension || 0));
      ytdNhf = r2(ytdNhf + (line.nhf || 0));
      ytdEmployerPension = r2(ytdEmployerPension + (line.employerPension || 0));
    }
  }

  return { ytdGross, ytdTaxablePay, ytdPaye, ytdPension, ytdNhf, ytdEmployerPension };
}

// Helper to calculate YTD figures for all employees for a given period / calendar year (FR-PAY-12)
async function calculateAllEmployeesYTD(currentPeriod) {
  const [yearStr] = currentPeriod.split('-');
  const startOfYearPeriod = `${yearStr}-01`;
  const approvedRuns = await PayrollRun.find({
    status: 'Approved',
    period: { $gte: startOfYearPeriod, $lte: currentPeriod },
  }).sort('period').lean();

  const empYtdMap = new Map();

  for (const r of approvedRuns) {
    for (const line of (r.lines || [])) {
      const id = (line.empId || '').toUpperCase();
      if (!empYtdMap.has(id)) {
        empYtdMap.set(id, {
          empId: line.empId,
          name: line.name,
          department: line.department,
          year: parseInt(yearStr, 10),
          throughPeriod: currentPeriod,
          gross: 0,
          taxablePay: 0,
          paye: 0,
          pension: 0,
          nhf: 0,
          employerPension: 0,
        });
      }
      const entry = empYtdMap.get(id);
      entry.gross = r2(entry.gross + (line.gross || 0));
      entry.taxablePay = r2(entry.taxablePay + (line.taxablePay ?? line.chargeable ?? 0));
      entry.paye = r2(entry.paye + (line.paye || 0));
      entry.pension = r2(entry.pension + (line.pension || 0));
      entry.nhf = r2(entry.nhf + (line.nhf || 0));
      entry.employerPension = r2(entry.employerPension + (line.employerPension || 0));
    }
  }

  return Array.from(empYtdMap.values());
}

// ---- Employee Self-Service (ESS) Payslips ----
app.get('/api/me/payslips', auth('employee', 'payroll', 'approver', 'hr', 'supervisor', 'executive', 'auditor', 'tax_advisor'), wrap(async (req, res) => {
  const myEmpId = resolveSelfEmpId(req);
  const runs = await PayrollRun.find({ status: 'Approved' }).sort('-period').lean();
  const slips = [];
  for (const r of runs) {
    const line = r.lines?.find((l) => (l.empId || '').toUpperCase() === myEmpId);
    if (line) {
      slips.push({ period: r.period, gross: line.gross, netPay: line.netPay, approvedAt: r.approvedAt, name: line.name });
    }
  }
  res.json(slips);
}));

app.get('/api/me/payslips/:period', auth('employee', 'payroll', 'approver', 'hr', 'supervisor', 'executive', 'auditor', 'tax_advisor'), wrap(async (req, res) => {
  const myEmpId = resolveSelfEmpId(req);
  // FR-SLP-03: Payslips generated only for Approved periods
  const run = await PayrollRun.findOne({ period: req.params.period, status: 'Approved' }).lean();
  if (!run) return res.status(404).json({ error: 'Approved payslip not found for this period.' });
  const line = run.lines?.find((l) => (l.empId || '').toUpperCase() === myEmpId);
  if (!line) return res.status(404).json({ error: 'Payslip not found for employee.' });

  const ytd = await calculateEmployeeYTD(myEmpId, run.period);
  const payslip = buildEmployeePayslip(line, {
    period: run.period,
    status: run.status,
    approvedAt: run.approvedAt,
    approvedBy: run.approvedBy,
    ...ytd,
  });

  // Log portal delivery access
  await PayslipDelivery.create({
    period: run.period,
    empId: line.empId,
    channel: 'portal',
    recipient: req.user.name,
    status: 'Delivered',
    deliveredBy: req.user.name,
  });

  res.json(payslip);
}));

// FR-SLP-01 to FR-SLP-06: Individual Payslip Endpoint
app.get('/api/payroll/:period/payslip/:empId', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'employee'), wrap(async (req, res) => {
  const targetId = req.params.empId.toUpperCase();
  // FR-SLP-06: Personal data protection / authenticated access
  if (req.user.role === 'employee') {
    const myEmpId = resolveSelfEmpId(req);
    if (myEmpId !== targetId) return res.status(403).json({ error: 'You can only view your own payslip.' });
  }

  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'Payroll run not found.' });

  // FR-SLP-03: Payslips shall be generated only for Approved periods
  // If user is employee, must strictly be Approved
  if (req.user.role === 'employee' && run.status !== 'Approved') {
    return res.status(409).json({ error: 'Payslips are only available for Approved periods.' });
  }

  const line = run?.lines.find((l) => (l.empId || '').toUpperCase() === targetId);
  if (!line) return res.status(404).json({ error: 'Payslip not found.' });

  const ytd = await calculateEmployeeYTD(targetId, run.period);
  const payslip = buildEmployeePayslip(line, {
    period: run.period,
    status: run.status,
    approvedAt: run.approvedAt,
    approvedBy: run.approvedBy,
    ...ytd,
  });

  if (run.status === 'Approved') {
    await PayslipDelivery.create({
      period: run.period,
      empId: line.empId,
      channel: req.query.channel === 'print' ? 'print' : 'portal',
      recipient: req.user.name,
      status: req.query.channel === 'print' ? 'Printed' : 'Delivered',
      deliveredBy: req.user.name,
    });
  }

  res.json(payslip);
}));

// FR-SLP-04: Batch payslips generation for an Approved period
app.get('/api/payroll/:period/payslips', auth('payroll', 'approver', 'hr', 'auditor', 'executive'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'Payroll run not found for this period.' });
  // FR-SLP-03: Generated only for Approved periods
  if (run.status !== 'Approved') {
    return res.status(409).json({ error: 'Payslips can only be generated for Approved periods.' });
  }

  const slips = [];
  for (const line of run.lines || []) {
    const ytd = await calculateEmployeeYTD(line.empId, run.period);
    const p = buildEmployeePayslip(line, {
      period: run.period,
      status: run.status,
      approvedAt: run.approvedAt,
      approvedBy: run.approvedBy,
      ...ytd,
    });
    slips.push(p);
  }

  // If format=html or format=print/pdf is requested, return printable batch layout
  if (req.query.format === 'html' || req.query.format === 'print') {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Batch Payslips - ${run.period}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; color: #111; }
    .payslip { page-break-after: always; border: 1px solid #ccc; padding: 24px; max-width: 800px; margin: 0 auto 30px; border-radius: 6px; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #222; padding-bottom: 12px; margin-bottom: 16px; }
    .header h2 { margin: 0 0 4px; font-size: 1.3rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 0.9rem; }
    th, td { padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left; }
    .num { text-align: right; }
    .total-row { font-weight: bold; border-top: 2px solid #333; }
    .ytd-box { background: #f8f9fa; border: 1px solid #ddd; padding: 10px; border-radius: 4px; font-size: 0.85rem; margin-top: 12px; }
    @media print { .noprint { display: none; } body { margin: 0; } }
  </style>
</head>
<body>
  <div class="noprint" style="margin-bottom: 16px; text-align: right;">
    <button onclick="window.print()" style="padding: 8px 16px; font-size: 1rem; cursor: pointer;">Print / Save as PDF</button>
  </div>
  ${slips.map((p) => `
    <div class="payslip">
      <div class="header">
        <div>
          <h2>${escapeHtml(p.company.name)}</h2>
          <div style="font-size: 0.85rem; color: #555;">${escapeHtml(p.company.address)}</div>
        </div>
        <div style="text-align: right;">
          <strong>EMPLOYEE PAYSLIP</strong>
          <div>Period: <b>${escapeHtml(p.period)}</b></div>
          <div>Pay Date: ${escapeHtml(p.payDate)}</div>
        </div>
      </div>
      <div class="grid">
        <div>
          <div>Employee ID: <b>${escapeHtml(p.empId)}</b></div>
          <div>Name: <b>${escapeHtml(p.name)}</b></div>
          <div>Department: ${escapeHtml(p.department || '')}</div>
          <div>Position: ${escapeHtml(p.position || 'Staff')}</div>
        </div>
        <div>
          <div>Bank: <b>${escapeHtml(p.bank || 'N/A')}</b></div>
          <div>Account No: <b>${escapeHtml(p.accountNo)}</b></div>
          <div>Status: <span style="color: green; font-weight: bold;">${escapeHtml(p.status)}</span></div>
          ${p.remainingLoanBalance > 0 ? `<div>Remaining Loan Balance: <b>₦${p.remainingLoanBalance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</b></div>` : ''}
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div>
          <table>
            <thead><tr><th>Earnings</th><th class="num">Amount (₦)</th></tr></thead>
            <tbody>
              <tr><td>Basic Salary</td><td class="num">${p.basic.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td></tr>
              ${p.overtime.hours > 0 ? `<tr><td>Overtime (${p.overtime.hours} h)</td><td class="num">${p.overtime.amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td></tr>` : ''}
              ${p.allowances.itemised.map((a) => `<tr><td>${escapeHtml(a.name)}</td><td class="num">${a.amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td></tr>`).join('')}
              ${p.bonuses.itemised.map((b) => `<tr><td>${escapeHtml(b.name)}</td><td class="num">${b.amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td></tr>`).join('')}
              <tr class="total-row"><td>GROSS PAY</td><td class="num">${p.gross.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <table>
            <thead><tr><th>Deductions</th><th class="num">Amount (₦)</th></tr></thead>
            <tbody>
              ${p.itemisedDeductions.map((d) => `<tr><td>${escapeHtml(d.name)}</td><td class="num">${d.amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td></tr>`).join('')}
              <tr class="total-row"><td>TOTAL DEDUCTIONS</td><td class="num">${p.totalDeductions.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style="background: #eef2ff; padding: 12px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
        <span style="font-size: 1.1rem; font-weight: bold;">NET PAY:</span>
        <span style="font-size: 1.3rem; font-weight: bold; color: #1e3a8a;">₦${p.netPay.toLocaleString('en-NG', { minimumFractionDigits: 2 })}</span>
      </div>

      <div class="ytd-box">
        <strong>Year-to-Date (YTD) Summary:</strong>
        Gross: ₦${p.ytd.gross.toLocaleString('en-NG', { minimumFractionDigits: 2 })} |
        PAYE: ₦${p.ytd.paye.toLocaleString('en-NG', { minimumFractionDigits: 2 })} |
        Employee Pension: ₦${p.ytd.pension.toLocaleString('en-NG', { minimumFractionDigits: 2 })} |
        Employer Pension: ₦${p.ytd.employerPension.toLocaleString('en-NG', { minimumFractionDigits: 2 })}
      </div>
    </div>
  `).join('')}
</body>
</html>`;
    return res.type('text/html').send(html);
  }

  res.json({ period: run.period, count: slips.length, payslips: slips });
}));

// FR-SLP-04: Distribute payslips (email, portal, print) with delivery status logging
app.post('/api/payroll/:period/payslips/distribute', auth('payroll', 'approver'), wrap(async (req, res) => {
  const { period } = req.params;
  const { channel = 'email', empIds } = req.body;
  if (!['email', 'portal', 'print'].includes(channel)) {
    return res.status(400).json({ error: 'Channel must be email, portal, or print.' });
  }

  const run = await PayrollRun.findOne({ period }).lean();
  if (!run || run.status !== 'Approved') {
    return res.status(409).json({ error: 'Payslips can only be distributed for Approved payroll periods.' });
  }

  const targetLines = Array.isArray(empIds) && empIds.length
    ? run.lines.filter((l) => empIds.includes(l.empId))
    : run.lines;

  const deliveries = [];
  for (const line of targetLines) {
    // Find employee email if channel is email
    const emp = await Employee.findOne({ empId: line.empId }).lean();
    const recipient = channel === 'email' ? (emp?.email || `${line.empId.toLowerCase()}@factory.com`) : line.empId;

    const delivery = await PayslipDelivery.create({
      period,
      empId: line.empId,
      channel,
      recipient,
      status: 'Delivered',
      deliveredAt: new Date(),
      deliveredBy: req.user.name,
      metadata: {
        netPay: line.netPay,
        employeeName: line.name,
      },
    });
    deliveries.push(delivery);
  }

  await log(req, 'distribute_payslips', 'PayslipDelivery', period, { channel, count: deliveries.length });
  res.json({ message: `Successfully distributed ${deliveries.length} payslips via ${channel}.`, count: deliveries.length, channel });
}));

// Delivery status enquiry
app.get('/api/payroll/:period/payslips/deliveries', auth('payroll', 'approver', 'auditor', 'executive'), wrap(async (req, res) => {
  const logs = await PayslipDelivery.find({ period: req.params.period }).sort('-createdAt').lean();
  res.json(logs);
}));

// ---- Helper Generators for Payroll Register Exports (FR-REG-02, FR-REG-03) ----
function generateRegisterZipXlsx(sheetName, rows) {
  function dateToDosTime(d) {
    return ((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) |
           (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  }
  function crc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    return ~crc >>> 0;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
    table[i] = c;
  }
  function colName(n) {
    let s = '';
    while (n >= 0) {
      s = String.fromCharCode((n % 26) + 65) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }
  let sheetDataXml = '';
  rows.forEach((row, rIdx) => {
    const rowNum = rIdx + 1;
    let cellsXml = '';
    row.forEach((val, cIdx) => {
      const cRef = colName(cIdx) + rowNum;
      if (val === null || val === undefined) return;
      if (typeof val === 'number') {
        cellsXml += `<c r="${cRef}"><v>${val}</v></c>`;
      } else {
        const escVal = String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        cellsXml += `<c r="${cRef}" t="inlineStr"><is><t>${escVal}</t></is></c>`;
      }
    });
    sheetDataXml += `<row r="${rowNum}">${cellsXml}</row>`;
  });
  const files = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName.replace(/["&<>]/g, '')}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetDataXml}</sheetData></worksheet>`
    }
  ];
  const timeField = dateToDosTime(new Date());
  const localHeaders = [];
  const cdHeaders = [];
  let curOffset = 0;
  files.forEach((f) => {
    const dataBuf = Buffer.from(f.data, 'utf8');
    const compBuf = zlib.deflateRawSync(dataBuf);
    const useComp = compBuf.length < dataBuf.length;
    const finalData = useComp ? compBuf : dataBuf;
    const method = useComp ? 8 : 0;
    const fCrc = crc32(dataBuf);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(timeField, 10);
    lh.writeUInt32LE(fCrc, 14);
    lh.writeUInt32LE(finalData.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);
    localHeaders.push(lh, finalData);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(timeField, 12);
    cdh.writeUInt32LE(fCrc, 16);
    cdh.writeUInt32LE(finalData.length, 20);
    cdh.writeUInt32LE(dataBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(curOffset, 42);
    nameBuf.copy(cdh, 46);
    cdHeaders.push(cdh);
    curOffset += lh.length + finalData.length;
  });
  const cdStart = curOffset;
  const cdBuf = Buffer.concat(cdHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

function generateRegisterPdfDocument({ period, status, watermark, rows, grandTotal }) {
  const lines = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj'
  ];
  let stream = `BT /F1 14 Tf 40 570 Td (PAYROLL REGISTER - Period: ${period} | Status: ${status}) Tj ET\n`;
  if (watermark) {
    stream += `BT /F1 48 Tf 250 300 Td (${watermark}) Tj ET\n`;
  }
  let y = 530;
  stream += `BT /F1 8 Tf 40 ${y} Td (Period | EmpID | Name | Dept | Basic | OTPay | Allowances | Bonuses | GrossPay | Pension | NHF | TaxablePay | PAYE | LoanDed | OtherDed | NetPay) Tj ET\n`;
  y -= 14;
  for (const r of rows) {
    if (y < 60) break;
    stream += `BT /F1 7 Tf 40 ${y} Td (${r.replace(/[()\\\\]/g, '')}) Tj ET\n`;
    y -= 12;
  }
  if (grandTotal) {
    stream += `BT /F1 8 Tf 40 ${Math.max(40, y - 6)} Td (${grandTotal.replace(/[()\\\\]/g, '')}) Tj ET\n`;
  }
  const contentObj = `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}endstream\nendobj`;
  lines.splice(3, 0, contentObj);
  let output = lines[0] + '\n';
  const xref = [0];
  let offset = output.length;
  for (let i = 1; i < lines.length; i++) {
    xref.push(offset);
    output += lines[i] + '\n';
    offset = output.length;
  }
  const xrefOffset = offset;
  output += `xref\n0 ${lines.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < lines.length; i++) {
    output += String(xref[i]).padStart(10, '0') + ' 00000 n \n';
  }
  output += `trailer << /Size ${lines.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, 'binary');
}

function buildRegisterData(run, query = {}) {
  const period = run.period;
  const status = run.status || 'Draft';
  const isApproved = ['Approved', 'Paid/Locked'].includes(status);
  const watermark = isApproved ? null : 'DRAFT';

  // Extract all lines with required 16 fields (FR-REG-01)
  let items = (run.lines || []).map((l) => ({
    period,
    empId: l.empId,
    name: l.name,
    department: l.department || 'General',
    basic: r2(l.basic || 0),
    otPay: r2(l.otPay || 0),
    allowances: r2(l.allowances || 0),
    bonuses: r2(l.bonuses || 0),
    grossPay: r2(l.gross ?? l.grossPay ?? 0),
    pension: r2(l.pension || 0),
    nhf: r2(l.nhf || 0),
    taxablePay: r2(l.taxablePay ?? l.chargeable ?? 0),
    paye: r2(l.paye || 0),
    loanDeduction: r2(l.loanDeduction || 0),
    otherDeductions: r2(l.otherDeductions || 0),
    netPay: r2(l.netPay || 0),
  }));

  // Filtering (FR-REG-02)
  if (query.department) {
    const deptFilter = String(query.department).toLowerCase();
    items = items.filter((i) => (i.department || '').toLowerCase() === deptFilter);
  }
  if (query.search) {
    const s = String(query.search).toLowerCase();
    items = items.filter((i) =>
      (i.empId || '').toLowerCase().includes(s) ||
      (i.name || '').toLowerCase().includes(s) ||
      (i.department || '').toLowerCase().includes(s)
    );
  }

  // Sorting (FR-REG-02)
  const sortBy = query.sortBy || 'empId';
  const sortDir = (query.sortDir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  items.sort((a, b) => {
    const va = a[sortBy] ?? '';
    const vb = b[sortBy] ?? '';
    if (typeof va === 'number' && typeof vb === 'number') {
      return (va - vb) * sortDir;
    }
    return String(va).localeCompare(String(vb)) * sortDir;
  });

  const sumList = (arr, key) => r2(arr.reduce((s, row) => s + (Number(row[key]) || 0), 0));
  const numericKeys = ['basic', 'otPay', 'allowances', 'bonuses', 'grossPay', 'pension', 'nhf', 'taxablePay', 'paye', 'loanDeduction', 'otherDeductions', 'netPay'];

  // Subtotals by department (FR-REG-02)
  const deptGroups = {};
  for (const item of items) {
    const dept = item.department || 'General';
    if (!deptGroups[dept]) deptGroups[dept] = [];
    deptGroups[dept].push(item);
  }

  const departmentSubtotals = Object.keys(deptGroups).sort().map((dept) => {
    const list = deptGroups[dept];
    const sub = { department: dept, count: list.length };
    for (const k of numericKeys) sub[k] = sumList(list, k);
    return sub;
  });

  // Grand total (FR-REG-02)
  const grandTotal = { count: items.length };
  for (const k of numericKeys) grandTotal[k] = sumList(items, k);

  return {
    period,
    status,
    isApproved,
    watermark,
    version: run.version || 1,
    versionStamp: run.versionStamp || null,
    preparedBy: run.preparedBy || null,
    approvedBy: run.approvedBy || null,
    approvedAt: run.approvedAt || null,
    items,
    departmentSubtotals,
    grandTotal,
  };
}

// ---- Payroll Register Endpoints (FR-REG-01, FR-REG-02, FR-REG-03, FR-REG-04) ----
app.get('/api/payroll/:period/register', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'No payroll found for this period.' });
  const reg = buildRegisterData(run, req.query);
  res.json(reg);
}));

app.get('/api/payroll/:period/register.csv', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'No payroll found for this period.' });
  const reg = buildRegisterData(run, req.query);

  const headers = ['Period', 'EmpID', 'Name', 'Department', 'Basic', 'OTPay', 'Allowances', 'Bonuses', 'GrossPay', 'Pension', 'NHF', 'TaxablePay', 'PAYE', 'LoanDeduction', 'OtherDeductions', 'NetPay'];
  const rows = [];
  if (reg.watermark) {
    rows.push(`*** WATERMARK: ${reg.watermark} ***,Period Status: ${reg.status}`);
  }
  rows.push(headers.join(','));

  // Group by department with subtotals
  for (const sub of reg.departmentSubtotals) {
    const deptItems = reg.items.filter((i) => i.department === sub.department);
    for (const it of deptItems) {
      rows.push([
        it.period, it.empId, qCsv(it.name), qCsv(it.department),
        it.basic.toFixed(2), it.otPay.toFixed(2), it.allowances.toFixed(2), it.bonuses.toFixed(2),
        it.grossPay.toFixed(2), it.pension.toFixed(2), it.nhf.toFixed(2), it.taxablePay.toFixed(2),
        it.paye.toFixed(2), it.loanDeduction.toFixed(2), it.otherDeductions.toFixed(2), it.netPay.toFixed(2),
      ].join(','));
    }
    rows.push([
      `SUBTOTAL (${sub.department})`, `${sub.count} employees`, '', '',
      sub.basic.toFixed(2), sub.otPay.toFixed(2), sub.allowances.toFixed(2), sub.bonuses.toFixed(2),
      sub.grossPay.toFixed(2), sub.pension.toFixed(2), sub.nhf.toFixed(2), sub.taxablePay.toFixed(2),
      sub.paye.toFixed(2), sub.loanDeduction.toFixed(2), sub.otherDeductions.toFixed(2), sub.netPay.toFixed(2),
    ].join(','));
  }

  // Grand total row
  rows.push([
    'GRAND TOTAL', `${reg.grandTotal.count} employees`, '', '',
    reg.grandTotal.basic.toFixed(2), reg.grandTotal.otPay.toFixed(2), reg.grandTotal.allowances.toFixed(2), reg.grandTotal.bonuses.toFixed(2),
    reg.grandTotal.grossPay.toFixed(2), reg.grandTotal.pension.toFixed(2), reg.grandTotal.nhf.toFixed(2), reg.grandTotal.taxablePay.toFixed(2),
    reg.grandTotal.paye.toFixed(2), reg.grandTotal.loanDeduction.toFixed(2), reg.grandTotal.otherDeductions.toFixed(2), reg.grandTotal.netPay.toFixed(2),
  ].join(','));

  if (reg.versionStamp) {
    rows.push(`Version Stamp: ${reg.versionStamp},Approved By: ${reg.approvedBy || ''},Approved At: ${reg.approvedAt ? new Date(reg.approvedAt).toISOString() : ''}`);
  }

  await log(req, 'export', 'PayrollRegisterCSV', run.period, { count: reg.items.length, status: reg.status });
  res.type('text/csv').attachment(`payroll-register-${run.period}.csv`).send(rows.join('\n'));
}));

app.get('/api/payroll/:period/register.xlsx', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'No payroll found for this period.' });
  const reg = buildRegisterData(run, req.query);

  const xlsxRows = [];
  if (reg.watermark) {
    xlsxRows.push([`WATERMARK: ${reg.watermark}`, `Status: ${reg.status}`]);
  }
  xlsxRows.push(['Period', 'EmpID', 'Name', 'Department', 'Basic', 'OTPay', 'Allowances', 'Bonuses', 'GrossPay', 'Pension', 'NHF', 'TaxablePay', 'PAYE', 'LoanDeduction', 'OtherDeductions', 'NetPay']);

  for (const sub of reg.departmentSubtotals) {
    const deptItems = reg.items.filter((i) => i.department === sub.department);
    for (const it of deptItems) {
      xlsxRows.push([
        it.period, it.empId, it.name, it.department,
        it.basic, it.otPay, it.allowances, it.bonuses,
        it.grossPay, it.pension, it.nhf, it.taxablePay,
        it.paye, it.loanDeduction, it.otherDeductions, it.netPay,
      ]);
    }
    xlsxRows.push([
      `SUBTOTAL (${sub.department})`, `${sub.count} staff`, '', '',
      sub.basic, sub.otPay, sub.allowances, sub.bonuses,
      sub.grossPay, sub.pension, sub.nhf, sub.taxablePay,
      sub.paye, sub.loanDeduction, sub.otherDeductions, sub.netPay,
    ]);
  }

  xlsxRows.push([
    'GRAND TOTAL', `${reg.grandTotal.count} staff`, '', '',
    reg.grandTotal.basic, reg.grandTotal.otPay, reg.grandTotal.allowances, reg.grandTotal.bonuses,
    reg.grandTotal.grossPay, reg.grandTotal.pension, reg.grandTotal.nhf, reg.grandTotal.taxablePay,
    reg.grandTotal.paye, reg.grandTotal.loanDeduction, reg.grandTotal.otherDeductions, reg.grandTotal.netPay,
  ]);

  if (reg.versionStamp) {
    xlsxRows.push([`Version Stamp: ${reg.versionStamp}`, `Approved By: ${reg.approvedBy || ''}`, `Approved At: ${reg.approvedAt ? new Date(reg.approvedAt).toISOString() : ''}`]);
  }

  const xlsxBuf = generateRegisterZipXlsx('Payroll_Register', xlsxRows);
  await log(req, 'export', 'PayrollRegisterXLSX', run.period, { count: reg.items.length, status: reg.status });
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`payroll-register-${run.period}.xlsx`).send(xlsxBuf);
}));

app.get('/api/payroll/:period/register.pdf', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'No payroll found for this period.' });
  const reg = buildRegisterData(run, req.query);

  const pdfRows = reg.items.map((it) =>
    `${it.period} | ${it.empId} | ${it.name} | ${it.department} | ${it.basic.toFixed(2)} | ${it.otPay.toFixed(2)} | ${it.allowances.toFixed(2)} | ${it.bonuses.toFixed(2)} | ${it.grossPay.toFixed(2)} | ${it.pension.toFixed(2)} | ${it.nhf.toFixed(2)} | ${it.taxablePay.toFixed(2)} | ${it.paye.toFixed(2)} | ${it.loanDeduction.toFixed(2)} | ${it.otherDeductions.toFixed(2)} | ${it.netPay.toFixed(2)}`
  );
  const grandTotalStr = `GRAND TOTAL: Gross: ${reg.grandTotal.grossPay.toFixed(2)} | Pension: ${reg.grandTotal.pension.toFixed(2)} | PAYE: ${reg.grandTotal.paye.toFixed(2)} | Net: ${reg.grandTotal.netPay.toFixed(2)}${reg.versionStamp ? ` | Stamp: ${reg.versionStamp}` : ''}`;

  const pdfBuf = generateRegisterPdfDocument({
    period: reg.period,
    status: reg.status,
    watermark: reg.watermark,
    rows: pdfRows,
    grandTotal: grandTotalStr,
  });

  await log(req, 'export', 'PayrollRegisterPDF', run.period, { count: reg.items.length, status: reg.status });
  res.type('application/pdf').attachment(`payroll-register-${run.period}.pdf`).send(pdfBuf);
}));

// FR-PAY-09: Register reconciliation endpoint
app.get('/api/payroll/:period/reconciliation', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'No payroll found for this period.' });

  const bankSchedule = {
    totalNet: run.totals?.net || 0,
    totalAmount: run.totals?.net || 0,
  };

  const reconciliation = reconcilePayrollRegister(run.lines || [], bankSchedule);
  res.json({
    period: run.period,
    status: run.status,
    ...reconciliation,
  });
}));

// FR-PAY-10: Variance analysis comparing Gross and Net against previous period
app.get('/api/payroll/:period/variance', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const { period } = req.params;
  const currentRun = await PayrollRun.findOne({ period }).lean();
  if (!currentRun) return res.status(404).json({ error: 'No payroll found for current period.' });

  const [yearStr, monthStr] = period.split('-');
  const y = parseInt(yearStr, 10);
  const m = parseInt(monthStr, 10);
  const prevPeriod = m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`;

  const previousRun = await PayrollRun.findOne({ period: prevPeriod }).lean();
  const threshold = req.query.threshold !== undefined ? parseFloat(req.query.threshold) : 0.10;

  const varianceResult = calculatePayrollVariance(
    currentRun.lines || [],
    previousRun ? (previousRun.lines || []) : [],
    threshold
  );

  res.json({
    period,
    previousPeriod: prevPeriod,
    previousRunExists: Boolean(previousRun),
    thresholdPct: varianceResult.thresholdPct,
    totalEmployees: varianceResult.totalEmployees,
    flaggedCount: varianceResult.flaggedCount,
    comparisons: varianceResult.comparisons,
  });
}));

// FR-PAY-12: Year-to-date totals endpoint for calendar year (all employees)
app.get('/api/payroll/:period/ytd', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor'), wrap(async (req, res) => {
  const { period } = req.params;
  if (!validPeriod(period)) return res.status(400).json({ error: 'Period must look like 2026-11.' });

  const ytdData = await calculateAllEmployeesYTD(period);
  res.json({
    period,
    year: parseInt(period.split('-')[0], 10),
    count: ytdData.length,
    employees: ytdData,
  });
}));

// FR-PAY-12: Year-to-date totals endpoint for single employee
app.get('/api/payroll/:period/ytd/:empId', auth('payroll', 'approver', 'hr', 'auditor', 'executive', 'tax_advisor', 'employee'), wrap(async (req, res) => {
  const { period, empId } = req.params;
  if (!validPeriod(period)) return res.status(400).json({ error: 'Period must look like 2026-11.' });

  const ytd = await calculateEmployeeYTD(empId, period);
  res.json({
    empId,
    period,
    year: parseInt(period.split('-')[0], 10),
    ...ytd,
  });
}));

// ---- Bank Transfer Schedule ----
app.get('/api/payroll/:period/bank.csv', auth('payroll', 'approver', 'executive'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run || run.status !== 'Approved') return res.status(409).json({ error: 'The bank file is available only after approval.' });
  const pay = run.lines.filter((l) => l.netPay > 0);
  const rows = ['EmpID,EmployeeName,Bank,AccountNo,NetPay,Narration',
    ...pay.map((l) => [l.empId, qCsv(l.name), qCsv(l.bank), l.accountNo, l.netPay.toFixed(2), qCsv(`Salary ${run.period}`)].join(',')),
    `TOTAL,${pay.length} payments,,,${r2(pay.reduce((s, l) => s + l.netPay, 0)).toFixed(2)},`];
  await log(req, 'export', 'BankFile', run.period, { count: pay.length });
  res.type('text/csv').attachment(`bank-${run.period}.csv`).send(rows.join('\n'));
}));

// ---- Statutory Remittances (Tax Advisor / Statutory Bodies / Approver / Executive) ----
app.get('/api/payroll/:period/remittances/summary', auth('tax_advisor', 'approver', 'payroll', 'executive', 'auditor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'Payroll not found for this period.' });

  const statesMap = {};
  for (const l of run.lines) {
    const st = l.state || 'Lagos (Default)';
    if (!statesMap[st]) statesMap[st] = { state: st, count: 0, gross: 0, chargeable: 0, paye: 0 };
    statesMap[st].count += 1;
    statesMap[st].gross = r2(statesMap[st].gross + (l.gross || 0));
    statesMap[st].chargeable = r2(statesMap[st].chargeable + (l.chargeable || 0));
    statesMap[st].paye = r2(statesMap[st].paye + (l.paye || 0));
  }

  const grossTotal = run.totals.gross || 0;
  const nsitf = r2(grossTotal * 0.01); // 1% Employees Compensation Scheme
  const itf = r2(grossTotal * 0.01);   // 1% Industrial Training Fund
  const totalPension = r2((run.totals.pension || 0) + (run.totals.employerPension || 0));

  res.json({
    period: run.period,
    status: run.status,
    paye: {
      total: run.totals.paye,
      byState: Object.values(statesMap),
    },
    pension: {
      employee: run.totals.pension,
      employer: run.totals.employerPension,
      total: totalPension,
      enrolledCount: run.lines.filter((l) => l.pension > 0).length,
    },
    nhf: {
      total: run.totals.nhf,
      enrolledCount: run.lines.filter((l) => l.nhf > 0).length,
    },
    levies: {
      nsitf,
      itf,
    },
    totalRemittanceLiability: r2((run.totals.paye || 0) + totalPension + (run.totals.nhf || 0) + nsitf + itf),
  });
}));

app.get('/api/payroll/:period/remittance/paye.csv', auth('tax_advisor', 'approver', 'payroll', 'executive'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'Payroll not found for this period.' });
  const rows = ['EmpID,EmployeeName,TIN,State,GrossPay,ChargeableIncome,PAYE',
    ...run.lines.map((l) => [l.empId, qCsv(l.name), qCsv(l.tin || ''), qCsv(l.state || 'Lagos'), l.gross.toFixed(2), (l.chargeable || 0).toFixed(2), l.paye.toFixed(2)].join(',')),
    `TOTAL,${run.lines.length} employees,,,,${r2(run.totals.gross).toFixed(2)},${r2(run.totals.paye).toFixed(2)}`];
  await log(req, 'export', 'RemittancePAYE', run.period, { count: run.lines.length });
  res.type('text/csv').attachment(`paye-remittance-${run.period}.csv`).send(rows.join('\n'));
}));

app.get('/api/payroll/:period/remittance/pension.csv', auth('tax_advisor', 'approver', 'payroll', 'executive'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'Payroll not found for this period.' });
  const totalPen = (l) => r2(l.pension + l.employerPension).toFixed(2);
  const rows = ['EmpID,EmployeeName,PensionPIN,PensionableEmoluments,EmployeePension,EmployerPension,TotalPension',
    ...run.lines.map((l) => [l.empId, qCsv(l.name), qCsv(l.pensionPin || ''), (l.pensionable || 0).toFixed(2), l.pension.toFixed(2), l.employerPension.toFixed(2), totalPen(l)].join(',')),
    `TOTAL,${run.lines.length} employees,,${r2(run.lines.reduce((s, l) => s + (l.pensionable || 0), 0)).toFixed(2)},${r2(run.totals.pension).toFixed(2)},${r2(run.totals.employerPension).toFixed(2)},${r2((run.totals.pension || 0) + (run.totals.employerPension || 0)).toFixed(2)}`];
  await log(req, 'export', 'RemittancePension', run.period, { count: run.lines.length });
  res.type('text/csv').attachment(`pension-remittance-${run.period}.csv`).send(rows.join('\n'));
}));

app.get('/api/payroll/:period/remittance/nhf.csv', auth('tax_advisor', 'approver', 'payroll', 'executive'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'Payroll not found for this period.' });
  const nhfLines = run.lines.filter((l) => l.nhf > 0);
  const rows = ['EmpID,EmployeeName,BasicSalary,NHFDeduction',
    ...nhfLines.map((l) => [l.empId, qCsv(l.name), l.basic.toFixed(2), l.nhf.toFixed(2)].join(',')),
    `TOTAL,${nhfLines.length} employees,${r2(nhfLines.reduce((s, l) => s + l.basic, 0)).toFixed(2)},${r2(run.totals.nhf).toFixed(2)}`];
  await log(req, 'export', 'RemittanceNHF', run.period, { count: nhfLines.length });
  res.type('text/csv').attachment(`nhf-remittance-${run.period}.csv`).send(rows.join('\n'));
}));

// ---- Executive Dashboard (MD / CFO / Approver / Auditor) ----
app.get('/api/dashboard/:period', auth('executive', 'approver', 'auditor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) {
    return res.json({
      period: req.params.period,
      status: 'Not Run',
      message: `No payroll calculated for ${req.params.period}.`,
    });
  }

  const deptMap = {};
  for (const l of run.lines) {
    const dept = l.department || 'Unassigned';
    if (!deptMap[dept]) deptMap[dept] = { department: dept, count: 0, gross: 0, otPay: 0, netPay: 0, employerCost: 0 };
    deptMap[dept].count += 1;
    deptMap[dept].gross = r2(deptMap[dept].gross + l.gross);
    deptMap[dept].otPay = r2(deptMap[dept].otPay + l.otPay);
    deptMap[dept].netPay = r2(deptMap[dept].netPay + l.netPay);
    deptMap[dept].employerCost = r2(deptMap[dept].employerCost + l.gross + l.employerPension);
  }

  const highValueEmployees = run.lines
    .filter((l) => l.netPay >= 1000000)
    .map((l) => ({ empId: l.empId, name: l.name, department: l.department, gross: l.gross, netPay: l.netPay }));

  const flaggedEmployees = run.lines
    .filter((l) => l.flags && l.flags.length > 0)
    .map((l) => ({ empId: l.empId, name: l.name, flags: l.flags, netPay: l.netPay }));

  const totalOTHours = r2(run.lines.reduce((s, l) => s + (l.otHours || 0), 0));
  const totalBonuses = r2(run.lines.reduce((s, l) => s + (l.bonuses || 0), 0));
  const totalEmployerCost = r2((run.totals.gross || 0) + (run.totals.employerPension || 0));

  res.json({
    period: run.period,
    status: run.status,
    preparedBy: run.preparedBy,
    approvedBy: run.approvedBy,
    approvedAt: run.approvedAt,
    kpis: {
      headcount: run.totals.employees,
      grossPayroll: run.totals.gross,
      netPayroll: run.totals.net,
      totalPAYE: run.totals.paye,
      pensionEmployee: run.totals.pension,
      pensionEmployer: run.totals.employerPension,
      pensionTotal: r2((run.totals.pension || 0) + (run.totals.employerPension || 0)),
      totalNHF: run.totals.nhf,
      otHours: totalOTHours,
      otCost: run.totals.otPay,
      bonuses: totalBonuses,
      loanRecoveries: run.totals.loans,
      employerCost: totalEmployerCost,
      statutoryLevies: {
        nsitf: r2((run.totals.gross || 0) * 0.01),
        itf: r2((run.totals.gross || 0) * 0.01),
      },
    },
    departmentBreakdown: Object.values(deptMap),
    governance: {
      highValueCount: highValueEmployees.length,
      highValueEmployees,
      exceptionCount: flaggedEmployees.length,
      flaggedEmployees,
      warnings: run.warnings || [],
    },
  });
}));

// ---- Audit Log (FR-AUD-01 to FR-AUD-05) ----
// FR-AUD-04: Restricted strictly to Auditor and Admin roles
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildAuditQuery(query) {
  const filter = {};
  const andClauses = [];

  if (query.user) {
    filter.user = new RegExp(escapeRegex(String(query.user).trim()), 'i');
  }
  if (query.action) {
    filter.action = String(query.action).trim();
  }
  if (query.entity) {
    filter.entity = String(query.entity).trim();
  }
  if (query.empId) {
    const eid = String(query.empId).trim();
    andClauses.push({ $or: [{ empId: eid }, { entityId: eid }, { 'details.empId': eid }] });
  }
  if (query.search) {
    const s = escapeRegex(String(query.search).trim());
    const sRegex = new RegExp(s, 'i');
    andClauses.push({
      $or: [
        { user: sRegex },
        { action: sRegex },
        { entity: sRegex },
        { entityId: sRegex },
        { empId: sRegex },
      ],
    });
  }
  if (query.startDate || query.endDate) {
    filter.ts = {};
    if (query.startDate) {
      filter.ts.$gte = new Date(query.startDate);
    }
    if (query.endDate) {
      const ed = new Date(query.endDate);
      // If date only (length <= 10), extend to end of day
      if (String(query.endDate).length <= 10) ed.setUTCHours(23, 59, 59, 999);
      filter.ts.$lte = ed;
    }
  }

  if (andClauses.length === 1) {
    Object.assign(filter, andClauses[0]);
  } else if (andClauses.length > 1) {
    filter.$and = andClauses;
  }

  return filter;
}

app.get('/api/audit', auth('auditor', 'admin'), wrap(async (req, res) => {
  const filter = buildAuditQuery(req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000);
  const entries = await Audit.find(filter).sort('-ts').limit(limit).lean();
  res.json(entries);
}));

app.get('/api/audit/export', auth('auditor', 'admin'), wrap(async (req, res) => {
  const filter = buildAuditQuery(req.query);
  const entries = await Audit.find(filter).sort('-ts').limit(10000).lean();
  await log(req, 'export', 'AuditLog', 'audit-trail', { count: entries.length });

  const format = String(req.query.format || 'csv').toLowerCase();
  const headers = ['Timestamp', 'User', 'Action', 'Entity', 'RecordID', 'EmpID', 'Details'];

  const rows = entries.map((e) => [
    e.ts ? new Date(e.ts).toISOString() : '',
    e.user || '',
    e.action || '',
    e.entity || '',
    e.entityId || '',
    e.empId || '',
    JSON.stringify(e.details || {}),
  ]);

  if (format === 'xlsx') {
    const xlsxRows = [headers, ...rows];
    const xlsxBuf = generateRegisterZipXlsx('Audit_Log', xlsxRows);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
       .attachment(`audit-log-${new Date().toISOString().slice(0, 10)}.xlsx`)
       .send(xlsxBuf);
  } else {
    const csvLines = [
      headers.join(','),
      ...rows.map((r) => r.map((c) => qCsv(c)).join(',')),
    ];
    res.type('text/csv')
       .attachment(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`)
       .send(csvLines.join('\n'));
  }
}));

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

// Helper to get or initialize leave balance
async function getOrCreateLeaveBalance(empId, year, leaveType) {
  let bal = await LeaveBalance.findOne({ empId, year, leaveType });
  if (!bal) {
    const defaultEntitlements = {
      Annual: 20,
      Sick: 12,
      Maternity: 84, // 12 weeks
      Paternity: 14, // 2 weeks
      Compassionate: 5,
      Study: 10,
      Unpaid: 365,
    };
    const entitlement = defaultEntitlements[leaveType] || 0;
    bal = await LeaveBalance.create({
      empId,
      year,
      leaveType,
      entitlement,
      used: 0,
      pending: 0,
      carryOver: 0,
    });
  }
  return bal;
}

// ---- Leave Management (FR-LV-01 to FR-LV-07) ----

// Leave Balances list & management (FR-LV-06)
app.get('/api/leaves/balances', auth('employee', 'hr', 'approver', 'admin'), wrap(async (req, res) => {
  const empId = req.user.role === 'employee' ? req.user.empId : req.query.empId;
  const year = Number(req.query.year) || new Date().getFullYear();
  const q = { year };
  if (empId) q.empId = empId;
  const balances = await LeaveBalance.find(q).sort('empId leaveType').lean();
  res.json(balances);
}));

app.post('/api/leaves/balances', auth('hr', 'admin'), wrap(async (req, res) => {
  const { empId, year = new Date().getFullYear(), leaveType, entitlement, carryOver = 0 } = req.body;
  if (!empId || !leaveType) return res.status(400).json({ error: 'empId and leaveType are required.' });
  if (!LEAVE_TYPES[leaveType]) return res.status(400).json({ error: `Invalid leaveType. Must be one of: ${Object.keys(LEAVE_TYPES).join(', ')}` });

  const bal = await LeaveBalance.findOneAndUpdate(
    { empId, year: Number(year), leaveType },
    { entitlement: Number(entitlement) || 0, carryOver: Number(carryOver) || 0 },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await log(req, 'upsert_balance', 'LeaveBalance', bal._id, { empId, year, leaveType, entitlement });
  res.json(bal);
}));

// Leave Requests endpoint (maps to Leave_Register)
app.get(['/api/leaves', '/api/ess/leaves'], auth('employee', 'hr', 'approver'), wrap(async (req, res) => {
  const empId = req.user.role === 'employee' ? req.user.empId : req.query.empId;
  const q = {};
  if (empId) q.empId = empId;
  if (req.query.status) q.status = req.query.status;
  if (req.query.leaveType) q.leaveType = req.query.leaveType;
  res.json(await LeaveRequest.find(q).sort('-createdAt').lean());
}));

app.post(['/api/leaves', '/api/ess/leaves'], auth('employee', 'hr'), wrap(async (req, res) => {
  const empId = req.user.role === 'employee' ? req.user.empId : req.body.empId;
  if (!empId) return res.status(400).json({ error: 'Employee ID required.' });

  const emp = await Employee.findOne({ empId });
  if (!emp) return res.status(404).json({ error: 'Employee record not found.' });

  const { leaveType, startDate, endDate, reason, overrideReason, leaveAllowanceRequested } = req.body;

  // FR-LV-02: Controlled list with pay treatment
  if (!leaveType || !LEAVE_TYPES[leaveType]) {
    return res.status(400).json({
      error: `Invalid leaveType. Controlled list: ${Object.keys(LEAVE_TYPES).join(', ')}`,
    });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({ error: 'Valid startDate and endDate are required.' });
  }
  if (start > end) {
    return res.status(400).json({ error: 'startDate cannot be after endDate.' });
  }

  // FR-LV-07: The system shall reject overlapping leave records for the same employee
  const overlap = await LeaveRequest.findOne({
    empId,
    status: { $in: ['Pending', 'Approved'] },
    startDate: { $lte: end },
    endDate: { $gte: start },
  });
  if (overlap) {
    return res.status(409).json({
      error: `Overlapping leave request exists for employee ${empId} from ${overlap.startDate.toISOString().slice(0, 10)} to ${overlap.endDate.toISOString().slice(0, 10)}.`,
    });
  }

  // FR-LV-01: Days calculated from the difference between the end date and the start date (excluding weekends/holidays per configuration)
  const excludeWeekends = req.body.excludeWeekends !== undefined ? Boolean(req.body.excludeWeekends) : false;
  const excludeHolidays = req.body.excludeHolidays !== undefined ? Boolean(req.body.excludeHolidays) : false;
  let holidaysList = [];
  if (excludeHolidays) {
    const holidayDocs = await PublicHoliday.find({ date: { $gte: start, $lte: end } }).lean();
    holidaysList = holidayDocs.map((h) => h.date);
  }
  const calculatedDays = calculateLeaveDays(start, end, holidaysList, { excludeWeekends, excludeHolidays });

  if (calculatedDays <= 0) {
    return res.status(400).json({ error: 'Leave duration must be at least 1 day.' });
  }

  // FR-LV-06: Maintain leave balances per employee per leave year, reject requests exceeding balance (unless overridden)
  const leaveYear = start.getUTCFullYear();
  let isOverridden = false;
  if (leaveType !== 'Unpaid') {
    const bal = await getOrCreateLeaveBalance(empId, leaveYear, leaveType);
    const available = (bal.entitlement || 0) + (bal.carryOver || 0) - (bal.used || 0) - (bal.pending || 0);

    if (calculatedDays > available) {
      if (overrideReason && (req.user.role === 'hr' || req.user.role === 'admin')) {
        isOverridden = true;
      } else {
        return res.status(400).json({
          error: `Insufficient leave balance for ${leaveType}. Available: ${available} days, requested: ${calculatedDays} days. Override requires HR/Admin permission and overrideReason.`,
          availableDays: available,
          requestedDays: calculatedDays,
        });
      }
    }
  }

  // FR-LV-02 Pay treatment
  const typeConfig = LEAVE_TYPES[leaveType];
  const payTreatment = req.body.payTreatment || typeConfig.treatment;
  const paidPercentage = req.body.paidPercentage !== undefined ? Number(req.body.paidPercentage) : typeConfig.defaultPaidPct;

  // Optional leave allowance calculation (FR-LV-06)
  let leaveAllowanceAmount = 0;
  if (leaveAllowanceRequested && leaveType === 'Annual') {
    leaveAllowanceAmount = calculateLeaveAllowance(emp.basic, req.body.leaveAllowanceRatePct || 0.10);
  }

  const leave = await LeaveRequest.create({
    empId,
    leaveType,
    payTreatment,
    paidPercentage,
    startDate: start,
    endDate: end,
    days: calculatedDays,
    leaveYear,
    reason,
    overrideReason,
    isOverridden,
    status: 'Pending',
    leaveAllowanceRequested: Boolean(leaveAllowanceRequested),
    leaveAllowancePaid: false,
    leaveAllowanceAmount,
  });

  // Track pending in balance
  if (leaveType !== 'Unpaid') {
    const bal = await getOrCreateLeaveBalance(empId, leaveYear, leaveType);
    bal.pending = (bal.pending || 0) + calculatedDays;
    await bal.save();
  }

  await log(req, 'create', 'LeaveRequest', leave._id, { empId, leaveType, days: calculatedDays, isOverridden });
  res.status(201).json(leave);
}));

// FR-LV-03: Leave shall require approval before it affects attendance/payroll
app.post(['/api/leaves/:id/approve', '/api/ess/leaves/:id/approve'], auth('approver', 'hr'), wrap(async (req, res) => {
  const leave = await LeaveRequest.findById(req.params.id);
  if (!leave) return res.status(404).json({ error: 'Leave request not found.' });
  if (leave.status === 'Approved') return res.status(409).json({ error: 'Leave request is already approved.' });

  leave.status = 'Approved';
  leave.approvedBy = req.user.name;
  leave.approvedAt = new Date();
  if (req.body.comments) leave.comments = req.body.comments;
  await leave.save();

  // Update LeaveBalance: move days from pending to used
  if (leave.leaveType !== 'Unpaid') {
    const bal = await getOrCreateLeaveBalance(leave.empId, leave.leaveYear, leave.leaveType);
    bal.pending = Math.max(0, (bal.pending || 0) - leave.days);
    bal.used = (bal.used || 0) + leave.days;
    await bal.save();
  }

  // If leave is currently active, optionally set employee status to 'On Leave'
  const now = new Date();
  if (now >= leave.startDate && now <= leave.endDate) {
    await Employee.updateOne({ empId: leave.empId, status: 'Active' }, { status: 'On Leave' });
  }

  await log(req, 'approve', 'LeaveRequest', leave._id, { empId: leave.empId, days: leave.days });
  res.json(leave);
}));

app.post(['/api/leaves/:id/reject', '/api/ess/leaves/:id/reject'], auth('approver', 'hr'), wrap(async (req, res) => {
  const leave = await LeaveRequest.findById(req.params.id);
  if (!leave) return res.status(404).json({ error: 'Leave request not found.' });
  if (leave.status !== 'Pending') return res.status(409).json({ error: `Cannot reject leave with status ${leave.status}.` });

  leave.status = 'Rejected';
  leave.comments = req.body.reason || req.body.comments || 'Rejected by approver';
  await leave.save();

  // Release pending days
  if (leave.leaveType !== 'Unpaid') {
    const bal = await getOrCreateLeaveBalance(leave.empId, leave.leaveYear, leave.leaveType);
    bal.pending = Math.max(0, (bal.pending || 0) - leave.days);
    await bal.save();
  }

  await log(req, 'reject', 'LeaveRequest', leave._id, { empId: leave.empId, comments: leave.comments });
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

  // SC-14 & Section 3.7 Mitigation: dual authorization on payment batches
  const batch = await PaymentBatch.create({
    ...batchData,
    status: 'Pending_Dual_Approval',
    initiatedBy: req.user.name,
    dualApprovalRequired: true,
  });

  run.bankPaymentInitiated = true;
  run.paymentReference = batch.batchReference;
  await run.save();

  await log(req, 'direct_bank_payment_initiated', 'PaymentBatch', batch.batchReference, {
    channel,
    amount: batch.totalAmount,
    status: 'Pending_Dual_Approval',
  });
  res.json({ message: 'Direct bank payment batch initiated and awaiting dual approval.', batch });
}));

// Payment Batch Dual Approval Endpoint (Risk Mitigation: dual approval on payments)
app.post('/api/payments/batches/:id/approve', auth('approver', 'executive'), wrap(async (req, res) => {
  const batch = await PaymentBatch.findById(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Payment batch not found.' });
  if (batch.status !== 'Pending_Dual_Approval') {
    return res.status(409).json({ error: `Batch is not pending dual approval (current status: ${batch.status}).` });
  }
  // Dual approval constraint: approver cannot be the same person who initiated the payment batch
  if (batch.initiatedBy === req.user.name) {
    return res.status(403).json({ error: 'Dual authorization required: payment batch must be approved by a different authorized user.' });
  }

  batch.approvedBy = req.user.name;
  batch.approvedAt = new Date();
  batch.status = batch.failedCount === 0 ? 'Completed' : (batch.successfulCount > 0 ? 'Completed' : 'Failed');
  await batch.save();

  const run = await PayrollRun.findOne({ period: batch.period });
  if (run) {
    run.bankPaymentApproved = true;
    run.bankPaymentApprovedBy = req.user.name;
    await run.save();
  }

  await log(req, 'direct_bank_payment_approved', 'PaymentBatch', batch.batchReference, {
    approvedBy: req.user.name,
    status: batch.status,
    totalAmount: batch.totalAmount,
  });

  res.json({ message: 'Payment batch dual approval granted and funds disbursed.', batch });
}));

// Parallel-Run Reconciliation Utility (SC-02 & Section 3.7 Mitigation)
app.post('/api/payroll/:period/parallel-run', auth('payroll', 'approver', 'executive', 'auditor'), wrap(async (req, res) => {
  const run = await PayrollRun.findOne({ period: req.params.period }).lean();
  if (!run) return res.status(404).json({ error: 'Payroll run not found for this period.' });

  const legacyLines = Array.isArray(req.body.legacyLines) ? req.body.legacyLines : [];
  const reconciliation = reconcileParallelRun(legacyLines, run.lines);

  await log(req, 'parallel_run_reconciliation', 'PayrollRun', run.period, {
    passed: reconciliation.passed,
    evaluatedCount: reconciliation.evaluatedCount,
    varianceCount: reconciliation.varianceCount,
    totalNetVariance: reconciliation.totalNetVariance,
  });

  res.json(reconciliation);
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
