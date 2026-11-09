const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateLeaveDays,
  isDateRangeOverlapping,
  calculateUnpaidLeaveDeduction,
  computeLeaveAllowance,
  calcLine,
} = require('../lib/payroll');
const { LEAVE_TYPES, LEAVE_PAY_TREATMENT } = require('../lib/models');

test('FR-LV-01: calculateLeaveDays calculates business days excluding weekends and public holidays', () => {
  // Monday 2026-11-02 to Friday 2026-11-06 = 5 days (no holidays)
  const days1 = calculateLeaveDays('2026-11-02', '2026-11-06', []);
  assert.equal(days1, 5);

  // Friday 2026-11-06 to Tuesday 2026-11-10 (includes Sat Nov 7 & Sun Nov 8) -> 3 business days
  const days2 = calculateLeaveDays('2026-11-06', '2026-11-10', []);
  assert.equal(days2, 3);

  // Monday 2026-11-02 to Friday 2026-11-06 where Wednesday 2026-11-04 is a holiday -> 4 business days
  const holidays = ['2026-11-04'];
  const days3 = calculateLeaveDays('2026-11-02', '2026-11-06', holidays);
  assert.equal(days3, 4);

  // Error case: startDate after endDate
  assert.throws(() => {
    calculateLeaveDays('2026-11-10', '2026-11-05');
  }, /startDate cannot be after endDate/);
});

test('FR-LV-02: LeaveType is a controlled list with defined pay treatments', () => {
  const expectedTypes = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];
  assert.deepEqual(LEAVE_TYPES, expectedTypes);

  assert.equal(LEAVE_PAY_TREATMENT.Annual, 'Paid');
  assert.equal(LEAVE_PAY_TREATMENT.Sick, 'Paid');
  assert.equal(LEAVE_PAY_TREATMENT.Maternity, 'Paid');
  assert.equal(LEAVE_PAY_TREATMENT.Paternity, 'Paid');
  assert.equal(LEAVE_PAY_TREATMENT.Compassionate, 'Paid');
  assert.equal(LEAVE_PAY_TREATMENT.Study, 'Policy-Based');
  assert.equal(LEAVE_PAY_TREATMENT.Unpaid, 'Unpaid');
});

test('FR-LV-07: isDateRangeOverlapping detects overlapping leave date windows', () => {
  // Distinct non-overlapping periods
  assert.equal(isDateRangeOverlapping('2026-11-01', '2026-11-05', '2026-11-06', '2026-11-10'), false);

  // Overlapping period (partial overlap)
  assert.equal(isDateRangeOverlapping('2026-11-01', '2026-11-05', '2026-11-04', '2026-11-08'), true);

  // Completely enclosing period
  assert.equal(isDateRangeOverlapping('2026-11-01', '2026-11-10', '2026-11-03', '2026-11-05'), true);

  // Exact same day boundary overlap
  assert.equal(isDateRangeOverlapping('2026-11-01', '2026-11-05', '2026-11-05', '2026-11-08'), true);
});

test('FR-LV-05 & BRL-13: Unpaid leave days reduce pay proportionally (basic / working days * unpaid days)', () => {
  const basicSalary = 220000;
  const workingDays = 22;
  const unpaidDays = 2;

  // Expected deduction: 220,000 / 22 * 2 = 20,000
  const deduction = calculateUnpaidLeaveDeduction(basicSalary, unpaidDays, workingDays);
  assert.equal(deduction, 20000);

  const emp = {
    empId: 'EMP_LV_01',
    surname: 'Ade',
    firstName: 'Bisi',
    basic: 220000,
    housing: 0,
    transport: 0,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
  };

  const lineWithUnpaidLeave = calcLine(emp, { unpaidLeaveDays: 2 }, '2026-11', { workingDaysInMonth: 22 });
  assert.equal(lineWithUnpaidLeave.unpaidLeaveDays, 2);
  assert.equal(lineWithUnpaidLeave.unpaidLeaveDeduction, 20000);
  assert.equal(lineWithUnpaidLeave.basic, 200000); // 220,000 - 20,000
});

test('FR-LV-06: Leave balance checking and optional leave allowance payment computation', () => {
  // Annual leave allowance computation (10% of annual basic)
  const monthlyBasic = 150000;
  const annualBasic = 150000 * 12; // 1,800,000
  const allowance = computeLeaveAllowance(monthlyBasic, 0.10, true);
  assert.equal(allowance, 180000);

  // Non-annual monthly rate allowance (10% of 1 month basic)
  const monthlyAllowance = computeLeaveAllowance(monthlyBasic, 0.10, false);
  assert.equal(monthlyAllowance, 15000);
});
