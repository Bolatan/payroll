const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePeriodTrends,
  reconcileDashboardToRegister,
  STANDARD_REPORTS,
  normalizeReportType,
  generateStandardReport,
  exportReportCSV,
  exportReportXLSX,
  exportReportPDF,
} = require('../lib/payroll');
const { r2 } = require('../lib/tax');

/**
 * Test Suite: Dashboard and Reports (FR-DSH-01 through FR-DSH-06)
 */

test('FR-DSH-01: Core KPIs verification (paid headcount, gross, PAYE, pension employee & employer, net)', () => {
  const currentRun = {
    period: '2026-11',
    status: 'Approved',
    lines: [
      { empId: 'EMP001', name: 'Adeyemi B', department: 'Production', gross: 250000, paye: 25000, pension: 20000, employerPension: 25000, nhf: 3000, loanDeduction: 10000, otherDeductions: 2000, netPay: 190000, otHours: 8, otPay: 20000, bonuses: 10000 },
      { empId: 'EMP002', name: 'Okafor C', department: 'Logistics', gross: 180000, paye: 15000, pension: 14400, employerPension: 18000, nhf: 2500, loanDeduction: 0, otherDeductions: 0, netPay: 148100, otHours: 4, otPay: 10000, bonuses: 5000 },
      { empId: 'EMP003', name: 'Musa D', department: 'Production', gross: 0, paye: 0, pension: 0, employerPension: 0, nhf: 0, loanDeduction: 0, otherDeductions: 0, netPay: 0, otHours: 0, otPay: 0, bonuses: 0 },
    ],
    totals: {
      employees: 3,
      gross: 430000,
      paye: 40000,
      pension: 34400,
      employerPension: 43000,
      nhf: 5500,
      loans: 10000,
      otPay: 30000,
      net: 338100,
    },
  };

  const recon = reconcileDashboardToRegister(currentRun);
  assert.equal(recon.registerTotals.headcount, 3);
  assert.equal(recon.registerTotals.paidHeadcount, 2); // 2 employees with netPay > 0
  assert.equal(recon.registerTotals.gross, 430000);
  assert.equal(recon.registerTotals.paye, 40000);
  assert.equal(recon.registerTotals.pension, 34400); // employee pension
  assert.equal(recon.registerTotals.employerPension, 43000); // employer pension
  assert.equal(recon.registerTotals.net, 338100);
});

test('FR-DSH-02: Extended KPIs verification (NHF, loans, OT cost & hours, bonuses, total employer cost, dept headcount)', () => {
  const currentRun = {
    period: '2026-11',
    status: 'Approved',
    lines: [
      { empId: 'EMP001', name: 'Adeyemi B', department: 'Production', gross: 250000, paye: 25000, pension: 20000, employerPension: 25000, nhf: 3000, loanDeduction: 10000, otherDeductions: 2000, netPay: 190000, otHours: 10, otPay: 25000, bonuses: 15000 },
      { empId: 'EMP002', name: 'Okafor C', department: 'Logistics', gross: 180000, paye: 15000, pension: 14400, employerPension: 18000, nhf: 2500, loanDeduction: 5000, otherDeductions: 0, netPay: 143100, otHours: 5, otPay: 12000, bonuses: 5000 },
    ],
    totals: {
      employees: 2,
      gross: 430000,
      paye: 40000,
      pension: 34400,
      employerPension: 43000,
      nhf: 5500,
      loans: 15000,
      otPay: 37000,
      net: 333100,
    },
  };

  const trends = calculatePeriodTrends(currentRun, null);

  assert.equal(trends.gross.current, 430000);
  assert.equal(trends.overtimeCost.current, 37000);
  assert.equal(trends.overtimeHours.current, 15); // 10h + 5h
  assert.equal(trends.paye.current, 40000);

  // Total employer cost = gross (430,000) + employer pension (43,000) + statutory levies 2% (8,600) = 481,600
  const expectedLevies = r2(430000 * 0.02);
  assert.equal(expectedLevies, 8600);
  assert.equal(trends.employerCost.current, r2(430000 + 43000 + 8600));

  // Headcount by department
  assert.equal(trends.departmentTrends.length, 2);
  const prodDept = trends.departmentTrends.find((d) => d.department === 'Production');
  const logDept = trends.departmentTrends.find((d) => d.department === 'Logistics');
  assert.equal(prodDept.current.count, 1);
  assert.equal(prodDept.current.gross, 250000);
  assert.equal(prodDept.current.otPay, 25000);
  assert.equal(prodDept.current.otHours, 10);
  assert.equal(logDept.current.count, 1);
  assert.equal(logDept.current.gross, 180000);
});

test('FR-DSH-03: Period-over-period trend analysis for gross, net, overtime, PAYE, and department cost breakdown', () => {
  const previousRun = {
    period: '2026-10',
    lines: [
      { empId: 'EMP001', name: 'Adeyemi B', department: 'Production', gross: 200000, netPay: 150000, paye: 20000, otPay: 15000, otHours: 6, employerPension: 20000 },
      { empId: 'EMP002', name: 'Okafor C', department: 'Logistics', gross: 160000, netPay: 130000, paye: 12000, otPay: 8000, otHours: 4, employerPension: 16000 },
    ],
    totals: { employees: 2, gross: 360000, net: 280000, paye: 32000, otPay: 23000, employerPension: 36000 },
  };

  const currentRun = {
    period: '2026-11',
    lines: [
      { empId: 'EMP001', name: 'Adeyemi B', department: 'Production', gross: 250000, netPay: 190000, paye: 25000, otPay: 25000, otHours: 10, employerPension: 25000 },
      { empId: 'EMP002', name: 'Okafor C', department: 'Logistics', gross: 180000, netPay: 143100, paye: 15000, otPay: 12000, otHours: 5, employerPension: 18000 },
    ],
    totals: { employees: 2, gross: 430000, net: 333100, paye: 40000, otPay: 37000, employerPension: 43000 },
  };

  const trends = calculatePeriodTrends(currentRun, previousRun);

  assert.equal(trends.currentPeriod, '2026-11');
  assert.equal(trends.previousPeriod, '2026-10');

  // Gross Trend
  assert.equal(trends.gross.current, 430000);
  assert.equal(trends.gross.previous, 360000);
  assert.equal(trends.gross.delta, 70000);
  assert.equal(trends.gross.pctChange, r2((70000 / 360000) * 100));

  // Net Trend
  assert.equal(trends.net.current, 333100);
  assert.equal(trends.net.previous, 280000);
  assert.equal(trends.net.delta, 53100);

  // Overtime Cost Trend
  assert.equal(trends.overtimeCost.current, 37000);
  assert.equal(trends.overtimeCost.previous, 23000);
  assert.equal(trends.overtimeCost.delta, 14000);

  // Overtime Hours Trend
  assert.equal(trends.overtimeHours.current, 15);
  assert.equal(trends.overtimeHours.previous, 10);
  assert.equal(trends.overtimeHours.delta, 5);

  // PAYE Trend
  assert.equal(trends.paye.current, 40000);
  assert.equal(trends.paye.previous, 32000);
  assert.equal(trends.paye.delta, 8000);

  // Department cost breakdown comparison
  const prod = trends.departmentTrends.find((d) => d.department === 'Production');
  assert.equal(prod.current.gross, 250000);
  assert.equal(prod.previous.gross, 200000);
  assert.equal(prod.delta.gross, 50000);
  assert.equal(prod.pctChange.gross, 25);
});

test('FR-DSH-04: Exact reconciliation between dashboard totals and register lines with zero discrepancy tolerance', () => {
  const balancedRun = {
    period: '2026-11',
    lines: [
      { empId: 'E1', gross: 200000, pension: 16000, employerPension: 20000, nhf: 2500, paye: 15000, loanDeduction: 10000, otherDeductions: 1000, netPay: 155500, otPay: 12000, otHours: 5, bonuses: 5000 },
      { empId: 'E2', gross: 150000, pension: 12000, employerPension: 15000, nhf: 2000, paye: 10000, loanDeduction: 0, otherDeductions: 0, netPay: 126000, otPay: 8000, otHours: 3, bonuses: 0 },
    ],
    totals: {
      employees: 2,
      gross: 350000,
      net: 281500,
      paye: 25000,
      pension: 28000,
      employerPension: 35000,
      nhf: 4500,
      loans: 10000,
      otPay: 20000,
    },
  };

  const reconBalanced = reconcileDashboardToRegister(balancedRun);
  assert.equal(reconBalanced.reconciled, true);
  assert.equal(reconBalanced.discrepancyCount, 0);
  assert.equal(reconBalanced.discrepancies.length, 0);
  assert.equal(reconBalanced.tolerance, 0);

  // Test detection of intentional discrepancy
  const unbalancedRun = {
    ...balancedRun,
    totals: {
      ...balancedRun.totals,
      gross: 355000, // Discrepancy of ₦5,000 against register lines
    },
  };

  const reconUnbalanced = reconcileDashboardToRegister(unbalancedRun);
  assert.equal(reconUnbalanced.reconciled, false);
  assert.equal(reconUnbalanced.discrepancyCount >= 1, true);
  const grossDisc = reconUnbalanced.discrepancies.find((d) => d.field === 'gross');
  assert.ok(grossDisc);
  assert.equal(grossDisc.variance, 5000);
});

test('FR-DSH-05: 14 Standard Reports specification and generation', () => {
  // Confirm exactly 14 standard reports are defined in STANDARD_REPORTS
  assert.equal(STANDARD_REPORTS.length, 14);

  const expectedReportIds = [
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
    'employer-cost-report',
  ];

  for (const id of expectedReportIds) {
    const found = STANDARD_REPORTS.find((r) => r.id === id);
    assert.ok(found, `Report '${id}' must be included in STANDARD_REPORTS`);
  }

  // Alias normalization test
  assert.equal(normalizeReportType('register'), 'payroll-register');
  assert.equal(normalizeReportType('paye'), 'paye-remittance');
  assert.equal(normalizeReportType('pension'), 'pension-remittance');
  assert.equal(normalizeReportType('nhf'), 'nhf-remittance');
  assert.equal(normalizeReportType('bank'), 'bank-schedule');
  assert.equal(normalizeReportType('overtime'), 'overtime-report');
  assert.equal(normalizeReportType('loans'), 'loan-ledger');
  assert.equal(normalizeReportType('leaves'), 'leave-report');
  assert.equal(normalizeReportType('bonuses'), 'bonus-report');
  assert.equal(normalizeReportType('variance'), 'variance-report');
  assert.equal(normalizeReportType('exceptions'), 'exceptions-report');
  assert.equal(normalizeReportType('audit'), 'audit-report');
  assert.equal(normalizeReportType('employer_cost'), 'employer-cost-report');

  // Verify all 14 reports generate successfully
  const mockContext = {
    period: '2026-11',
    run: {
      period: '2026-11',
      lines: [
        { empId: 'EMP001', name: 'Adeyemi B', department: 'Production', basic: 120000, gross: 200000, netPay: 155000, paye: 15000, pension: 16000, employerPension: 20000, nhf: 3000, loanDeduction: 10000, otherDeductions: 1000, otPay: 20000, otHours: 8, bonuses: 10000, state: 'Lagos', tin: 'TIN001', pensionPin: 'PEN001', bank: 'Zenith Bank', accountNo: '0123456789' }
      ],
      totals: { employees: 1, gross: 200000, net: 155000, paye: 15000, pension: 16000, employerPension: 20000, nhf: 3000, loans: 10000, otPay: 20000 },
      exceptions: [{ empId: 'EMP001', type: 'INFO', message: 'Test exception' }],
    },
    previousRun: {
      period: '2026-10',
      lines: [{ empId: 'EMP001', name: 'Adeyemi B', gross: 180000, netPay: 140000 }],
    },
    attendance: [{ empId: 'EMP001', otHours: 8, hoursWorked: 48 }],
    repayments: [{ loanId: 'LN001', empId: 'EMP001', amountDeducted: 10000, balanceBefore: 50000, balanceAfter: 40000 }],
    loans: [{ loanId: 'LN001', empId: 'EMP001', outstanding: 40000 }],
    leaves: [{ empId: 'EMP001', leaveType: 'Annual', days: 5, status: 'Approved' }],
    bonuses: [{ empId: 'EMP001', performanceBonus: 10000 }],
    auditLogs: [{ user: 'admin', action: 'calculate', entity: 'PayrollRun', ts: new Date() }],
  };

  for (const id of expectedReportIds) {
    const report = generateStandardReport(id, mockContext);
    assert.equal(report.id, id);
    assert.ok(report.name);
    assert.ok(report.category);
    assert.ok(Array.isArray(report.headers));
    assert.ok(report.headers.length > 0);
    assert.ok(Array.isArray(report.rows));
    assert.ok(report.rows.length > 0);
  }
});

test('FR-DSH-06: Multi-format export to CSV, XLSX, and PDF across standard reports', () => {
  const report = generateStandardReport('payroll-register', {
    period: '2026-11',
    run: {
      period: '2026-11',
      lines: [
        { empId: 'EMP001', name: 'Adeyemi B', department: 'Production', basic: 100000, otPay: 10000, allowances: 20000, bonuses: 5000, gross: 135000, pension: 10800, nhf: 2500, taxablePay: 100000, paye: 8000, loanDeduction: 5000, otherDeductions: 1000, netPay: 107700 }
      ],
      totals: { employees: 1, gross: 135000, net: 107700, paye: 8000, pension: 10800, employerPension: 13500, nhf: 2500, loans: 5000, otPay: 10000 },
    },
  });

  // CSV Export verification
  const csv = exportReportCSV(report);
  assert.equal(typeof csv, 'string');
  assert.ok(csv.includes('# REPORT: Payroll Register'));
  assert.ok(csv.includes('# PERIOD: 2026-11'));
  assert.ok(csv.includes('Period,EmpID,Name,Department'));
  assert.ok(csv.includes('EMP001,Adeyemi B,Production'));

  // XLSX Export verification
  const xlsx = exportReportXLSX(report);
  assert.ok(Buffer.isBuffer(xlsx));
  assert.ok(xlsx.length > 100);
  // Zip/OpenXML file magic bytes: 0x50 0x4B 0x03 0x04 ('PK\x03\x04')
  assert.equal(xlsx.slice(0, 4).toString('hex'), '504b0304');

  // PDF Export verification
  const pdf = exportReportPDF(report);
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 100);
  // PDF header magic bytes: %PDF-
  assert.equal(pdf.slice(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.toString('binary').includes('%%EOF'));
});
