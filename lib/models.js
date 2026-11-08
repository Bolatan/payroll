const mongoose = require('mongoose');
const { Schema } = mongoose;
const M = (n, s) => mongoose.models[n] || mongoose.model(n, s);

const User = M('User', new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9._-]{3,30}$/ },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ['admin', 'hr', 'payroll', 'approver', 'supervisor', 'executive', 'auditor', 'tax_advisor', 'employee'], required: true },
  empId: { type: String, trim: true },
  passwordHash: { type: String, required: true, select: false },
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: true },
  failedLogins: { type: Number, default: 0 }, lockUntil: Date,
  tokenVersion: { type: Number, default: 0 }, lastLogin: Date,
}, { timestamps: true }));

const Employee = M('Employee', new Schema({
  empId: { type: String, required: true, unique: true, trim: true },
  surname: { type: String, required: true }, firstName: { type: String, required: true },
  department: String, position: String, hireDate: Date,
  basic: { type: Number, required: true, min: 0 },
  housing: { type: Number, default: 0, min: 0 }, transport: { type: Number, default: 0, min: 0 },
  otherAllowance: { type: Number, default: 0, min: 0 },
  hourlyRate: { type: Number, min: 0 },
  pensionPct: { type: Number, default: 0.08, min: 0, max: 1 },
  nhfEnrolled: { type: Boolean, default: true }, nhfPct: { type: Number, default: 0.025 },
  annualRent: { type: Number, default: 0, min: 0 },
  bank: String, accountNo: { type: String, match: /^\d{10}$/ },
  state: String, tin: String, pensionPin: String,
  status: { type: String, enum: ['Active', 'On Leave', 'Suspended', 'Terminated'], default: 'Active' },
}, { timestamps: true }));

const attendanceSchema = new Schema({
  empId: { type: String, required: true, index: true },
  date: { type: Date, required: true },
  shift: { type: String, enum: ['Day', 'Night', 'Weekend', 'Holiday'], required: true },
  clockIn: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
  clockOut: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
  breakHours: { type: Number, default: 0 },
  hoursWorked: Number,
  approved: { type: Boolean, default: false }, approvedBy: String, createdBy: String,
}, { timestamps: true });
attendanceSchema.index({ empId: 1, date: 1, shift: 1 }, { unique: true });
const Attendance = M('Attendance', attendanceSchema);

const Loan = M('Loan', new Schema({
  empId: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 1 }, termMonths: { type: Number, required: true, min: 1 },
  startPeriod: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  monthly: Number, outstanding: Number,
  status: { type: String, enum: ['Pending', 'Active', 'Closed'], default: 'Pending' },
  createdBy: String, approvedBy: String,
}, { timestamps: true }));

// Bonuses, one-off earnings and other deductions (absence, damages, advances)
const Adjustment = M('Adjustment', new Schema({
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
  empId: { type: String, required: true },
  type: { type: String, enum: ['bonus', 'earning', 'deduction'], required: true },
  amount: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true },
  approved: { type: Boolean, default: false }, approvedBy: String, createdBy: String,
}, { timestamps: true }));

const PayrollRun = M('PayrollRun', new Schema({
  period: { type: String, required: true, unique: true },
  status: { type: String, enum: ['Draft', 'Approved'], default: 'Draft' },
  preparedBy: String, approvedBy: String, approvedAt: Date,
  lines: [Schema.Types.Mixed], warnings: [String],
  totals: Schema.Types.Mixed,
}, { timestamps: true }));

// Append-only: updates and deletes are blocked at the model level
const auditSchema = new Schema({
  ts: { type: Date, default: Date.now }, user: String, action: String, entity: String, entityId: String, details: Schema.Types.Mixed,
});
['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'].forEach((op) =>
  auditSchema.pre(op, function () { throw new Error('Audit log is append-only'); }));
const Audit = M('Audit', auditSchema);

module.exports = { User, Employee, Attendance, Loan, Adjustment, PayrollRun, Audit };
