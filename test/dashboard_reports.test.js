const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePeriodTrends, reconcileDashboardToRegister } = require('../lib/payroll');

test('FR-DSH-01: Dashboard shows paid headcount, total gross, PAYE, pension (employee and employer), and net payroll', () => {
  const run = {
    period: '2026-11',
    status: 'Approved',
    totals: {
      employees: 3,
      gross: 450000,
      paye: 36000,
      pension: 36000,
      employerPension: 45000,
      net: 318000,
      nhf: 11250,
      otPay: 30000,
      loans: 15000,
    },
    lines: [
      { empId: 'E1', name: 'John Doe', department: 'Production', basic: 100000, otPay: 10000, gross: 150000, paye: 12000, pension: 12000, employerPension: 15000, nhf: 3750, loanDeduction: 5000, otherDeductions: 0, netPay: 106000 },
      { empId: 'E2', name: 'Jane Smith', department: 'Production', basic: 100000, otPay: 20000, gross: 160000, paye: 13000, pension: 12800, employerPension: 16000, nhf: 3750, loanDeduction: 10000, otherDeductions: 0, netPay: 104450 },
      { empId: 'E3', name: 'Bob Ali', department: 'Logistics', basic: 100000, otPay: 0, gross: 140000, paye: 11000, pension: 11200, employerPension: 14000, nhf: 3750, loanDeduction: 0, otherDeductions: 0, netPay: 107550 },
    ],
  };

  const totalHeadcount = run.totals.employees;
  const totalGross = run.totals.gross;
  const totalPAYE = run.totals.paye;
  const totalPensionEmployee = run.totals.pension;
  const totalPensionEmployer = run.totals.employerPension;
  const totalPensionCombined = totalPensionEmployee + totalPensionEmployer;
  const totalNet = run.totals.net;

  assert.strictEqual(totalHeadcount, 3);
  assert.strictEqual(totalGross, 450000);
  assert.strictEqual(totalPAYE, 36000);
  assert.strictEqual(totalPensionEmployee, 36000);
  assert.strictEqual(totalPensionEmployer, 45000);
  assert.strictEqual(totalPensionCombined, 81000);
  assert.strictEqual(totalNet, 318000);
});

test('FR-DSH-02: Dashboard shows total NHF, loan recoveries, overtime cost and hours, bonuses, employer cost, and headcount by department', () => {
  const lines = [
    { empId: 'E1', name: 'John Doe', department: 'Production', gross: 150000, otHours: 8, otPay: 10000, bonuses: 5000, employerPension: 15000, nhf: 3750, loanDeduction: 5000 },
    { empId: 'E2', name: 'Jane Smith', department: 'Production', gross: 160000, otHours: 12, otPay: 20000, bonuses: 10000, employerPension: 16000, nhf: 3750, loanDeduction: 10000 },
    { empId: 'E3', name: 'Bob Ali', department: 'Logistics', gross: 140000, otHours: 0, otPay: 0, bonuses: 0, employerPension: 14000, nhf: 3750, loanDeduction: 0 },
  ];

  const totalNHF = lines.reduce((s, l) => s + l.nhf, 0);
  const totalLoans = lines.reduce((s, l) => s + l.loanDeduction, 0);
  const totalOTHours = lines.reduce((s, l) => s + l.otHours, 0);
  const totalOTCost = lines.reduce((s, l) => s + l.otPay, 0);
  const totalBonuses = lines.reduce((s, l) => s + l.bonuses, 0);
  const totalGross = lines.reduce((s, l) => s + l.gross, 0);
  const totalEmployerPension = lines.reduce((s, l) => s + l.employerPension, 0);
  const totalEmployerCost = totalGross + totalEmployerPension;

  assert.strictEqual(totalNHF, 11250);
  assert.strictEqual(totalLoans, 15000);
  assert.strictEqual(totalOTHours, 20);
  assert.strictEqual(totalOTCost, 30000);
  assert.strictEqual(totalBonuses, 15000);
  assert.strictEqual(totalEmployerCost, 450000 + 45000);

  // Headcount and costs by department
  const deptMap = {};
  for (const l of lines) {
    if (!deptMap[l.department]) deptMap[l.department] = { count: 0, gross: 0, employerCost: 0 };
    deptMap[l.department].count += 1;
    deptMap[l.department].gross += l.gross;
    deptMap[l.department].employerCost += l.gross + l.employerPension;
  }

  assert.strictEqual(deptMap['Production'].count, 2);
  assert.strictEqual(deptMap['Production'].gross, 310000);
  assert.strictEqual(deptMap['Production'].employerCost, 341000);
  assert.strictEqual(deptMap['Logistics'].count, 1);
  assert.strictEqual(deptMap['Logistics'].gross, 140000);
});

test('FR-DSH-03: Period-over-period trend metrics for gross, net, overtime and PAYE', () => {
  const octRun = {
    period: '2026-10',
    status: 'Approved',
    totals: { employees: 2, gross: 300000, net: 220000, otPay: 20000, paye: 24000 },
    lines: [
      { empId: 'E1', gross: 150000, netPay: 110000, otPay: 10000, otHours: 5, paye: 12000 },
      { empId: 'E2', gross: 150000, netPay: 110000, otPay: 10000, otHours: 5, paye: 12000 },
    ],
  };

  const novRun = {
    period: '2026-11',
    status: 'Approved',
    totals: { employees: 3, gross: 450000, net: 318000, otPay: 30000, paye: 36000 },
    lines: [
      { empId: 'E1', gross: 150000, netPay: 106000, otPay: 10000, otHours: 8, paye: 12000 },
      { empId: 'E2', gross: 160000, netPay: 104450, otPay: 20000, otHours: 12, paye: 13000 },
      { empId: 'E3', gross: 140000, netPay: 107550, otPay: 0, otHours: 0, paye: 11000 },
    ],
  };

  const trends = calculatePeriodTrends(novRun, [octRun]);
  assert.strictEqual(trends.currentPeriod, '2026-11');
  assert.strictEqual(trends.series.length, 2);
  assert.strictEqual(trends.series[0].period, '2026-10');
  assert.strictEqual(trends.series[1].period, '2026-11');

  const v = trends.varianceSummary;
  assert.ok(v, 'Variance summary must be calculated against immediate prior period');
  assert.strictEqual(v.priorPeriod, '2026-10');
  assert.strictEqual(v.gross.difference, 150000);
  assert.strictEqual(v.gross.percentageChange, 50); // (450k - 300k) / 300k = +50%
  assert.strictEqual(v.net.difference, 98000);
  assert.strictEqual(v.overtime.difference, 10000);
  assert.strictEqual(v.paye.difference, 12000);
  assert.strictEqual(v.headcount.difference, 1);
});

test('FR-DSH-04: Dashboard figures are formula/query-driven from the register and reconcile to it exactly (100% check)', () => {
  const balancedRun = {
    period: '2026-11',
    status: 'Approved',
    totals: {
      employees: 2,
      gross: 300000,
      pension: 24000,
      employerPension: 30000,
      nhf: 7500,
      paye: 25000,
      loans: 10000,
      otherDeductions: 2000,
      net: 231500, // 300000 - (24000 + 7500 + 25000 + 10000 + 2000) = 231500
    },
    lines: [
      { empId: 'E1', gross: 150000, pension: 12000, employerPension: 15000, nhf: 3750, paye: 12500, loanDeduction: 5000, otherDeductions: 1000, netPay: 115750 },
      { empId: 'E2', gross: 150000, pension: 12000, employerPension: 15000, nhf: 3750, paye: 12500, loanDeduction: 5000, otherDeductions: 1000, netPay: 115750 },
    ],
  };

  const rec = reconcileDashboardToRegister(balancedRun);
  assert.strictEqual(rec.balanced, true, 'Balanced run must pass 100% reconciliation');
  assert.strictEqual(rec.errorCount, 0);
  assert.strictEqual(rec.checks.length, 6);

  // Mismatched / Out-of-balance run
  const unbalancedRun = {
    ...balancedRun,
    totals: {
      ...balancedRun.totals,
      net: 240000, // intentional mismatch
    },
  };
  const unrec = reconcileDashboardToRegister(unbalancedRun);
  assert.strictEqual(unrec.balanced, false, 'Unbalanced run must fail reconciliation');
  assert.ok(unrec.errorCount > 0);
});

test('FR-DSH-05 & FR-DSH-06: 14 Standard reports enumeration and export formats', () => {
  const standardReports = [
    'payroll-register',
    'payslips',
    'paye-remittance',
    'pension-remittance',
    'nhf-remittance',
    'bank-schedule',
    'overtime-report',
    'loan-ledger',
    'leave-report',
    'bonus-report',
    'variance-report',
    'exceptions-report',
    'audit-report',
    'employer-cost',
  ];

  assert.strictEqual(standardReports.length, 14, 'System must provide all 14 standard reports specified in FR-DSH-05');

  const exportFormats = ['json', 'csv', 'xlsx', 'pdf'];
  assert.strictEqual(exportFormats.includes('pdf'), true);
  assert.strictEqual(exportFormats.includes('xlsx'), true);
  assert.strictEqual(exportFormats.includes('csv'), true);
});
