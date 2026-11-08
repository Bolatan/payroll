const test = require('node:test');
const assert = require('node:assert/strict');
const { computePAYE, annualTax, r2, GHANA_BANDS, KENYA_BANDS } = require('../lib/tax');
const {
  calcLine,
  hoursBetween,
  generateGLJournal,
  processBankPaymentSimulation,
  pairTimeClockPunches,
} = require('../lib/payroll');

test('Extended: Multi-country PAYE calculation for Ghana and Kenya', () => {
  // Ghana calculation test
  const ghResult = computePAYE({
    annualGross: 60000,
    country: 'GH',
  });
  assert(ghResult.monthlyTax > 0, 'Ghana monthly tax should be positive');

  // Kenya calculation test
  const keResult = computePAYE({
    annualGross: 1200000,
    country: 'KE',
  });
  assert(keResult.monthlyTax > 0, 'Kenya monthly tax should be positive');
  assert.equal(keResult.rentRelief, 0, 'Kenya does not apply Nigeria rent relief');
});

test('Extended: General-Ledger (GL) double-entry journal posting balances exactly', () => {
  const dummyRun = {
    period: '2026-11',
    totals: {
      employees: 2,
      gross: 500000,
      employerPension: 50000,
      pension: 40000,
      nhf: 12500,
      paye: 45000,
      loans: 20000,
      net: 382500,
    },
  };

  const journal = generateGLJournal(dummyRun);
  assert.equal(journal.isBalanced, true, 'Debits and credits must be equal');
  assert.equal(journal.totalDebit, journal.totalCredit, 'Total debits must match total credits');
  assert.equal(journal.totalDebit, 550000, 'Total debit should equal gross + employer pension');
});

test('Extended: Direct bank payment simulation reconciles and handles validation', () => {
  const dummyRun = {
    period: '2026-11',
    lines: [
      { empId: 'EMP001', name: 'Valid Staff', bank: 'Zenith Bank', accountNo: '0123456789', netPay: 200000 },
      { empId: 'EMP002', name: 'Invalid Account Staff', bank: 'First Bank', accountNo: '123', netPay: 150000 },
      { empId: 'EMP003', name: 'Zero Pay Staff', bank: 'GTBank', accountNo: '0987654321', netPay: 0 },
    ],
  };

  const batch = processBankPaymentSimulation(dummyRun, 'NIBSS_INSTANT_PAY');
  assert.equal(batch.totalCount, 2, 'Only netPay > 0 lines are included');
  assert.equal(batch.successfulCount, 1, 'One valid account succeeds');
  assert.equal(batch.failedCount, 1, 'One invalid account fails');
  assert.equal(batch.totalAmount, 350000);
});

test('Extended: Biometric time-clock punch pairing computes attendance and handles shifts', () => {
  const samplePunches = [
    {
      _id: 'p1',
      deviceId: 'GATE-01',
      empId: 'EMP100',
      timestamp: '2026-11-02T08:00:00Z',
      punchType: 'IN',
    },
    {
      _id: 'p2',
      deviceId: 'GATE-01',
      empId: 'EMP100',
      timestamp: '2026-11-02T17:00:00Z',
      punchType: 'OUT',
    },
  ];

  const attendance = pairTimeClockPunches(samplePunches);
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].empId, 'EMP100');
  assert.equal(attendance[0].clockIn, '08:00');
  assert.equal(attendance[0].clockOut, '17:00');
  assert.equal(attendance[0].hoursWorked, 9);
  assert.equal(attendance[0].source, 'timeclock');
});

test('Extended: Multi-currency and multi-country attributes in calcLine', () => {
  const ghEmp = {
    empId: 'GH001',
    surname: 'Mensah',
    firstName: 'Kwame',
    country: 'GH',
    currency: 'GHS',
    basic: 5000,
    housing: 1000,
    transport: 500,
    bank: 'Ecobank Ghana',
    accountNo: 'GH1234567890',
  };

  const line = calcLine(ghEmp, {}, '2026-11');
  assert.equal(line.country, 'GH');
  assert.equal(line.currency, 'GHS');
  assert.equal(line.gross, 6500);
  assert.equal(line.nhf, 0, 'NHF is only applicable to Nigeria');
  assert(line.netPay > 0, 'Net pay must be calculated');
});
