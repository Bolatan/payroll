const express = require('express');
const connect = require('./db');
const {
  User, Employee, Attendance, Loan, Adjustment, PayrollRun, Audit,
  Candidate, Appraisal, LeaveRequest, GLJournal, PaymentBatch, ExchangeRate, TimeClockDevice, PunchLog,
} = require('./models');
const {
  calcLine, hoursBetween, timeToMinutes, resolveMultiplier,
  calculateAttendanceMetrics, summarizeEmployeeAttendance,
  generateGLJournal, processBankPaymentSimulation, pairTimeClockPunches, CFG
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

// Helper to check if period is locked (FR-ATT-13)
async function isPeriodLocked(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return false;
  const p = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const run = await PayrollRun.findOne({ period: p }).lean();
  return run?.status === 'Approved';
}

// Helper to check time overlap (FR-ATT-03)
function timesOverlap(in1, out1, in2, out2) {
  const [h1, m1] = in1.split(':').map(Number);
  const [h2, m2] = out1.split(':').map(Number);
  const [h3, m3] = in2.split(':').map(Number);
  const [h4, m4] = out2.split(':').map(Number);

  let start1 = h1 * 60 + m1;
  let end1 = h2 * 60 + m2;
  if (end1 <= start1) end1 += 1440; // night shift

  let start2 = h3 * 60 + m3;
  let end2 = h4 * 60 + m4;
  if (end2 <= start2) end2 += 1440;

  return start1 < end2 && start2 < end1;
}

// ---- Attendance (FR-ATT-01 to FR-ATT-13) ----
app.get('/api/attendance', auth('payroll', 'approver', 'supervisor', 'hr', 'auditor'), wrap(async (req, res) => {
  const q = {};
  if (req.query.period && validPeriod(req.query.period)) {
    const [from, to] = periodRange(req.query.period);
    q.date = { $gte: from, $lt: to };
  }
  if (req.query.empId) q.empId = req.query.empId;
  res.json(await Attendance.find(q).sort('-date').limit(1000).lean());
}));

// FR-ATT-12: A period attendance summary per employee
app.get('/api/attendance/summary', auth('payroll', 'approver', 'supervisor', 'hr', 'auditor'), wrap(async (req, res) => {
  const { period, empId } = req.query;
  if (!period || !validPeriod(period)) return res.status(400).json({ error: 'Valid period (YYYY-MM) is required.' });

  const [from, to] = periodRange(period);
  const qAtt = { date: { $gte: from, $lt: to } };
  const qEmp = { status: { $in: ['Active', 'On Leave'] } };
  if (empId) {
    qAtt.empId = empId;
    qEmp.empId = empId;
  }

  const [employees, records, leaves] = await Promise.all([
    Employee.find(qEmp).sort('empId').lean(),
    Attendance.find(qAtt).lean(),
    LeaveRequest.find({
      status: 'Approved',
      startDate: { $lt: to },
      endDate: { $gte: from },
    }).lean(),
  ]);

  const attByEmp = {};
  for (const r of records) {
    (attByEmp[r.empId] ||= []).push(r);
  }

  const leaveByEmp = {};
  for (const l of leaves) {
    (leaveByEmp[l.empId] ||= []).push(l);
  }

  const summaries = employees.map((e) => {
    const summary = summarizeEmployeeAttendance(attByEmp[e.empId] || [], leaveByEmp[e.empId] || []);
    return {
      empId: e.empId,
      name: `${e.surname} ${e.firstName}`,
      department: e.department,
      period,
      ...summary,
    };
  });

  res.json(summaries);
}));

// FR-ATT-08: Unapproved OT exceptions report
app.get('/api/attendance/exceptions', auth('payroll', 'approver', 'supervisor', 'hr'), wrap(async (req, res) => {
  const { period } = req.query;
  const q = { approved: false, absent: false };
  if (period && validPeriod(period)) {
    const [from, to] = periodRange(period);
    q.date = { $gte: from, $lt: to };
  }
  const pending = await Attendance.find(q).sort('-date').lean();
  res.json({ count: pending.length, exceptions: pending });
}));

// FR-ATT-01, FR-ATT-03, FR-ATT-04, FR-ATT-05, FR-ATT-06, FR-ATT-07, FR-ATT-09, FR-ATT-11, FR-ATT-13
app.post('/api/attendance', auth('payroll', 'supervisor', 'admin'), wrap(async (req, res) => {
  const b = req.body;
  if (!b.date || isNaN(new Date(b.date).getTime())) return res.status(400).json({ error: 'Valid date is required.' });

  // FR-ATT-13: Locked period is read-only
  if (await isPeriodLocked(b.date)) {
    return res.status(409).json({ error: 'Attendance for an approved/locked payroll period is read-only.' });
  }

  if (!(await Employee.exists({ empId: b.empId, status: { $in: ['Active', 'On Leave'] } })))
    return res.status(400).json({ error: 'Employee not found or not active.' });

  if (b.absent) {
    // Record absent entry (FR-ATT-10)
    const attDate = new Date(b.date);
    const existing = await Attendance.findOne({ empId: b.empId, date: attDate, shift: b.shift || 'Day' });
    if (existing) return res.status(409).json({ error: 'Attendance entry already exists for this date and shift.' });

    const a = await Attendance.create({
      empId: b.empId,
      date: attDate,
      shift: b.shift || 'Day',
      clockIn: '00:00',
      clockOut: '00:00',
      breakHours: 0,
      hoursWorked: 0,
      absent: true,
      absentReason: b.absentReason || 'Absence recorded',
      approved: true,
      createdBy: req.user.name,
      approvedBy: req.user.name,
    });
    await log(req, 'record_absent', 'Attendance', a._id, { empId: a.empId, date: a.date, reason: a.absentReason });
    return res.status(201).json(a);
  }

  if (!/^\d{2}:\d{2}$/.test(b.clockIn || '') || !/^\d{2}:\d{2}$/.test(b.clockOut || ''))
    return res.status(400).json({ error: 'Clock times must be HH:MM.' });

  const attDate = new Date(b.date);

  // FR-ATT-03: Reject duplicate or overlapping entries for same employee and time range
  const sameDayEntries = await Attendance.find({
    empId: b.empId,
    date: {
      $gte: new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate())),
      $lt: new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate() + 1)),
    },
    absent: false,
  }).lean();

  for (const ex of sameDayEntries) {
    if (ex.shift === b.shift) {
      return res.status(409).json({ error: 'An attendance record already exists for this shift on this date.' });
    }
    if (timesOverlap(ex.clockIn, ex.clockOut, b.clockIn, b.clockOut)) {
      return res.status(409).json({ error: `Overlapping attendance time range with shift ${ex.shift} (${ex.clockIn}-${ex.clockOut}).` });
    }
  }

  const metrics = calculateAttendanceMetrics({
    shift: b.shift,
    clockIn: b.clockIn,
    clockOut: b.clockOut,
    breakHours: b.breakHours,
    appliedMultiplier: b.appliedMultiplier,
  });

  if (metrics.hoursWorked <= 0 || metrics.hoursWorked > 24)
    return res.status(400).json({ error: 'Hours worked must be between 0 and 24.' });

  // FR-ATT-09: Overtime warning if max daily OT exceeded
  const otHoursTotal = metrics.otHours + metrics.weekendOt + metrics.holidayOt;
  const otCapped = otHoursTotal > CFG.MAX_DAILY_OT;

  const a = await Attendance.create({
    ...b,
    date: attDate,
    ...metrics,
    otCapped,
    approved: false,
    createdBy: req.user.name,
  });

  await log(req, 'create', 'Attendance', a._id, { empId: a.empId, date: a.date, hoursWorked: a.hoursWorked, otHours: a.otHours, otCapped });
  res.status(201).json(a);
}));

// FR-ATT-02: Bulk attendance entry / update
app.post('/api/attendance/bulk', auth('payroll', 'supervisor', 'admin'), wrap(async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ error: 'Entries must be a non-empty array.' });
  }

  const results = { created: 0, errors: [] };

  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    const rowNum = i + 1;
    try {
      if (!item.empId || !item.date || !item.shift || !item.clockIn || !item.clockOut) {
        throw new Error('Missing required fields (empId, date, shift, clockIn, clockOut)');
      }
      if (await isPeriodLocked(item.date)) {
        throw new Error('Payroll period for this date is locked');
      }
      if (!(await Employee.exists({ empId: item.empId, status: { $in: ['Active', 'On Leave'] } }))) {
        throw new Error(`Employee ${item.empId} is not active`);
      }
      const attDate = new Date(item.date);
      const sameDayEntries = await Attendance.find({
        empId: item.empId,
        date: {
          $gte: new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate())),
          $lt: new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate() + 1)),
        },
        absent: false,
      }).lean();

      for (const ex of sameDayEntries) {
        if (ex.shift === item.shift || timesOverlap(ex.clockIn, ex.clockOut, item.clockIn, item.clockOut)) {
          throw new Error(`Overlapping or duplicate shift on date ${item.date}`);
        }
      }

      const metrics = calculateAttendanceMetrics(item);
      await Attendance.create({
        ...item,
        date: attDate,
        ...metrics,
        approved: false,
        createdBy: req.user.name,
        source: 'bulk',
      });
      results.created += 1;
    } catch (err) {
      results.errors.push({ row: rowNum, empId: item.empId, error: err.message });
    }
  }

  await log(req, 'bulk_create', 'Attendance', 'bulk', { count: results.created, errorCount: results.errors.length });
  res.json({ message: `Processed ${entries.length} rows. Created ${results.created}.`, ...results });
}));

// FR-ATT-02: Import from CSV time-clock export with row-level error reporting
app.post('/api/attendance/import', auth('payroll', 'supervisor', 'admin'), wrap(async (req, res) => {
  const { csvData } = req.body;
  if (!csvData || typeof csvData !== 'string') {
    return res.status(400).json({ error: 'csvData string is required.' });
  }

  const lines = csvData.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV must contain at least a header and one data row.' });
  }

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1);

  const results = { imported: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // accounting for 1-based index and header
    const values = rows[i].split(',').map((v) => v.trim());
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx]; });

    const empId = obj['empid'] || obj['emp_id'] || obj['employee id'];
    const date = obj['date'];
    const shift = obj['shift'] || 'Day';
    const clockIn = obj['clockin'] || obj['clock_in'] || obj['in'];
    const clockOut = obj['clockout'] || obj['clock_out'] || obj['out'];
    const breakHours = Number(obj['breakhours'] || obj['break_hours'] || 0);

    try {
      if (!empId || !date || !clockIn || !clockOut) {
        throw new Error('Missing mandatory columns (EmpID, Date, ClockIn, ClockOut)');
      }
      if (await isPeriodLocked(date)) {
        throw new Error(`Date ${date} falls into an approved and locked payroll period`);
      }
      if (!(await Employee.exists({ empId, status: { $in: ['Active', 'On Leave'] } }))) {
        throw new Error(`Employee ${empId} not found or not active`);
      }
      if (!/^\d{2}:\d{2}$/.test(clockIn) || !/^\d{2}:\d{2}$/.test(clockOut)) {
        throw new Error('Clock times must follow HH:MM format');
      }

      const attDate = new Date(date);
      const sameDay = await Attendance.find({
        empId,
        date: {
          $gte: new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate())),
          $lt: new Date(Date.UTC(attDate.getUTCFullYear(), attDate.getUTCMonth(), attDate.getUTCDate() + 1)),
        },
        absent: false,
      }).lean();

      for (const ex of sameDay) {
        if (ex.shift === shift || timesOverlap(ex.clockIn, ex.clockOut, clockIn, clockOut)) {
          throw new Error(`Duplicate or overlapping shift ${shift} with existing entry (${ex.clockIn}-${ex.clockOut})`);
        }
      }

      const metrics = calculateAttendanceMetrics({ shift, clockIn, clockOut, breakHours });
      await Attendance.create({
        empId,
        date: attDate,
        shift,
        clockIn,
        clockOut,
        breakHours,
        ...metrics,
        source: 'csv_import',
        approved: false,
        createdBy: req.user.name,
      });
      results.imported += 1;
    } catch (err) {
      results.errors.push({ row: rowNum, empId: empId || 'Unknown', error: err.message });
    }
  }

  await log(req, 'csv_import', 'Attendance', 'import', { count: results.imported, errors: results.errors.length });
  res.json({ message: `CSV import completed: ${results.imported} rows imported, ${results.errors.length} failed.`, ...results });
}));

// FR-ATT-08: Supervisor approval with segregation of duties (cannot approve own entry)
app.post('/api/attendance/:id/approve', auth('approver', 'supervisor'), wrap(async (req, res) => {
  const a = await Attendance.findById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Entry not found.' });

  // FR-ATT-13: Locked period is read-only
  if (await isPeriodLocked(a.date)) {
    return res.status(409).json({ error: 'Attendance for an approved/locked payroll period is read-only.' });
  }

  // Segregation of duties: Creator cannot approve their own entry
  if (a.createdBy === req.user.name) {
    return res.status(403).json({ error: 'You cannot approve attendance you recorded yourself.' });
  }

  a.approved = true;
  a.approvedBy = req.user.name;
  await a.save();

  await log(req, 'approve', 'Attendance', a._id, { empId: a.empId, date: a.date });
  res.json(a);
}));

// FR-ATT-10: Auto-absent generation for scheduled working days with no attendance & no approved leave
app.post('/api/attendance/auto-absent', auth('payroll', 'supervisor', 'admin'), wrap(async (req, res) => {
  const { date } = req.body;
  if (!date || isNaN(new Date(date).getTime())) return res.status(400).json({ error: 'Valid date is required.' });

  if (await isPeriodLocked(date)) {
    return res.status(409).json({ error: 'Attendance for an approved/locked payroll period is read-only.' });
  }

  const targetDate = new Date(date);
  const startOfDay = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate()));
  const endOfDay = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate() + 1));

  const dayOfWeek = startOfDay.getUTCDay(); // 0 is Sunday, 6 is Saturday
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return res.json({ message: 'Selected date is a weekend; automatic absence applies only to scheduled working days.', count: 0 });
  }

  const [activeEmps, presentAtt, approvedLeaves] = await Promise.all([
    Employee.find({ status: 'Active' }).lean(),
    Attendance.find({ date: { $gte: startOfDay, $lt: endOfDay } }).lean(),
    LeaveRequest.find({
      status: 'Approved',
      startDate: { $lte: endOfDay },
      endDate: { $gte: startOfDay },
    }).lean(),
  ]);

  const presentEmpIds = new Set(presentAtt.map((x) => x.empId));
  const leaveEmpIds = new Set(approvedLeaves.map((x) => x.empId));

  let absentCreated = 0;
  for (const emp of activeEmps) {
    if (!presentEmpIds.has(emp.empId) && !leaveEmpIds.has(emp.empId)) {
      await Attendance.create({
        empId: emp.empId,
        date: startOfDay,
        shift: 'Day',
        clockIn: '00:00',
        clockOut: '00:00',
        breakHours: 0,
        hoursWorked: 0,
        absent: true,
        absentReason: 'Unexcused absence - no attendance or approved leave record',
        approved: true,
        createdBy: 'auto_absent_scheduler',
        approvedBy: req.user.name,
        source: 'auto_absent',
      });
      absentCreated += 1;
    }
  }

  await log(req, 'auto_absent', 'Attendance', date, { count: absentCreated });
  res.json({ message: `Generated ${absentCreated} absence records for ${date}`, count: absentCreated });
}));

// Supervisor override of absent record (FR-ATT-10)
app.put('/api/attendance/:id/override-absent', auth('approver', 'supervisor'), wrap(async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Override reason is required.' });

  const a = await Attendance.findById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Attendance entry not found.' });
  if (await isPeriodLocked(a.date)) {
    return res.status(409).json({ error: 'Attendance for an approved/locked payroll period is read-only.' });
  }

  a.absentReason = reason;
  a.approvedBy = req.user.name;
  await a.save();

  await log(req, 'override_absent', 'Attendance', a._id, { empId: a.empId, reason });
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
