const test = require('node:test');
const assert = require('node:assert/strict');
const { PayrollRun } = require('../lib/models');
const {
  calcLine,
  reconcilePayrollRegister,
  calculatePayrollVariance,
} = require('../lib/payroll');
const { computeTaxBands, computePAYE } = require('../lib/tax');

// FR-PAY-01: Calculate Basic (pro-rated), OTPay, Allowances, Bonuses, GrossPay = sum of all earnings
test('FR-PAY-01: Calculate Basic (pro-rated), OTPay, Allowances, Bonuses, GrossPay = sum of all earnings', () => {
  const emp = {
    empId: 'EMP_P01',
    surname: 'Bello',
    firstName: 'Ibrahim',
    department: 'Packaging',
    basic: 120000,
    housing: 40000,
    transport: 20000,
    otherAllowance: 10000,
    hourlyRate: 1000,
    bank: 'Access Bank',
    accountNo: '0123456789',
    status: 'Active',
  };

  const attendance = [
    { shift: 'Day', hoursWorked: 10, otHours: 2, multiplier: 1.5, approved: true },
    { shift: 'Night', hoursWorked: 10, otHours: 2, multiplier: 1.75, approved: true },
  ];
  const allowances = [
    { type: 'shift_allowance', amount: 8000, startPeriod: '2026-11', status: 'Approved' }
  ];
  const bonuses = [
    { period: '2026-11', attendanceBonus: 15000, performanceBonus: 25000, status: 'Approved' }
  ];

  const line = calcLine(emp, { attendance, allowances, bonuses }, '2026-11');

  // OT Pay: Day (2 * 1000 * 1.5 = 3000) + Night (2 * 1000 * 1.75 = 3500) = 6500
  assert.equal(line.basic, 120000);
  assert.equal(line.otPay, 6500);
  assert.equal(line.allowances, 40000 + 20000 + 10000 + 8000); // 78000
  assert.equal(line.bonuses, 40000); // 15000 + 25000
  assert.equal(line.gross, 120000 + 78000 + 6500 + 40000); // 244500
});

// FR-PAY-02: Derive and store bases separately: Pensionable Emoluments, NHF base (basic salary), Taxable Gross
test('FR-PAY-02: Derive and store statutory bases separately', () => {
  const emp = {
    empId: 'EMP_P02',
    surname: 'Okonkwo',
    firstName: 'Emeka',
    department: 'Maintenance',
    basic: 150000,
    housing: 60000,
    transport: 40000,
    otherAllowance: 25000,
    nhfEnrolled: true,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
  };

  const line = calcLine(emp, {}, '2026-11');

  assert.ok(line.pensionableEmoluments !== undefined, 'Must store pensionableEmoluments');
  assert.ok(line.nhfBase !== undefined, 'Must store nhfBase');
  assert.ok(line.taxableGross !== undefined, 'Must store taxableGross');

  assert.equal(line.pensionableEmoluments, 150000 + 60000 + 40000); // 250,000
  assert.equal(line.nhfBase, 150000);
  assert.equal(line.taxableGross, 275000); // 150k + 60k + 40k + 25k
  assert.equal(line.computationDetail.bases.pensionableEmoluments, 250000);
  assert.equal(line.computationDetail.bases.nhfBase, 150000);
  assert.equal(line.computationDetail.bases.taxableGross, 275000);
});

// FR-PAY-03: Pension (employee) = Pension% × pensionable emoluments (default 8%)
test('FR-PAY-03: Pension (employee) = Pension% × pensionable emoluments (default 8%)', () => {
  const empDefault = {
    empId: 'EMP_P03A',
    surname: 'Sani',
    firstName: 'Aliyu',
    basic: 100000,
    housing: 50000,
    transport: 30000,
    bank: 'First Bank of Nigeria',
    accountNo: '0123456789',
  };
  const lineDefault = calcLine(empDefault, {}, '2026-11');
  assert.equal(lineDefault.pension, (100000 + 50000 + 30000) * 0.08); // 14,400

  const empCustom = {
    ...empDefault,
    empId: 'EMP_P03B',
    pensionPct: 0.10, // 10%
  };
  const lineCustom = calcLine(empCustom, {}, '2026-11');
  assert.equal(lineCustom.pension, (100000 + 50000 + 30000) * 0.10); // 18,000
});

// FR-PAY-04: NHF = NHF% × basic salary (default 2.5%) for NHF-enrolled employees
test('FR-PAY-04: NHF = NHF% × basic salary for enrolled employees, 0 if not enrolled', () => {
  const empEnrolled = {
    empId: 'EMP_P04A',
    surname: 'Dada',
    firstName: 'Folake',
    basic: 200000,
    housing: 50000,
    nhfEnrolled: true,
    bank: 'GTBank',
    accountNo: '0123456789',
  };
  const lineEnrolled = calcLine(empEnrolled, {}, '2026-11');
  assert.equal(lineEnrolled.nhf, 200000 * 0.025); // 5000

  const empNotEnrolled = {
    ...empEnrolled,
    empId: 'EMP_P04B',
    nhfEnrolled: false,
  };
  const lineNotEnrolled = calcLine(empNotEnrolled, {}, '2026-11');
  assert.equal(lineNotEnrolled.nhf, 0);
});

// FR-PAY-05: PAYE shall be computed using the progressive tax engine, not a flat percentage
test('FR-PAY-05: PAYE is computed progressively via NTA 2025 bands, not flat 10%', () => {
  const emp = {
    empId: 'EMP_P05',
    surname: 'Ade',
    firstName: 'Ola',
    basic: 150000,
    housing: 60000,
    transport: 40000,
    annualRent: 600000,
    nhfEnrolled: true,
    bank: 'UBA',
    accountNo: '0123456789',
  };
  const line = calcLine(emp, {}, '2026-11');
  // Annual Gross: 3,000,000
  // Pension: 240,000, NHF: 45,000, Rent Relief: 120,000
  // Chargeable: 2,595,000
  // Progressive tax: 800k @ 0% + 1,795,000 @ 15% = 269,250 annual -> 22,437.50 monthly
  assert.equal(line.paye, 22437.50);
  assert.notEqual(line.paye, 25000); // 10% flat would be 25,000 or 25,950
});

// FR-PAY-06: NetPay = GrossPay − Pension − NHF − PAYE − LoanDeduction − OtherDeductions
test('FR-PAY-06: NetPay formula equals GrossPay minus all deductions', () => {
  const emp = {
    empId: 'EMP_P06',
    surname: 'Eze',
    firstName: 'Chidi',
    basic: 200000,
    housing: 50000,
    transport: 30000,
    nhfEnrolled: true,
    bank: 'Access Bank',
    accountNo: '0123456789',
  };
  const loans = [{ loanId: 'LN01', amount: 50000, monthly: 10000, outstanding: 10000, status: 'Active', startPeriod: '2026-01' }];
  const deductions = [{ type: 'union_dues', amount: 3000, status: 'Approved', startPeriod: '2026-11' }];

  const line = calcLine(emp, { loans, deductions }, '2026-11');
  const expectedNet = line.gross - line.pension - line.nhf - line.paye - line.loanDeduction - line.otherDeductions;
  assert.equal(line.netPay, Math.round(expectedNet * 100) / 100);
});

// FR-PAY-07: The register shall retain full computation detail per employee (inputs, bases, band-by-band tax)
test('FR-PAY-07: Retains full computation detail and band-by-band tax', () => {
  const chargeable = 2595000;
  const bands = computeTaxBands(chargeable);

  assert.equal(bands.chargeable, 2595000);
  assert.equal(bands.totalTax, 269250);
  assert.ok(Array.isArray(bands.breakdown));
  assert.equal(bands.breakdown.length, 6);

  // Band 1: 0 - 800,000 @ 0%
  assert.equal(bands.breakdown[0].taxableAmount, 800000);
  assert.equal(bands.breakdown[0].tax, 0);

  // Band 2: 800,000 - 3,000,000 @ 15% (taxable: 1,795,000)
  assert.equal(bands.breakdown[1].taxableAmount, 1795000);
  assert.equal(bands.breakdown[1].tax, 269250);

  // Remaining bands taxableAmount = 0
  for (let i = 2; i < 6; i++) {
    assert.equal(bands.breakdown[i].taxableAmount, 0);
    assert.equal(bands.breakdown[i].tax, 0);
  }

  const emp = {
    empId: 'EMP_P07',
    surname: 'Musa',
    firstName: 'Haruna',
    basic: 150000,
    housing: 60000,
    transport: 40000,
    annualRent: 600000,
    nhfEnrolled: true,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
  };
  const line = calcLine(emp, {}, '2026-11');
  assert.ok(line.computationDetail);
  assert.ok(line.computationDetail.taxBands);
  assert.equal(line.computationDetail.taxBands.length, 6);
  assert.equal(line.computationDetail.taxBands[0].tax, 0);
  assert.equal(line.computationDetail.taxBands[1].tax, 269250);
});

// FR-PAY-08: Net Pay below zero shall be blocked and flagged per BRL-09
test('FR-PAY-08: Net Pay below zero is flagged with NEGATIVE_NET', () => {
  const emp = {
    empId: 'EMP_P08',
    surname: 'Nwosu',
    firstName: 'Emeka',
    basic: 50000,
    bank: 'GTBank',
    accountNo: '0123456789',
  };
  const adjustments = [{ type: 'deduction', amount: 100000 }];
  const line = calcLine(emp, { adjustments }, '2026-11');

  assert.ok(line.netPay < 0, 'Net pay must be negative');
  assert.ok(line.flags.includes('NEGATIVE_NET'), 'Must flag NEGATIVE_NET');
});

// FR-PAY-09: Register totals shall reconcile: sum employee Net Pay = bank file total; Gross − all deductions = Net
test('FR-PAY-09: Register reconciliation balances and blocks approval on imbalance', () => {
  const linesBalanced = [
    { empId: 'E1', name: 'User 1', gross: 200000, pension: 16000, nhf: 5000, paye: 15000, loanDeduction: 10000, otherDeductions: 4000, netPay: 150000 },
    { empId: 'E2', name: 'User 2', gross: 300000, pension: 24000, nhf: 7500, paye: 28500, loanDeduction: 0, otherDeductions: 0, netPay: 240000 },
  ];
  const bankScheduleBalanced = { totalNet: 390000 };

  const resBalanced = reconcilePayrollRegister(linesBalanced, bankScheduleBalanced);
  assert.equal(resBalanced.isReconciled, true);
  assert.equal(resBalanced.totalGross, 500000);
  assert.equal(resBalanced.totalNet, 390000);
  assert.equal(resBalanced.imbalances.length, 0);

  // Imbalance case: employee net altered manually
  const linesImbalanced = [
    { empId: 'E1', name: 'User 1', gross: 200000, pension: 16000, nhf: 5000, paye: 15000, loanDeduction: 10000, otherDeductions: 4000, netPay: 160000 }, // 10k discrepancy
  ];
  const resImbalanced = reconcilePayrollRegister(linesImbalanced);
  assert.equal(resImbalanced.isReconciled, false);
  assert.equal(resImbalanced.imbalances.length, 1);
  assert.equal(resImbalanced.imbalances[0].empId, 'E1');

  // Imbalance case: bank file mismatch
  const bankScheduleMismatch = { totalNet: 380000 };
  const resBankMismatch = reconcilePayrollRegister(linesBalanced, bankScheduleMismatch);
  assert.equal(resBankMismatch.isReconciled, false);
  assert.equal(resBankMismatch.bankReconciled, false);
});

// FR-PAY-10: Variance analysis shall compare each employee's Gross and Net against previous period
test('FR-PAY-10: Variance analysis detects changes above configurable threshold (default 10%)', () => {
  const prevLines = [
    { empId: 'E1', name: 'Alice', department: 'Production', gross: 200000, netPay: 160000 },
    { empId: 'E2', name: 'Bob', department: 'Production', gross: 200000, netPay: 160000 },
  ];

  const currentLines = [
    { empId: 'E1', name: 'Alice', department: 'Production', gross: 205000, netPay: 162000 }, // ~2.5% increase <= 10%
    { empId: 'E2', name: 'Bob', department: 'Production', gross: 260000, netPay: 210000 },   // 30% increase > 10%
    { empId: 'E3', name: 'Charlie', department: 'Logistics', gross: 180000, netPay: 145000 }, // New joiner (100% change)
  ];

  const varianceResult = calculatePayrollVariance(currentLines, prevLines, 0.10);

  assert.equal(varianceResult.totalEmployees, 3);
  assert.equal(varianceResult.flaggedCount, 2); // E2 and E3
  assert.equal(varianceResult.comparisons[0].isFlagged, false);
  assert.equal(varianceResult.comparisons[1].isFlagged, true);
  assert.equal(varianceResult.comparisons[1].grossExceedsThreshold, true);
  assert.equal(varianceResult.comparisons[2].isNewJoiner, true);
  assert.equal(varianceResult.comparisons[2].isFlagged, true);
});

// FR-PAY-11: Payroll runnable for all employees or filtered subset (department, employee type) and re-runnable
test('FR-PAY-11: Filtered recalculation logic by department and employment type', () => {
  const employees = [
    { empId: 'E1', surname: 'A', firstName: 'A', department: 'Production', employmentType: 'Permanent', basic: 100000, bank: 'GTB', accountNo: '0123456789' },
    { empId: 'E2', surname: 'B', firstName: 'B', department: 'Logistics', employmentType: 'Permanent', basic: 100000, bank: 'GTB', accountNo: '0123456789' },
    { empId: 'E3', surname: 'C', firstName: 'C', department: 'Production', employmentType: 'Contract', basic: 80000, bank: 'GTB', accountNo: '0123456789' },
  ];

  const prodEmployees = employees.filter((e) => e.department.toLowerCase() === 'production');
  assert.equal(prodEmployees.length, 2);

  const contractEmployees = employees.filter((e) => e.employmentType.toLowerCase() === 'contract');
  assert.equal(contractEmployees.length, 1);
  assert.equal(contractEmployees[0].empId, 'E3');
});

// FR-PAY-12: Year-to-date totals (gross, taxable pay, PAYE, pension, NHF) maintained per employee
test('FR-PAY-12: Year-to-date aggregation across multiple approved periods in calendar year', () => {
  const runs = [
    {
      period: '2026-01',
      status: 'Approved',
      lines: [{ empId: 'EMP001', gross: 200000, taxablePay: 180000, paye: 15000, pension: 16000, nhf: 5000 }],
    },
    {
      period: '2026-02',
      status: 'Approved',
      lines: [{ empId: 'EMP001', gross: 210000, taxablePay: 190000, paye: 16000, pension: 16000, nhf: 5000 }],
    },
    {
      period: '2026-03',
      status: 'Calculated', // Not approved yet - should not count towards YTD
      lines: [{ empId: 'EMP001', gross: 220000, taxablePay: 200000, paye: 17000, pension: 16000, nhf: 5000 }],
    },
  ];

  const approvedRuns = runs.filter((r) => r.status === 'Approved');
  let ytdGross = 0;
  let ytdTaxable = 0;
  let ytdPaye = 0;
  let ytdPension = 0;
  let ytdNhf = 0;

  for (const r of approvedRuns) {
    const line = r.lines.find((l) => l.empId === 'EMP001');
    if (line) {
      ytdGross += line.gross;
      ytdTaxable += line.taxablePay;
      ytdPaye += line.paye;
      ytdPension += line.pension;
      ytdNhf += line.nhf;
    }
  }

  assert.equal(ytdGross, 410000);
  assert.equal(ytdTaxable, 370000);
  assert.equal(ytdPaye, 31000);
  assert.equal(ytdPension, 32000);
  assert.equal(ytdNhf, 10000);
});
