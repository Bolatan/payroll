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

const CBN_BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '100', name: 'Suntrust Bank' },
  { code: '302', name: 'TAJ Bank' },
  { code: '102', name: 'Titan Trust Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
];

function calcProration(emp, period, method = 'calendar') {
  // method can be 'calendar' or 'working' (FR-EMP-11)
  const [y, m] = period.split('-').map(Number);
  const periodStart = new Date(Date.UTC(y, m - 1, 1));
  const periodEnd = new Date(Date.UTC(y, m, 0)); // last day of month
  const totalDays = periodEnd.getUTCDate();

  let startDay = 1;
  let endDay = totalDays;

  if (emp.hireDate) {
    const hd = new Date(emp.hireDate);
    if (hd > periodStart && hd <= periodEnd) {
      startDay = hd.getUTCDate();
    } else if (hd > periodEnd) {
      return 0; // hired after period
    }
  }

  if (emp.terminationDate) {
    const td = new Date(emp.terminationDate);
    if (td >= periodStart && td < periodEnd) {
      endDay = td.getUTCDate();
    } else if (td < periodStart) {
      return 0; // terminated before period
    }
  }

  if (startDay === 1 && endDay === totalDays) {
    return 1;
  }

  if (method === 'working') {
    // Count Monday to Friday working days
    let totalWorking = 0;
    let workedWorking = 0;
    for (let d = 1; d <= totalDays; d++) {
      const dt = new Date(Date.UTC(y, m - 1, d));
      const day = dt.getUTCDay();
      const isWork = day !== 0 && day !== 6;
      if (isWork) totalWorking++;
      if (isWork && d >= startDay && d <= endDay) workedWorking++;
    }
    return totalWorking > 0 ? r2(workedWorking / totalWorking) : 1;
  }

  // Calendar days proration
  const payableDays = Math.max(0, endDay - startDay + 1);
  return r2(payableDays / totalDays);
}

function calcLine(emp, { attendance = [], adjustments = [], loans = [] }, period, options = {}) {
  const country = emp.country || 'NG';
  const currency = emp.currency || 'NGN';

  // Proration calculation (FR-EMP-11)
  const prorationRatio = calcProration(emp, period, options.prorationMethod || 'calendar');
  const fullBasic = emp.basic || 0;
  const basic = r2(fullBasic * prorationRatio);

  let housing = emp.housing || 0;
  let transport = emp.transport || 0;
  let otherAllowance = emp.otherAllowance || 0;
  let pensionableComponents = 0;
  let taxableComponents = 0;

  // FR-EMP-06: Check pay components per employee (Basic, Housing, Transport, etc.)
  if (Array.isArray(emp.payComponents) && emp.payComponents.length > 0) {
    housing = 0;
    transport = 0;
    otherAllowance = 0;
    for (const comp of emp.payComponents) {
      const cAmt = r2((comp.amount || 0) * (comp.recurring ? prorationRatio : 1));
      if (comp.name.toLowerCase().includes('housing')) housing += cAmt;
      else if (comp.name.toLowerCase().includes('transport')) transport += cAmt;
      else otherAllowance += cAmt;

      if (comp.pensionable) pensionableComponents += cAmt;
      if (comp.taxable) taxableComponents += cAmt;
    }
  } else {
    housing = r2(housing * prorationRatio);
    transport = r2(transport * prorationRatio);
    otherAllowance = r2(otherAllowance * prorationRatio);
    pensionableComponents = housing + transport;
    taxableComponents = housing + transport + otherAllowance;
  }

  const allowances = r2(housing + transport + otherAllowance);
  const rate = emp.hourlyRate || r2(fullBasic / CFG.HOURS());

  let otHours = 0, otPay = 0;
  for (const a of attendance) {
    const stdHours = a.stdHours != null ? a.stdHours : CFG.STD_HOURS;
    const isPremium = CFG.ALL_HOURS_PREMIUM.includes(a.shift);
    const ot = isPremium ? a.hoursWorked : Math.max(0, a.hoursWorked - stdHours);
    const mult = a.otMultiplier != null ? a.otMultiplier : (CFG.MULT[a.shift] || 1);
    otHours += ot;
    otPay += ot * rate * mult;
  }

  let bonuses = 0, otherDeductions = 0;
  for (const j of adjustments) {
    if (j.type === 'deduction') otherDeductions += j.amount;
    else bonuses += j.amount;
  }

  const gross = r2(basic + allowances + otPay + bonuses);
  const pensionable = r2(basic + pensionableComponents);
  const pension = r2((emp.pensionPct ?? 0.08) * pensionable);
  const nhf = (country === 'NG' && emp.nhfEnrolled) ? r2((emp.nhfPct ?? 0.025) * basic) : 0;

  // Annualised method with multi-country tax bands
  const tax = computePAYE({
    annualGross: gross * 12,
    annualPension: pension * 12,
    annualNHF: nhf * 12,
    annualRent: emp.annualRent || 0,
    country,
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
  if (country === 'NG' && (!/^\d{10}$/.test(emp.accountNo || '') || !emp.bank)) {
    flags.push('NO_BANK');
  } else if (!emp.accountNo || !emp.bank) {
    flags.push('NO_BANK');
  }

  return {
    empId: emp.empId, name: `${emp.surname} ${emp.firstName}`, department: emp.department, position: emp.position,
    country, currency,
    bank: emp.bank, accountNo: emp.accountNo,
    basic, allowances, otHours: r2(otHours), otPay: r2(otPay), bonuses: r2(bonuses), gross,
    pension, nhf, rentRelief: tax.rentRelief, chargeable: tax.chargeable, paye: tax.monthlyTax,
    loanDeduction, otherDeductions, netPay, employerPension: r2(CFG.EMPLOYER_PENSION * pensionable),
    loanBreakdown, flags,
  };
}

// -------------------------------------------------------------
// Extended Engines: GL Posting, Bank Payment, Time-Clock Pairing
// -------------------------------------------------------------

function generateGLJournal(payrollRun, options = {}) {
  const period = payrollRun.period;
  const t = payrollRun.totals || {};
  const journalNumber = `GL-${period}-${Date.now().toString().slice(-4)}`;
  const currency = options.currency || 'NGN';

  const gross = r2(t.gross || 0);
  const employerPension = r2(t.employerPension || 0);
  const employeePension = r2(t.pension || 0);
  const totalPensionPayable = r2(employeePension + employerPension);
  const paye = r2(t.paye || 0);
  const nhf = r2(t.nhf || 0);
  const loanRecoveries = r2(t.loans || 0);
  const netPayable = r2(t.net || 0);

  // Debits: Expenses
  // Credits: Liabilities & Asset Reductions / Clearances
  const entries = [
    { accountCode: '5001', accountName: 'Gross Salaries & Wages Expense', debit: gross, credit: 0 },
    { accountCode: '5002', accountName: 'Employer Pension Contribution Expense', debit: employerPension, credit: 0 },
    { accountCode: '2001', accountName: 'Net Salaries Payable', debit: 0, credit: netPayable },
    { accountCode: '2002', accountName: 'Pension Remittance Payable (PFA)', debit: 0, credit: totalPensionPayable },
    { accountCode: '2003', accountName: 'PAYE Tax Withholding Payable (IRS)', debit: 0, credit: paye },
  ];

  if (nhf > 0) {
    entries.push({ accountCode: '2004', accountName: 'NHF Withholding Payable (FMBN)', debit: 0, credit: nhf });
  }
  if (loanRecoveries > 0) {
    entries.push({ accountCode: '1050', accountName: 'Staff Loans Receivable (Recovery)', debit: 0, credit: loanRecoveries });
  }

  // Handle other deductions balancing if any
  const totalDebits = r2(entries.reduce((s, e) => s + e.debit, 0));
  const totalCredits = r2(entries.reduce((s, e) => s + e.credit, 0));
  const diff = r2(totalDebits - totalCredits);
  if (Math.abs(diff) > 0.005) {
    entries.push({
      accountCode: '2099',
      accountName: 'Other Payroll Deductions Clearing',
      debit: diff < 0 ? Math.abs(diff) : 0,
      credit: diff > 0 ? diff : 0
    });
  }

  const finalDebits = r2(entries.reduce((s, e) => s + e.debit, 0));
  const finalCredits = r2(entries.reduce((s, e) => s + e.credit, 0));

  return {
    journalNumber,
    period,
    description: `Payroll journal entry for period ${period}`,
    currency,
    entries,
    totalDebit: finalDebits,
    totalCredit: finalCredits,
    isBalanced: Math.abs(finalDebits - finalCredits) < 0.01,
  };
}

function processBankPaymentSimulation(payrollRun, channel = 'NIBSS_INSTANT_PAY') {
  const period = payrollRun.period;
  const batchReference = `PAY-${channel.slice(0, 4)}-${period}-${Date.now().toString().slice(-4)}`;
  const payableLines = (payrollRun.lines || []).filter((l) => l.netPay > 0);

  const transactions = payableLines.map((l, idx) => {
    // In simulation: valid 10-digit account succeeds; missing or malformed fails
    const isValidAcc = /^\d{10}$/.test(l.accountNo || '') && !!l.bank;
    return {
      empId: l.empId,
      accountNo: l.accountNo || 'N/A',
      bankName: l.bank || 'Unknown Bank',
      bankCode: '000',
      amount: l.netPay,
      status: isValidAcc ? 'Success' : 'Failed',
      gatewayTxId: `TX-${Date.now()}-${idx + 1}`,
      message: isValidAcc ? 'Transaction completed successfully' : 'Invalid bank or account number',
    };
  });

  const successfulCount = transactions.filter((t) => t.status === 'Success').length;
  const failedCount = transactions.length - successfulCount;
  const totalAmount = r2(payableLines.reduce((s, l) => s + l.netPay, 0));

  return {
    batchReference,
    period,
    channel,
    currency: 'NGN',
    totalAmount,
    totalCount: transactions.length,
    successfulCount,
    failedCount,
    status: failedCount === 0 ? 'Completed' : (successfulCount > 0 ? 'Completed' : 'Failed'),
    transactions,
  };
}

function pairTimeClockPunches(punches, options = {}) {
  const holidays = options.holidays || []; // list of date strings (YYYY-MM-DD) or Dates
  const holidayDateSet = new Set(
    holidays.map((h) => {
      const d = new Date(h);
      return !isNaN(d) ? d.toISOString().slice(0, 10) : String(h);
    })
  );
  // Sort punches ascending by timestamp
  const sorted = [...punches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const grouped = {};

  for (const p of sorted) {
    const dt = new Date(p.timestamp);
    const dateStr = dt.toISOString().slice(0, 10);
    const key = `${p.empId}:::${dateStr}`;
    grouped[key] ||= [];
    grouped[key].push(p);
  }

  const attendanceEntries = [];
  for (const [key, list] of Object.entries(grouped)) {
    const [empId, dateStr] = key.split(':::');
    const firstIn = list.find((x) => x.punchType === 'IN');
    const lastOut = [...list].reverse().find((x) => x.punchType === 'OUT');

    if (firstIn && lastOut && new Date(lastOut.timestamp) > new Date(firstIn.timestamp)) {
      const inDate = new Date(firstIn.timestamp);
      const outDate = new Date(lastOut.timestamp);
      const pad = (n) => String(n).padStart(2, '0');
      const clockIn = `${pad(inDate.getUTCHours())}:${pad(inDate.getUTCMinutes())}`;
      const clockOut = `${pad(outDate.getUTCHours())}:${pad(outDate.getUTCMinutes())}`;
      const dayOfWeek = inDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
      let shift = (dayOfWeek === 0 || dayOfWeek === 6) ? 'Weekend' : 'Day';
      if (holidayDateSet.has(dateStr)) {
        shift = 'Holiday';
      }
      const hoursWorked = hoursBetween(clockIn, clockOut, 0);

      attendanceEntries.push({
        empId,
        date: new Date(dateStr),
        shift,
        clockIn,
        clockOut,
        breakHours: 0,
        hoursWorked,
        source: 'timeclock',
        deviceId: firstIn.deviceId,
        punchIds: [firstIn._id, lastOut._id].filter(Boolean),
      });
    }
  }

  return attendanceEntries;
}

module.exports = {
  calcLine,
  calcProration,
  hoursBetween,
  CFG,
  CBN_BANKS,
  generateGLJournal,
  processBankPaymentSimulation,
  pairTimeClockPunches,
};
