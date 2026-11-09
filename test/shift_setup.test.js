const test = require('node:test');
const assert = require('node:assert/strict');
const { calcLine, hoursBetween, pairTimeClockPunches } = require('../lib/payroll');

test('FR-SHF-01: Default shift multipliers and standard hours calculation', () => {
  const emp = {
    empId: 'EMP_SHF_01',
    surname: 'Test',
    firstName: 'Shift',
    basic: 176000, // hourlyRate = 1000
    housing: 0,
    transport: 0,
    bank: 'First Bank',
    accountNo: '0123456789',
  };

  // Day: 10h worked (8h std, 2h OT @ 1.5x) => 2 * 1000 * 1.5 = 3000
  // Night: 10h worked (8h std, 2h OT @ 1.75x) => 2 * 1000 * 1.75 = 3500
  // Weekend: 8h worked (all OT @ 2.0x) => 8 * 1000 * 2.0 = 16000
  // Holiday: 8h worked (all OT @ 2.5x) => 8 * 1000 * 2.5 = 20000
  const attendance = [
    { shift: 'Day', hoursWorked: 10 },
    { shift: 'Night', hoursWorked: 10 },
    { shift: 'Weekend', hoursWorked: 8 },
    { shift: 'Holiday', hoursWorked: 8 },
  ];

  const line = calcLine(emp, { attendance }, '2026-11');
  assert.equal(line.otHours, 20); // 2 + 2 + 8 + 8 = 20
  assert.equal(line.otPay, 42500); // 3000 + 3500 + 16000 + 20000 = 42500
});

test('FR-SHF-01 & FR-SHF-02: User-defined shifts with custom stdHours and multipliers', () => {
  const emp = {
    empId: 'EMP_SHF_02',
    surname: 'Custom',
    firstName: 'Shift',
    basic: 176000,
    bank: 'Access Bank',
    accountNo: '0987654321',
  };

  // User-defined shift: 12-Hour Heavy Shift with 12h stdHours and 1.8x multiplier
  const attendance = [
    { shift: 'Heavy_12h', hoursWorked: 14, stdHours: 12, otMultiplier: 1.8 },
  ];

  const line = calcLine(emp, { attendance }, '2026-11');
  assert.equal(line.otHours, 2); // 14 - 12 = 2
  assert.equal(line.otPay, 3600); // 2h * 1000 * 1.8 = 3600
});

test('FR-SHF-02: Night shifts crossing midnight hours calculation with break duration', () => {
  // 22:00 to 06:00 is 8 hours; with 1h break duration = 7 hours
  const hours = hoursBetween('22:00', '06:00', 1.0);
  assert.equal(hours, 7.0);

  // 20:00 to 04:30 is 8.5 hours; with 0.5h break = 8.0 hours
  const hours2 = hoursBetween('20:00', '04:30', 0.5);
  assert.equal(hours2, 8.0);
});

test('FR-SHF-04: Public holiday calendar classifies holiday shift during punch pairing', () => {
  const holidayDate = '2026-12-25';
  const punches = [
    {
      deviceId: 'GATE-01',
      empId: 'EMP_HOL_01',
      timestamp: `${holidayDate}T08:00:00Z`,
      punchType: 'IN',
    },
    {
      deviceId: 'GATE-01',
      empId: 'EMP_HOL_01',
      timestamp: `${holidayDate}T16:00:00Z`,
      punchType: 'OUT',
    },
  ];

  const result = pairTimeClockPunches(punches, { holidays: [holidayDate] });
  assert.equal(result.length, 1);
  assert.equal(result[0].shift, 'Holiday', 'Shift on public holiday must be classified as Holiday');
});
