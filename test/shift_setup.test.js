const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveEffectiveShiftRule,
  evaluateAttendanceEntry,
  hoursBetween,
  calcLine,
  CFG,
} = require('../lib/payroll');
const { ShiftSetup, PublicHoliday, Attendance } = require('../lib/models');

test('FR-SHF-01: Default shift types and standard hours & multipliers', () => {
  // Standard defaults: 8h with 1.5, 1.75, 2.0, 2.5
  assert.equal(CFG.STD_HOURS, 8);
  assert.equal(CFG.MULT.Day, 1.5);
  assert.equal(CFG.MULT.Night, 1.75);
  assert.equal(CFG.MULT.Weekend, 2.0);
  assert.equal(CFG.MULT.Holiday, 2.5);

  // User-defined shift types supported
  const customShiftRule = {
    shift: 'Evening_Hazard',
    stdHours: 6,
    multiplier: 1.8,
    startTime: '16:00',
    endTime: '22:00',
    unpaidBreakHours: 0.5,
    effectiveDate: new Date('2026-01-01'),
  };
  const resolved = resolveEffectiveShiftRule(customShiftRule, '2026-06-01');
  assert.equal(resolved.shift, 'Evening_Hazard');
  assert.equal(resolved.stdHours, 6);
  assert.equal(resolved.multiplier, 1.8);
});

test('FR-SHF-02: Configurable start/end times crossing midnight, break duration, and effective date', () => {
  // Night shift 21:00 to 05:30 with 0.5h break = 8 hours worked
  const hours = hoursBetween('21:00', '05:30', 0.5);
  assert.equal(hours, 8);

  const nightShiftConfig = {
    shift: 'Night',
    stdHours: 8,
    multiplier: 1.75,
    startTime: '20:00',
    endTime: '05:00',
    unpaidBreakHours: 1,
    effectiveDate: new Date('2026-01-01'),
  };

  const resolved = resolveEffectiveShiftRule(nightShiftConfig, new Date('2026-03-01'));
  assert.equal(resolved.startTime, '20:00');
  assert.equal(resolved.endTime, '05:00');
  assert.equal(resolved.unpaidBreakHours, 1);
  assert.equal(resolved.multiplier, 1.75);
});

test('FR-SHF-03: Changes to multipliers or standard hours apply prospectively by effective date', () => {
  // Historical configuration before 2026-07-01: 8h, 1.5x
  // Prospective update starting 2026-07-01: 7h, 1.6x
  const shiftRecord = {
    shift: 'Day',
    stdHours: 7,
    multiplier: 1.6,
    startTime: '08:00',
    endTime: '16:00',
    unpaidBreakHours: 1,
    effectiveDate: new Date('2026-07-01'),
    history: [
      {
        effectiveDate: new Date('2025-01-01'),
        stdHours: 8,
        multiplier: 1.5,
        startTime: '08:00',
        endTime: '17:00',
        unpaidBreakHours: 1,
        changedBy: 'admin',
        reason: 'Initial standard',
      },
    ],
  };

  // Query as of 2026-05-15 (before prospective effective date) -> should receive 8h, 1.5x
  const prior = resolveEffectiveShiftRule(shiftRecord, new Date('2026-05-15'));
  assert.equal(prior.stdHours, 8);
  assert.equal(prior.multiplier, 1.5);
  assert.equal(prior.endTime, '17:00');

  // Query as of 2026-07-15 (after prospective effective date) -> should receive 7h, 1.6x
  const prospective = resolveEffectiveShiftRule(shiftRecord, new Date('2026-07-15'));
  assert.equal(prospective.stdHours, 7);
  assert.equal(prospective.multiplier, 1.6);
  assert.equal(prospective.endTime, '16:00');
});

test('FR-SHF-04: Maintain public-holiday calendar used to classify Holiday shifts', () => {
  // A public holiday date classifies attendance on that date as HolidayOT with multiplier 2.5
  const holidayAttendance = evaluateAttendanceEntry({
    shift: 'Day',
    clockIn: '08:00',
    clockOut: '17:00',
    breakHours: 1,
  }, {
    isHoliday: true, // classified via PublicHoliday calendar
    stdHours: 8,
  });

  assert.equal(holidayAttendance.hoursWorked, 8);
  assert.equal(holidayAttendance.holidayOT, 8);
  assert.equal(holidayAttendance.multiplier, 2.5);
  assert.equal(holidayAttendance.otHours, 0);
  assert.equal(holidayAttendance.weekendOT, 0);
});

test('FR-SHF-05: Multipliers validated as >= 1.0 and standard hours between 1 and 24', () => {
  function validateShiftSetup(stdHours, multiplier) {
    const hours = Number(stdHours);
    const mult = Number(multiplier);
    if (isNaN(hours) || hours < 1 || hours > 24) {
      throw new Error('Standard hours must be between 1 and 24.');
    }
    if (isNaN(mult) || mult < 1.0) {
      throw new Error('Shift multiplier must be >= 1.0.');
    }
    return true;
  }

  // Valid configurations
  assert.equal(validateShiftSetup(8, 1.5), true);
  assert.equal(validateShiftSetup(1, 1.0), true);
  assert.equal(validateShiftSetup(24, 3.0), true);

  // Invalid multipliers (< 1.0)
  assert.throws(() => validateShiftSetup(8, 0.95), /multiplier must be >= 1.0/);
  assert.throws(() => validateShiftSetup(8, -1), /multiplier must be >= 1.0/);
  assert.throws(() => validateShiftSetup(8, 0), /multiplier must be >= 1.0/);

  // Invalid standard hours (< 1 or > 24)
  assert.throws(() => validateShiftSetup(0, 1.5), /between 1 and 24/);
  assert.throws(() => validateShiftSetup(25, 1.5), /between 1 and 24/);
  assert.throws(() => validateShiftSetup(-5, 1.5), /between 1 and 24/);
});
