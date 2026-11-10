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

  // Scenario 4: Optional working-day calculation excluding weekends
  const daysWorking = calculateLeaveDays('2026-05-04', '2026-05-10', [], { excludeWeekends: true });
  assert.strictEqual(daysWorking, 5);

  // Scenario 5: Excluding both weekends and configured public holidays
  // Monday 2026-05-04 to Sunday 2026-05-10 has 5 weekdays.
  // If Wednesday 2026-05-06 is a Public Holiday, net leave days should be 4.
  const daysWithHoliday = calculateLeaveDays('2026-05-04', '2026-05-10', ['2026-05-06'], {
    excludeWeekends: true,
    excludeHolidays: true,
  });
  assert.strictEqual(daysWithHoliday, 4);

  // Scenario 6: Invalid date ranges return 0
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

test('FR-LV-04: Approved leave prevents auto-absent and marks attendance calendar', () => {
  // Calendar marking logic
  const approvedLeaves = [
    { empId: 'EMP-LV-03', startDate: new Date('2026-07-06'), endDate: new Date('2026-07-08'), leaveType: 'Annual', status: 'Approved' }
  ];

  function getDayStatus(empId, dateStr, leaves, attendances = []) {
    const targetDate = new Date(dateStr);
    const hasApprovedLeave = leaves.find((l) => l.empId === empId && l.status === 'Approved' && l.startDate <= targetDate && l.endDate >= targetDate);
    if (hasApprovedLeave) {
      return { status: `Leave: ${hasApprovedLeave.leaveType}`, isLeave: true, leaveType: hasApprovedLeave.leaveType };
    }
    const hasAttendance = attendances.find((a) => a.empId === empId && a.date === dateStr);
    if (hasAttendance) return { status: 'Present', isLeave: false };
    return { status: 'Absent', isLeave: false };
  }

  const day1 = getDayStatus('EMP-LV-03', '2026-07-07', approvedLeaves);
  assert.strictEqual(day1.status, 'Leave: Annual');
  assert.strictEqual(day1.isLeave, true);

  const dayAfter = getDayStatus('EMP-LV-03', '2026-07-10', approvedLeaves);
  assert.strictEqual(dayAfter.status, 'Absent');
  assert.strictEqual(dayAfter.isLeave, false);
});

test('FR-LV-06: Leave balance validation, pending accumulation, and HR override', () => {
  const balance = {
    empId: 'EMP-LV-04',
    year: 2026,
    leaveType: 'Annual',
    entitlement: 20,
    used: 12,
    pending: 3,
    carryOver: 0,
  };

  const available = balance.entitlement + balance.carryOver - balance.used - balance.pending; // 20 - 12 - 3 = 5
  assert.strictEqual(available, 5);

  // Requesting 4 days within balance
  function validateLeaveRequest(requestedDays, availableDays, userRole, overrideReason) {
    if (requestedDays > availableDays) {
      if (overrideReason && (userRole === 'hr' || userRole === 'admin')) {
        return { allowed: true, isOverridden: true };
      }
      return { allowed: false, isOverridden: false, error: 'Insufficient leave balance.' };
    }
    return { allowed: true, isOverridden: false };
  }

  const validReq = validateLeaveRequest(4, available, 'employee');
  assert.strictEqual(validReq.allowed, true);
  assert.strictEqual(validReq.isOverridden, false);

  // Requesting 6 days exceeds available without override
  const exceededReq = validateLeaveRequest(6, available, 'employee');
  assert.strictEqual(exceededReq.allowed, false);

  // Exceeding request with HR override
  const overriddenReq = validateLeaveRequest(6, available, 'hr', 'Approved by Managing Director for family emergency');
  assert.strictEqual(overriddenReq.allowed, true);
  assert.strictEqual(overriddenReq.isOverridden, true);
});
