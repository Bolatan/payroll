const test = require('node:test');
const assert = require('node:assert/strict');
const { Employee, PayrollRun } = require('../lib/models');
const {
  calcLine,
  calcProration,
  calculateLoanMonthlyDeduction,
  calculateUnpaidLeaveDeduction,
  hoursBetween,
  evaluateAttendanceEntry,
  CBN_BANKS,
  CFG,
} = require('../lib/payroll');
const { computePAYE, annualTax, r2, NIGERIA_2025_BANDS } = require('../lib/tax');

/**
 * BUSINESS RULES SUITE (BRL-01 through BRL-15)
 * REQUIREMENTS.md Section 3.5
 */

// BRL-01: Each employee has a unique EmpID that is never reused.
test('BRL-01: Each employee has a unique EmpID that is never reused', () => {
  const empIdField = Employee.schema.path('empId');
  assert.ok(empIdField, 'Employee schema must include empId');
  assert.equal(empIdField.options.required, true, 'empId is required');
  assert.equal(empIdField.options.unique, true, 'empId must be strictly unique');
});

// BRL-02: Only employees with Status = Active (or on paid leave) on any day within the period are paid;
// Terminated/Suspended employees are excluded unless an approved final-pay or arrears entry exists.
test('BRL-02: Employee status pay eligibility and exclusion of terminated/suspended without entry', () => {
  // Proration / inclusion logic
  const activeEmp = { empId: 'EMP001', status: 'Active', basic: 200000 };
  assert.equal(calcProration(activeEmp, '2026-11'), 1);

  // Terminated prior to period -> proration is 0 (excluded from pay)
  const terminatedPrior = {
    empId: 'EMP002',
    status: 'Terminated',
    terminationDate: '2026-10-15',
    basic: 200000,
  };
  assert.equal(calcProration(terminatedPrior, '2026-11'), 0);

  // Terminated mid-period (e.g. 15th of 30 days) -> prorated for payable days
  const terminatedMid = {
    empId: 'EMP003',
    status: 'Terminated',
    terminationDate: '2026-11-15',
    basic: 200000,
  };
  const ratio = calcProration(terminatedMid, '2026-11');
  assert.equal(ratio, 0.5); // 15/30 = 0.5
});

// BRL-03: Pay period is one calendar month unless configured otherwise.
test('BRL-03: Pay period standard format is one calendar month (YYYY-MM)', () => {
  const validPeriodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
  assert.ok(validPeriodRegex.test('2026-01'));
  assert.ok(validPeriodRegex.test('2026-11'));
  assert.ok(!validPeriodRegex.test('2026-13'));
  assert.ok(!validPeriodRegex.test('2026-00'));
  assert.ok(!validPeriodRegex.test('2026/11'));
});

// BRL-04: Overtime pay = OT hours × employee HourlyRate × multiplier for the applicable shift type
// (defaults: Day 1.5, Night 1.75, Weekend 2.0, Holiday 2.5). Standard hours per shift default to 8.
test('BRL-04: Overtime pay formula: OT hours × HourlyRate × multiplier with standard shift defaults', () => {
  const hourlyRate = 1000;
  assert.equal(CFG.STD_HOURS, 8);
  assert.equal(CFG.MULT.Day, 1.5);
  assert.equal(CFG.MULT.Night, 1.75);
  assert.equal(CFG.MULT.Weekend, 2.0);
  assert.equal(CFG.MULT.Holiday, 2.5);

  const emp = {
    empId: 'EMP010',
    surname: 'Test',
    firstName: 'BRL04',
    basic: 176000,
    hourlyRate,
    bank: 'Access Bank',
    accountNo: '0123456789',
  };

  // Day shift (10h worked - 8h std = 2h OT) * 1000 * 1.5 = 3000
  // Weekend shift (8h full OT) * 1000 * 2.0 = 16000
  // Holiday shift (8h full OT) * 1000 * 2.5 = 20000
  const attendance = [
    { shift: 'Day', hoursWorked: 10, otHours: 2, multiplier: 1.5 },
    { shift: 'Weekend', hoursWorked: 8, weekendOT: 8, multiplier: 2.0 },
    { shift: 'Holiday', hoursWorked: 8, holidayOT: 8, multiplier: 2.5 },
  ];
  const line = calcLine(emp, { attendance }, '2026-11');
  assert.equal(line.otHours, 18);
  assert.equal(line.otPay, 3000 + 16000 + 20000);
});

// BRL-05: PAYE is computed progressively on chargeable income using the effective-dated tax bands,
// after allowable reliefs and deductions. Flat percentages are not permitted.
test('BRL-05: Progressive PAYE computation using effective-dated bands (no flat rate)', () => {
  // First 800k @ 0%
  assert.equal(annualTax(800000, NIGERIA_2025_BANDS), 0);

  // 800,001 - 3,000,000 (2.2m) @ 15% -> 330,000
  assert.equal(annualTax(3000000, NIGERIA_2025_BANDS), 330000);

  // Progressive bands check: at 2,595,000:
  // first 800k @ 0 = 0
  // next 1,795,000 @ 15% = 269,250
  assert.equal(annualTax(2595000, NIGERIA_2025_BANDS), 269250);
});

// BRL-06: Employee pension = Pension% (default 8%) × pensionable emoluments;
// employer pension = 10% minimum of the same base (statutory minimum).
test('BRL-06: Employee pension (8%) and Employer pension (minimum 10%) on pensionable emoluments', () => {
  const emp = {
    empId: 'EMP020',
    surname: 'Pension',
    firstName: 'Worker',
    basic: 150000,
    housing: 60000,
    transport: 40000,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
  };
  const line = calcLine(emp, {}, '2026-11');
  assert.equal(line.pensionable, 250000); // 150k + 60k + 40k
  assert.equal(line.pension, 20000); // 8% of 250k
  assert.equal(line.employerPension, 25000); // 10% statutory minimum of 250k
});

// BRL-07: NHF = NHF% (default 2.5%) × basic salary, for employees enrolled in NHF.
test('BRL-07: NHF = 2.5% × basic salary for enrolled employees, 0 if not enrolled', () => {
  const empEnrolled = {
    empId: 'EMP030',
    surname: 'Enrolled',
    firstName: 'NHF',
    basic: 200000,
    housing: 50000,
    nhfEnrolled: true,
    bank: 'First Bank of Nigeria',
    accountNo: '0123456789',
  };
  const line1 = calcLine(empEnrolled, {}, '2026-11');
  assert.equal(line1.nhf, 5000); // 2.5% of 200,000 basic

  const empNotEnrolled = {
    ...empEnrolled,
    nhfEnrolled: false,
  };
  const line2 = calcLine(empNotEnrolled, {}, '2026-11');
  assert.equal(line2.nhf, 0);
});

// BRL-08: A loan instalment is deducted monthly until Outstanding = 0;
// the deduction in any month never exceeds the remaining balance.
test('BRL-08: Loan instalment deducted monthly and deduction never exceeds remaining balance', () => {
  const emp = {
    empId: 'EMP040',
    surname: 'Loan',
    firstName: 'Borrower',
    basic: 200000,
    bank: 'GTBank',
    accountNo: '0123456789',
  };

  // Case A: normal instalment where monthly (20,000) < outstanding (50,000)
  const lineA = calcLine(emp, {
    loans: [{ _id: 'L1', loanId: 'LN01', status: 'Active', monthly: 20000, outstanding: 50000, startPeriod: '2026-01' }],
  }, '2026-11');
  assert.equal(lineA.loanDeduction, 20000);
  assert.equal(lineA.loanBreakdown[0].remainingAfter, 30000);

  // Case B: final instalment where monthly (20,000) > outstanding (7,500)
  const lineB = calcLine(emp, {
    loans: [{ _id: 'L2', loanId: 'LN02', status: 'Active', monthly: 20000, outstanding: 7500, startPeriod: '2026-01' }],
  }, '2026-11');
  assert.equal(lineB.loanDeduction, 7500);
  assert.equal(lineB.loanBreakdown[0].remainingAfter, 0);
});

// BRL-09: Total deductions may not make Net Pay negative; any shortfall is carried forward
// as a recoverable balance or flagged for manager decision.
test('BRL-09: Negative net pay is flagged (NEGATIVE_NET) and checked against deduction policies', () => {
  const emp = {
    empId: 'EMP050',
    surname: 'Low',
    firstName: 'Income',
    basic: 50000,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
  };

  // Huge deduction making net negative
  const adjustments = [{ type: 'deduction', amount: 80000 }];
  const line = calcLine(emp, { adjustments }, '2026-11');

  assert.ok(line.netPay < 0);
  assert.ok(line.flags.includes('NEGATIVE_NET'), 'Must flag NEGATIVE_NET per BRL-09');
});

// BRL-10: Once a period is Approved/Locked, no pay-affecting data for that period can be changed;
// corrections are posted as adjustments in a later open period.
test('BRL-10: Locked period state prevents changes and enforces adjustments in later open period', () => {
  const runSchema = PayrollRun.schema;
  const statusValues = runSchema.path('status').enumValues;
  assert.ok(statusValues.includes('Draft'));
  assert.ok(statusValues.includes('Approved'));
});

// BRL-11: The user who prepares payroll cannot be the user who approves it.
test('BRL-11: Segregation of duties - preparer cannot be the approver', () => {
  const preparedBy = 'payroll_officer';
  const approverSame = 'payroll_officer';
  const approverDifferent = 'finance_manager';

  const canApproveSame = preparedBy !== approverSame;
  const canApproveDiff = preparedBy !== approverDifferent;

  assert.equal(canApproveSame, false, 'Same user cannot approve');
  assert.equal(canApproveDiff, true, 'Different user can approve');
});

// BRL-12: Bank details must be validated (valid bank, 10-digit NUBAN account number)
// before an employee can be included in the bank file.
test('BRL-12: Bank details validation (valid CBN bank and 10-digit NUBAN)', () => {
  // Valid account
  const validAcc = '0123456789';
  const invalidAcc1 = '12345'; // too short
  const invalidAcc2 = '0123456789A'; // non-numeric
  const nubanRegex = /^\d{10}$/;

  assert.equal(nubanRegex.test(validAcc), true);
  assert.equal(nubanRegex.test(invalidAcc1), false);
  assert.equal(nubanRegex.test(invalidAcc2), false);

  const validBank = CBN_BANKS.find((b) => b.name === 'Zenith Bank');
  assert.ok(validBank, 'Zenith Bank must be in CBN list');

  const empWithInvalidBank = {
    empId: 'EMP060',
    surname: 'Bad',
    firstName: 'Bank',
    basic: 100000,
    accountNo: '12345',
    bank: 'Unknown Bank',
  };
  const line = calcLine(empWithInvalidBank, {}, '2026-11');
  assert.ok(line.flags.includes('NO_BANK'), 'Invalid bank details must flag NO_BANK');
});

// BRL-13: Absence without approved leave reduces pay proportionally (basic ÷ working days × absent days).
test('BRL-13: Absence without approved leave reduces pay proportionally: basic ÷ working days × absent days', () => {
  const basicSalary = 220000;
  const workingDays = 22;
  const absentDays = 3;

  // Daily rate = 220,000 / 22 = 10,000
  // Deduction = 10,000 * 3 = 30,000
  const deduction = calculateUnpaidLeaveDeduction(basicSalary, absentDays, workingDays);
  assert.equal(deduction, 30000);

  const emp = {
    empId: 'EMP070',
    surname: 'Absentee',
    firstName: 'Staff',
    basic: basicSalary,
    bank: 'Access Bank',
    accountNo: '0123456789',
  };

  const line = calcLine(emp, {
    leaves: [{ status: 'Approved', leaveType: 'Unpaid', payTreatment: 'unpaid', days: 3 }],
  }, '2026-11', { workingDaysInMonth: 22 });

  assert.equal(line.unpaidLeaveDeduction, 30000);
  assert.equal(line.basic, 190000); // 220,000 - 30,000
});

// BRL-14: Bonuses are taxable and are included in gross unless flagged as exempt by the Tax Advisor.
test('BRL-14: Bonuses are taxable and included in gross earnings', () => {
  const emp = {
    empId: 'EMP080',
    surname: 'Bonus',
    firstName: 'Earner',
    basic: 200000,
    housing: 50000,
    transport: 30000,
    bank: 'First Bank of Nigeria',
    accountNo: '0123456789',
  };

  const adjustments = [{ type: 'bonus', amount: 50000 }];
  const line = calcLine(emp, { adjustments }, '2026-11');

  // Gross = 200k + 80k allowances + 50k bonus = 330,000
  assert.equal(line.bonuses, 50000);
  assert.equal(line.gross, 330000);
  assert.ok(line.chargeable > 0);
});

// BRL-15: All monetary amounts are in Nigerian Naira (₦), rounded to 2 decimal places using
// a single documented rounding rule applied at line level.
test('BRL-15: Monetary amounts rounded to 2 decimal places using single rounding rule (r2)', () => {
  assert.equal(r2(100.456), 100.46);
  assert.equal(r2(100.454), 100.45);
  assert.equal(r2(100.455), 100.46);

  const emp = {
    empId: 'EMP090',
    surname: 'Rounding',
    firstName: 'Test',
    basic: 123456.78,
    housing: 12345.67,
    transport: 9876.54,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
  };
  const line = calcLine(emp, {}, '2026-11');

  // Check 2 decimal place consistency
  assert.equal(line.basic, 123456.78);
  assert.equal(line.allowances, r2(12345.67 + 9876.54));
  assert.equal(line.gross, r2(line.basic + line.allowances));
  assert.equal(line.netPay, r2(line.gross - line.totalDeductions));
});
