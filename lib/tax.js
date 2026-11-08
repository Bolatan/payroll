// Nigeria Tax Act 2025 (effective 1 Jan 2026). CONFIRM with a tax advisor before go-live (see FR-TAX-03).
const BANDS = [
  { upTo: 800000, rate: 0 },
  { upTo: 3000000, rate: 0.15 },
  { upTo: 12000000, rate: 0.18 },
  { upTo: 25000000, rate: 0.21 },
  { upTo: 50000000, rate: 0.23 },
  { upTo: Infinity, rate: 0.25 },
];
const RENT_RELIEF_RATE = 0.2;
const RENT_RELIEF_CAP = 500000;

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function annualTax(chargeable) {
  let prev = 0, tax = 0;
  for (const b of BANDS) {
    if (chargeable <= prev) break;
    tax += (Math.min(chargeable, b.upTo) - prev) * b.rate;
    prev = b.upTo;
  }
  return tax;
}

function computePAYE({ annualGross, annualPension = 0, annualNHF = 0, annualRent = 0 }) {
  const rentRelief = Math.min(RENT_RELIEF_RATE * annualRent, RENT_RELIEF_CAP);
  const chargeable = Math.max(0, annualGross - annualPension - annualNHF - rentRelief);
  const tax = annualTax(chargeable);
  return { rentRelief: r2(rentRelief), chargeable: r2(chargeable), annualTax: r2(tax), monthlyTax: r2(tax / 12) };
}

module.exports = { BANDS, computePAYE, annualTax, r2 };
