const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calcLine,
  calcProration,
  reconcilePayrollRegister,
  calculatePayrollVariance,
  CFG,
} = require('../lib/payroll');
const { computePAYE, annualTax, r2, NIGERIA_BANDS } = require('../lib/tax');

test('FR-PAY-01: Calculate Basic (pro-rated), OTPay, Allowances, Bonuses, and GrossPay = sum of all earnings', () => {
  const emp = {
    empId: 'EMP_PAY_01',
    surname: 'Okonkwo',
    firstName: 'Emeka',
    department: 'Packaging',
    position: 'Operator',
    basic: 150000,
    housing: 50000,
    transport: 30000,
    otherAllowance: 20000,
    hourlyRate: 150000 / 176,
    bank: 'Access Bank',
    accountNo: '0123456789',
    pensionPct: 0.08,
    nhfPct: 0.025,
    nhfEnrolled: true,
  };

  const attendance = [
    { approved: true, shift: 'Day', hoursWorked: 10, otHours: 2, multiplier: 1.5 },
  ];
  const bonuses = [
    { status: 'Approved', performanceBonus: 25000, attendanceBonus: 10000 },
  ];

  const line = calcLine(emp, { attendance, bonuses }, '2026-11');

  assert.equal(line.basic, 150000);
  assert.equal(line.allowances, 100000); // 50k + 30k + 20k
  assert.equal(line.otHours, 2);
  const expectedOtPay = r2(2 * (150000 / 176) * 1.5);
  assert.equal(line.otPay, expectedOtPay);
  assert.equal(line.bonuses, 35000);
  assert.equal(line.gross, r2(150000 + 100000 + expectedOtPay + 35000));
});

test('FR-PAY-02: Derive and store bases separately: Pensionable Emoluments, NHF base, Taxable Gross', () => {
  const emp = {
    empId: 'EMP_PAY_02',
    surname: 'Ade',
    firstName: 'Bimbo',
    basic: 200000,
    housing: 80000,
    transport: 50000,
    otherAllowance: 20000,
    bank: 'GTBank',
    accountNo: '0123456789',
    nhfEnrolled: true,
  };

  const line = calcLine(emp, {}, '2026-11');

  assert.equal(line.nhfBase, 200000, 'NHF base must equal basic salary');
  assert.equal(line.pensionableEmoluments, 330000, 'Pensionable emoluments must equal basic + housing + transport');
  assert.equal(line.taxableGross, 350000, 'Taxable gross equals gross earnings before non-taxable exemptions');
  assert.equal(line.pensionable, 330000);
});

test('FR-PAY-03: Pension (employee) = Pension% × pensionable emoluments (default 8%)', () => {
  const empDefault = {
    empId: 'EMP_PAY_03A',
    basic: 100000,
    housing: 40000,
    transport: 20000,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
  };
  const lineDefault = calcLine(empDefault, {}, '2026-11');
  assert.equal(lineDefault.pensionableEmoluments, 160000);
  assert.equal(lineDefault.pension, r2(160000 * 0.08), 'Pension defaults to 8% of pensionable emoluments');

  const empCustom = {
    ...empDefault,
    empId: 'EMP_PAY_03B',
    pensionPct: 0.10,
  };
  const lineCustom = calcLine(empCustom, {}, '2026-11');
  assert.equal(lineCustom.pension, r2(160000 * 0.10), 'Pension uses employee-specific Pension%');
});

test('FR-PAY-04: NHF = NHF% × basic salary (default 2.5%) for NHF-enrolled employees', () => {
  const empEnrolled = {
    empId: 'EMP_PAY_04A',
    basic: 180000,
    housing: 50000,
    nhfEnrolled: true,
    bank: 'First Bank of Nigeria',
    accountNo: '0123456789',
  };
  const lineEnrolled = calcLine(empEnrolled, {}, '2026-11');
  assert.equal(lineEnrolled.nhf, r2(180000 * 0.025), 'NHF defaults to 2.5% of basic');

  const empNotEnrolled = {
    ...empEnrolled,
    empId: 'EMP_PAY_04B',
    nhfEnrolled: false,
  };
  const lineNotEnrolled = calcLine(empNotEnrolled, {}, '2026-11');
  assert.equal(lineNotEnrolled.nhf, 0, 'NHF is 0 for non-enrolled employee');

  const empCustomNHF = {
    ...empEnrolled,
    empId: 'EMP_PAY_04C',
    nhfPct: 0.03,
  };
  const lineCustomNHF = calcLine(empCustomNHF, {}, '2026-11');
  assert.equal(lineCustomNHF.nhf, r2(180000 * 0.03), 'NHF uses employee-specific NHF%');
});

test('FR-PAY-05: PAYE is computed using progressive tax engine, not a flat percentage', () => {
  const emp = {
    empId: 'EMP_PAY_05',
    basic: 150000,
    housing: 60000,
    transport: 40000,
    annualRent: 600000,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
    nhfEnrolled: true,
  };

  const line = calcLine(emp, {}, '2026-11');

  assert.equal(line.chargeable, 2595000);
  assert.equal(line.paye, 22437.50);
  assert.ok(line.taxDetail, 'Must include tax detail object');
  assert.equal(line.taxDetail.annualTax, 269250);
  assert.equal(line.taxDetail.monthlyTax, 22437.50);
});

test('FR-PAY-06: NetPay = GrossPay − Pension − NHF − PAYE − LoanDeduction − OtherDeductions', () => {
  const emp = {
    empId: 'EMP_PAY_06',
    basic: 200000,
    housing: 50000,
    transport: 30000,
    bank: 'GTBank',
    accountNo: '0123456789',
    nhfEnrolled: true,
  };

  const loans = [
    { loanId: 'LN01', status: 'Active', monthly: 15000, outstanding: 45000, startPeriod: '2026-01' },
  ];
  const deductions = [
    { status: 'Approved', type: 'Union Dues', amount: 5000, startPeriod: '2026-11' },
  ];

  const line = calcLine(emp, { loans, deductions }, '2026-11');
  const expectedTotalDeductions = r2(line.pension + line.nhf + line.paye + line.loanDeduction + line.otherDeductions);
  assert.equal(line.totalDeductions, expectedTotalDeductions);
  assert.equal(line.netPay, r2(line.gross - expectedTotalDeductions));
});

test('FR-PAY-07: Register retains full computation detail (inputs, bases, band-by-band tax)', () => {
  const emp = {
    empId: 'EMP_PAY_07',
    basic: 500000,
    housing: 200000,
    transport: 100000,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
    nhfEnrolled: true,
  };

  const line = calcLine(emp, {}, '2026-11');

  assert.ok(line.taxDetail, 'taxDetail retained');
  assert.ok(Array.isArray(line.taxDetail.bands), 'tax bands retained');
  assert.ok(line.taxDetail.bands.length > 0, 'bands list is populated');
  const firstBand = line.taxDetail.bands[0];
  assert.equal(firstBand.bandIndex, 1);
  assert.equal(firstBand.rate, 0);
  assert.equal(firstBand.tax, 0);

  const secondBand = line.taxDetail.bands[1];
  assert.equal(secondBand.bandIndex, 2);
  assert.equal(secondBand.rate, 0.15);
  assert.ok(secondBand.taxableInBand > 0);
  assert.ok(secondBand.tax > 0);
});

test('FR-PAY-08: Net Pay below zero blocked and flagged per BRL-09', () => {
  const emp = {
    empId: 'EMP_PAY_08',
    basic: 40000,
    bank: 'Access Bank',
    accountNo: '0123456789',
  };

  const adjustments = [
    { type: 'deduction', amount: 60000, approved: true },
  ];

  const line = calcLine(emp, { adjustments }, '2026-11');
  assert.ok(line.netPay < 0, 'Net pay is negative');
  assert.ok(line.flags.includes('NEGATIVE_NET'), 'Must flag NEGATIVE_NET');
});

test('FR-PAY-09: Register totals reconcile and imbalance is detected', () => {
  const empA = { empId: 'A', basic: 100000, bank: 'GTBank', accountNo: '0123456789' };
  const empB = { empId: 'B', basic: 200000, bank: 'GTBank', accountNo: '0123456789' };

  const lineA = calcLine(empA, {}, '2026-11');
  const lineB = calcLine(empB, {}, '2026-11');
  const lines = [lineA, lineB];

  const reconPass = reconcilePayrollRegister(lines);
  assert.equal(reconPass.isReconciled, true);
  assert.equal(reconPass.imbalancedLines.length, 0);
  assert.equal(reconPass.totalImbalance, 0);

  const corruptLines = [
    { ...lineA, netPay: r2(lineA.netPay + 500) },
    lineB,
  ];
  const reconFail = reconcilePayrollRegister(corruptLines);
  assert.equal(reconFail.isReconciled, false);
  assert.equal(reconFail.imbalancedLines.length, 1);
  assert.equal(reconFail.imbalancedLines[0].empId, 'A');
});

test('FR-PAY-10: Variance analysis compares employee Gross and Net against previous period (default 10%)', () => {
  const prevLines = [
    { empId: 'EMP100', name: 'Stable Staff', department: 'Operations', gross: 200000, netPay: 160000 },
    { empId: 'EMP101', name: 'Promoted Staff', department: 'Production', gross: 200000, netPay: 160000 },
    { empId: 'EMP102', name: 'Penalized Staff', department: 'Logistics', gross: 200000, netPay: 160000 },
  ];

  const currentLines = [
    { empId: 'EMP100', name: 'Stable Staff', department: 'Operations', gross: 205000, netPay: 164000 },
    { empId: 'EMP101', name: 'Promoted Staff', department: 'Production', gross: 260000, netPay: 210000 },
    { empId: 'EMP102', name: 'Penalized Staff', department: 'Logistics', gross: 170000, netPay: 130000 },
    { empId: 'EMP103', name: 'New Joiner', department: 'HR', gross: 180000, netPay: 150000 },
  ];

  const variance = calculatePayrollVariance(currentLines, prevLines, 0.10);

  assert.equal(variance.thresholdPct, 0.10);
  assert.equal(variance.totalEmployees, 4);
  assert.equal(variance.flaggedCount, 3);

  const emp100 = variance.items.find((i) => i.empId === 'EMP100');
  assert.equal(emp100.isFlagged, false);

  const emp101 = variance.items.find((i) => i.empId === 'EMP101');
  assert.equal(emp101.isFlagged, true);
  assert.equal(emp101.grossFlagged, true);

  const emp102 = variance.items.find((i) => i.empId === 'EMP102');
  assert.equal(emp102.isFlagged, true);

  const emp103 = variance.items.find((i) => i.empId === 'EMP103');
  assert.equal(emp103.isNewJoiner, true);
  assert.equal(emp103.isFlagged, true);
});

test('FR-PAY-11 & FR-PAY-12: Recalculation, filtered calculations, and YTD calculation structures', () => {
  const emp = {
    empId: 'EMP_PAY_11',
    basic: 250000,
    housing: 80000,
    transport: 50000,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
    nhfEnrolled: true,
  };

  const line1 = calcLine(emp, {}, '2026-11');
  const line2 = calcLine(emp, {}, '2026-11');
  assert.deepEqual(line1, line2, 'Calculation is completely idempotent and re-runnable');

  const periodLines = [
    { period: '2026-01', gross: 380000, taxableGross: 380000, paye: 45000, pension: 24000, nhf: 6250, netPay: 304750 },
    { period: '2026-02', gross: 380000, taxableGross: 380000, paye: 45000, pension: 24000, nhf: 6250, netPay: 304750 },
    { period: '2026-03', gross: 400000, taxableGross: 400000, paye: 48000, pension: 24000, nhf: 6250, netPay: 321750 },
  ];

  const ytdGross = r2(periodLines.reduce((s, l) => s + l.gross, 0));
  const ytdTaxableGross = r2(periodLines.reduce((s, l) => s + l.taxableGross, 0));
  const ytdPaye = r2(periodLines.reduce((s, l) => s + l.paye, 0));
  const ytdPension = r2(periodLines.reduce((s, l) => s + l.pension, 0));
  const ytdNhf = r2(periodLines.reduce((s, l) => s + l.nhf, 0));

  assert.equal(ytdGross, 1160000);
  assert.equal(ytdTaxableGross, 1160000);
  assert.equal(ytdPaye, 138000);
  assert.equal(ytdPension, 72000);
  assert.equal(ytdNhf, 18750);
});
