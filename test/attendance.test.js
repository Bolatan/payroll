const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calcLine,
  hoursBetween,
  evaluateAttendanceEntry,
  summarizePeriodAttendance,
  CFG,
} = require('../lib/payroll');

test('FR-ATT-04: HoursWorked calculated as ClockOut - ClockIn - break, handling night shift crossing midnight', () => {
  // Day shift 08:00 to 17:00 with 1 hour break = 8 hours
  const dayHours = hoursBetween('08:00', '17:00', 1);
  assert.equal(dayHours, 8);

  // Night shift 22:00 to 06:00 (crosses midnight) with 1 hour break = 7 hours
  const nightHours = hoursBetween('22:00', '06:00', 1);
  assert.equal(nightHours, 7);

  // Shift crossing midnight 20:00 to 04:00 with 0 break = 8 hours
  const midnightHours = hoursBetween('20:00', '04:00', 0);
  assert.equal(midnightHours, 8);
});

test('FR-ATT-05: Weekday Day/Night overtime calculated as HoursWorked - StdHours (positive)', () => {
  // Day shift with 10 hours worked and 8h standard hours -> 2h OT
  const dayEval = evaluateAttendanceEntry({
    shift: 'Day',
    clockIn: '08:00',
    clockOut: '18:00',
    breakHours: 0,
  }, { stdHours: 8 });

  assert.equal(dayEval.hoursWorked, 10);
  assert.equal(dayEval.otHours, 2);
  assert.equal(dayEval.weekendOT, 0);
  assert.equal(dayEval.holidayOT, 0);
  assert.equal(dayEval.multiplier, 1.5);

  // Night shift with 9 hours worked -> 1h OT
  const nightEval = evaluateAttendanceEntry({
    shift: 'Night',
    clockIn: '21:00',
    clockOut: '06:00',
    breakHours: 0,
  }, { stdHours: 8 });

  assert.equal(nightEval.hoursWorked, 9);
  assert.equal(nightEval.otHours, 1);
  assert.equal(nightEval.multiplier, 1.75);
});

test('FR-ATT-06: Weekend or Public Holiday shifts classified as WeekendOT or HolidayOT at full hours', () => {
  // Weekend shift 8h -> 8h WeekendOT at 2.0
  const wkndEval = evaluateAttendanceEntry({
    shift: 'Weekend',
    clockIn: '08:00',
    clockOut: '16:00',
    breakHours: 0,
  }, { isWeekend: true });

  assert.equal(wkndEval.hoursWorked, 8);
  assert.equal(wkndEval.otHours, 0);
  assert.equal(wkndEval.weekendOT, 8);
  assert.equal(wkndEval.holidayOT, 0);
  assert.equal(wkndEval.multiplier, 2.0);

  // Public Holiday shift 8h -> 8h HolidayOT at 2.5
  const holEval = evaluateAttendanceEntry({
    shift: 'Holiday',
    clockIn: '08:00',
    clockOut: '16:00',
    breakHours: 0,
  }, { isHoliday: true });

  assert.equal(holEval.hoursWorked, 8);
  assert.equal(holEval.otHours, 0);
  assert.equal(holEval.weekendOT, 0);
  assert.equal(holEval.holidayOT, 8);
  assert.equal(holEval.multiplier, 2.5);
});

test('FR-ATT-07: Overlapping multipliers apply highest applicable multiplier without compounding', () => {
  // Night shift (1.75) worked on a Public Holiday (2.5) -> applies 2.5, not 1.75 * 2.5
  const overlapEval = evaluateAttendanceEntry({
    shift: 'Night',
    clockIn: '20:00',
    clockOut: '04:00',
    breakHours: 0,
  }, { isHoliday: true });

  assert.equal(overlapEval.multiplier, 2.5);
  assert.equal(overlapEval.holidayOT, 8);
});

test('FR-ATT-08 & FR-ATT-09: Maximum overtime cap warning and period summary', () => {
  // Entry with 6 hours overtime on standard 8 hours -> 14h total -> exceeds daily cap of 4h
  const evalWithWarning = evaluateAttendanceEntry({
    shift: 'Day',
    clockIn: '06:00',
    clockOut: '20:00',
    breakHours: 0,
  }, { maxDailyOT: 4 });

  assert.equal(evalWithWarning.hoursWorked, 14);
  assert.equal(evalWithWarning.otHours, 6);
  assert(evalWithWarning.otExceededWarning, 'Warning should be generated when OT exceeds daily cap');
  assert(evalWithWarning.otExceededWarning.includes('exceeds daily cap'));

  // Period summary aggregation
  const records = [
    { hoursWorked: 10, otHours: 2, weekendOT: 0, holidayOT: 0, approved: true, lateMinutes: 20 },
    { hoursWorked: 8, otHours: 0, weekendOT: 8, holidayOT: 0, approved: true, lateMinutes: 0 },
    { hoursWorked: 8, otHours: 0, weekendOT: 0, holidayOT: 8, approved: false, lateMinutes: 0 }, // unapproved holiday OT
    { absent: true, absentReason: 'Sick' },
  ];

  const summary = summarizePeriodAttendance(records, 2);
  assert.equal(summary.daysPresent, 3);
  assert.equal(summary.daysAbsent, 1);
  assert.equal(summary.daysLeave, 2);
  assert.equal(summary.totalHours, 26);
  assert.equal(summary.weekdayOT, 2);
  assert.equal(summary.weekendOT, 8);
  assert.equal(summary.holidayOT, 8);
  assert.equal(summary.totalOT, 18);
  assert.equal(summary.unapprovedOTHours, 8); // 8h unapproved holiday OT
  assert.equal(summary.lateCount, 1);
  assert.equal(summary.totalLateMinutes, 20);
});

test('FR-ATT-11: Late arrival and early departure calculations', () => {
  // Shift scheduled 08:00 to 17:00, clocked in 08:30 (30 mins late > 15m threshold)
  const lateEval = evaluateAttendanceEntry({
    shift: 'Day',
    clockIn: '08:30',
    clockOut: '17:00',
    breakHours: 1,
  }, { scheduledStart: '08:00', scheduledEnd: '17:00', lateThresholdMins: 15 });

  assert.equal(lateEval.lateMinutes, 30);
  assert.equal(lateEval.earlyDepartureMinutes, 0);

  // Clocked out 16:30 (30 mins early > 15m threshold)
  const earlyEval = evaluateAttendanceEntry({
    shift: 'Day',
    clockIn: '08:00',
    clockOut: '16:30',
    breakHours: 1,
  }, { scheduledStart: '08:00', scheduledEnd: '17:00', earlyThresholdMins: 15 });

  assert.equal(earlyEval.earlyDepartureMinutes, 30);
});

test('FR-ATT-05 & FR-ATT-06: calcLine properly pays overtime based on evaluated breakdown', () => {
  const emp = {
    empId: 'EMP888',
    surname: 'Adeyemi',
    firstName: 'Tola',
    basic: 176000,
    hourlyRate: 1000,
    bank: 'Access Bank',
    accountNo: '0123456789',
  };

  const attendance = [
    // 2 hours weekday OT at 1.5 = 2 * 1000 * 1.5 = 3000
    { shift: 'Day', hoursWorked: 10, otHours: 2, weekendOT: 0, holidayOT: 0, multiplier: 1.5 },
    // 8 hours Weekend OT at 2.0 = 8 * 1000 * 2.0 = 16000
    { shift: 'Weekend', hoursWorked: 8, otHours: 0, weekendOT: 8, holidayOT: 0, multiplier: 2.0 },
    // 8 hours Holiday OT at 2.5 = 8 * 1000 * 2.5 = 20000
    { shift: 'Holiday', hoursWorked: 8, otHours: 0, weekendOT: 0, holidayOT: 8, multiplier: 2.5 },
  ];

  const line = calcLine(emp, { attendance }, '2026-11');
  assert.equal(line.otHours, 18); // 2 + 8 + 8 = 18
  assert.equal(line.otPay, 3000 + 16000 + 20000); // 39,000
  assert.equal(line.gross, 176000 + 39000);
});
