// Multi-country Tax and Statutory Engines
// Supports Nigeria (NTA 2025), Ghana (GRA progressive income tax), and Kenya (KRA PAYE).

const NIGERIA_BANDS = [
  { upTo: 800000, rate: 0 },
  { upTo: 3000000, rate: 0.15 },
  { upTo: 12000000, rate: 0.18 },
  { upTo: 25000000, rate: 0.21 },
  { upTo: 50000000, rate: 0.23 },
  { upTo: Infinity, rate: 0.25 },
];

const GHANA_BANDS = [
  { upTo: 5880, rate: 0 },
  { upTo: 7200, rate: 0.05 },
  { upTo: 8640, rate: 0.10 },
  { upTo: 46640, rate: 0.175 },
  { upTo: 240000, rate: 0.25 },
  { upTo: 600000, rate: 0.30 },
  { upTo: Infinity, rate: 0.35 },
];

const KENYA_BANDS = [
  { upTo: 288000, rate: 0.10 },
  { upTo: 388000, rate: 0.25 },
  { upTo: 6000000, rate: 0.30 },
  { upTo: 9600000, rate: 0.325 },
  { upTo: Infinity, rate: 0.35 },
];

const RENT_RELIEF_RATE = 0.2;
const RENT_RELIEF_CAP = 500000;

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function computeTaxBands(chargeable, bands = NIGERIA_BANDS) {
  let prev = 0;
  const bandResults = [];
  for (const b of bands) {
    if (chargeable <= prev) {
      bandResults.push({
        lower: prev,
        upper: b.upTo === Infinity ? null : b.upTo,
        rate: b.rate,
        taxableAmount: 0,
        taxAmount: 0,
      });
      prev = b.upTo;
      continue;
    }
    const taxableAmount = r2(Math.min(chargeable, b.upTo) - prev);
    const taxAmount = r2(taxableAmount * b.rate);
    bandResults.push({
      lower: prev,
      upper: b.upTo === Infinity ? null : b.upTo,
      rate: b.rate,
      taxableAmount,
      taxAmount,
    });
    prev = b.upTo;
  }
  return bandResults;
}

function annualTax(chargeable, bands = NIGERIA_BANDS) {
  let prev = 0, tax = 0;
  for (const b of bands) {
    if (chargeable <= prev) break;
    tax += (Math.min(chargeable, b.upTo) - prev) * b.rate;
    prev = b.upTo;
  }
  return tax;
}

function computePAYE({ annualGross, annualPension = 0, annualNHF = 0, annualRent = 0, country = 'NG' }) {
  let bands = NIGERIA_BANDS;
  let rentRelief = 0;

  if (country === 'GH') {
    bands = GHANA_BANDS;
  } else if (country === 'KE') {
    bands = KENYA_BANDS;
  } else {
    // Default Nigeria (NTA 2025)
    rentRelief = Math.min(RENT_RELIEF_RATE * annualRent, RENT_RELIEF_CAP);
  }

  const chargeable = Math.max(0, annualGross - annualPension - annualNHF - rentRelief);
  const tax = annualTax(chargeable, bands);
  const taxBands = computeTaxBands(chargeable, bands);
  return {
    rentRelief: r2(rentRelief),
    chargeable: r2(chargeable),
    annualTax: r2(tax),
    monthlyTax: r2(tax / 12),
    taxBands,
  };
}

module.exports = {
  BANDS: NIGERIA_BANDS,
  NIGERIA_BANDS,
  GHANA_BANDS,
  KENYA_BANDS,
  computePAYE,
  computeTaxBands,
  annualTax,
  r2
};
