const test = require('node:test');
const assert = require('node:assert');
const { computePAYE } = require('../lib/tax');
const { calcLine, hoursBetween } = require('../lib/payroll');

test('US-21 AC1: chargeable 2,595,000 -> annual PAYE 269,250', () => {
  const t = computePAYE({ annualGross: 3000000, annualPension: 240000, annualNHF: 45000, annualRent: 600000 });
  assert.strictEqual(t.chargeable, 2595000);
  assert.strictEqual(t.annualTax, 269250);
  assert.strictEqual(t.monthlyTax, 22437.5);
});

test('US-21 AC2: monthly gross 1,000,000 -> monthly PAYE 146,300', () => {
  const t = computePAYE({ annualGross: 12000000, annualPension: 960000, annualNHF: 120000 });
  assert.strictEqual(t.annualTax, 1755600);
  assert.strictEqual(t.monthlyTax, 146300);
});

test('US-22: low earner pays no PAYE; rent relief capped at 500,000', () => {
  assert.strictEqual(computePAYE({ annualGross: 720000 }).annualTax, 0);
  assert.strictEqual(computePAYE({ annualGross: 9e6, annualRent: 3e6 }).rentRelief, 500000);
});

test('US-20 AC1: sample employee net pay 203,812.50', () => {
  const emp = { empId: 'E1', surname: 'A', firstName: 'B', basic: 150000, housing: 60000, transport: 40000, annualRent: 600000, nhfEnrolled: true, bank: 'GTB', accountNo: '0123456789' };
  const l = calcLine(emp, {}, '2026-11');
  assert.deepStrictEqual([l.gross, l.pension, l.nhf, l.paye, l.netPay], [250000, 20000, 3750, 22437.5, 203812.5]);
});

test('US-07: night shift crossing midnight = 8h; Day OT x1.5', () => {
  assert.strictEqual(hoursBetween('22:00', '07:00', 1), 8);
  const emp = { empId: 'E2', surname: 'A', firstName: 'B', basic: 100000, hourlyRate: 1000, bank: 'GTB', accountNo: '0123456789' };
  const l = calcLine(emp, { attendance: [{ shift: 'Day', hoursWorked: 10 }] }, '2026-11');
  assert.strictEqual(l.otPay, 3000); // 2h x 1000 x 1.5
});

test('US-12: final loan instalment equals remaining balance', () => {
  const emp = { empId: 'E3', surname: 'A', firstName: 'B', basic: 100000, bank: 'GTB', accountNo: '0123456789' };
  const l = calcLine(emp, { loans: [{ _id: 'L1', status: 'Active', monthly: 20000, outstanding: 12500, startPeriod: '2026-01' }] }, '2026-11');
  assert.strictEqual(l.loanDeduction, 12500);
});
