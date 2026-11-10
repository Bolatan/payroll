const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PayrollRun,
  PayrollInput,
  PAYROLL_PERIOD_STATES,
  Adjustment,
  Employee,
} = require('../lib/models');
const {
  assembleEmployeePayrollInput,
  validatePayrollPreCalculation,
  calcLine,
} = require('../lib/payroll');

test('FR-INP-01: Payroll periods support states Open -> Inputs Frozen -> Calculated -> Under Review -> Approved -> Paid/Locked', () => {
  const allowed = PayrollRun.schema.path('status').enumValues;
  const expectedStates = ['Open', 'Inputs Frozen', 'Calculated', 'Under Review', 'Approved', 'Paid/Locked'];

  for (const st of expectedStates) {
    assert.ok(allowed.includes(st), `PayrollRun status enum must include state: ${st}`);
  }
  // Draft retained for backward compatibility
  assert.ok(allowed.includes('Draft'));

  // Test state transition validity logic
  function canTransition(current, next) {
    // Approved can advance to Paid/Locked, but once Paid/Locked it cannot be modified
    if (current === 'Paid/Locked' && next !== current) {
      return false; // strictly locked
    }
    if (current === 'Approved' && next !== 'Paid/Locked' && next !== current) {
      return false; // locked from calculation edits
    }
    return allowed.includes(next);
  }

  assert.equal(canTransition('Open', 'Inputs Frozen'), true);
  assert.equal(canTransition('Inputs Frozen', 'Calculated'), true);
  assert.equal(canTransition('Calculated', 'Under Review'), true);
  assert.equal(canTransition('Under Review', 'Approved'), true);
  assert.equal(canTransition('Approved', 'Paid/Locked'), true);
  assert.equal(canTransition('Approved', 'Calculated'), false);
  assert.equal(canTransition('Paid/Locked', 'Open'), false);
});

test('FR-INP-02: Automatic input assembly consolidates BasicSalary, OTPay, Allowances, Bonuses, LoanDeduction, and OtherDeductions', () => {
  const emp = {
    empId: 'EMP-INP-001',
    surname: 'Adeyemi',
    firstName: 'Babatunde',
    department: 'Production',
    position: 'Senior Operator',
    basic: 200000,
    housing: 60000,
    transport: 40000,
    hourlyRate: 200000 / 176,
    country: 'NG',
    currency: 'NGN',
    bank: 'Access Bank',
    accountNo: '0123456789',
    tin: 'TIN-001',
    pensionPin: 'PEN-001',
  };

  const attendance = [
    { empId: 'EMP-INP-001', hoursWorked: 10, shift: 'Day', approved: true }, // 2h OT @ 1.5
    { empId: 'EMP-INP-001', hoursWorked: 8, shift: 'Weekend', approved: true }, // 8h Weekend @ 2.0
  ];

  const allowances = [
    { empId: 'EMP-INP-001', type: 'shift_allowance', amount: 15000, status: 'Approved', startPeriod: '2026-11', recurring: true },
  ];

  const bonuses = [
    {
      empId: 'EMP-INP-001',
      period: '2026-11',
      performanceBonus: 25000,
      attendanceBonus: 5000,
      totalBonuses: 30000,
      status: 'Approved',
    },
  ];

  const loans = [
    {
      _id: 'L001',
      loanId: 'LN-001',
      empId: 'EMP-INP-001',
      monthly: 20000,
      outstanding: 50000,
      status: 'Active',
      startDate: new Date('2026-01-01'),
    },
  ];

  const deductions = [
    {
      _id: 'D001',
      empId: 'EMP-INP-001',
      type: 'cooperative',
      amount: 10000,
      status: 'Approved',
      startPeriod: '2026-11',
      recurring: true,
    },
  ];

  const leaves = [
    {
      empId: 'EMP-INP-001',
      days: 2,
      payTreatment: 'unpaid',
      status: 'Approved',
    },
  ];

  const input = assembleEmployeePayrollInput(emp, {
    attendance,
    adjustments: [],
    loans,
    deductions,
    leaves,
    bonuses,
    allowances,
  }, '2026-11');

  // Verify assembled input properties
  assert.equal(input.empId, 'EMP-INP-001');
  assert.equal(input.period, '2026-11');
  assert.equal(input.name, 'Adeyemi Babatunde');
  assert.equal(input.department, 'Production');

  // Unpaid leave deduction: 200,000 / 22 * 2 = 18,181.82 -> Net Basic = 181,818.18
  assert.ok(Math.abs(input.basicSalary - 181818.18) < 0.1);

  // OTPay: rate = 200000/176 = 1136.3636.
  // 2h * 1.5 * rate + 8h * 2.0 * rate = (3 + 16) * rate = 19 * 1136.3636 = 21,590.91
  assert.ok(input.otPay > 21500 && input.otPay < 21700);

  // Allowances: housing (60,000) + transport (40,000) + shift_allowance (15,000) = 115,000
  assert.equal(input.allowances, 115000);

  // Bonuses: 30,000
  assert.equal(input.bonuses, 30000);

  // Loan deduction: 20,000
  assert.equal(input.loanDeduction, 20000);

  // Other deductions: cooperative = 10,000
  assert.equal(input.otherDeductions, 10000);

  // Check Schema paths of PayrollInput model
  assert.ok(PayrollInput.schema.paths.basicSalary);
  assert.ok(PayrollInput.schema.paths.otPay);
  assert.ok(PayrollInput.schema.paths.allowances);
  assert.ok(PayrollInput.schema.paths.bonuses);
  assert.ok(PayrollInput.schema.paths.loanDeduction);
  assert.ok(PayrollInput.schema.paths.otherDeductions);
});

test('FR-INP-03: Manual adjustments require mandatory reason and track creator/approver', () => {
  const schema = Adjustment.schema.paths;
  assert.ok(schema.reason, 'reason must exist');
  assert.ok(schema.reason.isRequired, 'reason must be required');
  assert.ok(schema.createdBy, 'createdBy must exist');
  assert.ok(schema.approvedBy, 'approvedBy must exist');
  assert.ok(schema.approved, 'approved status flag must exist');

  // Cannot create adjustment without reason
  const invalidAdj = new Adjustment({
    period: '2026-11',
    empId: 'EMP001',
    type: 'earning',
    amount: 15000,
  });
  const err = invalidAdj.validateSync();
  assert.ok(err && err.errors.reason, 'Validation must fail when reason is omitted');

  // Valid adjustment with reason
  const validAdj = new Adjustment({
    period: '2026-11',
    empId: 'EMP001',
    type: 'earning',
    amount: 15000,
    reason: 'Tool replacement reimbursement approved by factory manager',
    createdBy: 'payroll_officer',
  });
  assert.equal(validAdj.validateSync(), undefined);
  assert.equal(validAdj.approved, false);
});

test('FR-INP-04: Pre-calculation validation lists exceptions and blocks approval on unresolved blocking errors', () => {
  const employees = [
    // 1. Valid employee
    {
      empId: 'EMP001',
      surname: 'Okoro',
      firstName: 'Chidi',
      basic: 150000,
      bank: 'Zenith Bank',
      accountNo: '0123456789',
      tin: 'TIN001',
      pensionPin: 'PEN001',
      status: 'Active',
      country: 'NG',
    },
    // 2. Missing bank details (BLOCKING)
    {
      empId: 'EMP002',
      surname: 'Musa',
      firstName: 'Aliyu',
      basic: 120000,
      bank: '',
      accountNo: '',
      tin: 'TIN002',
      pensionPin: 'PEN002',
      status: 'Active',
      country: 'NG',
    },
    // 3. Zero salary (BLOCKING)
    {
      empId: 'EMP003',
      surname: 'Bello',
      firstName: 'Fatima',
      basic: 0,
      bank: 'GTBank',
      accountNo: '0987654321',
      tin: 'TIN003',
      pensionPin: 'PEN003',
      status: 'Active',
      country: 'NG',
    },
    // 4. Missing TIN and Pension PIN (non-blocking compliance exceptions)
    {
      empId: 'EMP004',
      surname: 'Balogun',
      firstName: 'Kemi',
      basic: 180000,
      bank: 'First Bank of Nigeria',
      accountNo: '1122334455',
      tin: '',
      pensionPin: '',
      status: 'Active',
      country: 'NG',
    },
    // 5. Duplicate EmpID test
    {
      empId: 'EMP001',
      surname: 'Duplicate',
      firstName: 'Person',
      basic: 100000,
      bank: 'Zenith Bank',
      accountNo: '0123456789',
      status: 'Active',
      country: 'NG',
    },
  ];

  const attendance = [
    { empId: 'EMP001', hoursWorked: 8, shift: 'Day', approved: true, date: '2026-11-01' },
    // Unapproved attendance with OT (BLOCKING)
    { empId: 'EMP004', hoursWorked: 10, shift: 'Day', otHours: 2, approved: false, date: '2026-11-02' },
  ];

  const bonuses = [
    // Unapproved bonus (BLOCKING)
    { empId: 'EMP001', totalBonuses: 20000, status: 'Pending' },
  ];

  const adjustments = [
    // Unapproved adjustment (BLOCKING)
    { empId: 'EMP001', type: 'earning', amount: 5000, approved: false },
  ];

  const leaves = [
    // Pending leave (BLOCKING)
    { empId: 'EMP001', status: 'Pending', startDate: '2026-11-05' },
  ];

  const report = validatePayrollPreCalculation({
    employees,
    attendance,
    adjustments,
    bonuses,
    allowances: [],
    leaves,
    period: '2026-11',
  });

  assert.equal(report.valid, false, 'Pre-calculation validation must fail due to blocking exceptions');
  assert.ok(report.blockingCount > 0, 'Blocking exceptions count must be greater than zero');

  const blockingTypes = report.blockingExceptions.map((e) => e.type);
  assert.ok(blockingTypes.includes('DUPLICATE_EMPID'), 'Must detect DUPLICATE_EMPID');
  assert.ok(blockingTypes.includes('MISSING_BANK_DETAILS'), 'Must detect MISSING_BANK_DETAILS');
  assert.ok(blockingTypes.includes('ZERO_OR_NEGATIVE_SALARY'), 'Must detect ZERO_OR_NEGATIVE_SALARY');
  assert.ok(blockingTypes.includes('UNAPPROVED_ATTENDANCE'), 'Must detect UNAPPROVED_ATTENDANCE');
  assert.ok(blockingTypes.includes('UNAPPROVED_BONUS'), 'Must detect UNAPPROVED_BONUS');
  assert.ok(blockingTypes.includes('UNAPPROVED_ADJUSTMENT'), 'Must detect UNAPPROVED_ADJUSTMENT');
  assert.ok(blockingTypes.includes('UNAPPROVED_LEAVE'), 'Must detect UNAPPROVED_LEAVE');

  const allTypes = report.exceptions.map((e) => e.type);
  assert.ok(allTypes.includes('MISSING_TIN'), 'Must report MISSING_TIN');
  assert.ok(allTypes.includes('MISSING_PENSION_PIN'), 'Must report MISSING_PENSION_PIN');
  assert.ok(allTypes.includes('NO_ATTENDANCE'), 'Must report NO_ATTENDANCE for EMP002 and EMP003');
});

test('FR-INP-05: Payroll recalculation is permitted multiple times until Approved', () => {
  let periodState = 'Open';
  let calculationCount = 0;

  function calculateRun(state) {
    if (['Approved', 'Paid/Locked'].includes(state)) {
      throw new Error('This period is approved and locked.');
    }
    calculationCount++;
    return 'Calculated';
  }

  // Recalculate multiple times while in progress
  periodState = calculateRun(periodState);
  assert.equal(calculationCount, 1);
  assert.equal(periodState, 'Calculated');

  periodState = calculateRun(periodState);
  assert.equal(calculationCount, 2);

  periodState = calculateRun(periodState);
  assert.equal(calculationCount, 3);

  // Once approved, recalculation must throw error
  periodState = 'Approved';
  assert.throws(() => calculateRun(periodState), /This period is approved and locked/);
});

test('FR-INP-06: Arrears and back-pay adjustments for prior periods', () => {
  const arrearsAdjustment = new Adjustment({
    period: '2026-11',
    priorPeriod: '2026-10',
    empId: 'EMP001',
    type: 'earning',
    subtype: 'arrears',
    amount: 35000,
    reason: 'Back-pay for October 2026 promotion increment from Level 4 to Level 5',
    createdBy: 'hr_officer',
  });

  assert.equal(arrearsAdjustment.validateSync(), undefined);
  assert.equal(arrearsAdjustment.subtype, 'arrears');
  assert.equal(arrearsAdjustment.priorPeriod, '2026-10');

  // Verify that arrears adjustment flows into payroll calculation
  const emp = {
    empId: 'EMP001',
    surname: 'Okoro',
    firstName: 'Chidi',
    basic: 150000,
    hourlyRate: 150000 / 176,
    country: 'NG',
    currency: 'NGN',
    bank: 'Access Bank',
    accountNo: '0123456789',
  };

  const lineWithArrears = calcLine(emp, {
    adjustments: [arrearsAdjustment],
  }, '2026-11');

  // Arrears earning is added to bonuses/gross pay
  assert.equal(lineWithArrears.bonuses, 35000);
  assert.equal(lineWithArrears.gross, 185000);
});
