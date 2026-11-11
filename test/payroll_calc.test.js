const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calcLine,
  reconcilePayrollRegister,
  calculatePayrollVariance,
} = require('../lib/payroll');
const { computeTaxBands, computePAYE } = require('../lib/tax');

test('FR-PAY-01: Calculate Basic (pro-rated), OTPay, Allowances, Bonuses, and GrossPay = sum of all earnings', () => {
  const emp = {
    empId: 'EMP_CALC_01',
    surname: 'Okoro',
    firstName: 'Emeka',
    department: 'Production',
    basic: 120000,
    housing: 40000,
    transport: 20000,
    otherAllowance: 10000,
    nhfEnrolled: true,
    bank: 'Access Bank',
    accountNo: '0123456789',
  };

  const period = '2026-11';
  const attendance = [
    { date: '2026-11-02', shift: 'Day', hoursWorked: 10, otHours: 2, multiplier: 1.5, approved: true },
  ];
  const allowances = [
    { type: 'shift_allowance', amount: 5000, startPeriod: '2026-11', status: 'Approved' },
  ];
  const bonuses = [
    { period: '2026-11', performanceBonus: 8000, attendanceBonus: 4000, status: 'Approved' },
  ];

  const line = calcLine(emp, { attendance, allowances, bonuses }, period);

  assert.strictEqual(line.basic, 120000);
  assert.strictEqual(line.allowances, 75000); // 40k + 20k + 10k + 5k
  assert.ok(line.otPay > 0);
  assert.strictEqual(line.bonuses, 12000);
  // GrossPay = Basic + OTPay + Allowances + Bonuses
  const expectedGross = Math.round((line.basic + line.otPay + line.allowances + line.bonuses) * 100) / 100;
  assert.strictEqual(line.gross, expectedGross);
});

test('FR-PAY-02: Derive and store separately: Pensionable Emoluments, NHF base (basic salary), Taxable Gross', () => {
  const emp = {
    empId: 'EMP_CALC_02',
    surname: 'Balogun',
    firstName: 'Kola',
    basic: 200000,
    housing: 60000,
    transport: 40000,
    otherAllowance: 20000,
    nhfEnrolled: true,
    bank: 'Zenith Bank',
    accountNo: '1234567890',
  };

  const period = '2026-11';
  const bonuses = [
    {
      period: '2026-11',
      performanceBonus: 30000,
      flags: { performance: { taxable: false, pensionable: true } },
      status: 'Approved',
    },
  ];

  const line = calcLine(emp, { bonuses }, period);

  // Bases stored separately and explicitly
  assert.ok(line.pensionableEmoluments !== undefined, 'Must store pensionableEmoluments');
  assert.ok(line.nhfBase !== undefined, 'Must store nhfBase');
  assert.ok(line.taxableGross !== undefined, 'Must store taxableGross');

  // Pensionable = Basic (200k) + Housing (60k) + Transport (40k) + Pensionable bonus (30k) = 330,000
  assert.strictEqual(line.pensionableEmoluments, 330000);
  // NHF base = basic salary = 200,000
  assert.strictEqual(line.nhfBase, 200000);
  // Gross = 200k + 120k + 30k = 350k. Non-taxable bonus = 30k -> Taxable Gross = 320,000
  assert.strictEqual(line.gross, 350000);
  assert.strictEqual(line.taxableGross, 320000);
});

test('FR-PAY-03 & FR-PAY-04: Pension = Pension% × pensionable emoluments (default 8%); NHF = NHF% × basic salary (default 2.5%)', () => {
  const empDefault = {
    empId: 'EMP_CALC_03A',
    basic: 100000,
    housing: 30000,
    transport: 20000,
    nhfEnrolled: true,
    bank: 'UBA',
    accountNo: '1122334455',
  };

  const lineDefault = calcLine(empDefault, {}, '2026-11');
  // Default 8% of pensionable (150,000) = 12,000
  assert.strictEqual(lineDefault.pension, 12000);
  // Default 2.5% of basic (100,000) = 2,500
  assert.strictEqual(lineDefault.nhf, 2500);

  // Custom rates in Employee Master
  const empCustom = {
    empId: 'EMP_CALC_03B',
    basic: 100000,
    housing: 30000,
    transport: 20000,
    pensionPct: 0.10, // 10%
    nhfPct: 0.03, // 3%
    nhfEnrolled: true,
    bank: 'UBA',
    accountNo: '1122334455',
  };

  const lineCustom = calcLine(empCustom, {}, '2026-11');
  assert.strictEqual(lineCustom.pension, 15000); // 10% of 150,000
  assert.strictEqual(lineCustom.nhf, 3000); // 3% of 100,000

  // NHF not enrolled
  const empNoNhf = { ...empCustom, nhfEnrolled: false };
  const lineNoNhf = calcLine(empNoNhf, {}, '2026-11');
  assert.strictEqual(lineNoNhf.nhf, 0);
});

test('FR-PAY-05 & FR-PAY-07: PAYE computed using progressive tax engine with full band-by-band detail', () => {
  const emp = {
    empId: 'EMP_CALC_05',
    basic: 150000,
    housing: 60000,
    transport: 40000,
    annualRent: 600000,
    nhfEnrolled: true,
    bank: 'GTB',
    accountNo: '0123456789',
  };

  const line = calcLine(emp, {}, '2026-11');

  // Progressive computation, not flat percentage
  assert.strictEqual(line.gross, 250000);
  assert.strictEqual(line.pension, 20000);
  assert.strictEqual(line.nhf, 3750);
  assert.strictEqual(line.rentRelief, 120000);
  assert.strictEqual(line.chargeable, 2595000); // 3m gross - 240k pen - 45k nhf - 120k rent
  assert.strictEqual(line.paye, 22437.5);

  // Full band-by-band detail retained
  assert.ok(Array.isArray(line.taxBands), 'taxBands must be an array');
  assert.ok(line.taxBands.length >= 6, 'Must include progressive tax bands');
  assert.strictEqual(line.taxBands[0].taxAmount, 0); // first 800k @ 0%
  assert.strictEqual(line.taxBands[1].rate, 0.15); // next 2.2m @ 15%
  assert.strictEqual(line.taxBands[1].taxableAmount, 1795000); // 2,595,000 - 800,000
  assert.strictEqual(line.taxBands[1].taxAmount, 269250);

  // computationDetail retained
  assert.ok(line.computationDetail);
  assert.strictEqual(line.computationDetail.bases.pensionableEmoluments, 250000);
  assert.strictEqual(line.computationDetail.bases.nhfBase, 150000);
  assert.strictEqual(line.computationDetail.bases.taxableGross, 250000);
});

test('FR-PAY-06: NetPay = GrossPay − Pension − NHF − PAYE − LoanDeduction − OtherDeductions', () => {
  const emp = {
    empId: 'EMP_CALC_06',
    basic: 120000,
    housing: 40000,
    transport: 20000,
    nhfEnrolled: true,
    bank: 'Sterling',
    accountNo: '0123456789',
  };

  const loans = [
    { loanId: 'LN1', amount: 50000, monthly: 10000, outstanding: 10000, status: 'Active', startPeriod: '2026-01' },
  ];
  const deductions = [
    { type: 'union_dues', amount: 2500, status: 'Approved', startPeriod: '2026-11' },
  ];

  const line = calcLine(emp, { loans, deductions }, '2026-11');
  const expectedTotalDeductions = Math.round((line.pension + line.nhf + line.paye + line.loanDeduction + line.otherDeductions) * 100) / 100;
  const expectedNet = Math.round((line.gross - expectedTotalDeductions) * 100) / 100;

  assert.strictEqual(line.loanDeduction, 10000);
  assert.strictEqual(line.otherDeductions, 2500);
  assert.strictEqual(line.totalDeductions, expectedTotalDeductions);
  assert.strictEqual(line.netPay, expectedNet);
});

test('FR-PAY-08: Net Pay below zero shall be blocked and flagged per BRL-09', () => {
  const emp = {
    empId: 'EMP_CALC_08',
    basic: 50000,
    bank: 'First Bank',
    accountNo: '0123456789',
  };

  const deductions = [
    { type: 'court_order', amount: 80000, status: 'Approved', startPeriod: '2026-11' },
  ];

  const line = calcLine(emp, { deductions }, '2026-11');
  assert.ok(line.netPay < 0, 'Net pay is negative');
  assert.ok(line.flags.includes('NEGATIVE_NET'), 'Must flag NEGATIVE_NET per BRL-09');
});

test('FR-PAY-09: Register totals shall reconcile (Gross - deductions = Net at employee and total levels, bank schedule total)', () => {
  const lines = [
    {
      empId: 'E1', name: 'A', gross: 200000, pension: 16000, nhf: 3000, paye: 15000,
      loanDeduction: 10000, otherDeductions: 1000, netPay: 155000, flags: []
    },
    {
      empId: 'E2', name: 'B', gross: 300000, pension: 24000, nhf: 4500, paye: 35000,
      loanDeduction: 0, otherDeductions: 0, netPay: 236500, flags: []
    },
  ];

  const bankSchedule = { totalNetPay: 391500, controlTotal: 391500 };
  const reconValid = reconcilePayrollRegister(lines, bankSchedule);

  assert.strictEqual(reconValid.passed, true);
  assert.strictEqual(reconValid.discrepancies.length, 0);
  assert.strictEqual(reconValid.totals.net, 391500);

  // Inject line discrepancy
  const linesBad = [
    {
      empId: 'E1', name: 'A', gross: 200000, pension: 16000, nhf: 3000, paye: 15000,
      loanDeduction: 10000, otherDeductions: 1000, netPay: 160000, flags: [] // Net off by 5000
    },
  ];
  const reconBad = reconcilePayrollRegister(linesBad, { totalNetPay: 160000 });
  assert.strictEqual(reconBad.passed, false);
  assert.ok(reconBad.discrepancies.some((d) => d.type === 'LINE_IMBALANCE'));
  assert.ok(reconBad.discrepancies.some((d) => d.type === 'TOTAL_IMBALANCE'));

  // Inject bank schedule mismatch
  const reconBankMismatch = reconcilePayrollRegister(lines, { totalNetPay: 380000 });
  assert.strictEqual(reconBankMismatch.passed, false);
  assert.ok(reconBankMismatch.discrepancies.some((d) => d.type === 'BANK_SCHEDULE_MISMATCH'));
});

test('FR-PAY-10: Variance analysis compares employee Gross and Net against previous period with configurable threshold', () => {
  const prevLines = [
    { empId: 'E1', name: 'Employee 1', department: 'Operations', gross: 100000, netPay: 80000 },
    { empId: 'E2', name: 'Employee 2', department: 'Operations', gross: 200000, netPay: 160000 },
  ];

  const curLines = [
    { empId: 'E1', name: 'Employee 1', department: 'Operations', gross: 125000, netPay: 98000 }, // 25% gross increase -> above 10%
    { empId: 'E2', name: 'Employee 2', department: 'Operations', gross: 202000, netPay: 161000 }, // 1% change -> within 10%
  ];

  const varianceResult = calculatePayrollVariance(curLines, prevLines, 0.10);
  assert.strictEqual(varianceResult.totalEmployees, 2);
  assert.strictEqual(varianceResult.flaggedCount, 1);
  assert.strictEqual(varianceResult.hasVariancesAboveThreshold, true);

  const e1Var = varianceResult.variances.find((v) => v.empId === 'E1');
  assert.strictEqual(e1Var.flagged, true);
  assert.strictEqual(e1Var.grossDifference, 25000);
  assert.strictEqual(e1Var.grossPctChange, 25);

  const e2Var = varianceResult.variances.find((v) => v.empId === 'E2');
  assert.strictEqual(e2Var.flagged, false);
});
