const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computePAYE,
  annualTax,
  calculateBandTax,
  resolveTaxConfig,
  runTaxRegressionPack,
  NTA_2025_BANDS,
  PITA_HISTORICAL_BANDS,
  DEFAULT_TAX_CONFIGS,
  r2,
} = require('../lib/tax');
const { calcLine, hoursBetween } = require('../lib/payroll');

/**
 * TAX ENGINE AND STATUTORY REFERENCE DATA TEST SUITE (FR-TAX-01 to FR-TAX-09)
 */

test('FR-TAX-01: Effective-dated reference data stored with rates, bands and relief rules', () => {
  assert.ok(Array.isArray(DEFAULT_TAX_CONFIGS), 'Reference configurations must be stored in array/collection');
  assert.ok(DEFAULT_TAX_CONFIGS.length >= 2, 'Must include both active NTA 2025 and historical PITA');

  const ntaConfig = DEFAULT_TAX_CONFIGS.find((c) => c.regime === 'NTA_2025');
  assert.ok(ntaConfig);
  assert.strictEqual(ntaConfig.country, 'NG');
  assert.strictEqual(ntaConfig.rentReliefRate, 0.20);
  assert.strictEqual(ntaConfig.rentReliefCap, 500000);
  assert.strictEqual(ntaConfig.exemptionThreshold, 800000);
  assert.strictEqual(ntaConfig.craEnabled, false);

  const pitaConfig = DEFAULT_TAX_CONFIGS.find((c) => c.regime === 'PITA_HISTORICAL');
  assert.ok(pitaConfig);
  assert.strictEqual(pitaConfig.craEnabled, true);
  assert.strictEqual(pitaConfig.rentReliefRate, 0);
});

test('FR-TAX-02: Progressive contiguous bands with cumulative lower bound and open-ended top band', () => {
  let prevUpper = 0;
  for (let i = 0; i < NTA_2025_BANDS.length; i++) {
    const band = NTA_2025_BANDS[i];
    assert.strictEqual(band.lowerBound, prevUpper, `Band ${i + 1} lower bound must match previous upper bound`);
    if (i === NTA_2025_BANDS.length - 1) {
      assert.strictEqual(band.upTo, Infinity, 'Top band must be open-ended (Infinity)');
    } else {
      assert.ok(band.upTo > band.lowerBound, `Band ${i + 1} upper limit must exceed lower bound`);
      prevUpper = band.upTo;
    }
  }

  // Check arbitrary fractional amounts do not fall through cracks
  const frac1 = calculateBandTax(800000.50, NTA_2025_BANDS);
  assert.strictEqual(frac1.totalTax, 0.08); // 0.50 * 0.15 = 0.075 -> 0.08

  const frac2 = calculateBandTax(3000000.75, NTA_2025_BANDS);
  assert.strictEqual(frac2.totalTax, 330000.14); // 330000 + 0.75 * 0.18 = 330000.135 -> 330000.14
});

test('FR-TAX-03 & Illustrative: Nigeria Tax Act 2025 bands active from 1 Jan 2026', () => {
  // Illustrative calculation in REQUIREMENTS.md Section 4.9:
  // Monthly: Basic ₦150k, Housing ₦60k, Transport ₦40k -> Gross ₦250k (₦3m/yr), Annual rent ₦600k
  // Pension: ₦240k/yr, NHF: ₦45k/yr, Rent relief: ₦120k/yr (20% x 600k)
  // Chargeable: 3,000,000 - 240,000 - 45,000 - 120,000 = 2,595,000
  // Tax: first 800k @ 0% = 0; remaining 1,795,000 @ 15% = 269,250
  // Monthly PAYE = 22,437.50
  // Net Pay = 250,000 - 20,000 - 3,750 - 22,437.50 = 203,812.50
  const ill = computePAYE({
    annualGross: 3000000,
    annualPension: 240000,
    annualNHF: 45000,
    annualRent: 600000,
    rentEvidenceRef: 'RENT-PROOF-01',
    period: '2026-11',
  });
  assert.strictEqual(ill.rentRelief, 120000);
  assert.strictEqual(ill.chargeable, 2595000);
  assert.strictEqual(ill.annualTax, 269250);
  assert.strictEqual(ill.monthlyTax, 22437.5);

  const emp = {
    empId: 'E1',
    surname: 'A',
    firstName: 'B',
    basic: 150000,
    housing: 60000,
    transport: 40000,
    annualRent: 600000,
    rentEvidenceRef: 'RENT-PROOF-01',
    nhfEnrolled: true,
    bank: 'GTB',
    accountNo: '0123456789',
  };
  const l = calcLine(emp, {}, '2026-11');
  assert.deepStrictEqual([l.gross, l.pension, l.nhf, l.paye, l.netPay], [250000, 20000, 3750, 22437.5, 203812.5]);
});

test('FR-TAX-04: Annualised chargeable income = gross − allowable deductions − rent relief', () => {
  const calc = computePAYE({
    annualGross: 12000000,
    annualPension: 960000,
    annualNHF: 120000,
    annualRent: 0,
    period: '2026-05',
  });
  // Chargeable = 12m - 960k - 120k = 10,920,000
  // First 800k @ 0% = 0
  // Next 2.2m @ 15% = 330,000
  // Remaining 7.92m @ 18% = 1,425,600
  // Total Annual Tax = 1,755,600
  // Monthly Tax = 146,300
  assert.strictEqual(calc.chargeable, 10920000);
  assert.strictEqual(calc.annualTax, 1755600);
  assert.strictEqual(calc.monthlyTax, 146300);
});

test('FR-TAX-05: Rent relief 20% capped at ₦500,000, evidence handling, no CRA in 2026', () => {
  // Scenario 1: Rent ₦3,000,000 -> 20% = ₦600,000 -> Capped at ₦500,000
  const capped = computePAYE({
    annualGross: 8000000,
    annualRent: 3000000,
    rentEvidenceRef: 'PROOF-99',
    period: '2026-03',
  });
  assert.strictEqual(capped.rentRelief, 500000);
  assert.strictEqual(capped.cra, 0, 'CRA must be 0 under 2026 NTA rules');

  // Scenario 2: Rent relief only applies when rent is recorded (0 if rent is 0)
  const noRent = computePAYE({
    annualGross: 8000000,
    annualRent: 0,
    period: '2026-03',
  });
  assert.strictEqual(noRent.rentRelief, 0);

  // Scenario 3: Missing evidence when requireRentEvidence is enforced
  const noEvidence = computePAYE({
    annualGross: 3000000,
    annualRent: 600000,
    rentEvidenceRef: '',
    customConfig: {
      ...resolveTaxConfig('NG', new Date('2026-01-01')),
      requireRentEvidence: true,
    },
  });
  assert.strictEqual(noEvidence.rentRelief, 0);
  assert.strictEqual(noEvidence.rentReliefEligible, false);
});

test('FR-TAX-06: Income within tax-free band or exemption threshold computes zero PAYE', () => {
  // Low earner at ₦720,000 annual gross (within ₦800,000 exemption threshold)
  const low = computePAYE({ annualGross: 720000, period: '2026-06' });
  assert.strictEqual(low.isExempt, true);
  assert.strictEqual(low.annualTax, 0);
  assert.strictEqual(low.monthlyTax, 0);

  // Exact threshold of ₦800,000
  const threshold = computePAYE({ annualGross: 800000, period: '2026-06' });
  assert.strictEqual(threshold.isExempt, true);
  assert.strictEqual(threshold.annualTax, 0);
  assert.strictEqual(threshold.monthlyTax, 0);
});

test('FR-TAX-07: Tax calculation selected by period end date (historical PITA before 2026)', () => {
  // Period 2025-11 (Pre-2026) -> Recalculates under PITA historical rules with CRA
  const pitaRun = computePAYE({
    annualGross: 3000000,
    annualPension: 240000,
    annualNHF: 45000,
    period: '2025-11',
  });
  assert.strictEqual(pitaRun.regime, 'PITA_HISTORICAL');
  assert.strictEqual(pitaRun.rentRelief, 0);
  assert.ok(pitaRun.cra > 0, 'PITA historical must calculate CRA');
  // CRA = Higher of (200,000 or 1% of 3m = 30k) + 20% of 3m = 200k + 600k = 800,000
  assert.strictEqual(pitaRun.cra, 800000);
  // Chargeable = 3,000,000 - 240,000 - 45,000 - 800,000 = 1,915,000
  assert.strictEqual(pitaRun.chargeable, 1915000);
  // PITA bands:
  // 300k @ 7% = 21,000
  // 300k @ 11% = 33,000
  // 500k @ 15% = 75,000
  // 500k @ 19% = 95,000
  // remaining 315,000 @ 21% = 66,150
  // Total PITA Tax = 290,150
  assert.strictEqual(pitaRun.annualTax, 290150);

  // Period 2026-01 -> Automatically switches to NTA 2025
  const ntaRun = computePAYE({
    annualGross: 3000000,
    annualPension: 240000,
    annualNHF: 45000,
    period: '2026-01',
  });
  assert.strictEqual(ntaRun.regime, 'NTA_2025');
  assert.strictEqual(ntaRun.cra, 0);
});

test('FR-TAX-08: Band-by-band result detail for validation and training calculator', () => {
  const calc = computePAYE({
    annualGross: 3000000,
    annualPension: 240000,
    annualNHF: 45000,
    annualRent: 600000,
    period: '2026-11',
  });
  assert.ok(Array.isArray(calc.bands), 'Must return band-by-band breakdown array');
  assert.strictEqual(calc.bands.length, 2); // 800k @ 0%, remaining 1.795m @ 15%
  assert.strictEqual(calc.bands[0].taxableInBand, 800000);
  assert.strictEqual(calc.bands[0].tax, 0);
  assert.strictEqual(calc.bands[1].taxableInBand, 1795000);
  assert.strictEqual(calc.bands[1].tax, 269250);
});

test('FR-TAX-09: Regression test pack of 25 reference employees passes with 100% accuracy', () => {
  const rep = runTaxRegressionPack();
  assert.strictEqual(rep.total, 25);
  assert.strictEqual(rep.passed, 25);
  assert.strictEqual(rep.failed, 0);
  assert.strictEqual(rep.allPassed, true);
});

test('Existing payroll unit tests: OT calculation and final loan instalment', () => {
  assert.strictEqual(hoursBetween('22:00', '07:00', 1), 8);
  const emp2 = { empId: 'E2', surname: 'A', firstName: 'B', basic: 100000, hourlyRate: 1000, bank: 'GTB', accountNo: '0123456789' };
  const l2 = calcLine(emp2, { attendance: [{ shift: 'Day', hoursWorked: 10 }] }, '2026-11');
  assert.strictEqual(l2.otPay, 3000); // 2h x 1000 x 1.5

  const emp3 = { empId: 'E3', surname: 'A', firstName: 'B', basic: 100000, bank: 'GTB', accountNo: '0123456789' };
  const l3 = calcLine(emp3, { loans: [{ _id: 'L1', status: 'Active', monthly: 20000, outstanding: 12500, startPeriod: '2026-01' }] }, '2026-11');
  assert.strictEqual(l3.loanDeduction, 12500);
});
