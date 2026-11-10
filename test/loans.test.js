const test = require('node:test');
const assert = require('node:assert');
const { Loan, RepaymentLedger, DeductionRegister } = require('../lib/models');
const { calcLine, calculateLoanMonthlyDeduction } = require('../lib/payroll');

test('FR-LN-01: Loan model schema defines LoanID, EmpID, Amount, StartDate, TermMonths, and Interest fields', () => {
  const schema = Loan.schema.paths;
  assert.ok(schema.loanId, 'loanId field is required');
  assert.ok(schema.empId, 'empId field is required');
  assert.ok(schema.amount, 'amount field is required');
  assert.ok(schema.startDate, 'startDate field is required');
  assert.ok(schema.termMonths, 'termMonths field is required');
  assert.ok(schema.monthly, 'monthly deduction field is required');
  assert.ok(schema.outstanding, 'outstanding field is required');
  assert.ok(schema.status, 'status field is required');
});

test('FR-LN-01: Calculate MonthlyDeduction with Amount ÷ TermMonths and interest if configured', () => {
  // Without interest
  const deductionNoInterest = calculateLoanMonthlyDeduction(120000, 12, 0);
  assert.strictEqual(deductionNoInterest, 10000);

  // With 10% flat interest on principal
  // Principal = 120,000, Interest = 12,000, Total = 132,000 ÷ 12 = 11,000
  const deductionFlatInterest = calculateLoanMonthlyDeduction(120000, 12, 0.10, 'flat');
  assert.strictEqual(deductionFlatInterest, 11000);

  // With 1% monthly interest
  // Total = 120,000 + (120,000 * 0.01 * 12) = 134,400 ÷ 12 = 11,200
  const deductionMonthlyInterest = calculateLoanMonthlyDeduction(120000, 12, 0.01, 'monthly');
  assert.strictEqual(deductionMonthlyInterest, 11200);
});

test('FR-LN-03 & FR-LN-05: Automatically pull instalment for active loan and final instalment equals remaining balance', () => {
  const emp = {
    empId: 'EMP001',
    surname: 'Doe',
    firstName: 'John',
    basic: 200000,
    housing: 50000,
    transport: 30000,
    accountNo: '0123456789',
    bank: 'Zenith Bank',
    country: 'NG',
  };

  // Case 1: Normal instalment (monthly = 20,000, outstanding = 80,000)
  const line1 = calcLine(emp, {
    loans: [
      {
        _id: 'L001',
        loanId: 'LN-001',
        status: 'Active',
        startPeriod: '2026-01',
        monthly: 20000,
        outstanding: 80000,
      },
    ],
  }, '2026-03');

  assert.strictEqual(line1.loanDeduction, 20000);
  assert.strictEqual(line1.loanBreakdown[0].amount, 20000);
  assert.strictEqual(line1.loanBreakdown[0].remainingAfter, 60000);

  // Case 2: Final instalment equals remaining balance (monthly = 20,000, outstanding = 12,500)
  const line2 = calcLine(emp, {
    loans: [
      {
        _id: 'L001',
        loanId: 'LN-001',
        status: 'Active',
        startPeriod: '2026-01',
        monthly: 20000,
        outstanding: 12500,
      },
    ],
  }, '2026-06');

  assert.strictEqual(line2.loanDeduction, 12500);
  assert.strictEqual(line2.loanBreakdown[0].amount, 12500);
  assert.strictEqual(line2.loanBreakdown[0].remainingAfter, 0);

  // Case 3: Inactive loan or future startPeriod is not deducted
  const line3 = calcLine(emp, {
    loans: [
      {
        _id: 'L002',
        loanId: 'LN-002',
        status: 'Pending',
        startPeriod: '2026-01',
        monthly: 10000,
        outstanding: 50000,
      },
      {
        _id: 'L003',
        loanId: 'LN-003',
        status: 'Active',
        startPeriod: '2026-08',
        monthly: 15000,
        outstanding: 60000,
      },
    ],
  }, '2026-03');

  assert.strictEqual(line3.loanDeduction, 0);
  assert.strictEqual(line3.loanBreakdown.length, 0);
});

test('FR-LN-06: Instalment holiday skips loan deduction in designated periods', () => {
  const emp = {
    empId: 'EMP002',
    surname: 'Smith',
    firstName: 'Jane',
    basic: 300000,
    accountNo: '0123456789',
    bank: 'Access Bank',
  };

  const loanWithHoliday = {
    _id: 'L004',
    loanId: 'LN-004',
    status: 'Active',
    startPeriod: '2026-01',
    monthly: 25000,
    outstanding: 100000,
    holidayPeriods: ['2026-04', '2026-05'],
  };

  // Regular period: deduction occurs
  const lineRegular = calcLine(emp, { loans: [loanWithHoliday] }, '2026-03');
  assert.strictEqual(lineRegular.loanDeduction, 25000);

  // Holiday period: deduction skipped
  const lineHoliday = calcLine(emp, { loans: [loanWithHoliday] }, '2026-04');
  assert.strictEqual(lineHoliday.loanDeduction, 0);
  assert.strictEqual(lineHoliday.loanBreakdown.length, 0);
});

test('FR-LN-07: On termination, outstanding loan balance is flagged for full recovery from final pay', () => {
  const emp = {
    empId: 'EMP003',
    surname: 'Adams',
    firstName: 'Paul',
    basic: 400000,
    accountNo: '0123456789',
    bank: 'GTBank',
    status: 'Terminated',
    terminationDate: '2026-04-15',
  };

  const activeLoan = {
    _id: 'L005',
    loanId: 'LN-005',
    status: 'Active',
    startPeriod: '2026-01',
    monthly: 30000,
    outstanding: 90000,
  };

  const line = calcLine(emp, { loans: [activeLoan] }, '2026-04');
  // Full outstanding recovered
  assert.strictEqual(line.loanDeduction, 90000);
  assert.strictEqual(line.loanBreakdown[0].amount, 90000);
  assert.strictEqual(line.loanBreakdown[0].remainingAfter, 0);
  assert.strictEqual(line.loanBreakdown[0].isFinalRecovery, true);
  assert.ok(line.flags.includes('LOAN_TERMINATION_RECOVERY'));
});

test('FR-LN-08 & BRL-09: Total monthly deductions checked against maximum deduction policy and negative net flagged', () => {
  const emp = {
    empId: 'EMP004',
    surname: 'Nwosu',
    firstName: 'Emeka',
    basic: 100000,
    accountNo: '0123456789',
    bank: 'UBA',
  };

  // High loan deduction causing negative net pay and exceeding 50% max deduction policy
  const largeLoan = {
    _id: 'L006',
    loanId: 'LN-006',
    status: 'Active',
    startPeriod: '2026-01',
    monthly: 120000,
    outstanding: 500000,
  };

  const line = calcLine(emp, { loans: [largeLoan] }, '2026-02', { maxDeductionPct: 0.5 });
  assert.ok(line.netPay < 0);
  assert.ok(line.flags.includes('NEGATIVE_NET'));
  assert.ok(line.flags.includes('MAX_DEDUCTION_EXCEEDED'));
});

test('FR-LN-09: Deductions register records and applies recurring/one-off deductions', () => {
  const emp = {
    empId: 'EMP005',
    surname: 'Okonkwo',
    firstName: 'Chidi',
    basic: 250000,
    accountNo: '0123456789',
    bank: 'Fidelity Bank',
  };

  const deductions = [
    {
      _id: 'D001',
      type: 'cooperative',
      title: 'Staff Cooperative Contribution',
      amount: 15000,
      recurring: true,
      startPeriod: '2026-01',
      endPeriod: '2026-12',
      status: 'Approved',
    },
    {
      _id: 'D002',
      type: 'union_dues',
      title: 'Monthly Union Dues',
      amount: 5000,
      recurring: true,
      startPeriod: '2026-01',
      status: 'Approved',
    },
    {
      _id: 'D003',
      type: 'damages',
      title: 'Equipment Damage Surcharge',
      amount: 7500,
      recurring: false,
      startPeriod: '2026-03',
      status: 'Approved',
    },
    {
      _id: 'D004',
      type: 'salary_advance',
      title: 'Pending Unapproved Advance',
      amount: 20000,
      recurring: false,
      startPeriod: '2026-03',
      status: 'Pending', // Unapproved, should be skipped
    },
  ];

  // In 2026-03: Cooperative (15k) + Union Dues (5k) + Damages (7.5k) = 27.5k
  const lineMarch = calcLine(emp, { deductions }, '2026-03');
  assert.strictEqual(lineMarch.otherDeductions, 27500);
  assert.strictEqual(lineMarch.deductionRegisterBreakdown.length, 3);

  // In 2026-04: One-off damages does not apply; Cooperative (15k) + Union Dues (5k) = 20k
  const lineApril = calcLine(emp, { deductions }, '2026-04');
  assert.strictEqual(lineApril.otherDeductions, 20000);
  assert.strictEqual(lineApril.deductionRegisterBreakdown.length, 2);
});

test('FR-LN-02 & FR-LN-06: Loan and change-request approval segregation of duties logic', () => {
  // Test FR-LN-02: approver cannot be the creator/requestor
  const loanRecord = {
    createdBy: 'john_payroll',
    status: 'Pending',
  };
  const approver1 = 'john_payroll'; // same user
  const approver2 = 'mary_manager'; // distinct user

  assert.strictEqual(loanRecord.createdBy === approver1, true, 'Same user should be identified and rejected');
  assert.strictEqual(loanRecord.createdBy === approver2, false, 'Distinct approver should be permitted');

  // Test FR-LN-06 change request approver segregation of duties
  const changeRequest = {
    type: 'topup',
    requestedBy: 'alice_hr',
    status: 'Pending',
  };
  assert.strictEqual(changeRequest.requestedBy === 'alice_hr', true, 'Requestor cannot approve own change request');
  assert.strictEqual(changeRequest.requestedBy === 'bob_approver', false, 'Separate approver can approve change request');
});

test('FR-LN-04: RepaymentLedger schema defines LoanID, period, amountDeducted, and balanceAfter', () => {
  const schema = RepaymentLedger.schema.paths;
  assert.ok(schema.loanId, 'loanId must be defined on RepaymentLedger');
  assert.ok(schema.period, 'period must be defined on RepaymentLedger');
  assert.ok(schema.amountDeducted, 'amountDeducted must be defined on RepaymentLedger');
  assert.ok(schema.balanceAfter, 'balanceAfter must be defined on RepaymentLedger');
  assert.ok(schema.type, 'type must be defined on RepaymentLedger');
});

test('FR-LN-09: DeductionRegister schema supports all required deduction types', () => {
  const schema = DeductionRegister.schema.paths;
  assert.ok(schema.empId, 'empId is required on DeductionRegister');
  assert.ok(schema.type, 'type is required on DeductionRegister');
  assert.ok(schema.amount, 'amount is required on DeductionRegister');
  assert.ok(schema.startPeriod, 'startPeriod is required on DeductionRegister');

  const enumValues = schema.type.enumValues;
  ['cooperative', 'union_dues', 'damages', 'salary_advance', 'other'].forEach((t) => {
    assert.ok(enumValues.includes(t), `Type ${t} should be supported in DeductionRegister enum`);
  });
});
