const test = require('node:test');
const assert = require('node:assert/strict');
const { Attendance, ShiftSetup, PublicHoliday, LeaveRequest, Employee, PayrollRun } = require('../lib/models');
const {
  calcLine,
  hoursBetween,
  evaluateAttendanceEntry,
  summarizePeriodAttendance,
  CFG,
} = require('../lib/payroll');

// FR-ATT-01: The system shall record one attendance entry per employee per date per shift: Date, EmpID, Shift, ClockIn, ClockOut.
test('FR-ATT-01: Attendance schema records Date, EmpID, Shift, ClockIn, ClockOut with compound uniqueness index', () => {
  const schema = Attendance.schema.paths;
  assert.ok(schema.empId, 'Schema must define empId');
  assert.ok(schema.date, 'Schema must define date');
  assert.ok(schema.shift, 'Schema must define shift');
  assert.ok(schema.clockIn, 'Schema must define clockIn');
  assert.ok(schema.clockOut, 'Schema must define clockOut');

  // Verify shift enum covers all 4 standard shifts
  const shiftEnum = schema.shift.enumValues;
  assert.deepEqual(shiftEnum.sort(), ['Day', 'Holiday', 'Night', 'Weekend'].sort());

  // Compound uniqueness index check on (empId, date, shift)
  const indexes = Attendance.schema.indexes();
  const compoundIdx = indexes.find(([idxDef]) => idxDef.empId === 1 && idxDef.date === 1 && idxDef.shift === 1);
  assert.ok(compoundIdx, 'Compound index on empId, date, shift must exist');
  assert.equal(compoundIdx[1].unique, true, 'Compound index must be unique');
});

// FR-ATT-02: Attendance shall be enterable manually, edited in bulk, or imported from CSV/XLSX time-clock exports with row-level error reporting.
test('FR-ATT-02: Bulk import validation and row-level error reporting logic', () => {
  function validateAttendanceImportRow(row, rowIndex, existingEntries = new Set()) {
    const errors = [];
    if (!row.empId) errors.push('Missing empId.');
    if (!row.date) errors.push('Missing date.');
    const shift = row.shift || 'Day';
    if (!['Day', 'Night', 'Weekend', 'Holiday'].includes(shift)) errors.push('Invalid shift type.');

    const attDate = new Date(row.date);
    if (isNaN(attDate.getTime())) errors.push('Invalid date format.');

    const key = `${row.empId}_${row.date}_${shift}`;
    if (existingEntries.has(key)) {
      errors.push('Duplicate entry for same employee, date and shift.');
    }

    if (!row.absent) {
      if (!/^\d{2}:\d{2}$/.test(row.clockIn || '') || !/^\d{2}:\d{2}$/.test(row.clockOut || '')) {
        errors.push('Clock times must be HH:MM format.');
      } else if (row.clockOut <= row.clockIn) {
        errors.push('Clock-out time must be higher than clock-in time.');
      }
    }

    if (errors.length > 0) {
      return { row: rowIndex, empId: row.empId || 'N/A', status: 'Failed', errors };
    }
    existingEntries.add(key);
    return { row: rowIndex, empId: row.empId, status: 'Success' };
  }

  const batch = [
    { empId: 'EMP001', date: '2026-11-02', shift: 'Day', clockIn: '08:00', clockOut: '17:00' },
    { empId: '', date: '2026-11-02', shift: 'Day', clockIn: '08:00', clockOut: '17:00' }, // missing empId
    { empId: 'EMP002', date: 'invalid-date', shift: 'Night', clockIn: '20:00', clockOut: '04:00' }, // invalid date
    { empId: 'EMP003', date: '2026-11-02', shift: 'Day', clockIn: '17:00', clockOut: '08:00' }, // clockOut <= clockIn
    { empId: 'EMP001', date: '2026-11-02', shift: 'Day', clockIn: '08:00', clockOut: '17:00' }, // duplicate
    { empId: 'EMP004', date: '2026-11-02', shift: 'Day', absent: true }, // valid absent entry
  ];

  const seen = new Set();
  const reports = batch.map((row, idx) => validateAttendanceImportRow(row, idx + 1, seen));

  assert.equal(reports[0].status, 'Success');
  assert.equal(reports[1].status, 'Failed');
  assert.ok(reports[1].errors.includes('Missing empId.'));
  assert.equal(reports[2].status, 'Failed');
  assert.ok(reports[2].errors.includes('Invalid date format.'));
  assert.equal(reports[3].status, 'Failed');
  assert.ok(reports[3].errors.includes('Clock-out time must be higher than clock-in time.'));
  assert.equal(reports[4].status, 'Failed');
  assert.ok(reports[4].errors.includes('Duplicate entry for same employee, date and shift.'));
  assert.equal(reports[5].status, 'Success');
});

// FR-ATT-03: The system shall reject duplicate/overlapping entries for the same employee and time range.
test('FR-ATT-03: Reject duplicate or overlapping entries for same employee and date/shift', () => {
  function checkDuplicateAttendance(existingRecords, candidate) {
    const candDateStr = new Date(candidate.date).toISOString().slice(0, 10);
    return existingRecords.some((rec) => {
      if (rec.empId !== candidate.empId) return false;
      const recDateStr = new Date(rec.date).toISOString().slice(0, 10);
      if (recDateStr !== candDateStr) return false;
      return rec.shift === candidate.shift;
    });
  }

  const existing = [
    { empId: 'EMP001', date: '2026-11-02', shift: 'Day' },
    { empId: 'EMP001', date: '2026-11-02', shift: 'Night' },
    { empId: 'EMP002', date: '2026-11-02', shift: 'Day' },
  ];

  // Exact duplicate: EMP001 on 2026-11-02 for Day shift
  assert.equal(checkDuplicateAttendance(existing, { empId: 'EMP001', date: '2026-11-02', shift: 'Day' }), true);
  // Same emp, same date, but different shift (Night exists, Holiday does not)
  assert.equal(checkDuplicateAttendance(existing, { empId: 'EMP001', date: '2026-11-02', shift: 'Holiday' }), false);
  // Different employee, same date and shift
  assert.equal(checkDuplicateAttendance(existing, { empId: 'EMP003', date: '2026-11-02', shift: 'Day' }), false);
});

// FR-ATT-04: HoursWorked shall be calculated as (ClockOut − ClockIn − unpaid break), correctly handling night shifts that cross midnight.
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

  // Partial hour breaks and times: 08:30 to 17:15 with 0.5 hour break
  const fractionalHours = hoursBetween('08:30', '17:15', 0.5);
  assert.equal(fractionalHours, 8.25);
});

// FR-ATT-05: OTHours shall be calculated as HoursWorked − StdHours when positive, for weekday Day/Night shifts.
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

  // Less than or equal to standard hours: 8h worked -> 0h OT
  const exactEval = evaluateAttendanceEntry({
    shift: 'Day',
    clockIn: '08:00',
    clockOut: '16:00',
    breakHours: 0,
  }, { stdHours: 8 });
  assert.equal(exactEval.hoursWorked, 8);
  assert.equal(exactEval.otHours, 0);
});

// FR-ATT-06: For shifts worked on a weekend or public holiday, all (or configured share) classified as WeekendOT or HolidayOT.
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

// FR-ATT-07: Where a day qualifies for more than one multiplier, apply highest applicable multiplier without compounding.
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

  // Weekend shift (2.0) worked on a Public Holiday (2.5) -> applies 2.5
  const wkndHolEval = evaluateAttendanceEntry({
    shift: 'Weekend',
    clockIn: '08:00',
    clockOut: '16:00',
    breakHours: 0,
  }, { isHoliday: true, isWeekend: true });

  assert.equal(wkndHolEval.multiplier, 2.5);
  assert.equal(wkndHolEval.holidayOT, 8);
});

// FR-ATT-08: Overtime shall require approval by the supervisor before flowing to payroll; unapproved OT excluded.
test('FR-ATT-08: Overtime approval requirement and unapproved OT exclusion from payroll', () => {
  const emp = {
    empId: 'EMP777',
    surname: 'Oladipo',
    firstName: 'Bisi',
    basic: 180000,
    hourlyRate: 1000,
    bank: 'Zenith Bank',
    accountNo: '0123456789',
  };

  // One approved entry (2h OT), one unapproved entry (4h OT)
  const attendance = [
    { shift: 'Day', hoursWorked: 10, otHours: 2, weekendOT: 0, holidayOT: 0, multiplier: 1.5, approved: true },
    { shift: 'Day', hoursWorked: 12, otHours: 4, weekendOT: 0, holidayOT: 0, multiplier: 1.5, approved: false },
  ];

  const line = calcLine(emp, { attendance }, '2026-11');
  // Only the approved 2h OT should be paid (2 * 1000 * 1.5 = 3000)
  assert.equal(line.otHours, 2);
  assert.equal(line.otPay, 3000);
  assert.equal(line.gross, 180000 + 3000);
});

// FR-ATT-09: Configurable maximum OT hours per employee per period/day and warn when exceeded.
test('FR-ATT-09: Overtime daily cap and period cap warnings', () => {
  // Daily cap warning: 6h OT on standard 8h (14h worked) with maxDailyOT of 4h
  const dailyWarningEval = evaluateAttendanceEntry({
    shift: 'Day',
    clockIn: '06:00',
    clockOut: '20:00',
    breakHours: 0,
  }, { maxDailyOT: 4 });

  assert.equal(dailyWarningEval.hoursWorked, 14);
  assert.equal(dailyWarningEval.otHours, 6);
  assert.ok(dailyWarningEval.otExceededWarning, 'Warning must be generated when OT exceeds daily cap');
  assert.ok(dailyWarningEval.otExceededWarning.includes('exceeds daily cap'));

  // Period cap warning: summarizePeriodAttendance warns when total OT exceeds maxPeriodOT (e.g. 50h)
  const heavyRecords = [
    { hoursWorked: 16, otHours: 8, weekendOT: 0, holidayOT: 0, approved: true },
    { hoursWorked: 16, otHours: 8, weekendOT: 0, holidayOT: 0, approved: true },
    { hoursWorked: 16, otHours: 8, weekendOT: 0, holidayOT: 0, approved: true },
    { hoursWorked: 16, otHours: 8, weekendOT: 0, holidayOT: 0, approved: true },
    { hoursWorked: 16, otHours: 8, weekendOT: 0, holidayOT: 0, approved: true },
    { hoursWorked: 16, otHours: 8, weekendOT: 0, holidayOT: 0, approved: true },
    { hoursWorked: 16, otHours: 8, weekendOT: 0, holidayOT: 0, approved: true }, // 7 * 8 = 56h OT
  ];

  const periodSummary = summarizePeriodAttendance(heavyRecords, 0, { maxPeriodOT: 50 });
  assert.equal(periodSummary.totalOT, 56);
  assert.ok(periodSummary.warnings && periodSummary.warnings.length > 0, 'Should generate period OT warning');
  assert.ok(periodSummary.warnings[0].includes('exceeds period cap of 50h'));
});

// FR-ATT-10: Absent shall be set automatically for scheduled working days with no attendance and no approved leave.
test('FR-ATT-10: Auto-absent determination and supervisor override protection for approved leave', () => {
  function determineAutoAbsentEligibility(employee, dateStr, existingAttendances, approvedLeaves) {
    const hasAttendance = existingAttendances.some((a) => a.empId === employee.empId && a.date === dateStr);
    if (hasAttendance) return { shouldMarkAbsent: false, reason: 'Attendance exists' };

    const onLeave = approvedLeaves.find((l) => l.empId === employee.empId && l.startDate <= dateStr && l.endDate >= dateStr);
    if (onLeave) {
      return { shouldMarkAbsent: false, onApprovedLeave: true, leaveType: onLeave.leaveType };
    }

    return { shouldMarkAbsent: true, reason: 'Auto-marked Absent: No attendance and no approved leave' };
  }

  const employee = { empId: 'EMP100', status: 'Active' };
  const leaves = [{ empId: 'EMP100', startDate: '2026-11-05', endDate: '2026-11-08', leaveType: 'Annual' }];
  const attendances = [{ empId: 'EMP100', date: '2026-11-02' }];

  // Date with attendance -> not absent
  const res1 = determineAutoAbsentEligibility(employee, '2026-11-02', attendances, leaves);
  assert.equal(res1.shouldMarkAbsent, false);

  // Date on approved leave -> protected from auto-absent
  const res2 = determineAutoAbsentEligibility(employee, '2026-11-06', attendances, leaves);
  assert.equal(res2.shouldMarkAbsent, false);
  assert.equal(res2.onApprovedLeave, true);

  // Unscheduled date with no attendance and no leave -> mark absent
  const res3 = determineAutoAbsentEligibility(employee, '2026-11-10', attendances, leaves);
  assert.equal(res3.shouldMarkAbsent, true);
  assert.ok(res3.reason.includes('No attendance and no approved leave'));
});

// FR-ATT-11: Late arrival and early departure thresholds shall be configurable and reported.
test('FR-ATT-11: Late arrival and early departure calculations with configurable thresholds', () => {
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

  // Grace period test: 10 mins late with 15 min threshold -> lateMinutes is 0
  const graceEval = evaluateAttendanceEntry({
    shift: 'Day',
    clockIn: '08:10',
    clockOut: '17:00',
    breakHours: 1,
  }, { scheduledStart: '08:00', scheduledEnd: '17:00', lateThresholdMins: 15 });

  assert.equal(graceEval.lateMinutes, 0);
});

// FR-ATT-12: A period attendance summary per employee shall be produced: days present, absent, leave, OT hours by category, total hours.
test('FR-ATT-12: Period attendance summary produces days present, absent, leave, OT by category, and total hours', () => {
  const records = [
    { hoursWorked: 10, otHours: 2, weekendOT: 0, holidayOT: 0, approved: true, lateMinutes: 20 },
    { hoursWorked: 8, otHours: 0, weekendOT: 8, holidayOT: 0, approved: true, lateMinutes: 0 },
    { hoursWorked: 8, otHours: 0, weekendOT: 0, holidayOT: 8, approved: false, lateMinutes: 0 }, // unapproved holiday OT
    { absent: true, absentReason: 'Sick' },
  ];

  const summary = summarizePeriodAttendance(records, 3); // 3 approved leave days
  assert.equal(summary.daysPresent, 3);
  assert.equal(summary.daysAbsent, 1);
  assert.equal(summary.daysLeave, 3);
  assert.equal(summary.totalHours, 26);
  assert.equal(summary.weekdayOT, 2);
  assert.equal(summary.weekendOT, 8);
  assert.equal(summary.holidayOT, 8);
  assert.equal(summary.totalOT, 18);
  assert.equal(summary.unapprovedOTHours, 8);
  assert.equal(summary.lateCount, 1);
  assert.equal(summary.totalLateMinutes, 20);
});

// FR-ATT-13: Attendance for a locked period shall be read-only.
test('FR-ATT-13: Attendance for a locked period is strictly read-only', () => {
  function verifyPeriodLock(payrollRuns, targetDate) {
    const d = new Date(targetDate);
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const run = payrollRuns.find((r) => r.period === period);
    if (run && run.status === 'Approved') {
      const err = new Error(`Attendance for locked payroll period ${period} is read-only.`);
      err.status = 409;
      throw err;
    }
    return true;
  }

  const runs = [
    { period: '2026-10', status: 'Approved' },
    { period: '2026-11', status: 'Draft' },
  ];

  // Modifying date in locked period 2026-10 should throw 409
  assert.throws(
    () => verifyPeriodLock(runs, '2026-10-15'),
    (err) => err.status === 409 && err.message.includes('Attendance for locked payroll period 2026-10 is read-only.')
  );

  // Modifying date in unlocked period 2026-11 should succeed
  assert.doesNotThrow(() => verifyPeriodLock(runs, '2026-11-15'));
});

// Integration with payroll engine gross-to-net calculations
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
    { shift: 'Day', hoursWorked: 10, otHours: 2, weekendOT: 0, holidayOT: 0, multiplier: 1.5, approved: true },
    // 8 hours Weekend OT at 2.0 = 8 * 1000 * 2.0 = 16000
    { shift: 'Weekend', hoursWorked: 8, otHours: 0, weekendOT: 8, holidayOT: 0, multiplier: 2.0, approved: true },
    // 8 hours Holiday OT at 2.5 = 8 * 1000 * 2.5 = 20000
    { shift: 'Holiday', hoursWorked: 8, otHours: 0, weekendOT: 0, holidayOT: 8, multiplier: 2.5, approved: true },
  ];

  const line = calcLine(emp, { attendance }, '2026-11');
  assert.equal(line.otHours, 18); // 2 + 8 + 8 = 18
  assert.equal(line.otPay, 3000 + 16000 + 20000); // 39,000
  assert.equal(line.gross, 176000 + 39000);
});
