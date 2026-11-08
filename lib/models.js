const mongoose = require('mongoose');
const { Schema } = mongoose;
const M = (n, s) => mongoose.models[n] || mongoose.model(n, s);

const User = M('User', new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9._-]{3,30}$/ },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ['admin', 'hr', 'payroll', 'approver', 'employee'], required: true },
  empId: { type: String, trim: true }, // Links self-service users to their Employee record
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
  country: { type: String, default: 'NG' }, // Multi-country: NG, GH, KE, etc.
  currency: { type: String, default: 'NGN' }, // Multi-currency: NGN, GHS, KES, USD
  basic: { type: Number, required: true, min: 0 },
  housing: { type: Number, default: 0, min: 0 }, transport: { type: Number, default: 0, min: 0 },
  otherAllowance: { type: Number, default: 0, min: 0 },
  hourlyRate: { type: Number, min: 0 },
  pensionPct: { type: Number, default: 0.08, min: 0, max: 1 },
  nhfEnrolled: { type: Boolean, default: true }, nhfPct: { type: Number, default: 0.025 },
  annualRent: { type: Number, default: 0, min: 0 },
  bank: String, accountNo: { type: String },
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
  source: { type: String, default: 'manual' }, // manual, timeclock
  deviceId: String,
  approved: { type: Boolean, default: false }, approvedBy: String, createdBy: String,
}, { timestamps: true });
attendanceSchema.index({ empId: 1, date: 1, shift: 1 }, { unique: true });
const Attendance = M('Attendance', attendanceSchema);

const Loan = M('Loan', new Schema({
  empId: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 1 }, termMonths: { type: Number, required: true, min: 1 },
  startPeriod: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  monthly: Number, outstanding: Number,
  currency: { type: String, default: 'NGN' },
  status: { type: String, enum: ['Pending', 'Active', 'Closed', 'Rejected'], default: 'Pending' },
  createdBy: String, approvedBy: String,
}, { timestamps: true }));

// Bonuses, one-off earnings and other deductions (absence, damages, advances)
const Adjustment = M('Adjustment', new Schema({
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
  empId: { type: String, required: true },
  type: { type: String, enum: ['bonus', 'earning', 'deduction'], required: true },
  amount: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true },
  currency: { type: String, default: 'NGN' },
  approved: { type: Boolean, default: false }, approvedBy: String, createdBy: String,
}, { timestamps: true }));

const PayrollRun = M('PayrollRun', new Schema({
  period: { type: String, required: true, unique: true },
  status: { type: String, enum: ['Draft', 'Approved'], default: 'Draft' },
  preparedBy: String, approvedBy: String, approvedAt: Date,
  lines: [Schema.Types.Mixed], warnings: [String],
  totals: Schema.Types.Mixed,
  glPosted: { type: Boolean, default: false },
  glJournalId: String,
  bankPaymentInitiated: { type: Boolean, default: false },
  paymentReference: String,
}, { timestamps: true }));

// Append-only: updates and deletes are blocked at the model level
const auditSchema = new Schema({
  ts: { type: Date, default: Date.now }, user: String, action: String, entity: String, entityId: String, details: Schema.Types.Mixed,
});
['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'].forEach((op) =>
  auditSchema.pre(op, function () { throw new Error('Audit log is append-only'); }));
const Audit = M('Audit', auditSchema);

// ==========================================
// Extended Capabilities Models
// ==========================================

// 1. Recruitment & Onboarding
const Candidate = M('Candidate', new Schema({
  candidateId: { type: String, required: true, unique: true },
  fullName: { type: String, required: true },
  email: { type: String, required: true },
  phone: String,
  position: { type: String, required: true },
  department: { type: String, required: true },
  stage: { type: String, enum: ['Applied', 'Screening', 'Interviewing', 'Offered', 'Hired', 'Rejected'], default: 'Applied' },
  offeredSalary: Number,
  hireDate: Date,
  onboardingChecklist: [{ task: String, completed: { type: Boolean, default: false }, completedAt: Date }],
  createdEmployeeId: String,
  createdBy: String,
}, { timestamps: true }));

// 2. Performance Appraisal
const Appraisal = M('Appraisal', new Schema({
  empId: { type: String, required: true, index: true },
  cycle: { type: String, required: true }, // e.g. "2026-H1", "2026-Annual"
  rating: { type: Number, required: true, min: 1, max: 5 }, // 1-5 rating scale
  feedback: String,
  goals: [{ goal: String, weight: Number, score: Number }],
  bonusRecommendation: { type: Number, default: 0 },
  status: { type: String, enum: ['Draft', 'Submitted', 'Approved', 'Rejected'], default: 'Draft' },
  reviewer: String,
  approvedBy: String,
}, { timestamps: true }));

// 3. Employee Self-Service (Leave Requests & Inquiries)
const LeaveRequest = M('LeaveRequest', new Schema({
  empId: { type: String, required: true, index: true },
  leaveType: { type: String, enum: ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Unpaid'], required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  days: { type: Number, required: true, min: 1 },
  reason: String,
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  approvedBy: String,
  comments: String,
}, { timestamps: true }));

// 4. General-Ledger Journal Posting
const GLJournal = M('GLJournal', new Schema({
  journalNumber: { type: String, required: true, unique: true },
  period: { type: String, required: true, index: true },
  postDate: { type: Date, default: Date.now },
  description: String,
  currency: { type: String, default: 'NGN' },
  entries: [{
    accountCode: { type: String, required: true }, // e.g. 5001 Wages Expense
    accountName: { type: String, required: true },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
  }],
  totalDebit: { type: Number, required: true },
  totalCredit: { type: Number, required: true },
  postedBy: String,
  status: { type: String, enum: ['Draft', 'Posted'], default: 'Posted' },
}, { timestamps: true }));

// 5. Direct Bank Payment Integration
const PaymentBatch = M('PaymentBatch', new Schema({
  batchReference: { type: String, required: true, unique: true },
  period: { type: String, required: true },
  channel: { type: String, default: 'NIBSS_INSTANT_PAY' }, // NIBSS, FLUTTERWAVE, PAYSTACK, INTERSWITCH
  currency: { type: String, default: 'NGN' },
  totalAmount: { type: Number, required: true },
  totalCount: { type: Number, required: true },
  successfulCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  status: { type: String, enum: ['Initiated', 'Processing', 'Completed', 'Failed'], default: 'Initiated' },
  transactions: [{
    empId: String,
    accountNo: String,
    bankCode: String,
    bankName: String,
    amount: Number,
    status: { type: String, enum: ['Pending', 'Success', 'Failed'], default: 'Pending' },
    gatewayTxId: String,
    message: String,
  }],
  initiatedBy: String,
}, { timestamps: true }));

// 6. Multi-Currency Exchange Rates
const ExchangeRate = M('ExchangeRate', new Schema({
  baseCurrency: { type: String, default: 'NGN' },
  targetCurrency: { type: String, required: true }, // USD, EUR, GHS, KES
  rate: { type: Number, required: true }, // 1 Target = rate Base
  effectiveDate: { type: Date, required: true },
}, { timestamps: true }));

// 7. Time-Clock Hardware Integration
const TimeClockDevice = M('TimeClockDevice', new Schema({
  deviceId: { type: String, required: true, unique: true },
  name: { type: String, required: true }, // e.g. Factory Gate A Biometric Reader
  ipAddress: String,
  location: String,
  apiKey: String,
  active: { type: Boolean, default: true },
  lastSyncAt: Date,
}, { timestamps: true }));

const PunchLog = M('PunchLog', new Schema({
  deviceId: { type: String, required: true, index: true },
  empId: { type: String, required: true, index: true },
  timestamp: { type: Date, required: true },
  punchType: { type: String, enum: ['IN', 'OUT'], required: true },
  verificationType: { type: String, enum: ['Fingerprint', 'Face', 'Card', 'PIN'], default: 'Fingerprint' },
  processed: { type: Boolean, default: false },
  attendanceId: String,
}, { timestamps: true }));

module.exports = {
  User, Employee, Attendance, Loan, Adjustment, PayrollRun, Audit,
  Candidate, Appraisal, LeaveRequest, GLJournal, PaymentBatch, ExchangeRate, TimeClockDevice, PunchLog,
};
