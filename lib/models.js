const mongoose = require('mongoose');
const { Schema } = mongoose;
const M = (n, s) => mongoose.models[n] || mongoose.model(n, s);

const User = M('User', new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9._-]{3,30}$/ },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ['admin', 'hr', 'payroll', 'approver', 'supervisor', 'executive', 'auditor', 'tax_advisor', 'employee'], required: true },
  empId: { type: String, trim: true }, // Links self-service users to their Employee record
  passwordHash: { type: String, required: true, select: false },
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: true },
  failedLogins: { type: Number, default: 0 }, lockUntil: Date,
  tokenVersion: { type: Number, default: 0 }, lastLogin: Date,
}, { timestamps: true }));

const PayComponentSchema = new Schema({
  name: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 },
  taxable: { type: Boolean, default: true },
  pensionable: { type: Boolean, default: true },
  recurring: { type: Boolean, default: true },
}, { _id: false });

const SalaryHistorySchema = new Schema({
  effectiveDate: { type: Date, required: true },
  basic: { type: Number, required: true, min: 0 },
  housing: { type: Number, default: 0, min: 0 },
  transport: { type: Number, default: 0, min: 0 },
  otherAllowance: { type: Number, default: 0, min: 0 },
  hourlyRate: { type: Number, min: 0 },
  reason: { type: String, default: 'Initial salary' },
  changedBy: String,
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const Employee = M('Employee', new Schema({
  empId: { type: String, required: true, unique: true, trim: true },
  surname: { type: String, required: true }, firstName: { type: String, required: true },
  department: String, position: String, hireDate: Date, terminationDate: Date,
  country: { type: String, default: 'NG' }, // Multi-country: NG, GH, KE, etc.
  currency: { type: String, default: 'NGN' }, // Multi-currency: NGN, GHS, KES, USD
  basic: { type: Number, required: true, min: 0 },
  housing: { type: Number, default: 0, min: 0 }, transport: { type: Number, default: 0, min: 0 },
  otherAllowance: { type: Number, default: 0, min: 0 },
  hourlyRate: { type: Number, min: 0 },
  hourlyRateOverrideReason: String,
  pensionPct: { type: Number, default: 0.08, min: 0, max: 1 },
  nhfEnrolled: { type: Boolean, default: true }, nhfPct: { type: Number, default: 0.025 },
  annualRent: { type: Number, default: 0, min: 0 },
  rentEvidenceRef: String,
  bank: String, bankCode: String, accountNo: { type: String, index: true },
  employmentType: { type: String, enum: ['Permanent', 'Contract', 'Casual'], default: 'Permanent' },
  payFrequency: { type: String, enum: ['Monthly', 'Weekly', 'Bi-Weekly'], default: 'Monthly' },
  state: String, tin: String, pensionPin: String, pfa: String, nhfNumber: String,
  dob: Date, phone: String, email: String, emergencyContact: String,
  status: { type: String, enum: ['Active', 'On Leave', 'Suspended', 'Terminated'], default: 'Active' },
  payComponents: [PayComponentSchema],
  salaryHistory: [SalaryHistorySchema],
}, { timestamps: true }));

const attendanceSchema = new Schema({
  empId: { type: String, required: true, index: true },
  date: { type: Date, required: true },
  shift: { type: String, enum: ['Day', 'Night', 'Weekend', 'Holiday'], required: true },
  clockIn: { type: String, match: /^\d{2}:\d{2}$/ },
  clockOut: { type: String, match: /^\d{2}:\d{2}$/ },
  breakHours: { type: Number, default: 0 },
  hoursWorked: { type: Number, default: 0 },
  otHours: { type: Number, default: 0 },
  weekendOT: { type: Number, default: 0 },
  holidayOT: { type: Number, default: 0 },
  multiplier: { type: Number, default: 1.0 },
  absent: { type: Boolean, default: false },
  absentReason: String,
  supervisorOverrideReason: String,
  lateMinutes: { type: Number, default: 0 },
  earlyDepartureMinutes: { type: Number, default: 0 },
  otExceededWarning: String,
  source: { type: String, default: 'manual' }, // manual, timeclock, auto-absent
  deviceId: String,
  approved: { type: Boolean, default: false }, approvedBy: String, createdBy: String,
}, { timestamps: true });
attendanceSchema.index({ empId: 1, date: 1, shift: 1 }, { unique: true });
attendanceSchema.path('shift').enumValues = ['Day', 'Night', 'Weekend', 'Holiday'];
const Attendance = M('Attendance', attendanceSchema);

// Shift Configuration / Rules Model (FR-SHF-01 to FR-SHF-05)
const ShiftHistorySchema = new Schema({
  effectiveDate: { type: Date, required: true },
  stdHours: { type: Number, required: true, min: 1, max: 24 },
  multiplier: { type: Number, required: true, min: 1.0 },
  startTime: { type: String, default: '08:00' },
  endTime: { type: String, default: '17:00' },
  unpaidBreakHours: { type: Number, default: 1 },
  changedBy: String,
  reason: String,
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const shiftSetupSchema = new Schema({
  shift: { type: String, required: true, unique: true, trim: true }, // Day, Night, Weekend, Holiday, or user-defined (FR-SHF-01)
  stdHours: { type: Number, required: true, min: 1, max: 24, default: 8 },
  multiplier: { type: Number, required: true, min: 1.0, default: 1.5 },
  startTime: { type: String, default: '08:00' },
  endTime: { type: String, default: '17:00' },
  unpaidBreakHours: { type: Number, default: 1 },
  effectiveDate: { type: Date, default: Date.now },
  history: [ShiftHistorySchema],
}, { timestamps: true });
const ShiftSetup = M('ShiftSetup', shiftSetupSchema);

// Public Holiday Calendar Model (FR-SHF-04)
const PublicHoliday = M('PublicHoliday', new Schema({
  date: { type: Date, required: true, unique: true },
  name: { type: String, required: true },
}, { timestamps: true }));

const Loan = M('Loan', new Schema({
  loanId: { type: String, unique: true, sparse: true, trim: true },
  empId: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  termMonths: { type: Number, required: true, min: 1 },
  startDate: { type: Date },
  startPeriod: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  interestRate: { type: Number, default: 0, min: 0 }, // e.g. 0.05 for 5% flat or per-annum
  interestType: { type: String, enum: ['none', 'flat', 'monthly'], default: 'none' },
  monthly: Number,
  outstanding: Number,
  currency: { type: String, default: 'NGN' },
  status: { type: String, enum: ['Pending', 'Active', 'Closed', 'Rejected', 'Suspended'], default: 'Pending' },
  holidayPeriods: [{ type: String, match: /^\d{4}-\d{2}$/ }], // Instalment holiday periods (no deduction)
  changeRequests: [{
    type: { type: String, enum: ['topup', 'early_settlement', 'restructure', 'holiday'], required: true },
    details: Schema.Types.Mixed,
    requestedBy: String,
    requestedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    approvedBy: String,
    approvedAt: Date,
    rejectionReason: String,
  }],
  flaggedForFinalRecovery: { type: Boolean, default: false },
  createdBy: String,
  approvedBy: String,
}, { timestamps: true }));

// FR-LN-04: Repayment Ledger lines
const RepaymentLedger = M('RepaymentLedger', new Schema({
  loanId: { type: String, required: true, index: true },
  empId: { type: String, required: true, index: true },
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
  amountDeducted: { type: Number, required: true, min: 0 },
  balanceBefore: { type: Number },
  balanceAfter: { type: Number, required: true, min: 0 },
  type: { type: String, enum: ['payroll', 'early_settlement', 'manual'], default: 'payroll' },
  payrollRunId: String,
  approvedBy: String,
  timestamp: { type: Date, default: Date.now },
}, { timestamps: true }));

// FR-LN-09: Deductions Register for recurring or one-off deductions
const DeductionRegister = M('DeductionRegister', new Schema({
  empId: { type: String, required: true, index: true },
  type: {
    type: String,
    required: true,
    enum: ['cooperative', 'union_dues', 'damages', 'salary_advance', 'other'],
  },
  title: { type: String, trim: true },
  amount: { type: Number, required: true, min: 0.01 },
  recurring: { type: Boolean, default: false },
  startPeriod: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  endPeriod: { type: String, match: /^\d{4}-\d{2}$/ },
  currency: { type: String, default: 'NGN' },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Inactive'], default: 'Pending' },
  createdBy: String,
  approvedBy: String,
  approvedAt: Date,
  reason: String,
}, { timestamps: true }));

// Bonuses and Allowances (FR-BON-01 to FR-BON-06)
const BonusRegister = M('BonusRegister', new Schema({
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
  empId: { type: String, required: true, index: true },
  performanceBonus: { type: Number, default: 0, min: 0 },
  productionBonus: { type: Number, default: 0, min: 0 },
  attendanceBonus: { type: Number, default: 0, min: 0 },
  otherBonus: { type: Number, default: 0, min: 0 },
  otherBonusDescription: { type: String, trim: true },
  totalBonuses: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'NGN' },
  flags: {
    performance: {
      taxable: { type: Boolean, default: true },
      pensionable: { type: Boolean, default: false },
    },
    production: {
      taxable: { type: Boolean, default: true },
      pensionable: { type: Boolean, default: false },
    },
    attendance: {
      taxable: { type: Boolean, default: true },
      pensionable: { type: Boolean, default: false },
    },
    other: {
      taxable: { type: Boolean, default: true },
      pensionable: { type: Boolean, default: false },
    },
  },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  createdBy: String,
  approvedBy: String,
  approvedAt: Date,
  autoSuggested: { type: Boolean, default: false },
  source: { type: String, default: 'manual' }, // manual, auto_attendance, production_import
  comments: String,
}, { timestamps: true }));

// FR-BON-06: AllowanceRegister for one-off and recurring allowances
const AllowanceRegister = M('AllowanceRegister', new Schema({
  empId: { type: String, required: true, index: true },
  type: {
    type: String,
    required: true,
    enum: ['shift_allowance', 'hazard', 'meal', 'other'],
  },
  title: { type: String, trim: true },
  amount: { type: Number, required: true, min: 0.01 },
  recurring: { type: Boolean, default: false },
  startPeriod: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  endPeriod: { type: String, match: /^\d{4}-\d{2}$/ },
  currency: { type: String, default: 'NGN' },
  taxable: { type: Boolean, default: true },
  pensionable: { type: Boolean, default: false },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Inactive'], default: 'Pending' },
  createdBy: String,
  approvedBy: String,
  approvedAt: Date,
  reason: String,
}, { timestamps: true }));

// Bonuses, one-off earnings and other deductions (absence, damages, advances, arrears, back-pay)
const Adjustment = M('Adjustment', new Schema({
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
  empId: { type: String, required: true },
  type: { type: String, enum: ['bonus', 'earning', 'deduction'], required: true },
  subtype: { type: String, enum: ['general', 'arrears', 'back_pay', 'bonus', 'absence', 'damage', 'advance', 'other'], default: 'general' },
  priorPeriod: { type: String, match: /^\d{4}-\d{2}$/ },
  amount: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true },
  currency: { type: String, default: 'NGN' },
  approved: { type: Boolean, default: false }, approvedBy: String, createdBy: String,
}, { timestamps: true }));

// FR-INP-01: States: Open -> Inputs Frozen -> Calculated -> Under Review -> Approved -> Paid/Locked
// Draft is retained in enum for backward compatibility with existing tests
const PAYROLL_PERIOD_STATES = ['Open', 'Inputs Frozen', 'Calculated', 'Under Review', 'Approved', 'Paid/Locked', 'Draft'];

const payrollInputSchema = new Schema({
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
  empId: { type: String, required: true },
  name: String,
  department: String,
  position: String,
  basicSalary: { type: Number, default: 0 },
  otPay: { type: Number, default: 0 },
  allowances: { type: Number, default: 0 },
  bonuses: { type: Number, default: 0 },
  loanDeduction: { type: Number, default: 0 },
  otherDeductions: { type: Number, default: 0 },
  currency: { type: String, default: 'NGN' },
  assembledAt: { type: Date, default: Date.now },
  assembledBy: String,
  details: Schema.Types.Mixed,
}, { timestamps: true });
payrollInputSchema.index({ period: 1, empId: 1 }, { unique: true });
const PayrollInput = M('PayrollInput', payrollInputSchema);

const PayrollRun = M('PayrollRun', new Schema({
  period: { type: String, required: true, unique: true },
  status: { type: String, enum: PAYROLL_PERIOD_STATES, default: 'Draft' },
  preparedBy: String, approvedBy: String, approvedAt: Date,
  lines: [Schema.Types.Mixed], warnings: [String],
  inputs: [Schema.Types.Mixed],
  exceptions: [Schema.Types.Mixed],
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

// 3. Leave Management (FR-LV-01 to FR-LV-07)
const LeaveRequest = M('LeaveRequest', new Schema({
  empId: { type: String, required: true, index: true },
  leaveType: {
    type: String,
    enum: ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'],
    required: true,
  },
  payTreatment: {
    type: String,
    enum: ['paid', 'partially_paid', 'unpaid', 'policy_based'],
    default: 'paid',
  },
  paidPercentage: { type: Number, default: 1.0, min: 0, max: 1.0 },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  days: { type: Number, required: true, min: 1 },
  leaveYear: { type: Number, default: () => new Date().getFullYear() },
  reason: String,
  overrideReason: String, // HR / supervisor override if exceeding balance
  isOverridden: { type: Boolean, default: false },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected', 'Cancelled'], default: 'Pending' },
  approvedBy: String,
  approvedAt: Date,
  comments: String,
  leaveAllowanceRequested: { type: Boolean, default: false },
  leaveAllowancePaid: { type: Boolean, default: false },
  leaveAllowanceAmount: { type: Number, default: 0 },
}, { timestamps: true }));

// FR-LV-06: Leave Balances per employee per leave year
const leaveBalanceSchema = new Schema({
  empId: { type: String, required: true, index: true },
  year: { type: Number, required: true, index: true },
  leaveType: {
    type: String,
    enum: ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'],
    required: true,
  },
  entitlement: { type: Number, required: true, default: 0, min: 0 },
  used: { type: Number, default: 0, min: 0 },
  pending: { type: Number, default: 0, min: 0 },
  carryOver: { type: Number, default: 0, min: 0 },
}, { timestamps: true });
leaveBalanceSchema.index({ empId: 1, year: 1, leaveType: 1 }, { unique: true });
const LeaveBalance = M('LeaveBalance', leaveBalanceSchema);

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
  status: { type: String, enum: ['Initiated', 'Pending_Dual_Approval', 'Processing', 'Completed', 'Failed'], default: 'Pending_Dual_Approval' },
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
  approvedBy: String,
  approvedAt: Date,
  dualApprovalRequired: { type: Boolean, default: true },
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

// 8. Bank Transfer Schedule (FR-BNK-01 to FR-BNK-06)
const BankSchedule = M('BankSchedule', new Schema({
  scheduleId: { type: String, required: true, unique: true },
  period: { type: String, required: true, index: true },
  version: { type: Number, default: 1 },
  narration: { type: String, required: true },
  payableHeadcount: { type: Number, required: true },
  controlTotal: { type: Number, required: true },
  registerNetTotal: { type: Number, required: true },
  registerPayableHeadcount: { type: Number, required: true },
  isBalanced: { type: Boolean, default: true },
  templateKey: { type: String, default: 'GENERIC_BANK' },
  items: [{
    empId: String,
    name: String,
    bank: String,
    bankCode: String,
    accountNo: String,
    netPay: Number,
    narration: String,
    paymentStatus: { type: String, enum: ['Pending', 'Success', 'Failed', 'Paid'], default: 'Pending' },
    reconciliationNote: String,
    reconciledAt: Date,
    reconciledBy: String,
  }],
  exceptions: [{
    empId: String,
    name: String,
    bank: String,
    accountNo: String,
    netPay: Number,
    reasons: [String],
  }],
  generatedBy: String,
  status: { type: String, enum: ['Generated', 'Reconciled', 'Partial_Reconciled', 'Archived'], default: 'Generated' },
}, { timestamps: true }));

module.exports = {
  User, Employee, Attendance, ShiftSetup, PublicHoliday, Loan, RepaymentLedger, DeductionRegister,
  BonusRegister, AllowanceRegister,
  Adjustment, PayrollRun, PayrollInput, PAYROLL_PERIOD_STATES, Audit, Candidate, Appraisal, LeaveRequest, LeaveBalance, GLJournal, PaymentBatch,
  ExchangeRate, TimeClockDevice, PunchLog, BankSchedule,
};
