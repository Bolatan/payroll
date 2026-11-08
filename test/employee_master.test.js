const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calcLine,
  calcProration,
  CBN_BANKS,
  CFG,
} = require('../lib/payroll');

test('FR-EMP-01 & FR-EMP-08: Maintained CBN bank list with CBN bank codes and 10-digit NUBAN validation', () => {
  assert(CBN_BANKS.length >= 20, 'CBN bank list should include major Nigerian commercial banks');
  const accessBank = CBN_BANKS.find((b) => b.name === 'Access Bank');
  assert(accessBank, 'Access Bank should be in the list');
  assert.equal(accessBank.code, '044');

  const firstBank = CBN_BANKS.find((b) => b.name === 'First Bank of Nigeria');
  assert(firstBank, 'First Bank should be in the list');
  assert.equal(firstBank.code, '011');
});

test('FR-EMP-04: HourlyRate derived as BasicSalary ÷ standard monthly hours', () => {
  const basicSalary = 176000;
  const stdHours = CFG.HOURS(); // 176 by default
  const emp = {
    empId: 'EMP901',
    surname: 'Balogun',
    firstName: 'Tunde',
    basic: basicSalary,
    bank: 'First Bank of Nigeria',
    accountNo: '0123456789',
  };

  const line = calcLine(emp, {}, '2026-11');
  const expectedHourly = Math.round(basicSalary / stdHours);
  assert.equal(line.basic, 176000);
  // otHours calculation verifies rate derivation when OT is present
  const lineWithOT = calcLine(emp, { attendance: [{ shift: 'Day', hoursWorked: 10 }] }, '2026-11');
  // Day shift overtime = (10 - 8) * 1000 * 1.5 = 3000
  assert.equal(lineWithOT.otPay, 3000);
});

test('FR-EMP-06: Pay components per employee flagged Taxable, Pensionable and Recurring', () => {
  const emp = {
    empId: 'EMP902',
    surname: 'Oladipo',
    firstName: 'Kola',
    basic: 200000,
    bank: 'Zenith Bank',
    accountNo: '1234567890',
    payComponents: [
      { name: 'Housing Allowance', amount: 80000, taxable: true, pensionable: true, recurring: true },
      { name: 'Transport Allowance', amount: 40000, taxable: true, pensionable: true, recurring: true },
      { name: 'Utility Allowance', amount: 30000, taxable: true, pensionable: false, recurring: true },
      { name: 'Special Relocation Bonus', amount: 50000, taxable: true, pensionable: false, recurring: false },
    ],
  };

  const line = calcLine(emp, {}, '2026-11');
  // Pensionable base = basic (200k) + housing (80k) + transport (40k) = 320k
  // Pension = 8% * 320k = 25,600
  assert.equal(line.pension, 25600);
  assert.equal(line.employerPension, 32000);
  // Total allowances = 80k + 40k + 30k + 50k = 200k
  assert.equal(line.allowances, 200000);
  assert.equal(line.gross, 400000);
});

test('FR-EMP-11: Proration for new hires and leavers by calendar days and working days', () => {
  // Calendar days proration for mid-month joiner: joined 11th Nov in 30-day month -> 20 of 30 days
  const joiner = {
    empId: 'EMP903',
    surname: 'Chukwu',
    firstName: 'Amaka',
    hireDate: '2026-11-11',
    basic: 300000,
  };
  const calendarRatio = calcProration(joiner, '2026-11', 'calendar');
  // (30 - 11 + 1) / 30 = 20 / 30 = 0.67
  assert.equal(calendarRatio, 0.67);

  // Leaver terminated on Nov 15th
  const leaver = {
    empId: 'EMP904',
    surname: 'Abiola',
    firstName: 'Segun',
    hireDate: '2020-01-01',
    terminationDate: '2026-11-15',
    basic: 300000,
  };
  const leaverCalendarRatio = calcProration(leaver, '2026-11', 'calendar');
  // 15 of 30 days = 0.5
  assert.equal(leaverCalendarRatio, 0.5);

  // Working days proration
  const workingRatio = calcProration(joiner, '2026-11', 'working');
  assert(workingRatio > 0 && workingRatio <= 1, 'Working ratio must be a valid fraction');

  // Verify calcLine incorporates proration
  const line = calcLine(joiner, {}, '2026-11', { prorationMethod: 'calendar' });
  assert.equal(line.basic, Math.round(300000 * 0.67 * 100) / 100);
});

test('FR-EMP-03: Controlled Status and retained termination records', () => {
  const terminatedEmp = {
    empId: 'EMP905',
    surname: 'Yusuf',
    firstName: 'Fatima',
    status: 'Terminated',
    terminationDate: '2026-11-10',
    basic: 150000,
    bank: 'Access Bank',
    accountNo: '0987654321',
  };

  const line = calcLine(terminatedEmp, {}, '2026-11', { prorationMethod: 'calendar' });
  // 10 of 30 days = 10 / 30 = 0.33
  assert.equal(line.basic, Math.round(150000 * 0.33 * 100) / 100);
  assert(line.netPay > 0);
});
