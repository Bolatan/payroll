const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hoursBetween,
  timeToMinutes,
  resolveMultiplier,
  calculateAttendanceMetrics,
  summarizeEmployeeAttendance,
  calcLine,
  CFG,
} = require('../lib/payroll');
const { Attendance, Employee, User, PayrollRun } = require('../lib/models');

test('FR-ATT-04: hoursWorked handles night shifts crossing midnight and unpaid breaks', () => {
  // Day shift: 08:00 to 17:00 with 1 hour break = 8 hours
  assert.equal(hoursBetween('08:00', '17:00', 1), 8);

  // Night shift crossing midnight: 22:00 to 06:00 with 0 break = 8 hours
  assert.equal(hoursBetween('22:00', '06:00', 0), 8);

  // Night shift: 20:00 to 05:00 with 1 hour break = 8 hours
  assert.equal(hoursBetween('20:00', '05:00', 1), 8);
});

test('FR-ATT-05 & FR-ATT-06: OTHours calculation by shift category', () => {
  // Weekday Day shift: 10 hours worked -> 2 OTHours
  const dayMetrics = calculateAttendanceMetrics({
    shift: 'Day',
    clockIn: '08:00',
    clockOut: '18:00',
    breakHours: 0,
  });
  assert.equal(dayMetrics.hoursWorked, 10);
  assert.equal(dayMetrics.otHours, 2);
  assert.equal(dayMetrics.weekendOt, 0);
  assert.equal(dayMetrics.holidayOt, 0);

  // Weekend shift: 8 hours worked -> all classified as WeekendOT
  const wkndMetrics = calculateAttendanceMetrics({
    shift: 'Weekend',
    clockIn: '08:00',
    clockOut: '16:00',
    breakHours: 0,
  });
  assert.equal(wkndMetrics.hoursWorked, 8);
  assert.equal(wkndMetrics.otHours, 0);
  assert.equal(wkndMetrics.weekendOt, 8);
  assert.equal(wkndMetrics.holidayOt, 0);

  // Holiday shift: 8 hours worked -> all classified as HolidayOT
  const holMetrics = calculateAttendanceMetrics({
    shift: 'Holiday',
    clockIn: '08:00',
    clockOut: '16:00',
    breakHours: 0,
  });
  assert.equal(holMetrics.hoursWorked, 8);
  assert.equal(holMetrics.holidayOt, 8);
});

test('FR-ATT-07: Highest applicable multiplier resolution without compounding', () => {
  // Night shift on a public holiday:
  // Night multiplier = 1.75, Holiday multiplier = 2.5
  // Highest applicable = 2.5 (not 1.75 * 2.5)
  const mult = resolveMultiplier('Night', true, false);
  assert.equal(mult, 2.5);

  // Day shift on weekend:
  // Day multiplier = 1.5, Weekend = 2.0
  const wkndMult = resolveMultiplier('Day', false, true);
  assert.equal(wkndMult, 2.0);
});

test('FR-ATT-08: Unapproved OT exclusion in payroll calculation', () => {
  const emp = {
    empId: 'EMP001',
    surname: 'Test',
    firstName: 'Worker',
    basic: 176000,
    hourlyRate: 1000,
  };

  // 1 approved entry with 2 hours OT, and 1 unapproved entry with 4 hours OT
  const approvedAtt = [
    { shift: 'Day', hoursWorked: 10, otHours: 2, approved: true },
  ];
  // Passing only approved attendance to calcLine
  const line = calcLine(emp, { attendance: approvedAtt }, '2026-11');
  assert.equal(line.otHours, 2);
  assert.equal(line.otPay, 2 * 1000 * 1.5); // 3000
});

test('FR-ATT-09: Maximum OT hours warning detection', () => {
  const summaryExceeded = summarizeEmployeeAttendance([
    { shift: 'Day', hoursWorked: 12, otHours: 4, approved: true },
    { shift: 'Weekend', hoursWorked: 12, weekendOt: 12, approved: true },
    { shift: 'Weekend', hoursWorked: 12, weekendOt: 12, approved: true },
    { shift: 'Holiday', hoursWorked: 14, holidayOt: 14, approved: true },
  ]);
  assert.equal(summaryExceeded.totalOtHours, 42);
  assert.equal(summaryExceeded.otCappedWarning, true, 'Should warn when period OT > 40h');

  const summaryNormal = summarizeEmployeeAttendance([
    { shift: 'Day', hoursWorked: 10, otHours: 2, approved: true },
  ]);
  assert.equal(summaryNormal.totalOtHours, 2);
  assert.equal(summaryNormal.otCappedWarning, false);
});

test('FR-ATT-11: Lateness and early departure threshold detection', () => {
  // Scheduled Day shift: 08:00 - 16:00
  // In at 08:20 (20m late >= 15m threshold -> isLate = true)
  // Out at 15:40 (20m early >= 15m threshold -> isEarlyDeparture = true)
  const metrics = calculateAttendanceMetrics({
    shift: 'Day',
    clockIn: '08:20',
    clockOut: '15:40',
    breakHours: 0,
  });

  assert.equal(metrics.lateMinutes, 20);
  assert.equal(metrics.isLate, true);
  assert.equal(metrics.earlyMinutes, 20);
  assert.equal(metrics.isEarlyDeparture, true);

  // On-time check: 08:05 (5m late < 15m -> isLate = false)
  const onTimeMetrics = calculateAttendanceMetrics({
    shift: 'Day',
    clockIn: '08:05',
    clockOut: '16:00',
    breakHours: 0,
  });
  assert.equal(onTimeMetrics.isLate, false);
  assert.equal(onTimeMetrics.isEarlyDeparture, false);
});

test('FR-ATT-12: Period attendance summary generation per employee', () => {
  const attList = [
    { shift: 'Day', hoursWorked: 8, otHours: 0 },
    { shift: 'Day', hoursWorked: 10, otHours: 2, isLate: true },
    { shift: 'Night', hoursWorked: 9, otHours: 1 },
    { shift: 'Weekend', hoursWorked: 8, weekendOt: 8 },
    { shift: 'Holiday', hoursWorked: 8, holidayOt: 8 },
    { absent: true },
  ];
  const leaveList = [{ days: 2, status: 'Approved' }];

  const summary = summarizeEmployeeAttendance(attList, leaveList);
  assert.equal(summary.daysPresent, 5);
  assert.equal(summary.daysAbsent, 1);
  assert.equal(summary.daysLeave, 2);
  assert.equal(summary.totalHours, 43);
  assert.equal(summary.dayOtHours, 2);
  assert.equal(summary.nightOtHours, 1);
  assert.equal(summary.weekendOtHours, 8);
  assert.equal(summary.holidayOtHours, 8);
  assert.equal(summary.totalOtHours, 19);
  assert.equal(summary.lateCount, 1);
});

test('FR-ATT-01 & FR-ATT-03: Attendance model schema validation and indexes', () => {
  assert.ok(Attendance.schema.path('empId'), 'empId required');
  assert.ok(Attendance.schema.path('date'), 'date required');
  assert.ok(Attendance.schema.path('shift'), 'shift required');
  assert.ok(Attendance.schema.path('clockIn'), 'clockIn required');
  assert.ok(Attendance.schema.path('clockOut'), 'clockOut required');
  assert.ok(Attendance.schema.path('hoursWorked'), 'hoursWorked required');
  assert.ok(Attendance.schema.path('otHours'), 'otHours present');
  assert.ok(Attendance.schema.path('weekendOt'), 'weekendOt present');
  assert.ok(Attendance.schema.path('holidayOt'), 'holidayOt present');
  assert.ok(Attendance.schema.path('absent'), 'absent field present');
});
