const { computePAYE, r2 } = require('./tax');

const CFG = {
  HOURS: () => Number(process.env.HOURS_PER_MONTH || 176), // Open question Q2
  STD_HOURS: 8,
  MULT: { Day: 1.5, Night: 1.75, Weekend: 2.0, Holiday: 2.5 },
  ALL_HOURS_PREMIUM: ['Weekend', 'Holiday'], // Q3: all weekend/holiday hours count as overtime
  EMPLOYER_PENSION: 0.10,
  MAX_DAILY_OT: 4,      // Default max daily overtime hours (FR-ATT-09)
  MAX_PERIOD_OT: 50,    // Default max period overtime hours (FR-ATT-09)
  LATE_THRESHOLD_MINS: 15, // Default late arrival threshold (FR-ATT-11)
  EARLY_DEPART_THRESHOLD_MINS: 15, // Default early departure threshold (FR-ATT-11)
  DEFAULT_ATTENDANCE_BONUS_AMOUNT: 20000, // FR-BON-03 default perfect attendance bonus
};

function timeToMinutes(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function hoursBetween(clockIn, clockOut, breakHours = 0) {
  if (!clockIn || !clockOut) return 0;
  const inMins = timeToMinutes(clockIn);
  const outMins = timeToMinutes(clockOut);
  let mins = outMins - inMins;
  if (mins <= 0) mins += 1440; // shift crosses midnight
  return r2(Math.max(0, mins / 60 - Number(breakHours || 0)));
}

/**
 * FR-ATT-04, FR-ATT-05, FR-ATT-06, FR-ATT-07, FR-ATT-09, FR-ATT-11
 * Evaluates attendance entry hours, overtime breakdown, multipliers, lateness and warnings.
 */
function evaluateAttendanceEntry(entry, options = {}) {
  const shift = entry.shift || 'Day';
  const multMap = options.multipliers || CFG.MULT;
  const stdHours = options.stdHours ?? CFG.STD_HOURS;
  const isHoliday = Boolean(options.isHoliday || shift === 'Holiday');
  const isWeekend = Boolean(options.isWeekend || shift === 'Weekend');

  if (entry.absent) {
    return {
      hoursWorked: 0,
      otHours: 0,
      weekendOT: 0,
      holidayOT: 0,
      multiplier: 1.0,
      lateMinutes: 0,
      earlyDepartureMinutes: 0,
      absent: true,
      absentReason: entry.absentReason || 'Absent',
      supervisorOverrideReason: entry.supervisorOverrideReason || null,
      warnings: [],
    };
  }

  const hoursWorked = hoursBetween(entry.clockIn, entry.clockOut, entry.breakHours);

  // FR-ATT-07: Where a day qualifies for more than one multiplier (e.g. night shift on holiday),
  // select the highest applicable multiplier, not compounded.
  const applicableMultipliers = [multMap[shift] || 1.0];
  if (isHoliday) applicableMultipliers.push(multMap.Holiday || 2.5);
  if (isWeekend) applicableMultipliers.push(multMap.Weekend || 2.0);
  const activeMultiplier = Math.max(...applicableMultipliers);

  let otHours = 0;
  let weekendOT = 0;
  let holidayOT = 0;

  // FR-ATT-06: For shifts on weekend or public holiday, all hours classified as WeekendOT or HolidayOT
  if (isHoliday || shift === 'Holiday') {
    holidayOT = hoursWorked;
  } else if (isWeekend || shift === 'Weekend') {
    weekendOT = hoursWorked;
  } else {
    // Weekday Day or Night: OT hours = HoursWorked - StdHours when positive (FR-ATT-05)
    otHours = r2(Math.max(0, hoursWorked - stdHours));
  }

  // FR-ATT-11: Late arrival and early departure calculations
  let lateMinutes = 0;
  let earlyDepartureMinutes = 0;
  const scheduledStart = options.scheduledStart || (shift === 'Night' ? '20:00' : '08:00');
  const scheduledEnd = options.scheduledEnd || (shift === 'Night' ? '04:00' : '17:00');
  const lateThreshold = options.lateThresholdMins ?? CFG.LATE_THRESHOLD_MINS;
  const earlyThreshold = options.earlyThresholdMins ?? CFG.EARLY_DEPART_THRESHOLD_MINS;

  if (entry.clockIn && scheduledStart) {
    const diff = timeToMinutes(entry.clockIn) - timeToMinutes(scheduledStart);
    if (diff > lateThreshold) {
      lateMinutes = diff;
    }
  }

  if (entry.clockOut && scheduledEnd) {
    const diff = timeToMinutes(scheduledEnd) - timeToMinutes(entry.clockOut);
    // If shift doesn't cross midnight or handled
    if (diff > earlyThreshold && diff < 720) {
      earlyDepartureMinutes = diff;
    }
  }

  // FR-ATT-09: Overtime cap warning
  const maxDailyOT = options.maxDailyOT ?? CFG.MAX_DAILY_OT;
  const totalDayOT = r2(otHours + weekendOT + holidayOT);
  const warnings = [];
  let otExceededWarning = null;
  if (totalDayOT > maxDailyOT) {
    otExceededWarning = `Overtime of ${totalDayOT}h exceeds daily cap of ${maxDailyOT}h`;
    warnings.push(otExceededWarning);
  }

  return {
    hoursWorked,
    otHours,
    weekendOT,
    holidayOT,
    multiplier: activeMultiplier,
    lateMinutes,
    earlyDepartureMinutes,
    absent: false,
    otExceededWarning,
    warnings,
  };
}

/**
 * FR-ATT-12: A period attendance summary per employee:
 * days present, absent, leave, OT hours by category, total hours.
 */
function summarizePeriodAttendance(attendanceRecords = [], leaveDays = 0, options = {}) {
  let daysPresent = 0;
  let daysAbsent = 0;
  let totalHours = 0;
  let weekdayOT = 0;
  let weekendOT = 0;
  let holidayOT = 0;
  let unapprovedOTHours = 0;
  let totalLateMinutes = 0;
  let lateCount = 0;

  for (const a of attendanceRecords) {
    if (a.absent) {
      daysAbsent += 1;
      continue;
    }

    daysPresent += 1;
    totalHours += (a.hoursWorked || 0);
    weekdayOT += (a.otHours || 0);
    weekendOT += (a.weekendOT || 0);
    holidayOT += (a.holidayOT || 0);

    if (a.lateMinutes > 0) {
      totalLateMinutes += a.lateMinutes;
      lateCount += 1;
    }

    // FR-ATT-08: Check unapproved OT
    if (!a.approved && ((a.otHours || 0) > 0 || (a.weekendOT || 0) > 0 || (a.holidayOT || 0) > 0)) {
      unapprovedOTHours += ((a.otHours || 0) + (a.weekendOT || 0) + (a.holidayOT || 0));
    }
  }

  const totalOT = r2(weekdayOT + weekendOT + holidayOT);
  const maxPeriodOT = options.maxPeriodOT ?? CFG.MAX_PERIOD_OT;
  const warnings = [];
  if (totalOT > maxPeriodOT) {
    warnings.push(`Total period overtime of ${totalOT}h exceeds period cap of ${maxPeriodOT}h`);
  }

  return {
    daysPresent,
    daysAbsent,
    daysLeave: leaveDays,
    totalHours: r2(totalHours),
    weekdayOT: r2(weekdayOT),
    weekendOT: r2(weekendOT),
    holidayOT: r2(holidayOT),
    totalOT: r2(totalOT),
    unapprovedOTHours: r2(unapprovedOTHours),
    lateCount,
    totalLateMinutes,
    warnings,
  };
}

/**
 * FR-BON-03: Auto-suggest AttendanceBonus from attendance.
 * Configurable rules:
 * - maxAbsencesAllowed (default: 0)
 * - maxLatenessAllowed (default: 0)
 * - bonusAmount (default: 20000 or config)
 * - minDaysPresent (default: 15)
 */
function suggestAttendanceBonus(attendanceRecords = [], options = {}) {
  const summary = summarizePeriodAttendance(attendanceRecords);
  const maxAbsences = options.maxAbsencesAllowed ?? 0;
  const maxLateness = options.maxLatenessAllowed ?? 0;
  const minDaysPresent = options.minDaysPresent ?? 1;
  const bonusAmount = options.bonusAmount ?? CFG.DEFAULT_ATTENDANCE_BONUS_AMOUNT;

  const eligible = (
    summary.daysAbsent <= maxAbsences &&
    summary.lateCount <= maxLateness &&
    summary.daysPresent >= minDaysPresent
  );

  return {
    eligible,
    suggestedAmount: eligible ? bonusAmount : 0,
    daysPresent: summary.daysPresent,
    daysAbsent: summary.daysAbsent,
    lateCount: summary.lateCount,
    reason: eligible
      ? `Eligible: ${summary.daysPresent} days present, ${summary.daysAbsent} absences, ${summary.lateCount} late instances.`
      : `Ineligible: ${summary.daysAbsent} absences (max: ${maxAbsences}), ${summary.lateCount} late instances (max: ${maxLateness}), ${summary.daysPresent} present (min: ${minDaysPresent}).`,
  };
}

/**
 * FR-BON-03: Process production bonus import records
 * Records format: [{ empId, targetUnits, actualUnits, ratePerUnit, bonusAmount }]
 */
function parseProductionBonusData(rows = []) {
  const results = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 1;
    const empId = String(row.empId || row.EmpID || '').trim();
    if (!empId) {
      errors.push({ row: rowNum, error: 'Missing EmpID' });
      return;
    }

    let bonus = 0;
    if (row.bonusAmount !== undefined && row.bonusAmount !== null && row.bonusAmount !== '') {
      bonus = Number(row.bonusAmount);
    } else {
      const actual = Number(row.actualUnits || row.actual || 0);
      const target = Number(row.targetUnits || row.target || 0);
      const rate = Number(row.ratePerUnit || row.rate || 0);
      const excess = Math.max(0, actual - target);
      bonus = excess * rate;
    }

    if (isNaN(bonus) || bonus < 0) {
      errors.push({ row: rowNum, empId, error: 'Bonus amount must be non-negative numeric.' });
      return;
    }

    results.push({
      empId,
      productionBonus: r2(bonus),
      unitsProduced: Number(row.actualUnits || row.actual || 0),
      targetUnits: Number(row.targetUnits || row.target || 0),
    });
  });

  return { results, errors, count: results.length };
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

/**
 * Controlled Leave Types with Pay Treatment (FR-LV-02)
 */
const LEAVE_TYPES = {
  Annual: { treatment: 'paid', defaultPaidPct: 1.0, description: 'Annual leave (paid)' },
  Sick: { treatment: 'paid', defaultPaidPct: 1.0, description: 'Sick leave (paid/partially paid)' },
  Maternity: { treatment: 'paid', defaultPaidPct: 1.0, description: 'Maternity leave (paid)' },
  Paternity: { treatment: 'paid', defaultPaidPct: 1.0, description: 'Paternity leave (paid)' },
  Compassionate: { treatment: 'paid', defaultPaidPct: 1.0, description: 'Compassionate leave (paid)' },
  Study: { treatment: 'policy_based', defaultPaidPct: 1.0, description: 'Study leave (policy-based)' },
  Unpaid: { treatment: 'unpaid', defaultPaidPct: 0.0, description: 'Unpaid leave' },
};

/**
 * FR-LV-01: Calculate leave days from the difference between EndDate and StartDate.
 * Options allow excluding weekends and configured public holidays if configured.
 * StartDate and EndDate are inclusive.
 */
function calculateLeaveDays(startDate, endDate, holidays = [], options = {}) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
  if (start > end) return 0;

  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  // Base day difference between End Date and Start Date (inclusive)
  const diffDays = Math.round((endUtc - startUtc) / (1000 * 60 * 60 * 24)) + 1;

  if (options.excludeWeekends || options.excludeHolidays) {
    const holidaySet = new Set(
      (holidays || []).map((h) => {
        const d = new Date(h);
        return !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : String(h).slice(0, 10);
      })
    );

    let businessDays = 0;
    const cur = new Date(startUtc);
    const stop = new Date(endUtc);

    while (cur <= stop) {
      const dayOfWeek = cur.getUTCDay(); // 0 = Sun, 6 = Sat
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const dateStr = cur.toISOString().slice(0, 10);
      const isHoliday = holidaySet.has(dateStr);

      if ((options.excludeWeekends && isWeekend) || (options.excludeHolidays && isHoliday)) {
        // Excluded
      } else {
        businessDays += 1;
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return businessDays;
  }

  return diffDays;
}

/**
 * FR-LV-05 & BRL-13: Unpaid leave pay reduction
 * Formula: (basicSalary / workingDaysInMonth) * unpaidDays
 */
function calculateUnpaidLeaveDeduction(basicSalary, unpaidDays = 0, workingDaysInMonth = 22) {
  if (!basicSalary || unpaidDays <= 0 || workingDaysInMonth <= 0) return 0;
  const basic = Number(basicSalary);
  const deduction = (basic / workingDaysInMonth) * Number(unpaidDays);
  return r2(deduction);
}

/**
 * FR-LV-06: Optional leave allowance computation (e.g. 10% of basic annual salary or flat %)
 */
function calculateLeaveAllowance(basicSalary, ratePct = 0.10) {
  if (!basicSalary || ratePct <= 0) return 0;
  return r2(Number(basicSalary) * Number(ratePct));
}

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

/**
 * Calculates monthly loan deduction including interest if configured (FR-LN-01).
 * Supports flat interest rate or no interest.
 * Amount = Principal, TermMonths = number of instalments.
 */
function calculateLoanMonthlyDeduction(amount, termMonths, interestRate = 0, interestType = 'none') {
  if (!termMonths || termMonths <= 0) return 0;
  const principal = Number(amount || 0);
  const rate = Number(interestRate || 0);

  if (rate > 0) {
    if (interestType === 'monthly') {
      // Monthly interest rate
      const totalAmount = principal + (principal * rate * termMonths);
      return r2(totalAmount / termMonths);
    } else {
      // Flat interest on principal over loan term
      const totalInterest = principal * rate;
      const totalAmount = principal + totalInterest;
      return r2(totalAmount / termMonths);
    }
  }

  return r2(principal / termMonths);
}

function calcLine(emp, { attendance = [], adjustments = [], loans = [], deductions = [], leaves = [], bonuses: bonusEntries = [], allowances: allowanceEntries = [] }, period, options = {}) {
  const country = emp.country || 'NG';
  const currency = emp.currency || 'NGN';

  // Proration calculation (FR-EMP-11)
  const prorationRatio = calcProration(emp, period, options.prorationMethod || 'calendar');
  const fullBasic = emp.basic || 0;
  let basic = r2(fullBasic * prorationRatio);

  // FR-LV-05 & BRL-13: Unpaid leave pay reduction
  // Basic is reduced proportionally: (basic / workingDays) * unpaidDays
  let unpaidLeaveDays = options.unpaidLeaveDays !== undefined ? Number(options.unpaidLeaveDays) : 0;
  let unpaidLeaveDeduction = 0;
  let leaveAllowanceEarning = 0;

  if (Array.isArray(leaves) && leaves.length > 0) {
    for (const l of leaves) {
      if (l.status && l.status !== 'Approved') continue;
      if (l.payTreatment === 'unpaid' || l.leaveType === 'Unpaid') {
        unpaidLeaveDays += (l.days || 0);
      } else if (l.payTreatment === 'partially_paid') {
        const unpaidShare = (1 - (l.paidPercentage ?? 0.5));
        unpaidLeaveDays += (l.days || 0) * unpaidShare;
      }
      if (l.leaveAllowanceRequested && !l.leaveAllowancePaid) {
        leaveAllowanceEarning += (l.leaveAllowanceAmount || calculateLeaveAllowance(fullBasic, options.leaveAllowanceRatePct || 0.10));
      }
    }
  }

  const workingDaysInMonth = options.workingDaysInMonth || 22;
  if (unpaidLeaveDays > 0) {
    unpaidLeaveDeduction = calculateUnpaidLeaveDeduction(fullBasic, unpaidLeaveDays, workingDaysInMonth);
    basic = r2(Math.max(0, basic - unpaidLeaveDeduction));
  }

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

  let totalAllowances = r2(housing + transport + otherAllowance);
  let allowanceNonTaxable = 0;
  const allowanceRegisterBreakdown = [];

  // FR-BON-06: Allowance register entries (shift allowance, hazard, meal, etc.)
  for (const al of allowanceEntries) {
    if (al.status && al.status !== 'Approved') continue;
    if (al.startPeriod && al.startPeriod > period) continue;
    if (al.endPeriod && al.endPeriod < period) continue;
    if (!al.recurring && al.startPeriod !== period) continue;

    const amt = r2(al.amount || 0);
    totalAllowances = r2(totalAllowances + amt);
    if (al.taxable === false) {
      allowanceNonTaxable = r2(allowanceNonTaxable + amt);
    } else {
      taxableComponents += amt;
    }
    if (al.pensionable === true) pensionableComponents += amt;

    allowanceRegisterBreakdown.push({
      allowanceId: String(al._id || al.id || ''),
      type: al.type,
      title: al.title || al.type,
      amount: amt,
      taxable: al.taxable !== false,
      pensionable: al.pensionable === true,
      recurring: Boolean(al.recurring),
    });
  }

  const allowances = totalAllowances;
  const rate = emp.hourlyRate || r2(fullBasic / CFG.HOURS());

  let otHours = 0, otPay = 0;
  for (const a of attendance) {
    if (a.absent) continue;
    // FR-ATT-08: Overtime shall require approval by the employee's supervisor before it flows to payroll; unapproved OT is excluded
    if (a.approved === false) continue;

    // Overtime breakdown can be pre-computed on attendance record, or computed here
    const aOtHours = a.otHours !== undefined ? a.otHours : (CFG.ALL_HOURS_PREMIUM.includes(a.shift) ? 0 : Math.max(0, (a.hoursWorked || 0) - CFG.STD_HOURS));
    const aWkndHours = a.weekendOT !== undefined ? a.weekendOT : (a.shift === 'Weekend' ? (a.hoursWorked || 0) : 0);
    const aHolHours = a.holidayOT !== undefined ? a.holidayOT : (a.shift === 'Holiday' ? (a.hoursWorked || 0) : 0);
    const totalLineOT = aOtHours + aWkndHours + aHolHours;
    otHours += totalLineOT;

    const mult = a.multiplier || (CFG.MULT[a.shift] || 1);
    otPay += totalLineOT * rate * mult;
  }

  let bonuses = 0, otherDeductions = 0;
  let bonusPensionable = 0, bonusNonTaxable = 0;
  const bonusDetails = {
    performanceBonus: 0,
    productionBonus: 0,
    attendanceBonus: 0,
    otherBonus: 0,
    otherBonusDescription: '',
    items: [],
  };

  // FR-BON-01, FR-BON-02, FR-BON-04, FR-BON-05: Process BonusRegister entries
  for (const b of bonusEntries) {
    if (b.status && b.status !== 'Approved') continue;

    const perf = r2(b.performanceBonus || 0);
    const prod = r2(b.productionBonus || 0);
    const attBonus = r2(b.attendanceBonus || 0);
    const oth = r2(b.otherBonus || 0);
    const lineTotal = b.totalBonuses !== undefined && b.totalBonuses > 0
      ? r2(b.totalBonuses)
      : r2(perf + prod + attBonus + oth);

    bonuses += lineTotal;
    bonusDetails.performanceBonus = r2(bonusDetails.performanceBonus + perf);
    bonusDetails.productionBonus = r2(bonusDetails.productionBonus + prod);
    bonusDetails.attendanceBonus = r2(bonusDetails.attendanceBonus + attBonus);
    bonusDetails.otherBonus = r2(bonusDetails.otherBonus + oth);
    if (b.otherBonusDescription && !bonusDetails.otherBonusDescription) {
      bonusDetails.otherBonusDescription = b.otherBonusDescription;
    }

    const bFlags = b.flags || {};
    // Performance flag checks
    if (perf > 0) {
      if (bFlags.performance?.pensionable) bonusPensionable += perf;
      if (bFlags.performance?.taxable === false) bonusNonTaxable += perf;
    }
    // Production flag checks
    if (prod > 0) {
      if (bFlags.production?.pensionable) bonusPensionable += prod;
      if (bFlags.production?.taxable === false) bonusNonTaxable += prod;
    }
    // Attendance flag checks
    if (attBonus > 0) {
      if (bFlags.attendance?.pensionable) bonusPensionable += attBonus;
      if (bFlags.attendance?.taxable === false) bonusNonTaxable += attBonus;
    }
    // Other flag checks
    if (oth > 0) {
      if (bFlags.other?.pensionable) bonusPensionable += oth;
      if (bFlags.other?.taxable === false) bonusNonTaxable += oth;
    }

    bonusDetails.items.push({
      bonusId: String(b._id || b.id || ''),
      performanceBonus: perf,
      productionBonus: prod,
      attendanceBonus: attBonus,
      otherBonus: oth,
      otherBonusDescription: b.otherBonusDescription || '',
      total: lineTotal,
      flags: bFlags,
    });
  }

  if (leaveAllowanceEarning > 0) {
    bonuses += leaveAllowanceEarning;
  }

  for (const j of adjustments) {
    if (j.type === 'deduction') otherDeductions += j.amount;
    else bonuses += j.amount;
  }

  // FR-LN-09: Deductions register entries (approved, matching period)
  const deductionRegisterBreakdown = [];
  for (const d of deductions) {
    if (d.status && d.status !== 'Approved') continue;
    // Check period range
    if (d.startPeriod && d.startPeriod > period) continue;
    if (d.endPeriod && d.endPeriod < period) continue;
    if (!d.recurring && d.startPeriod !== period) continue;

    const amt = r2(d.amount || 0);
    otherDeductions += amt;
    deductionRegisterBreakdown.push({
      deductionId: String(d._id || d.id || ''),
      type: d.type,
      title: d.title || d.type,
      amount: amt,
    });
  }

  const gross = r2(basic + allowances + otPay + bonuses);
  // FR-BON-05: Incorporate pensionable bonus amount if flagged pensionable
  const totalPensionable = r2(basic + pensionableComponents + bonusPensionable);
  const pensionable = totalPensionable;
  const pension = r2((emp.pensionPct ?? 0.08) * pensionable);
  const nhf = (country === 'NG' && emp.nhfEnrolled) ? r2((emp.nhfPct ?? 0.025) * basic) : 0;

  // Annualised method with multi-country tax bands
  // Non-taxable bonus amounts and non-taxable allowances are excluded from taxable gross
  const taxableGross = r2(Math.max(0, gross - bonusNonTaxable - allowanceNonTaxable));
  const tax = computePAYE({
    annualGross: taxableGross * 12,
    annualPension: pension * 12,
    annualNHF: nhf * 12,
    annualRent: emp.annualRent || 0,
    country,
  });

  const [periodYear, periodMonth] = period.split('-').map(Number);
  const periodEndDate = new Date(Date.UTC(periodYear, periodMonth, 0)); // last day of month

  const isTerminatedThisPeriod = emp.status === 'Terminated' && emp.terminationDate &&
    new Date(emp.terminationDate) <= periodEndDate;

  const loanBreakdown = [];
  for (const l of loans) {
    if (l.status !== 'Active' || l.outstanding <= 0) continue;

    // Check StartDate or startPeriod <= period end (FR-LN-03)
    if (l.startDate) {
      const sDate = new Date(l.startDate);
      if (sDate > periodEndDate) continue;
    } else if (l.startPeriod && l.startPeriod > period) {
      continue;
    }

    // Check instalment holiday (FR-LN-06)
    if (Array.isArray(l.holidayPeriods) && l.holidayPeriods.includes(period)) {
      continue;
    }

    let instalment = 0;
    // FR-LN-07: On termination, any outstanding loan balance shall be flagged for recovery from final pay
    if (isTerminatedThisPeriod || l.flaggedForFinalRecovery) {
      instalment = r2(l.outstanding);
    } else {
      // FR-LN-05: Final instalment shall equal remaining balance (no over-recovery)
      instalment = r2(Math.min(l.monthly, l.outstanding));
    }

    loanBreakdown.push({
      loanId: String(l._id || l.loanId || ''),
      code: l.loanId,
      amount: instalment,
      remainingAfter: r2(Math.max(0, l.outstanding - instalment)),
      isFinalRecovery: Boolean(isTerminatedThisPeriod || l.flaggedForFinalRecovery),
    });
  }

  const loanDeduction = r2(loanBreakdown.reduce((s, l) => s + l.amount, 0));
  otherDeductions = r2(otherDeductions);

  // Total deductions calculation
  const totalDeductions = r2(pension + nhf + tax.monthlyTax + loanDeduction + otherDeductions);
  const netPay = r2(gross - totalDeductions);

  const flags = [];
  // FR-LN-08 & BRL-09: Total monthly deductions per employee checked against maximum-deduction policy and negative net
  if (netPay < 0) {
    flags.push('NEGATIVE_NET');
  }

  // Maximum deduction policy: e.g. deductions exceed max configured % of gross (default 50% or 66.67% of gross/net)
  // or deductions exceed net pay capacity
  const maxDeductionPct = options.maxDeductionPct ?? (Number(process.env.MAX_DEDUCTION_PCT) || 0.50);
  if (gross > 0 && totalDeductions > r2(gross * maxDeductionPct)) {
    flags.push('MAX_DEDUCTION_EXCEEDED');
  }

  if (isTerminatedThisPeriod && loanBreakdown.some((b) => b.isFinalRecovery)) {
    flags.push('LOAN_TERMINATION_RECOVERY');
  }

  if (country === 'NG' && (!/^\d{10}$/.test(emp.accountNo || '') || !emp.bank)) {
    flags.push('NO_BANK');
  } else if (!emp.accountNo || !emp.bank) {
    flags.push('NO_BANK');
  }

  return {
    empId: emp.empId, name: `${emp.surname} ${emp.firstName}`, department: emp.department, position: emp.position,
    country, currency,
    bank: emp.bank, accountNo: emp.accountNo, state: emp.state, tin: emp.tin, pensionPin: emp.pensionPin,
    basic, allowances, otHours: r2(otHours), otPay: r2(otPay), bonuses: r2(bonuses), gross,
    pensionable: r2(pensionable),
    pension, nhf, rentRelief: tax.rentRelief, chargeable: tax.chargeable, taxablePay: tax.chargeable, paye: tax.monthlyTax,
    loanDeduction, otherDeductions, totalDeductions, netPay, employerPension: r2(CFG.EMPLOYER_PENSION * pensionable),
    unpaidLeaveDays: r2(unpaidLeaveDays), unpaidLeaveDeduction, leaveAllowanceEarning: r2(leaveAllowanceEarning),
    loanBreakdown, deductionRegisterBreakdown, allowanceRegisterBreakdown, bonusDetails, flags,
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

function pairTimeClockPunches(punches) {
  // Sort punches ascending by timestamp
  const sorted = [...punches].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const grouped = {};

  for (const p of sorted) {
    const dt = new Date(p.timestamp);
    const dateStr = dt.toISOString().slice(0, 10);
    const key = `${p.empId}_${dateStr}`;
    grouped[key] ||= [];
    grouped[key].push(p);
  }

  const attendanceEntries = [];
  for (const [key, list] of Object.entries(grouped)) {
    const [empId, dateStr] = key.split('_');
    const firstIn = list.find((x) => x.punchType === 'IN');
    const lastOut = [...list].reverse().find((x) => x.punchType === 'OUT');

    if (firstIn && lastOut && new Date(lastOut.timestamp) > new Date(firstIn.timestamp)) {
      const inDate = new Date(firstIn.timestamp);
      const outDate = new Date(lastOut.timestamp);
      const pad = (n) => String(n).padStart(2, '0');
      const clockIn = `${pad(inDate.getUTCHours())}:${pad(inDate.getUTCMinutes())}`;
      const clockOut = `${pad(outDate.getUTCHours())}:${pad(outDate.getUTCMinutes())}`;
      const dayOfWeek = inDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
      const shift = (dayOfWeek === 0 || dayOfWeek === 6) ? 'Weekend' : 'Day';
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

/**
 * Reconciles a parallel run (old legacy payroll vs new system calculations)
 * per SC-02 and Section 3.7 Mitigation (User adoption resistance).
 * Target: every variance explained and signed off; no unexplained difference > ₦1.
 */
function reconcileParallelRun(legacyLines = [], systemLines = []) {
  const comparisons = [];
  let totalLegacyNet = 0;
  let totalSystemNet = 0;
  let hasDiscrepancy = false;

  for (const leg of legacyLines) {
    const sys = systemLines.find((s) => s.empId === leg.empId);
    const legNet = r2(leg.netPay || 0);
    const sysNet = sys ? r2(sys.netPay || 0) : 0;
    const diff = r2(sysNet - legNet);
    const isMatched = Math.abs(diff) <= 1.0;
    if (!isMatched) hasDiscrepancy = true;

    totalLegacyNet = r2(totalLegacyNet + legNet);
    totalSystemNet = r2(totalSystemNet + sysNet);

    comparisons.push({
      empId: leg.empId,
      name: leg.name || (sys ? sys.name : 'Unknown'),
      legacyGross: r2(leg.gross || 0),
      systemGross: sys ? r2(sys.gross || 0) : 0,
      legacyNet: legNet,
      systemNet: sysNet,
      netDifference: diff,
      status: isMatched ? 'Reconciled' : 'Variance_Exceeded',
      explanation: isMatched ? 'Within acceptable ₦1 tolerance' : 'Unexplained variance exceeds ₦1 threshold',
    });
  }

  return {
    period: systemLines[0]?.period || 'Unknown',
    totalLegacyNet,
    totalSystemNet,
    totalNetVariance: r2(totalSystemNet - totalLegacyNet),
    evaluatedCount: comparisons.length,
    reconciledCount: comparisons.filter((c) => c.status === 'Reconciled').length,
    varianceCount: comparisons.filter((c) => c.status === 'Variance_Exceeded').length,
    passed: !hasDiscrepancy,
    comparisons,
  };
}

/**
 * Resolves the effective shift configuration as of targetDate.
 * Applies prospective effective dating: picks the latest history entry with effectiveDate <= targetDate,
 * or current top-level shift values if effectiveDate <= targetDate, or closest prior record.
 */
function resolveEffectiveShiftRule(shiftDoc, targetDate = new Date()) {
  const d = new Date(targetDate);
  if (!shiftDoc) return null;

  // Gather all historical snapshots plus current state
  const snapshots = [];
  if (shiftDoc.effectiveDate) {
    snapshots.push({
      effectiveDate: new Date(shiftDoc.effectiveDate),
      stdHours: shiftDoc.stdHours,
      multiplier: shiftDoc.multiplier,
      startTime: shiftDoc.startTime,
      endTime: shiftDoc.endTime,
      unpaidBreakHours: shiftDoc.unpaidBreakHours,
    });
  }
  if (Array.isArray(shiftDoc.history)) {
    for (const h of shiftDoc.history) {
      if (h.effectiveDate) {
        snapshots.push({
          effectiveDate: new Date(h.effectiveDate),
          stdHours: h.stdHours,
          multiplier: h.multiplier,
          startTime: h.startTime,
          endTime: h.endTime,
          unpaidBreakHours: h.unpaidBreakHours,
        });
      }
    }
  }

  if (!snapshots.length) {
    return {
      shift: shiftDoc.shift,
      stdHours: shiftDoc.stdHours ?? 8,
      multiplier: shiftDoc.multiplier ?? 1.5,
      startTime: shiftDoc.startTime || '08:00',
      endTime: shiftDoc.endTime || '17:00',
      unpaidBreakHours: shiftDoc.unpaidBreakHours ?? 1,
      effectiveDate: shiftDoc.effectiveDate || new Date(),
    };
  }

  // Sort descending by effectiveDate
  snapshots.sort((a, b) => b.effectiveDate - a.effectiveDate);

  // Find latest snapshot with effectiveDate <= targetDate
  const matched = snapshots.find((s) => s.effectiveDate <= d) || snapshots[snapshots.length - 1];
  return {
    shift: shiftDoc.shift,
    stdHours: matched.stdHours,
    multiplier: matched.multiplier,
    startTime: matched.startTime,
    endTime: matched.endTime,
    unpaidBreakHours: matched.unpaidBreakHours,
    effectiveDate: matched.effectiveDate,
  };
}

/**
 * FR-INP-02: Automatically assemble Payroll_Input per active employee.
 * Calculates BasicSalary (pro-rated, after unpaid leave/absence), OTPay (from approved attendance),
 * Allowances (from employee components and active approved allowances), Bonuses (approved bonuses and positive adjustments),
 * LoanDeduction (due instalments), and OtherDeductions (approved deduction register and deduction adjustments).
 */
function assembleEmployeePayrollInput(emp, { attendance = [], adjustments = [], loans = [], deductions = [], leaves = [], bonuses: bonusEntries = [], allowances: allowanceEntries = [] }, period, options = {}) {
  const line = calcLine(emp, {
    attendance,
    adjustments,
    loans,
    deductions,
    leaves,
    bonuses: bonusEntries,
    allowances: allowanceEntries,
  }, period, options);

  return {
    period,
    empId: emp.empId,
    name: `${emp.surname} ${emp.firstName}`.trim(),
    department: emp.department || '',
    position: emp.position || '',
    currency: emp.currency || 'NGN',
    basicSalary: line.basic,
    otPay: line.otPay,
    allowances: line.allowances,
    bonuses: line.bonuses,
    loanDeduction: line.loanDeduction,
    otherDeductions: line.otherDeductions,
    details: {
      flags: line.flags || [],
      unpaidLeaveDays: line.unpaidLeaveDays || 0,
      unpaidLeaveDeduction: line.unpaidLeaveDeduction || 0,
      otHours: line.otHours || 0,
      loanBreakdown: line.loanBreakdown || [],
      deductionRegisterBreakdown: line.deductionRegisterBreakdown || [],
      allowanceRegisterBreakdown: line.allowanceRegisterBreakdown || [],
      bonusDetails: line.bonusDetails || {},
    },
  };
}

/**
 * FR-INP-04: Pre-calculation validation listing exceptions:
 * - missing bank details
 * - zero/negative salary
 * - missing pension/NHF/TIN data
 * - unapproved OT/bonus/leave/adjustments
 * - employees with no attendance
 * - duplicate EmpIDs
 */
function validatePayrollPreCalculation({
  employees = [],
  attendance = [],
  adjustments = [],
  bonuses = [],
  allowances = [],
  leaves = [],
  period,
}) {
  const exceptions = [];
  const blockingExceptions = [];

  // Check duplicate EmpIDs
  const seenEmpIds = new Set();
  const duplicateEmpIds = new Set();
  for (const emp of employees) {
    if (seenEmpIds.has(emp.empId)) {
      duplicateEmpIds.add(emp.empId);
    } else {
      seenEmpIds.add(emp.empId);
    }
  }
  for (const dup of duplicateEmpIds) {
    const item = {
      type: 'DUPLICATE_EMPID',
      empId: dup,
      blocking: true,
      message: `Duplicate Employee ID detected: ${dup}.`,
    };
    exceptions.push(item);
    blockingExceptions.push(item);
  }

  // Attendance by employee
  const attEmpMap = {};
  for (const a of attendance) {
    (attEmpMap[a.empId] ||= []).push(a);
    if (!a.approved && !a.absent && (a.hoursWorked > 0 || a.otHours > 0)) {
      const item = {
        type: 'UNAPPROVED_ATTENDANCE',
        empId: a.empId,
        date: a.date,
        blocking: true,
        message: `Unapproved attendance/OT on ${a.date} for employee ${a.empId}.`,
      };
      exceptions.push(item);
      blockingExceptions.push(item);
    }
  }

  // Check unapproved bonuses
  for (const b of bonuses) {
    if (b.status && b.status !== 'Approved') {
      const item = {
        type: 'UNAPPROVED_BONUS',
        empId: b.empId,
        blocking: true,
        message: `Unapproved bonus entry (Status: ${b.status}) for employee ${b.empId}.`,
      };
      exceptions.push(item);
      blockingExceptions.push(item);
    }
  }

  // Check unapproved allowances
  for (const al of allowances) {
    if (al.status && al.status !== 'Approved') {
      const item = {
        type: 'UNAPPROVED_ALLOWANCE',
        empId: al.empId,
        blocking: true,
        message: `Unapproved allowance entry (Status: ${al.status}) for employee ${al.empId}.`,
      };
      exceptions.push(item);
      blockingExceptions.push(item);
    }
  }

  // Check unapproved leaves
  for (const lv of leaves) {
    if (lv.status && lv.status === 'Pending') {
      const item = {
        type: 'UNAPPROVED_LEAVE',
        empId: lv.empId,
        blocking: true,
        message: `Pending leave request from ${lv.startDate ? new Date(lv.startDate).toISOString().slice(0, 10) : ''} for employee ${lv.empId}.`,
      };
      exceptions.push(item);
      blockingExceptions.push(item);
    }
  }

  // Check unapproved adjustments
  for (const adj of adjustments) {
    if (!adj.approved) {
      const item = {
        type: 'UNAPPROVED_ADJUSTMENT',
        empId: adj.empId,
        blocking: true,
        message: `Unapproved manual adjustment (${adj.type} of ${adj.amount}) for employee ${adj.empId}.`,
      };
      exceptions.push(item);
      blockingExceptions.push(item);
    }
  }

  // Employee-level data checks
  for (const emp of employees) {
    const isNG = (emp.country || 'NG') === 'NG';

    // 1. Missing bank details
    if (!emp.bank || !emp.accountNo || (isNG && !/^\d{10}$/.test(emp.accountNo))) {
      const item = {
        type: 'MISSING_BANK_DETAILS',
        empId: emp.empId,
        blocking: true,
        message: `Employee ${emp.empId} has missing or invalid bank details (requires valid bank and 10-digit NUBAN).`,
      };
      exceptions.push(item);
      blockingExceptions.push(item);
    }

    // 2. Zero or negative basic salary
    if (!emp.basic || Number(emp.basic) <= 0) {
      const item = {
        type: 'ZERO_OR_NEGATIVE_SALARY',
        empId: emp.empId,
        blocking: true,
        message: `Employee ${emp.empId} has zero or negative basic salary (${emp.basic}).`,
      };
      exceptions.push(item);
      blockingExceptions.push(item);
    }

    // 3. Missing pension / NHF / TIN data
    if (isNG) {
      if (!emp.tin || !String(emp.tin).trim()) {
        const item = {
          type: 'MISSING_TIN',
          empId: emp.empId,
          blocking: false,
          message: `Employee ${emp.empId} is missing Tax Identification Number (TIN).`,
        };
        exceptions.push(item);
      }
      if (!emp.pensionPin || !String(emp.pensionPin).trim()) {
        const item = {
          type: 'MISSING_PENSION_PIN',
          empId: emp.empId,
          blocking: false,
          message: `Employee ${emp.empId} is missing Pension PIN.`,
        };
        exceptions.push(item);
      }
      if (emp.nhfEnrolled && (!emp.nhfPct || emp.nhfPct <= 0)) {
        const item = {
          type: 'INVALID_NHF_DATA',
          empId: emp.empId,
          blocking: false,
          message: `Employee ${emp.empId} is enrolled in NHF but has invalid NHF rate.`,
        };
        exceptions.push(item);
      }
    }

    // 4. Employees with no attendance
    const empAtt = attEmpMap[emp.empId];
    if (emp.status === 'Active' && (!empAtt || empAtt.length === 0)) {
      const item = {
        type: 'NO_ATTENDANCE',
        empId: emp.empId,
        blocking: false,
        message: `Active employee ${emp.empId} has no attendance records for period ${period}.`,
      };
      exceptions.push(item);
    }
  }

  return {
    valid: blockingExceptions.length === 0,
    totalExceptions: exceptions.length,
    blockingCount: blockingExceptions.length,
    exceptions,
    blockingExceptions,
  };
}

/**
 * FR-SLP-01: Mask bank account number (protect personal data, e.g. ******1234)
 */
function maskAccountNumber(acc) {
  if (!acc || typeof acc !== 'string') return '';
  const clean = acc.trim();
  if (clean.length <= 4) return '****' + clean;
  return '*'.repeat(clean.length - 4) + clean.slice(-4);
}

/**
 * FR-SEC-04: Mask sensitive identifier strings (e.g. Tax ID / TIN, Pension PIN)
 * preserving only trailing 4 characters.
 */
function maskSensitiveIdentifier(val) {
  if (!val || typeof val !== 'string') return '';
  const clean = val.trim();
  if (clean.length <= 4) return '****' + clean;
  return '*'.repeat(clean.length - 4) + clean.slice(-4);
}

/**
 * FR-SEC-04: Filter/mask sensitive employee data according to stakeholder role permissions.
 * Authorized roles for full salary/bank/tax info: hr, payroll, approver, executive, tax_advisor
 * Restricted roles (e.g., supervisor, employee, auditor where full PII is restricted): sensitive fields masked.
 */
function maskEmployeeSensitiveFields(emp, role) {
  if (!emp) return emp;
  const isFullAccess = ['admin', 'hr', 'payroll', 'approver', 'executive', 'tax_advisor'].includes(role);
  if (isFullAccess) return emp;

  const masked = { ...emp };
  if (masked.accountNo) masked.accountNo = maskAccountNumber(masked.accountNo);
  if (masked.tin) masked.tin = maskSensitiveIdentifier(masked.tin);
  if (masked.pensionPin) masked.pensionPin = maskSensitiveIdentifier(masked.pensionPin);
  if (role === 'supervisor') {
    // Supervisors should only see attendance and operational fields, not compensation
    masked.basic = undefined;
    masked.housing = undefined;
    masked.transport = undefined;
    masked.otherAllowance = undefined;
    masked.hourlyRate = undefined;
    masked.annualRent = undefined;
  }
  return masked;
}

/**
 * FR-SLP-01 & FR-SLP-02 & FR-SLP-05:
 * Builds full payslip payload containing:
 * - company name / logo
 * - Period, Pay date
 * - Employee ID, Name, Department, Position, Bank/Account (masked)
 * - Basic, Overtime (hours and amount)
 * - Allowances (itemised)
 * - Bonuses (itemised)
 * - Gross Pay, Pension, NHF, PAYE, Loan Deduction, Other Deductions, Total Deductions, Net Pay
 * - Remaining loan balance
 * - Year-to-date (gross, PAYE, pension)
 */
function buildEmployeePayslip(line, options = {}) {
  const period = options.period || line.period || '';
  const [year, month] = period.split('-').map(Number);
  // Default pay date is last day of the period month (or custom option)
  const defaultPayDate = (year && month)
    ? new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const payDate = options.payDate || defaultPayDate;

  const company = {
    name: options.companyName || 'Lagos Manufacturing Factory Ltd',
    logo: options.companyLogo || '/logo.png',
    address: options.companyAddress || 'Plot 12, Industrial Avenue, Ikeja, Lagos State',
  };

  // Mask bank account
  const maskedAccount = maskAccountNumber(line.accountNo || options.accountNo || '');

  // Itemised allowances
  const itemisedAllowances = [];
  if (line.housing > 0) itemisedAllowances.push({ name: 'Housing Allowance', amount: r2(line.housing), taxable: true, pensionable: true });
  if (line.transport > 0) itemisedAllowances.push({ name: 'Transport Allowance', amount: r2(line.transport), taxable: true, pensionable: true });
  if (line.otherAllowance > 0) itemisedAllowances.push({ name: 'Other Allowance', amount: r2(line.otherAllowance), taxable: true, pensionable: false });
  if (Array.isArray(line.allowanceRegisterBreakdown)) {
    for (const al of line.allowanceRegisterBreakdown) {
      itemisedAllowances.push({
        name: al.title || al.type || 'Allowance',
        amount: r2(al.amount || 0),
        taxable: al.taxable !== false,
        pensionable: Boolean(al.pensionable),
        type: al.type,
      });
    }
  }

  // Itemised bonuses
  const itemisedBonuses = [];
  const bDet = line.bonusDetails || {};
  if (bDet.performanceBonus > 0) itemisedBonuses.push({ name: 'Performance Bonus', amount: r2(bDet.performanceBonus) });
  if (bDet.productionBonus > 0) itemisedBonuses.push({ name: 'Production Bonus', amount: r2(bDet.productionBonus) });
  if (bDet.attendanceBonus > 0) itemisedBonuses.push({ name: 'Attendance Bonus', amount: r2(bDet.attendanceBonus) });
  if (bDet.otherBonus > 0) itemisedBonuses.push({ name: bDet.otherBonusDescription || 'Other Bonus', amount: r2(bDet.otherBonus) });
  if (!itemisedBonuses.length && (line.bonuses > 0)) {
    itemisedBonuses.push({ name: 'Bonus', amount: r2(line.bonuses) });
  }

  // Itemised deductions
  const itemisedDeductions = [
    { name: 'Employee Pension (8%)', amount: r2(line.pension || 0), category: 'statutory' },
  ];
  if (line.nhf > 0) {
    itemisedDeductions.push({ name: 'NHF (2.5%)', amount: r2(line.nhf), category: 'statutory' });
  }
  itemisedDeductions.push({ name: 'PAYE Tax (NTA 2025)', amount: r2(line.paye || 0), category: 'tax' });
  if (line.loanDeduction > 0) {
    itemisedDeductions.push({ name: 'Loan Deduction', amount: r2(line.loanDeduction), category: 'loan' });
  }
  if (line.otherDeductions > 0) {
    if (Array.isArray(line.deductionRegisterBreakdown) && line.deductionRegisterBreakdown.length) {
      for (const d of line.deductionRegisterBreakdown) {
        itemisedDeductions.push({ name: d.title || d.type || 'Other Deduction', amount: r2(d.amount), category: 'other' });
      }
    } else {
      itemisedDeductions.push({ name: 'Other Deductions', amount: r2(line.otherDeductions), category: 'other' });
    }
  }

  // Remaining loan balance calculation
  let remainingLoanBalance = 0;
  if (Array.isArray(line.loanBreakdown)) {
    remainingLoanBalance = r2(line.loanBreakdown.reduce((sum, lb) => sum + (lb.remainingAfter ?? 0), 0));
  } else if (options.remainingLoanBalance !== undefined) {
    remainingLoanBalance = r2(options.remainingLoanBalance);
  }

  // YTD Figures (gross, PAYE, pension)
  const ytd = {
    gross: r2(options.ytdGross !== undefined ? options.ytdGross : (line.gross || 0)),
    paye: r2(options.ytdPaye !== undefined ? options.ytdPaye : (line.paye || 0)),
    pension: r2(options.ytdPension !== undefined ? options.ytdPension : (line.pension || 0)),
    employerPension: r2(options.ytdEmployerPension !== undefined ? options.ytdEmployerPension : (line.employerPension || 0)),
  };

  const totalDeductions = r2(line.totalDeductions !== undefined ? line.totalDeductions : (
    (line.pension || 0) + (line.nhf || 0) + (line.paye || 0) + (line.loanDeduction || 0) + (line.otherDeductions || 0)
  ));

  return {
    company,
    period,
    payDate,
    empId: line.empId,
    name: line.name,
    department: line.department,
    position: line.position,
    bank: line.bank,
    accountNo: maskedAccount,
    rawAccountNo: line.accountNo,
    basic: r2(line.basic || 0),
    overtime: {
      hours: r2(line.otHours || 0),
      amount: r2(line.otPay || 0),
    },
    allowances: {
      total: r2(line.allowances || 0),
      itemised: itemisedAllowances,
    },
    bonuses: {
      total: r2(line.bonuses || 0),
      itemised: itemisedBonuses,
    },
    gross: r2(line.gross || 0),
    pension: r2(line.pension || 0),
    employerPension: r2(line.employerPension || 0),
    nhf: r2(line.nhf || 0),
    paye: r2(line.paye || 0),
    loanDeduction: r2(line.loanDeduction || 0),
    otherDeductions: r2(line.otherDeductions || 0),
    itemisedDeductions,
    totalDeductions,
    netPay: r2(line.netPay || 0),
    remainingLoanBalance,
    ytd,
    status: options.status || line.status || 'Approved',
    approvedAt: options.approvedAt || line.approvedAt,
    approvedBy: options.approvedBy || line.approvedBy,
  };
}

module.exports = {
  reconcileParallelRun,
  calcLine,
  maskAccountNumber,
  maskSensitiveIdentifier,
  maskEmployeeSensitiveFields,
  buildEmployeePayslip,
  calcProration,
  calculateLoanMonthlyDeduction,
  calculateLeaveDays,
  calculateUnpaidLeaveDeduction,
  calculateLeaveAllowance,
  resolveEffectiveShiftRule,
  assembleEmployeePayrollInput,
  validatePayrollPreCalculation,
  LEAVE_TYPES,
  hoursBetween,
  timeToMinutes,
  evaluateAttendanceEntry,
  summarizePeriodAttendance,
  CFG,
  CBN_BANKS,
  generateGLJournal,
  processBankPaymentSimulation,
  pairTimeClockPunches,
  suggestAttendanceBonus,
  parseProductionBonusData,
};
