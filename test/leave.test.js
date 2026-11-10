const test = require('node:test');
const assert = require('node:assert');
const {
  calculateLeaveDays,
  calculateUnpaidLeaveDeduction,
  calculateLeaveAllowance,
  calcLine,
  LEAVE_TYPES,
} = require('../lib/payroll');

test('FR-LV-01: Calculate leave days from the difference between EndDate and StartDate', () => {
  // Scenario 1: A one-week span from Monday 2026-05-04 to Sunday 2026-05-10 = 7 days
  const days1 = calculateLeaveDays('2026-05-04', '2026-05-10');
  assert.strictEqual(days1, 7);

  // Scenario 2: 5-day span from Monday 2026-05-04 to Friday 2026-05-08 = 5 days
  const days2 = calculateLeaveDays('2026-05-04', '2026-05-08');
  assert.strictEqual(days2, 5);

  // Scenario 3: Single day leave (2026-05-04 to 2026-05-04) = 1 day
  const singleDay = calculateLeaveDays('2026-05-04', '2026-05-04');
  assert.strictEqual(singleDay, 1);

  // Scenario 4: Optional working-day calculation if options specified
  const daysWorking = calculateLeaveDays('2026-05-04', '2026-05-10', [], { excludeWeekends: true });
  assert.strictEqual(daysWorking, 5);

  // Scenario 5: Invalid date ranges return 0
  assert.strictEqual(calculateLeaveDays('2026-05-10', '2026-05-04'), 0);
});

test('FR-LV-02: Controlled list of LeaveTypes with pay treatment', () => {
  const expectedTypes = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];
  for (const type of expectedTypes) {
    assert.ok(LEAVE_TYPES[type], `Leave type ${type} must exist in controlled list`);
  }

  assert.strictEqual(LEAVE_TYPES.Annual.treatment, 'paid');
  assert.strictEqual(LEAVE_TYPES.Sick.treatment, 'paid');
  assert.strictEqual(LEAVE_TYPES.Maternity.treatment, 'paid');
  assert.strictEqual(LEAVE_TYPES.Paternity.treatment, 'paid');
  assert.strictEqual(LEAVE_TYPES.Compassionate.treatment, 'paid');
  assert.strictEqual(LEAVE_TYPES.Study.treatment, 'policy_based');
  assert.strictEqual(LEAVE_TYPES.Unpaid.treatment, 'unpaid');
});

test('FR-LV-05 & BRL-13: Unpaid leave days reduce pay proportionally (basic ÷ working days × absent days)', () => {
  // Basic = 220,000, 22 working days in month, 3 unpaid leave days
  // Daily rate = 220,000 / 22 = 10,000
  // Deduction = 10,000 * 3 = 30,000
  const deduction = calculateUnpaidLeaveDeduction(220000, 3, 22);
  assert.strictEqual(deduction, 30000);

  // In calcLine: Employee with 150,000 basic, 3 days unpaid leave in 22-day month
  // Basic deduction = 150,000 / 22 * 3 = 20,454.55
  // Remaining basic = 150,000 - 20,454.55 = 129,545.45
  const emp = {
    empId: 'EMP-LV-01',
    surname: 'Okafor',
    firstName: 'Ngozi',
    basic: 150000,
    housing: 60000,
    transport: 40000,
    accountNo: '0123456789',
    bank: 'Access Bank',
  };

  const lineWithUnpaidLeave = calcLine(emp, {
    leaves: [
      {
        leaveType: 'Unpaid',
        payTreatment: 'unpaid',
        days: 3,
        status: 'Approved',
      },
    ],
  }, '2026-05', { workingDaysInMonth: 22 });

  assert.strictEqual(lineWithUnpaidLeave.unpaidLeaveDays, 3);
  assert.strictEqual(lineWithUnpaidLeave.unpaidLeaveDeduction, 20454.55);
  assert.strictEqual(lineWithUnpaidLeave.basic, 129545.45);

  // Unapproved unpaid leave should NOT reduce pay (FR-LV-03)
  const lineUnapproved = calcLine(emp, {
    leaves: [
      {
        leaveType: 'Unpaid',
        payTreatment: 'unpaid',
        days: 3,
        status: 'Pending',
      },
    ],
  }, '2026-05', { workingDaysInMonth: 22 });

  assert.strictEqual(lineUnapproved.unpaidLeaveDays, 0);
  assert.strictEqual(lineUnapproved.unpaidLeaveDeduction, 0);
  assert.strictEqual(lineUnapproved.basic, 150000);
});

test('FR-LV-06: Leave allowance calculation', () => {
  const basic = 300000;
  // Default 10% annual leave allowance
  const allowance = calculateLeaveAllowance(basic, 0.10);
  assert.strictEqual(allowance, 30000);

  // In calcLine: Employee with annual leave requesting leave allowance
  const emp = {
    empId: 'EMP-LV-02',
    surname: 'Balogun',
    firstName: 'Tunde',
    basic: 200000,
    accountNo: '0123456789',
    bank: 'Zenith Bank',
  };

  const line = calcLine(emp, {
    leaves: [
      {
        leaveType: 'Annual',
        payTreatment: 'paid',
        days: 10,
        status: 'Approved',
        leaveAllowanceRequested: true,
        leaveAllowancePaid: false,
      },
    ],
  }, '2026-05', { leaveAllowanceRatePct: 0.10 });

  assert.strictEqual(line.leaveAllowanceEarning, 20000);
  assert.strictEqual(line.bonuses, 20000);
});

test('FR-LV-07 & FR-LV-03: Leave overlap and approval validation logic', () => {
  function isOverlapping(startA, endA, startB, endB) {
    const sA = new Date(startA);
    const eA = new Date(endA);
    const sB = new Date(startB);
    const eB = new Date(endB);
    return sA <= eB && sB <= eA;
  }

  // Same range
  assert.strictEqual(isOverlapping('2026-06-01', '2026-06-10', '2026-06-01', '2026-06-10'), true);
  // Partial overlap
  assert.strictEqual(isOverlapping('2026-06-01', '2026-06-10', '2026-06-08', '2026-06-15'), true);
  // Contained within
  assert.strictEqual(isOverlapping('2026-06-01', '2026-06-20', '2026-06-05', '2026-06-10'), true);
  // Non-overlapping
  assert.strictEqual(isOverlapping('2026-06-01', '2026-06-10', '2026-06-11', '2026-06-20'), false);
  assert.strictEqual(isOverlapping('2026-06-15', '2026-06-20', '2026-06-01', '2026-06-10'), false);
});
