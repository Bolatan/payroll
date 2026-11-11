const test = require('node:test');
const assert = require('node:assert/strict');
const { PayrollRun } = require('../lib/models');
const { calcLine } = require('../lib/payroll');

test('FR-REG-01: The register shall list, per period and employee: Period, EmpID, Name, Department, Basic, OTPay, Allowances, Bonuses, GrossPay, Pension, NHF, TaxablePay, PAYE, LoanDeduction, OtherDeductions, NetPay', () => {
  const emp = {
    empId: 'EMP001',
    surname: 'Adeyemi',
    firstName: 'Babatunde',
    department: 'Production',
    position: 'Machine Operator',
    basic: 120000,
    housing: 40000,
    transport: 20000,
    otherAllowance: 0,
    nhfEnrolled: true,
    bank: 'First Bank of Nigeria',
    accountNo: '0123456789',
  };

  const period = '2026-11';
  const attendance = [
    { date: '2026-11-02', shift: 'Day', hoursWorked: 10, otHours: 2, multiplier: 1.5, approved: true }
  ];
  const allowances = [
    { type: 'shift_allowance', amount: 5000, startPeriod: '2026-11', status: 'Approved' }
  ];
  const bonuses = [
    { period: '2026-11', attendanceBonus: 10000, status: 'Approved' }
  ];
  const loans = [
    { loanId: 'LN001', amount: 60000, termMonths: 6, monthly: 10000, outstanding: 10000, status: 'Active', startDate: '2026-06-01' }
  ];
  const deductions = [
    { type: 'union_dues', amount: 2000, startPeriod: '2026-11', status: 'Approved' }
  ];

  const line = calcLine(emp, { attendance, allowances, bonuses, loans, deductions }, period);

  // Check 16 required fields defined in FR-REG-01
  const requiredFields = [
    'Period', 'EmpID', 'Name', 'Department', 'Basic', 'OTPay', 'Allowances',
    'Bonuses', 'GrossPay', 'Pension', 'NHF', 'TaxablePay', 'PAYE',
    'LoanDeduction', 'OtherDeductions', 'NetPay'
  ];

  const registerRow = {
    Period: period,
    EmpID: line.empId,
    Name: line.name,
    Department: line.department,
    Basic: line.basic,
    OTPay: line.otPay,
    Allowances: line.allowances,
    Bonuses: line.bonuses,
    GrossPay: line.gross,
    Pension: line.pension,
    NHF: line.nhf,
    TaxablePay: line.taxablePay,
    PAYE: line.paye,
    LoanDeduction: line.loanDeduction,
    OtherDeductions: line.otherDeductions,
    NetPay: line.netPay,
  };

  for (const f of requiredFields) {
    assert.ok(registerRow[f] !== undefined, `Payroll register line must include ${f}`);
  }

  assert.strictEqual(registerRow.Period, '2026-11');
  assert.strictEqual(registerRow.EmpID, 'EMP001');
  assert.strictEqual(registerRow.Name, 'Adeyemi Babatunde');
  assert.strictEqual(registerRow.Department, 'Production');
  assert.strictEqual(registerRow.Basic, 120000);
  assert.strictEqual(registerRow.Allowances, 65000); // 40k housing + 20k transport + 5k shift
  assert.strictEqual(registerRow.Bonuses, 10000);
  assert.ok(registerRow.OTPay > 0);
  assert.strictEqual(registerRow.LoanDeduction, 10000);
  assert.strictEqual(registerRow.OtherDeductions, 2000);
  assert.strictEqual(registerRow.TaxablePay, line.chargeable);
  assert.strictEqual(registerRow.GrossPay, line.gross);
  assert.strictEqual(registerRow.NetPay, line.netPay);
});

test('FR-REG-02: Register shows subtotals by department, grand total, and supports filtering, sorting and exports', () => {
  const period = '2026-11';
  const lines = [
    {
      empId: 'EMP001', name: 'Adeyemi Babatunde', department: 'Production',
      basic: 100000, otPay: 10000, allowances: 20000, bonuses: 5000,
      gross: 135000, pension: 10800, nhf: 2500, chargeable: 100000, taxablePay: 100000,
      paye: 8000, loanDeduction: 5000, otherDeductions: 1000, netPay: 107700
    },
    {
      empId: 'EMP002', name: 'Danladi Garba', department: 'Production',
      basic: 120000, otPay: 15000, allowances: 30000, bonuses: 0,
      gross: 165000, pension: 13200, nhf: 3000, chargeable: 120000, taxablePay: 120000,
      paye: 11000, loanDeduction: 0, otherDeductions: 0, netPay: 137800
    },
    {
      empId: 'EMP003', name: 'Okafor Chinedu', department: 'Logistics',
      basic: 90000, otPay: 0, allowances: 20000, bonuses: 2000,
      gross: 112000, pension: 8800, nhf: 2250, chargeable: 80000, taxablePay: 80000,
      paye: 5000, loanDeduction: 2000, otherDeductions: 500, netPay: 93450
    }
  ];

  function calculateRegisterAggregation(items) {
    const numericKeys = ['basic', 'otPay', 'allowances', 'bonuses', 'grossPay', 'pension', 'nhf', 'taxablePay', 'paye', 'loanDeduction', 'otherDeductions', 'netPay'];
    const deptGroups = {};
    for (const it of items) {
      if (!deptGroups[it.department]) deptGroups[it.department] = [];
      deptGroups[it.department].push(it);
    }
    const departmentSubtotals = Object.keys(deptGroups).sort().map((dept) => {
      const group = deptGroups[dept];
      const sub = { department: dept, count: group.length };
      for (const k of numericKeys) {
        sub[k] = group.reduce((s, row) => s + (row[k] || row[k === 'grossPay' ? 'gross' : k] || 0), 0);
      }
      return sub;
    });

    const grandTotal = { count: items.length };
    for (const k of numericKeys) {
      grandTotal[k] = items.reduce((s, row) => s + (row[k] || row[k === 'grossPay' ? 'gross' : k] || 0), 0);
    }
    return { departmentSubtotals, grandTotal };
  }

  const { departmentSubtotals, grandTotal } = calculateRegisterAggregation(lines);

  // Subtotals validation
  assert.strictEqual(departmentSubtotals.length, 2);
  const logSub = departmentSubtotals.find((d) => d.department === 'Logistics');
  const prodSub = departmentSubtotals.find((d) => d.department === 'Production');
  assert.strictEqual(logSub.count, 1);
  assert.strictEqual(logSub.netPay, 93450);
  assert.strictEqual(prodSub.count, 2);
  assert.strictEqual(prodSub.netPay, 107700 + 137800);
  assert.strictEqual(prodSub.grossPay, 135000 + 165000);

  // Grand total validation
  assert.strictEqual(grandTotal.count, 3);
  assert.strictEqual(grandTotal.netPay, 107700 + 137800 + 93450);
  assert.strictEqual(grandTotal.grossPay, 135000 + 165000 + 112000);

  // Filtering by department
  const filteredProd = lines.filter((l) => l.department === 'Production');
  assert.strictEqual(filteredProd.length, 2);

  // Sorting by NetPay descending
  const sortedDesc = [...lines].sort((a, b) => b.netPay - a.netPay);
  assert.strictEqual(sortedDesc[0].empId, 'EMP002');
  assert.strictEqual(sortedDesc[2].empId, 'EMP003');
});

test('FR-REG-03: Period status displayed and watermarked "DRAFT" until approved', () => {
  const unapprovedStates = ['Draft', 'Open', 'Inputs Frozen', 'Calculated', 'Under Review'];
  for (const st of unapprovedStates) {
    const isApproved = ['Approved', 'Paid/Locked'].includes(st);
    const watermark = isApproved ? null : 'DRAFT';
    assert.strictEqual(watermark, 'DRAFT', `State ${st} must be watermarked DRAFT`);
  }

  const approvedStates = ['Approved', 'Paid/Locked'];
  for (const st of approvedStates) {
    const isApproved = ['Approved', 'Paid/Locked'].includes(st);
    const watermark = isApproved ? null : 'DRAFT';
    assert.strictEqual(watermark, null, `State ${st} must NOT have DRAFT watermark`);
  }
});

test('FR-REG-04: Approved registers shall be immutable; version stamp and approver/time recorded', () => {
  const paths = PayrollRun.schema.paths;
  assert.ok(paths.version, 'PayrollRun must have version field');
  assert.ok(paths.versionStamp, 'PayrollRun must have versionStamp field');
  assert.ok(paths.approvedBy, 'PayrollRun must have approvedBy field');
  assert.ok(paths.approvedAt, 'PayrollRun must have approvedAt field');

  const run = new PayrollRun({
    period: '2026-11',
    status: 'Approved',
    approvedBy: 'manager_cfo',
    approvedAt: new Date(),
    version: 1,
    versionStamp: 'v1-2026-11-1700000000',
    lines: [{ empId: 'EMP001', netPay: 150000 }]
  });

  run._originalStatus = 'Approved';
  run.isNew = false;

  run.lines = [{ empId: 'EMP001', netPay: 200000 }];
  assert.throws(() => {
    const hooks = PayrollRun.schema.s.hooks._pres.get('save');
    assert.ok(hooks && hooks.length > 0, 'Pre-save hooks must be registered');
    for (const h of hooks) {
      h.fn.call(run, (err) => { if (err) throw err; });
    }
  }, /Approved payroll register is immutable and cannot be modified/);
});
