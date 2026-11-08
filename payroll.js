const { computePAYE, r2 } = require('./tax');

const CFG = {
  HOURS: () => Number(process.env.HOURS_PER_MONTH || 176), // Open question Q2
  STD_HOURS: 8,
  MULT: { Day: 1.5, Night: 1.75, Weekend: 2, Holiday: 2.5 },
  ALL_HOURS_PREMIUM: ['Weekend', 'Holiday'], // Q3: all weekend/holiday hours count as overtime
  EMPLOYER_PENSION: 0.10,
};

function hoursBetween(clockIn, clockOut, breakHours = 0) {
  const [a, b] = clockIn.split(':').map(Number);
  const [c, d] = clockOut.split(':').map(Number);
  let mins = c * 60 + d - (a * 60 + b);
  if (mins <= 0) mins += 1440; // shift crosses midnight
  return r2(mins / 60 - breakHours);
}

function calcLine(emp, { attendance = [], adjustments = [], loans = [] }, period) {
  const basic = emp.basic || 0;
  const allowances = (emp.housing || 0) + (emp.transport || 0) + (emp.otherAllowance || 0);
  const rate = emp.hourlyRate || basic / CFG.HOURS();

  let otHours = 0, otPay = 0;
  for (const a of attendance) {
    const ot = CFG.ALL_HOURS_PREMIUM.includes(a.shift) ? a.hoursWorked : Math.max(0, a.hoursWorked - CFG.STD_HOURS);
    otHours += ot;
    otPay += ot * rate * (CFG.MULT[a.shift] || 1);
  }

  let bonuses = 0, otherDeductions = 0;
  for (const j of adjustments) {
    if (j.type === 'deduction') otherDeductions += j.amount;
    else bonuses += j.amount;
  }

  const gross = r2(basic + allowances + otPay + bonuses);
  const pensionable = basic + (emp.housing || 0) + (emp.transport || 0);
  const pension = r2((emp.pensionPct ?? 0.08) * pensionable);
  const nhf = emp.nhfEnrolled ? r2((emp.nhfPct ?? 0.025) * basic) : 0;

  // Annualised method (open question Q7)
  const tax = computePAYE({
    annualGross: gross * 12, annualPension: pension * 12, annualNHF: nhf * 12, annualRent: emp.annualRent || 0,
  });

  const loanBreakdown = [];
  for (const l of loans) {
    if (l.status !== 'Active' || l.outstanding <= 0 || l.startPeriod > period) continue;
    loanBreakdown.push({ loanId: String(l._id), amount: r2(Math.min(l.monthly, l.outstanding)) });
  }
  const loanDeduction = r2(loanBreakdown.reduce((s, l) => s + l.amount, 0));
  otherDeductions = r2(otherDeductions);

  const netPay = r2(gross - pension - nhf - tax.monthlyTax - loanDeduction - otherDeductions);
  const flags = [];
  if (netPay < 0) flags.push('NEGATIVE_NET');
  if (!/^\d{10}$/.test(emp.accountNo || '') || !emp.bank) flags.push('NO_BANK');

  return {
    empId: emp.empId, name: `${emp.surname} ${emp.firstName}`, department: emp.department, position: emp.position,
    bank: emp.bank, accountNo: emp.accountNo,
    basic, allowances, otHours: r2(otHours), otPay: r2(otPay), bonuses: r2(bonuses), gross,
    pension, nhf, rentRelief: tax.rentRelief, chargeable: tax.chargeable, paye: tax.monthlyTax,
    loanDeduction, otherDeductions, netPay, employerPension: r2(CFG.EMPLOYER_PENSION * pensionable),
    loanBreakdown, flags,
  };
}

module.exports = { calcLine, hoursBetween, CFG };
