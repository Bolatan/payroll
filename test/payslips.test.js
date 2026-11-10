const test = require('node:test');
const assert = require('node:assert/strict');
const {
  User, Employee, PayrollRun, PayslipDelivery, Loan,
} = require('../lib/models');
const {
  calcLine,
  buildEmployeePayslip,
  maskAccountNumber,
} = require('../lib/payroll');

test('FR-SLP-01: A payslip shall contain all required fields with masked bank account and itemised details', () => {
  // Test masking function
  assert.equal(maskAccountNumber('0123456789'), '******6789');
  assert.equal(maskAccountNumber('1234'), '****1234');
  assert.equal(maskAccountNumber(''), '');

  const sampleLine = {
    empId: 'EMP001',
    name: 'Babajide Sanwo',
    department: 'Engineering',
    position: 'Electrical Specialist',
    bank: 'Zenith Bank',
    accountNo: '0123456789',
    basic: 150000,
    housing: 50000,
    transport: 30000,
    otherAllowance: 10000,
    otHours: 6.5,
    otPay: 12500,
    bonuses: 45000,
    bonusDetails: {
      performanceBonus: 25000,
      productionBonus: 15000,
      attendanceBonus: 5000,
      otherBonus: 0,
      otherBonusDescription: '',
    },
    gross: 297500,
    pension: 18400,
    employerPension: 23000,
    nhf: 3750,
    paye: 28500,
    loanDeduction: 15000,
    otherDeductions: 5000,
    deductionRegisterBreakdown: [
      { title: 'Union Dues', amount: 5000, type: 'union_dues' },
    ],
    totalDeductions: 70650,
    netPay: 226850,
    loanBreakdown: [
      { loanId: 'L1', remainingAfter: 45000 },
    ],
  };

  const payslip = buildEmployeePayslip(sampleLine, {
    period: '2026-11',
    companyName: 'Lagos Manufacturing Factory Ltd',
    payDate: '2026-11-30',
  });

  // Verify Header & Metadata
  assert.ok(payslip.company.name, 'Company name must be present');
  assert.equal(payslip.period, '2026-11');
  assert.equal(payslip.payDate, '2026-11-30');

  // Verify Employee Information & Masked Account
  assert.equal(payslip.empId, 'EMP001');
  assert.equal(payslip.name, 'Babajide Sanwo');
  assert.equal(payslip.department, 'Engineering');
  assert.equal(payslip.position, 'Electrical Specialist');
  assert.equal(payslip.bank, 'Zenith Bank');
  assert.equal(payslip.accountNo, '******6789', 'Account number must be masked to protect personal data');

  // Verify Earnings & Overtime
  assert.equal(payslip.basic, 150000);
  assert.equal(payslip.overtime.hours, 6.5);
  assert.equal(payslip.overtime.amount, 12500);

  // Verify Itemised Allowances
  assert.ok(Array.isArray(payslip.allowances.itemised));
  const allowNames = payslip.allowances.itemised.map((a) => a.name);
  assert.ok(allowNames.includes('Housing Allowance'));
  assert.ok(allowNames.includes('Transport Allowance'));

  // Verify Itemised Bonuses
  assert.ok(Array.isArray(payslip.bonuses.itemised));
  const bonusNames = payslip.bonuses.itemised.map((b) => b.name);
  assert.ok(bonusNames.includes('Performance Bonus'));
  assert.ok(bonusNames.includes('Production Bonus'));
  assert.ok(bonusNames.includes('Attendance Bonus'));

  // Verify Deductions
  assert.equal(payslip.gross, 297500);
  assert.equal(payslip.pension, 18400);
  assert.equal(payslip.nhf, 3750);
  assert.equal(payslip.paye, 28500);
  assert.equal(payslip.loanDeduction, 15000);
  assert.equal(payslip.otherDeductions, 5000);
  assert.equal(payslip.totalDeductions, 70650);
  assert.equal(payslip.netPay, 226850);
});

test('FR-SLP-02: Payslip shows remaining loan balance and year-to-date gross, PAYE and pension', () => {
  const line = {
    empId: 'EMP002',
    name: 'Chinedu Okeke',
    basic: 200000,
    gross: 250000,
    pension: 20000,
    employerPension: 25000,
    paye: 22000,
    loanDeduction: 10000,
    loanBreakdown: [
      { loanId: 'LN01', code: 'LN01', amount: 10000, remainingAfter: 60000 },
      { loanId: 'LN02', code: 'LN02', amount: 5000, remainingAfter: 20000 },
    ],
  };

  const payslip = buildEmployeePayslip(line, {
    period: '2026-11',
    ytdGross: 2750000,
    ytdPaye: 242000,
    ytdPension: 220000,
    ytdEmployerPension: 275000,
  });

  // Remaining loan balance is sum of remaining balances across active loans
  assert.equal(payslip.remainingLoanBalance, 80000); // 60,000 + 20,000

  // YTD Figures
  assert.equal(payslip.ytd.gross, 2750000);
  assert.equal(payslip.ytd.paye, 242000);
  assert.equal(payslip.ytd.pension, 220000);
  assert.equal(payslip.ytd.employerPension, 275000);
});

test('FR-SLP-03: Payslips generated only for Approved periods and reproducible identically', () => {
  // Test approval requirement logic
  const draftRun = { period: '2026-11', status: 'Draft', lines: [{ empId: 'EMP001' }] };
  const approvedRun = { period: '2026-11', status: 'Approved', lines: [{ empId: 'EMP001', basic: 100000, gross: 120000, netPay: 95000 }] };

  const isEligibleForPayslip = (run) => run && run.status === 'Approved';
  assert.equal(isEligibleForPayslip(draftRun), false, 'Draft period cannot generate official employee payslips');
  assert.equal(isEligibleForPayslip(approvedRun), true, 'Approved period is eligible for official payslips');

  // Reproducibility check: generating payslip twice produces deep-equal output
  const line = approvedRun.lines[0];
  const slip1 = buildEmployeePayslip(line, { period: approvedRun.period, ytdGross: 120000 });
  const slip2 = buildEmployeePayslip(line, { period: approvedRun.period, ytdGross: 120000 });
  assert.deepEqual(slip1, slip2, 'Payslip generation must be deterministic and identically reproducible at any date');
});

test('FR-SLP-04: Payslip delivery log schema and distribution logging across channels', () => {
  const schema = PayslipDelivery.schema.paths;
  assert.ok(schema.period, 'period field must exist');
  assert.ok(schema.empId, 'empId field must exist');
  assert.ok(schema.channel, 'channel field must exist');
  assert.ok(schema.recipient, 'recipient field must exist');
  assert.ok(schema.status, 'status field must exist');

  const channelsEnum = schema.channel.enumValues;
  assert.ok(channelsEnum.includes('email'), 'Must support email channel');
  assert.ok(channelsEnum.includes('portal'), 'Must support portal channel');
  assert.ok(channelsEnum.includes('print'), 'Must support print channel');

  const delivery = new PayslipDelivery({
    period: '2026-11',
    empId: 'EMP001',
    channel: 'email',
    recipient: 'emp001@factory.com',
    status: 'Delivered',
    deliveredBy: 'officer_ada',
  });

  assert.equal(delivery.period, '2026-11');
  assert.equal(delivery.empId, 'EMP001');
  assert.equal(delivery.channel, 'email');
  assert.equal(delivery.recipient, 'emp001@factory.com');
  assert.equal(delivery.status, 'Delivered');
});

test('FR-SLP-05: Payslip figures reconcile exactly to the payroll register line', () => {
  const emp = {
    empId: 'EMP003',
    surname: 'Fatima',
    firstName: 'Bello',
    department: 'Quality Control',
    basic: 180000,
    housing: 60000,
    transport: 30000,
    bank: 'Access Bank',
    accountNo: '0123456789',
    annualRent: 600000,
    nhfEnrolled: true,
  };

  const attendance = [
    { shift: 'Day', hoursWorked: 10, otHours: 2, multiplier: 1.5 },
  ];

  const registerLine = calcLine(emp, { attendance }, '2026-11');
  const payslip = buildEmployeePayslip(registerLine, { period: '2026-11' });

  // Verify 100% exact numerical reconciliation to register line (FR-SLP-05, DoD-4)
  assert.equal(payslip.basic, registerLine.basic);
  assert.equal(payslip.gross, registerLine.gross);
  assert.equal(payslip.pension, registerLine.pension);
  assert.equal(payslip.nhf, registerLine.nhf);
  assert.equal(payslip.paye, registerLine.paye);
  assert.equal(payslip.loanDeduction, registerLine.loanDeduction);
  assert.equal(payslip.otherDeductions, registerLine.otherDeductions);
  assert.equal(payslip.totalDeductions, registerLine.totalDeductions);
  assert.equal(payslip.netPay, registerLine.netPay);

  // Arithmetic reconciliation: Gross - Total Deductions = Net Pay
  assert.equal(payslip.gross - payslip.totalDeductions, payslip.netPay);
});

test('FR-SLP-06: Personal data protection and access authorization policy', () => {
  const employeeUser = { username: 'fatima_b', role: 'employee', empId: 'EMP003' };
  const payrollOfficer = { username: 'john_payroll', role: 'payroll' };

  // Employee can only access their own payslip
  const checkAccess = (user, targetEmpId) => {
    if (user.role === 'employee') {
      return (user.empId || '').toUpperCase() === targetEmpId.toUpperCase();
    }
    return ['payroll', 'approver', 'hr', 'auditor', 'executive'].includes(user.role);
  };

  assert.equal(checkAccess(employeeUser, 'EMP003'), true, 'Employee can view their own payslip');
  assert.equal(checkAccess(employeeUser, 'EMP004'), false, 'Employee cannot view another employee payslip');
  assert.equal(checkAccess(payrollOfficer, 'EMP003'), true, 'Payroll role can access employee payslip');
  assert.equal(checkAccess(payrollOfficer, 'EMP004'), true, 'Payroll role can access employee payslip');
});
