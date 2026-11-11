const zlib = require('zlib');
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

/**
 * Bank Transfer Schedule Engine (FR-BNK-01 to FR-BNK-06)
 */

function formatPaymentNarration(period, customPrefix = 'Salary') {
  if (!period) return `${customPrefix}`;
  // Period format YYYY-MM -> Month Year e.g. "Salary Nov 2026" or "Salary 2026-11"
  const parts = String(period).split('-');
  if (parts.length === 2) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${customPrefix} ${monthNames[m - 1]} ${y}`;
    }
  }
  return `${customPrefix} ${period}`;
}

function validateBankTransferLine(line) {
  const errors = [];
  const netPay = Number(line.netPay) || 0;

  if (netPay <= 0) {
    errors.push('Net Pay must be greater than zero');
  }

  const accountNo = String(line.accountNo || '').trim();
  if (!accountNo) {
    errors.push('Account number is missing');
  } else if (!/^\d{10}$/.test(accountNo)) {
    errors.push('Account number must be exactly 10 digits (NUBAN)');
  }

  const bank = String(line.bank || '').trim();
  if (!bank) {
    errors.push('Bank name is missing');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function generateBankTransferSchedule(payrollRun, options = {}) {
  // FR-BNK-01 & FR-BNK-05: Require Approved status
  const status = payrollRun?.status;
  if (status !== 'Approved' && status !== 'Paid/Locked') {
    throw new Error('Bank transfer schedule can only be generated from Approved payroll.');
  }

  const period = payrollRun.period;
  const version = options.version || 1;
  const narration = options.narration || formatPaymentNarration(period, options.prefix || 'Salary');
  const lines = Array.isArray(payrollRun.lines) ? payrollRun.lines : [];

  const items = [];
  const exceptions = [];

  for (const line of lines) {
    const check = validateBankTransferLine(line);
    const empId = line.empId || '';
    const name = line.name || `${line.surname || ''} ${line.firstName || ''}`.trim();
    const bank = line.bank || '';
    const accountNo = line.accountNo || '';
    const netPay = r2(Number(line.netPay) || 0);

    if (check.valid) {
      items.push({
        empId,
        name,
        bank,
        bankCode: line.bankCode || '000',
        accountNo,
        netPay,
        narration,
        paymentStatus: 'Pending',
      });
    } else {
      exceptions.push({
        empId,
        name,
        bank,
        accountNo,
        netPay,
        reasons: check.errors,
      });
    }
  }

  const controlTotal = r2(items.reduce((sum, item) => sum + item.netPay, 0));
  const payableCount = items.length;

  // FR-BNK-04: Control total & count comparison with register totals
  const registerNetTotal = r2(payrollRun.totals?.net ?? lines.reduce((s, l) => s + (l.netPay || 0), 0));
  const registerPayableHeadcount = lines.filter((l) => (l.netPay || 0) > 0).length;
  const isBalanced = Math.abs(controlTotal - registerNetTotal) < 0.01 && exceptions.length === 0;

  return {
    period,
    version,
    narration,
    payableHeadcount: payableCount,
    controlTotal,
    registerNetTotal,
    registerPayableHeadcount,
    isBalanced,
    items,
    exceptions,
  };
}

// FR-BNK-03: Export formatting (CSV, XLSX xml template, Bank Bulk Upload templates)
const BANK_UPLOAD_TEMPLATES = {
  STANDARD_NIBSS: {
    name: 'NIBSS Instant Payment (NIP) Bulk Upload',
    format: 'csv',
    headers: ['PaymentReference', 'BeneficiaryName', 'BeneficiaryBankCode', 'BeneficiaryAccountNumber', 'Amount', 'Narration'],
    mapRow: (item, idx, schedule) => [
      `NIP-${schedule.period.replace('-', '')}-${String(idx + 1).padStart(4, '0')}`,
      `"${String(item.name).replace(/"/g, '""')}"`,
      item.bankCode || '000',
      item.accountNo,
      item.netPay.toFixed(2),
      `"${String(item.narration).replace(/"/g, '""')}"`,
    ],
  },
  GENERIC_BANK: {
    name: 'Bank Bulk Payment Format',
    format: 'csv',
    headers: ['EmpID', 'EmployeeName', 'Bank', 'AccountNo', 'NetPay', 'Narration', 'PaymentStatus'],
    mapRow: (item) => [
      item.empId,
      `"${String(item.name).replace(/"/g, '""')}"`,
      `"${String(item.bank).replace(/"/g, '""')}"`,
      item.accountNo,
      item.netPay.toFixed(2),
      `"${String(item.narration).replace(/"/g, '""')}"`,
      item.paymentStatus || 'Pending',
    ],
  },
};

function exportBankTransferCSV(schedule, templateKey = 'GENERIC_BANK') {
  const template = BANK_UPLOAD_TEMPLATES[templateKey] || BANK_UPLOAD_TEMPLATES.GENERIC_BANK;
  const rows = [template.headers.join(',')];

  schedule.items.forEach((item, idx) => {
    rows.push(template.mapRow(item, idx, schedule).join(','));
  });

  if (templateKey === 'GENERIC_BANK') {
    rows.push(`TOTAL,${schedule.payableHeadcount} payments,,,${schedule.controlTotal.toFixed(2)},,`);
  }

  return rows.join('\n');
}

function exportBankTransferXLSX(schedule) {
  // Generates SpreadsheetML XML format natively readable by Microsoft Excel as .xlsx / .xml
  const rowsXml = schedule.items.map((item) => `
    <Row>
      <Cell><Data ss:Type="String">${item.empId}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(item.name)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(item.bank)}</Data></Cell>
      <Cell><Data ss:Type="String">${item.accountNo}</Data></Cell>
      <Cell><Data ss:Type="Number">${item.netPay.toFixed(2)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(item.narration)}</Data></Cell>
      <Cell><Data ss:Type="String">${item.paymentStatus || 'Pending'}</Data></Cell>
    </Row>`).join('');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#EAEAEA" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Total">
   <Font ss:Bold="1"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Bank_Transfer">
  <Table>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">EmpID</Data></Cell>
    <Cell><Data ss:Type="String">EmployeeName</Data></Cell>
    <Cell><Data ss:Type="String">Bank</Data></Cell>
    <Cell><Data ss:Type="String">AccountNo</Data></Cell>
    <Cell><Data ss:Type="String">NetPay</Data></Cell>
    <Cell><Data ss:Type="String">PaymentNarration</Data></Cell>
    <Cell><Data ss:Type="String">PaymentStatus</Data></Cell>
   </Row>
   ${rowsXml}
   <Row ss:StyleID="Total">
    <Cell><Data ss:Type="String">TOTAL</Data></Cell>
    <Cell><Data ss:Type="String">Payable: ${schedule.payableHeadcount}</Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
    <Cell><Data ss:Type="Number">${schedule.controlTotal.toFixed(2)}</Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
   </Row>
  </Table>
 </Worksheet>
</Workbook>`;
}

function escapeXml(unsafe) {
  return String(unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
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

/**
 * FR-DSH-03: Period-over-period trend analysis for gross, net, overtime, PAYE, and department cost breakdowns.
 */
function calculatePeriodTrends(currentRun, previousRun) {
  const getTotals = (run) => {
    if (!run) {
      return {
        gross: 0,
        net: 0,
        paye: 0,
        otPay: 0,
        otHours: 0,
        pension: 0,
        employerPension: 0,
        nhf: 0,
        loans: 0,
        bonuses: 0,
        headcount: 0,
        employerCost: 0,
      };
    }
    const lines = run.lines || [];
    const totals = run.totals || {};
    const gross = r2(totals.gross ?? lines.reduce((s, l) => s + (l.gross || 0), 0));
    const net = r2(totals.net ?? lines.reduce((s, l) => s + (l.netPay || 0), 0));
    const paye = r2(totals.paye ?? lines.reduce((s, l) => s + (l.paye || 0), 0));
    const otPay = r2(totals.otPay ?? lines.reduce((s, l) => s + (l.otPay || 0), 0));
    const otHours = r2(lines.reduce((s, l) => s + (l.otHours || 0), 0));
    const pension = r2(totals.pension ?? lines.reduce((s, l) => s + (l.pension || 0), 0));
    const employerPension = r2(totals.employerPension ?? lines.reduce((s, l) => s + (l.employerPension || 0), 0));
    const nhf = r2(totals.nhf ?? lines.reduce((s, l) => s + (l.nhf || 0), 0));
    const loans = r2(totals.loans ?? lines.reduce((s, l) => s + (l.loanDeduction || 0), 0));
    const bonuses = r2(lines.reduce((s, l) => s + (l.bonuses || 0), 0));
    const headcount = lines.length || totals.employees || 0;
    const statutoryLevies = r2(gross * 0.02); // 1% NSITF + 1% ITF
    const employerCost = r2(gross + employerPension + statutoryLevies);

    return {
      gross,
      net,
      paye,
      otPay,
      otHours,
      pension,
      employerPension,
      nhf,
      loans,
      bonuses,
      headcount,
      statutoryLevies,
      employerCost,
    };
  };

  const curr = getTotals(currentRun);
  const prev = getTotals(previousRun);

  const calcDelta = (c, p) => {
    const delta = r2(c - p);
    const pctChange = p !== 0 ? r2(((c - p) / Math.abs(p)) * 100) : (c !== 0 ? 100 : 0);
    return { current: c, previous: p, delta, pctChange };
  };

  const trends = {
    currentPeriod: currentRun?.period || null,
    previousPeriod: previousRun?.period || null,
    gross: calcDelta(curr.gross, prev.gross),
    net: calcDelta(curr.net, prev.net),
    overtimeCost: calcDelta(curr.otPay, prev.otPay),
    overtimeHours: calcDelta(curr.otHours, prev.otHours),
    paye: calcDelta(curr.paye, prev.paye),
    headcount: calcDelta(curr.headcount, prev.headcount),
    employerCost: calcDelta(curr.employerCost, prev.employerCost),
    departmentTrends: [],
  };

  const buildDeptMap = (run) => {
    const map = {};
    if (!run || !run.lines) return map;
    for (const l of run.lines) {
      const dept = l.department || 'Unassigned';
      if (!map[dept]) {
        map[dept] = { count: 0, gross: 0, otPay: 0, otHours: 0, netPay: 0, employerPension: 0, employerCost: 0 };
      }
      map[dept].count += 1;
      map[dept].gross = r2(map[dept].gross + (l.gross || 0));
      map[dept].otPay = r2(map[dept].otPay + (l.otPay || 0));
      map[dept].otHours = r2(map[dept].otHours + (l.otHours || 0));
      map[dept].netPay = r2(map[dept].netPay + (l.netPay || 0));
      map[dept].employerPension = r2(map[dept].employerPension + (l.employerPension || 0));
      const levies = r2((l.gross || 0) * 0.02);
      map[dept].employerCost = r2(map[dept].employerCost + (l.gross || 0) + (l.employerPension || 0) + levies);
    }
    return map;
  };

  const currDepts = buildDeptMap(currentRun);
  const prevDepts = buildDeptMap(previousRun);
  const allDeptNames = [...new Set([...Object.keys(currDepts), ...Object.keys(prevDepts)])].sort();

  trends.departmentTrends = allDeptNames.map((dept) => {
    const cd = currDepts[dept] || { count: 0, gross: 0, otPay: 0, otHours: 0, netPay: 0, employerCost: 0 };
    const pd = prevDepts[dept] || { count: 0, gross: 0, otPay: 0, otHours: 0, netPay: 0, employerCost: 0 };
    return {
      department: dept,
      current: cd,
      previous: pd,
      delta: {
        count: cd.count - pd.count,
        gross: r2(cd.gross - pd.gross),
        otPay: r2(cd.otPay - pd.otPay),
        otHours: r2(cd.otHours - pd.otHours),
        netPay: r2(cd.netPay - pd.netPay),
        employerCost: r2(cd.employerCost - pd.employerCost),
      },
      pctChange: {
        gross: pd.gross > 0 ? r2(((cd.gross - pd.gross) / pd.gross) * 100) : (cd.gross > 0 ? 100 : 0),
        netPay: pd.netPay > 0 ? r2(((cd.netPay - pd.netPay) / pd.netPay) * 100) : (cd.netPay > 0 ? 100 : 0),
        otPay: pd.otPay > 0 ? r2(((cd.otPay - pd.otPay) / pd.otPay) * 100) : (cd.otPay > 0 ? 100 : 0),
        employerCost: pd.employerCost > 0 ? r2(((cd.employerCost - pd.employerCost) / pd.employerCost) * 100) : (cd.employerCost > 0 ? 100 : 0),
      },
    };
  });

  return trends;
}

/**
 * FR-DSH-04: Dashboard figures shall be formula/query-driven from the register and reconcile to it exactly.
 * Zero discrepancy tolerance.
 */
function reconcileDashboardToRegister(run) {
  if (!run || !run.lines) {
    return {
      reconciled: false,
      discrepancyCount: 1,
      discrepancies: [{ field: 'lines', message: 'No payroll run lines to reconcile' }],
      registerTotals: {},
      dashboardTotals: {},
    };
  }

  const lines = run.lines;
  const totals = run.totals || {};

  const registerTotals = {
    headcount: lines.length,
    paidHeadcount: lines.filter((l) => (l.netPay || 0) > 0).length,
    gross: r2(lines.reduce((s, l) => s + (l.gross || 0), 0)),
    net: r2(lines.reduce((s, l) => s + (l.netPay || 0), 0)),
    paye: r2(lines.reduce((s, l) => s + (l.paye || 0), 0)),
    pension: r2(lines.reduce((s, l) => s + (l.pension || 0), 0)),
    employerPension: r2(lines.reduce((s, l) => s + (l.employerPension || 0), 0)),
    nhf: r2(lines.reduce((s, l) => s + (l.nhf || 0), 0)),
    loans: r2(lines.reduce((s, l) => s + (l.loanDeduction || 0), 0)),
    otPay: r2(lines.reduce((s, l) => s + (l.otPay || 0), 0)),
    otHours: r2(lines.reduce((s, l) => s + (l.otHours || 0), 0)),
    bonuses: r2(lines.reduce((s, l) => s + (l.bonuses || 0), 0)),
  };

  const dashboardTotals = {
    headcount: totals.employees ?? registerTotals.headcount,
    gross: r2(totals.gross ?? registerTotals.gross),
    net: r2(totals.net ?? registerTotals.net),
    paye: r2(totals.paye ?? registerTotals.paye),
    pension: r2(totals.pension ?? registerTotals.pension),
    employerPension: r2(totals.employerPension ?? registerTotals.employerPension),
    nhf: r2(totals.nhf ?? registerTotals.nhf),
    loans: r2(totals.loans ?? registerTotals.loans),
    otPay: r2(totals.otPay ?? registerTotals.otPay),
  };

  const discrepancies = [];

  const checkMatch = (field, regVal, dashVal) => {
    const diff = r2(Math.abs(regVal - dashVal));
    if (diff > 0.001) {
      discrepancies.push({
        field,
        registerValue: regVal,
        dashboardValue: dashVal,
        variance: diff,
        message: `${field} mismatch: register sum ${regVal} !== dashboard total ${dashVal} (variance: ${diff})`,
      });
    }
  };

  checkMatch('gross', registerTotals.gross, dashboardTotals.gross);
  checkMatch('net', registerTotals.net, dashboardTotals.net);
  checkMatch('paye', registerTotals.paye, dashboardTotals.paye);
  checkMatch('pension', registerTotals.pension, dashboardTotals.pension);
  checkMatch('employerPension', registerTotals.employerPension, dashboardTotals.employerPension);
  checkMatch('nhf', registerTotals.nhf, dashboardTotals.nhf);
  checkMatch('loans', registerTotals.loans, dashboardTotals.loans);
  checkMatch('otPay', registerTotals.otPay, dashboardTotals.otPay);

  // Line-level internal consistency check:
  // For every employee line: gross - total deductions == netPay
  lines.forEach((l, idx) => {
    const deductions = r2(
      (l.pension || 0) +
      (l.nhf || 0) +
      (l.paye || 0) +
      (l.loanDeduction || 0) +
      (l.otherDeductions || 0)
    );
    const expectedNet = r2((l.gross || 0) - deductions);
    const actualNet = r2(l.netPay || 0);
    if (Math.abs(expectedNet - actualNet) > 0.01) {
      discrepancies.push({
        field: `line_${l.empId || idx}`,
        empId: l.empId,
        expectedNet,
        actualNet,
        variance: r2(Math.abs(expectedNet - actualNet)),
        message: `Employee ${l.empId}: gross (${l.gross}) minus deductions (${deductions}) does not equal netPay (${actualNet})`,
      });
    }
  });

  return {
    reconciled: discrepancies.length === 0,
    discrepancyCount: discrepancies.length,
    discrepancies,
    registerTotals,
    dashboardTotals,
    tolerance: 0,
  };
}

// ---- Generic Export Generators for Standard Reports (FR-DSH-06) ----

function generateZipXlsx(sheetName, rows) {
  function dateToDosTime(d) {
    return ((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) |
           (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  }
  function crc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    return ~crc >>> 0;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
    table[i] = c;
  }
  function colName(n) {
    let s = '';
    while (n >= 0) {
      s = String.fromCharCode((n % 26) + 65) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }
  let sheetDataXml = '';
  rows.forEach((row, rIdx) => {
    const rowNum = rIdx + 1;
    let cellsXml = '';
    row.forEach((val, cIdx) => {
      const cRef = colName(cIdx) + rowNum;
      if (val === null || val === undefined) return;
      if (typeof val === 'number') {
        cellsXml += `<c r="${cRef}"><v>${val}</v></c>`;
      } else {
        const escVal = String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        cellsXml += `<c r="${cRef}" t="inlineStr"><is><t>${escVal}</t></is></c>`;
      }
    });
    sheetDataXml += `<row r="${rowNum}">${cellsXml}</row>`;
  });
  const files = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${String(sheetName).replace(/["&<>]/g, '').slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetDataXml}</sheetData></worksheet>`
    }
  ];
  const timeField = dateToDosTime(new Date());
  const localHeaders = [];
  const cdHeaders = [];
  let curOffset = 0;
  files.forEach((f) => {
    const dataBuf = Buffer.from(f.data, 'utf8');
    const compBuf = zlib.deflateRawSync(dataBuf);
    const useComp = compBuf.length < dataBuf.length;
    const finalData = useComp ? compBuf : dataBuf;
    const method = useComp ? 8 : 0;
    const fCrc = crc32(dataBuf);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(timeField, 10);
    lh.writeUInt32LE(fCrc, 14);
    lh.writeUInt32LE(finalData.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);
    localHeaders.push(lh, finalData);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(timeField, 12);
    cdh.writeUInt32LE(fCrc, 16);
    cdh.writeUInt32LE(finalData.length, 20);
    cdh.writeUInt32LE(dataBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(curOffset, 42);
    nameBuf.copy(cdh, 46);
    cdHeaders.push(cdh);
    curOffset += lh.length + finalData.length;
  });
  const cdStart = curOffset;
  const cdBuf = Buffer.concat(cdHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

function generatePdfBuffer({ title, subtitle, headers, rows, grandTotal }) {
  const lines = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj'
  ];
  let stream = `BT /F1 12 Tf 40 570 Td (${(title || 'REPORT').replace(/[()\\\\]/g, '')}) Tj ET\n`;
  if (subtitle) {
    stream += `BT /F1 8 Tf 40 555 Td (${subtitle.replace(/[()\\\\]/g, '')}) Tj ET\n`;
  }
  let y = subtitle ? 535 : 550;
  if (headers && headers.length) {
    const hText = headers.join(' | ').slice(0, 150);
    stream += `BT /F1 8 Tf 40 ${y} Td (${hText.replace(/[()\\\\]/g, '')}) Tj ET\n`;
    y -= 14;
  }
  for (const r of rows) {
    if (y < 60) break;
    const rText = (Array.isArray(r) ? r.join(' | ') : String(r)).slice(0, 160);
    stream += `BT /F1 7 Tf 40 ${y} Td (${rText.replace(/[()\\\\]/g, '')}) Tj ET\n`;
    y -= 12;
  }
  if (grandTotal) {
    const gtText = (Array.isArray(grandTotal) ? grandTotal.join(' | ') : String(grandTotal)).slice(0, 160);
    stream += `BT /F1 8 Tf 40 ${Math.max(40, y - 6)} Td (${gtText.replace(/[()\\\\]/g, '')}) Tj ET\n`;
  }
  const contentObj = `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}endstream\nendobj`;
  lines.splice(3, 0, contentObj);
  let output = lines[0] + '\n';
  const xref = [0];
  let offset = output.length;
  for (let i = 1; i < lines.length; i++) {
    xref.push(offset);
    output += lines[i] + '\n';
    offset = output.length;
  }
  const xrefOffset = offset;
  output += `xref\n0 ${lines.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < lines.length; i++) {
    output += String(xref[i]).padStart(10, '0') + ' 00000 n \n';
  }
  output += `trailer << /Size ${lines.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, 'binary');
}

// ---- 14 Standard Reports (FR-DSH-05, FR-DSH-06) ----
const STANDARD_REPORTS = [
  { id: 'payroll-register', name: 'Payroll Register', category: 'Payroll', description: 'Complete 16-field payroll register per employee with department subtotals' },
  { id: 'payslips', name: 'Payslips Summary Report', category: 'Payroll', description: 'Itemised employee payslips with masked account numbers and deductions' },
  { id: 'paye-remittance', name: 'PAYE Remittance Report', category: 'Statutory', description: 'Monthly PAYE tax remittance schedule by employee, state, and TIN' },
  { id: 'pension-remittance', name: 'Pension Remittance Report', category: 'Statutory', description: 'Employee (8%) and employer (10%) pension contributions by PFA and PIN' },
  { id: 'nhf-remittance', name: 'NHF Remittance Report', category: 'Statutory', description: 'National Housing Fund (2.5% basic) remittance schedule' },
  { id: 'bank-schedule', name: 'Bank Transfer Schedule', category: 'Disbursement', description: 'Electronic bank payment schedule with 10-digit NUBAN and narration' },
  { id: 'overtime-report', name: 'Overtime Report', category: 'Attendance & Hours', description: 'Detailed overtime breakdown by normal, weekday, weekend, and holiday hours' },
  { id: 'loan-ledger', name: 'Loan Ledger Report', category: 'Loans & Deductions', description: 'Staff loan deductions, principal repayments, and remaining balances' },
  { id: 'leave-report', name: 'Leave Report', category: 'Leave Management', description: 'Leave requests, days taken, leave types, and pay treatment' },
  { id: 'bonus-report', name: 'Bonus Register Report', category: 'Compensation', description: 'Performance, production, attendance, and other discretionary bonuses' },
  { id: 'variance-report', name: 'Payroll Variance Report', category: 'Governance & Control', description: 'Period-over-period gross and net pay variance analysis with anomaly detection' },
  { id: 'exceptions-report', name: 'Pre-Calculation & Payroll Exceptions Report', category: 'Governance & Control', description: 'Pre-calculation exceptions, anomaly flags, and blocking errors' },
  { id: 'audit-report', name: 'Audit Trail Report', category: 'Compliance & Audit', description: 'Immutable log of administrative, operational, and financial changes' },
  { id: 'employer-cost-report', name: 'Employer Cost Report', category: 'Finance & Executive', description: 'Total cost of employment including gross salary, employer pension, NSITF, and ITF' },
];

function normalizeReportType(type) {
  if (!type) return '';
  const clean = String(type).trim().toLowerCase().replace(/_/g, '-');
  const aliasMap = {
    'register': 'payroll-register',
    'payroll-register': 'payroll-register',
    'payslip': 'payslips',
    'payslips': 'payslips',
    'payslips-summary': 'payslips',
    'paye': 'paye-remittance',
    'paye-remittance': 'paye-remittance',
    'pension': 'pension-remittance',
    'pension-remittance': 'pension-remittance',
    'nhf': 'nhf-remittance',
    'nhf-remittance': 'nhf-remittance',
    'bank': 'bank-schedule',
    'bank-schedule': 'bank-schedule',
    'bank-transfer': 'bank-schedule',
    'bank-transfer-schedule': 'bank-schedule',
    'overtime': 'overtime-report',
    'overtime-report': 'overtime-report',
    'loan': 'loan-ledger',
    'loans': 'loan-ledger',
    'loan-ledger': 'loan-ledger',
    'repayments': 'loan-ledger',
    'leave': 'leave-report',
    'leaves': 'leave-report',
    'leave-report': 'leave-report',
    'bonus': 'bonus-report',
    'bonuses': 'bonus-report',
    'bonus-report': 'bonus-report',
    'variance': 'variance-report',
    'variance-report': 'variance-report',
    'exceptions': 'exceptions-report',
    'exceptions-report': 'exceptions-report',
    'audit': 'audit-report',
    'audit-report': 'audit-report',
    'employer-cost': 'employer-cost-report',
    'employercost': 'employer-cost-report',
    'employer-cost-report': 'employer-cost-report',
  };
  return aliasMap[clean] || clean;
}

/**
 * FR-DSH-05: Generate standard report data structure.
 */
function generateStandardReport(reportType, context = {}) {
  const canonicalId = normalizeReportType(reportType);
  const def = STANDARD_REPORTS.find((r) => r.id === canonicalId);
  if (!def) {
    throw new Error(`Unknown standard report type: '${reportType}'`);
  }

  const {
    period = context.run?.period || 'N/A',
    run,
    previousRun,
    attendance = [],
    repayments = [],
    loans = [],
    leaves = [],
    bonuses = [],
    auditLogs = [],
  } = context;

  const lines = run?.lines || [];

  let headers = [];
  let columns = [];
  let rows = [];
  let summary = {};
  let summaryLine = null;

  switch (canonicalId) {
    case 'payroll-register': {
      headers = ['Period', 'EmpID', 'Name', 'Department', 'Basic', 'OTPay', 'Allowances', 'Bonuses', 'GrossPay', 'Pension', 'NHF', 'TaxablePay', 'PAYE', 'LoanDeduction', 'OtherDeductions', 'NetPay'];
      columns = ['period', 'empId', 'name', 'department', 'basic', 'otPay', 'allowances', 'bonuses', 'grossPay', 'pension', 'nhf', 'taxablePay', 'paye', 'loanDeduction', 'otherDeductions', 'netPay'];
      rows = lines.map((l) => ({
        period,
        empId: l.empId,
        name: l.name,
        department: l.department || 'General',
        basic: r2(l.basic || 0),
        otPay: r2(l.otPay || 0),
        allowances: r2(l.allowances || 0),
        bonuses: r2(l.bonuses || 0),
        grossPay: r2(l.gross ?? l.grossPay ?? 0),
        pension: r2(l.pension || 0),
        nhf: r2(l.nhf || 0),
        taxablePay: r2(l.taxablePay ?? l.chargeable ?? 0),
        paye: r2(l.paye || 0),
        loanDeduction: r2(l.loanDeduction || 0),
        otherDeductions: r2(l.otherDeductions || 0),
        netPay: r2(l.netPay || 0),
      }));
      const numKeys = ['basic', 'otPay', 'allowances', 'bonuses', 'grossPay', 'pension', 'nhf', 'taxablePay', 'paye', 'loanDeduction', 'otherDeductions', 'netPay'];
      for (const k of numKeys) summary[k] = r2(rows.reduce((s, r) => s + (r[k] || 0), 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} staff`, '', '', summary.basic, summary.otPay, summary.allowances, summary.bonuses, summary.grossPay, summary.pension, summary.nhf, summary.taxablePay, summary.paye, summary.loanDeduction, summary.otherDeductions, summary.netPay];
      break;
    }

    case 'payslips': {
      headers = ['Period', 'EmpID', 'Name', 'Department', 'Bank', 'AccountNo', 'Basic', 'OTPay', 'Allowances', 'Bonuses', 'GrossPay', 'TotalDeductions', 'NetPay'];
      columns = ['period', 'empId', 'name', 'department', 'bank', 'accountNo', 'basic', 'otPay', 'allowances', 'bonuses', 'grossPay', 'totalDeductions', 'netPay'];
      rows = lines.map((l) => {
        const totDed = r2((l.pension || 0) + (l.nhf || 0) + (l.paye || 0) + (l.loanDeduction || 0) + (l.otherDeductions || 0));
        return {
          period,
          empId: l.empId,
          name: l.name,
          department: l.department || 'General',
          bank: l.bank || '',
          accountNo: maskAccountNumber(l.accountNo || ''),
          basic: r2(l.basic || 0),
          otPay: r2(l.otPay || 0),
          allowances: r2(l.allowances || 0),
          bonuses: r2(l.bonuses || 0),
          grossPay: r2(l.gross || 0),
          totalDeductions: totDed,
          netPay: r2(l.netPay || 0),
        };
      });
      summary.totalGross = r2(rows.reduce((s, r) => s + r.grossPay, 0));
      summary.totalDeductions = r2(rows.reduce((s, r) => s + r.totalDeductions, 0));
      summary.totalNet = r2(rows.reduce((s, r) => s + r.netPay, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} payslips`, '', '', '', '', '', '', '', '', summary.totalGross, summary.totalDeductions, summary.totalNet];
      break;
    }

    case 'paye-remittance': {
      headers = ['Period', 'EmpID', 'Name', 'State', 'TIN', 'GrossPay', 'TaxablePay', 'PAYERemittance'];
      columns = ['period', 'empId', 'name', 'state', 'tin', 'grossPay', 'taxablePay', 'payeRemittance'];
      rows = lines.map((l) => ({
        period,
        empId: l.empId,
        name: l.name,
        state: l.state || 'Lagos',
        tin: l.tin || 'N/A',
        grossPay: r2(l.gross || 0),
        taxablePay: r2(l.chargeable ?? l.taxablePay ?? 0),
        payeRemittance: r2(l.paye || 0),
      }));
      summary.totalGross = r2(rows.reduce((s, r) => s + r.grossPay, 0));
      summary.totalTaxable = r2(rows.reduce((s, r) => s + r.taxablePay, 0));
      summary.totalPAYE = r2(rows.reduce((s, r) => s + r.payeRemittance, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} payees`, '', '', '', summary.totalGross, summary.totalTaxable, summary.totalPAYE];
      break;
    }

    case 'pension-remittance': {
      headers = ['Period', 'EmpID', 'Name', 'PensionPIN', 'PFA', 'PensionableEmoluments', 'EmployeePension', 'EmployerPension', 'TotalPension'];
      columns = ['period', 'empId', 'name', 'pensionPin', 'pfa', 'pensionableEmoluments', 'employeePension', 'employerPension', 'totalPension'];
      rows = lines.map((l) => {
        const empPen = r2(l.pension || 0);
        const emprPen = r2(l.employerPension || 0);
        return {
          period,
          empId: l.empId,
          name: l.name,
          pensionPin: l.pensionPin || 'PEN-PENDING',
          pfa: l.pfa || 'Leadway Pensure',
          pensionableEmoluments: r2(l.pensionable ?? ((l.basic || 0) + (l.housing || 0) + (l.transport || 0))),
          employeePension: empPen,
          employerPension: emprPen,
          totalPension: r2(empPen + emprPen),
        };
      });
      summary.totalPensionable = r2(rows.reduce((s, r) => s + r.pensionableEmoluments, 0));
      summary.totalEmployee = r2(rows.reduce((s, r) => s + r.employeePension, 0));
      summary.totalEmployer = r2(rows.reduce((s, r) => s + r.employerPension, 0));
      summary.totalPension = r2(rows.reduce((s, r) => s + r.totalPension, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} staff`, '', '', '', summary.totalPensionable, summary.totalEmployee, summary.totalEmployer, summary.totalPension];
      break;
    }

    case 'nhf-remittance': {
      headers = ['Period', 'EmpID', 'Name', 'NHFNumber', 'BasicSalary', 'NHFContribution'];
      columns = ['period', 'empId', 'name', 'nhfNumber', 'basicSalary', 'nhfContribution'];
      rows = lines.filter((l) => (l.nhf || 0) > 0 || l.nhfEnrolled).map((l) => ({
        period,
        empId: l.empId,
        name: l.name,
        nhfNumber: l.nhfNumber || 'NHF-PENDING',
        basicSalary: r2(l.basic || 0),
        nhfContribution: r2(l.nhf || 0),
      }));
      summary.totalBasic = r2(rows.reduce((s, r) => s + r.basicSalary, 0));
      summary.totalNHF = r2(rows.reduce((s, r) => s + r.nhfContribution, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} contributors`, '', '', summary.totalBasic, summary.totalNHF];
      break;
    }

    case 'bank-schedule': {
      headers = ['Period', 'EmpID', 'Name', 'Bank', 'AccountNo', 'NetPay', 'Narration'];
      columns = ['period', 'empId', 'name', 'bank', 'accountNo', 'netPay', 'narration'];
      rows = lines.filter((l) => (l.netPay || 0) > 0).map((l) => ({
        period,
        empId: l.empId,
        name: l.name,
        bank: l.bank || '',
        accountNo: l.accountNo || '',
        netPay: r2(l.netPay || 0),
        narration: formatPaymentNarration(period, l),
      }));
      summary.totalNet = r2(rows.reduce((s, r) => s + r.netPay, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} payments`, '', '', '', summary.totalNet, ''];
      break;
    }

    case 'overtime-report': {
      headers = ['Period', 'EmpID', 'Name', 'Department', 'NormalHours', 'WeekdayOT', 'WeekendOT', 'HolidayOT', 'TotalOTHours', 'OvertimePay'];
      columns = ['period', 'empId', 'name', 'department', 'normalHours', 'weekdayOT', 'weekendOT', 'holidayOT', 'totalOTHours', 'overtimePay'];
      rows = lines.map((l) => ({
        period,
        empId: l.empId,
        name: l.name,
        department: l.department || 'Operations',
        normalHours: r2(l.normalHours || (l.hoursWorked ? Math.max(0, l.hoursWorked - (l.otHours || 0)) : 160)),
        weekdayOT: r2(l.weekdayOT || l.otHours || 0),
        weekendOT: r2(l.weekendOT || 0),
        holidayOT: r2(l.holidayOT || 0),
        totalOTHours: r2(l.otHours || 0),
        overtimePay: r2(l.otPay || 0),
      }));
      summary.totalOTHours = r2(rows.reduce((s, r) => s + r.totalOTHours, 0));
      summary.totalOTPay = r2(rows.reduce((s, r) => s + r.overtimePay, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} staff`, '', '', '', '', '', '', summary.totalOTHours, summary.totalOTPay];
      break;
    }

    case 'loan-ledger': {
      headers = ['Period', 'LoanID', 'EmpID', 'Name', 'AmountDeducted', 'BalanceBefore', 'BalanceAfter', 'Status'];
      columns = ['period', 'loanId', 'empId', 'name', 'amountDeducted', 'balanceBefore', 'balanceAfter', 'status'];
      if (repayments && repayments.length) {
        rows = repayments.map((r) => ({
          period: r.period || period,
          loanId: r.loanId,
          empId: r.empId,
          name: r.empName || (lines.find((l) => l.empId === r.empId)?.name || r.empId),
          amountDeducted: r2(r.amountDeducted || 0),
          balanceBefore: r2(r.balanceBefore || 0),
          balanceAfter: r2(r.balanceAfter || 0),
          status: r.status || 'Active',
        }));
      } else {
        rows = lines.filter((l) => (l.loanDeduction || 0) > 0).map((l) => ({
          period,
          loanId: l.loanId || 'LN-RECOVERY',
          empId: l.empId,
          name: l.name,
          amountDeducted: r2(l.loanDeduction || 0),
          balanceBefore: r2((l.remainingLoanBalance || 0) + (l.loanDeduction || 0)),
          balanceAfter: r2(l.remainingLoanBalance || 0),
          status: (l.remainingLoanBalance || 0) <= 0 ? 'Settled' : 'Active',
        }));
      }
      summary.totalRecoveries = r2(rows.reduce((s, r) => s + r.amountDeducted, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} deductions`, '', '', summary.totalRecoveries, '', '', ''];
      break;
    }

    case 'leave-report': {
      headers = ['Period', 'EmpID', 'Name', 'Department', 'LeaveType', 'StartDate', 'EndDate', 'Days', 'Status', 'PaidLeave'];
      columns = ['period', 'empId', 'name', 'department', 'leaveType', 'startDate', 'endDate', 'days', 'status', 'paidLeave'];
      rows = (leaves || []).map((lv) => {
        const emp = lines.find((l) => l.empId === lv.empId);
        return {
          period,
          empId: lv.empId,
          name: emp?.name || lv.empName || lv.empId,
          department: emp?.department || lv.department || 'Operations',
          leaveType: lv.leaveType,
          startDate: lv.startDate ? String(lv.startDate).slice(0, 10) : '',
          endDate: lv.endDate ? String(lv.endDate).slice(0, 10) : '',
          days: lv.days || 0,
          status: lv.status || 'Approved',
          paidLeave: lv.leaveType === 'Unpaid' ? 'No' : 'Yes',
        };
      });
      summary.totalDays = rows.reduce((s, r) => s + (r.days || 0), 0);
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} leaves`, '', '', '', '', '', summary.totalDays, '', ''];
      break;
    }

    case 'bonus-report': {
      headers = ['Period', 'EmpID', 'Name', 'Department', 'PerformanceBonus', 'ProductionBonus', 'AttendanceBonus', 'OtherBonus', 'TotalBonuses'];
      columns = ['period', 'empId', 'name', 'department', 'performanceBonus', 'productionBonus', 'attendanceBonus', 'otherBonus', 'totalBonuses'];
      rows = lines.filter((l) => (l.bonuses || 0) > 0 || l.bonusDetails).map((l) => ({
        period,
        empId: l.empId,
        name: l.name,
        department: l.department || 'Operations',
        performanceBonus: r2(l.bonusDetails?.performanceBonus || 0),
        productionBonus: r2(l.bonusDetails?.productionBonus || 0),
        attendanceBonus: r2(l.bonusDetails?.attendanceBonus || 0),
        otherBonus: r2(l.bonusDetails?.otherBonus || 0),
        totalBonuses: r2(l.bonuses || 0),
      }));
      summary.totalBonuses = r2(rows.reduce((s, r) => s + r.totalBonuses, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} recipients`, '', '', '', '', '', '', summary.totalBonuses];
      break;
    }

    case 'variance-report': {
      headers = ['Period', 'EmpID', 'Name', 'Department', 'CurrentGross', 'PreviousGross', 'GrossDelta', 'CurrentNet', 'PreviousNet', 'NetDelta', 'Status'];
      columns = ['period', 'empId', 'name', 'department', 'currentGross', 'previousGross', 'grossDelta', 'currentNet', 'previousNet', 'netDelta', 'status'];
      const prevMap = new Map((previousRun?.lines || []).map((l) => [l.empId, l]));
      rows = lines.map((l) => {
        const prev = prevMap.get(l.empId);
        const curGross = r2(l.gross || 0);
        const prevGross = r2(prev?.gross || 0);
        const curNet = r2(l.netPay || 0);
        const prevNet = r2(prev?.netPay || 0);
        const grossDelta = r2(curGross - prevGross);
        const netDelta = r2(curNet - prevNet);
        let status = 'Match';
        if (!prev) status = 'New Joiner';
        else if (Math.abs(netDelta) > 1) status = 'Variance';
        return {
          period,
          empId: l.empId,
          name: l.name,
          department: l.department || 'Operations',
          currentGross: curGross,
          previousGross: prevGross,
          grossDelta,
          currentNet: curNet,
          previousNet: prevNet,
          netDelta,
          status,
        };
      });
      summary.totalCurrentNet = r2(rows.reduce((s, r) => s + r.currentNet, 0));
      summary.totalPreviousNet = r2(rows.reduce((s, r) => s + r.previousNet, 0));
      summary.netDelta = r2(summary.totalCurrentNet - summary.totalPreviousNet);
      summary.varianceCount = rows.filter((r) => r.status === 'Variance').length;
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} comparisons`, '', '', '', '', '', summary.totalCurrentNet, summary.totalPreviousNet, summary.netDelta, `${summary.varianceCount} variances`];
      break;
    }

    case 'exceptions-report': {
      headers = ['Period', 'EmpID', 'Name', 'Department', 'Category', 'Severity', 'Description'];
      columns = ['period', 'empId', 'name', 'department', 'category', 'severity', 'description'];
      rows = [];
      (run?.exceptions || []).forEach((x) => {
        rows.push({
          period,
          empId: x.empId || 'SYSTEM',
          name: x.empName || (lines.find((l) => l.empId === x.empId)?.name || 'N/A'),
          department: x.department || 'N/A',
          category: x.type || 'VALIDATION_EXCEPTION',
          severity: x.blocking ? 'Blocking' : 'Warning',
          description: x.message || x.description || '',
        });
      });
      lines.forEach((l) => {
        if (l.flags && l.flags.length) {
          l.flags.forEach((f) => {
            rows.push({
              period,
              empId: l.empId,
              name: l.name,
              department: l.department || 'Operations',
              category: 'LINE_FLAG',
              severity: 'Warning',
              description: `Flagged: ${f}`,
            });
          });
        }
      });
      summary.count = rows.length;
      summary.blockingCount = rows.filter((r) => r.severity === 'Blocking').length;
      summaryLine = ['TOTAL', `${rows.length} exceptions`, '', '', '', `${summary.blockingCount} blocking`, ''];
      break;
    }

    case 'audit-report': {
      headers = ['Timestamp', 'User', 'Action', 'Entity', 'RecordID', 'EmpID', 'Summary'];
      columns = ['ts', 'user', 'action', 'entity', 'recordId', 'empId', 'summary'];
      rows = (auditLogs || []).map((a) => ({
        ts: a.ts ? new Date(a.ts).toISOString() : '',
        user: a.user || '',
        action: a.action || '',
        entity: a.entity || '',
        recordId: a.entityId || '',
        empId: a.empId || '',
        summary: typeof a.details === 'object' ? JSON.stringify(a.details) : String(a.details || ''),
      }));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} audit entries`, '', '', '', '', ''];
      break;
    }

    case 'employer-cost-report': {
      headers = ['Period', 'EmpID', 'Name', 'Department', 'GrossPay', 'EmployerPension', 'NSITF_1Pct', 'ITF_1Pct', 'TotalEmployerCost'];
      columns = ['period', 'empId', 'name', 'department', 'grossPay', 'employerPension', 'nsitf', 'itf', 'totalEmployerCost'];
      rows = lines.map((l) => {
        const gross = r2(l.gross || 0);
        const empPension = r2(l.employerPension || 0);
        const nsitf = r2(gross * 0.01);
        const itf = r2(gross * 0.01);
        const tot = r2(gross + empPension + nsitf + itf);
        return {
          period,
          empId: l.empId,
          name: l.name,
          department: l.department || 'General',
          grossPay: gross,
          employerPension: empPension,
          nsitf,
          itf,
          totalEmployerCost: tot,
        };
      });
      summary.totalGross = r2(rows.reduce((s, r) => s + r.grossPay, 0));
      summary.totalEmployerPension = r2(rows.reduce((s, r) => s + r.employerPension, 0));
      summary.totalNSITF = r2(rows.reduce((s, r) => s + r.nsitf, 0));
      summary.totalITF = r2(rows.reduce((s, r) => s + r.itf, 0));
      summary.totalEmployerCost = r2(rows.reduce((s, r) => s + r.totalEmployerCost, 0));
      summary.count = rows.length;
      summaryLine = ['TOTAL', `${rows.length} staff`, '', '', summary.totalGross, summary.totalEmployerPension, summary.totalNSITF, summary.totalITF, summary.totalEmployerCost];
      break;
    }
  }

  return {
    id: def.id,
    name: def.name,
    category: def.category,
    period,
    generatedAt: new Date().toISOString(),
    headers,
    columns,
    rows,
    summary,
    summaryLine,
  };
}

/**
 * FR-DSH-06: Multi-format exports for standard reports.
 */
function exportReportCSV(report) {
  const qCsv = (val) => {
    if (val == null) return '';
    const s = String(val);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headerLine = (report.headers || []).map(qCsv).join(',');
  const rowLines = (report.rows || []).map((row) => {
    if (Array.isArray(row)) return row.map(qCsv).join(',');
    return (report.columns || report.headers || []).map((col) => qCsv(row[col])).join(',');
  });
  const lines = [
    `# REPORT: ${report.name || report.id}`,
    `# PERIOD: ${report.period || 'N/A'}`,
    `# GENERATED: ${report.generatedAt || new Date().toISOString()}`,
    headerLine,
    ...rowLines,
  ];
  if (report.summaryLine) {
    lines.push(report.summaryLine.map(qCsv).join(','));
  }
  return lines.join('\n');
}

function exportReportXLSX(report) {
  const rows = [];
  rows.push([`${report.name || report.id}`, `Period: ${report.period || 'N/A'}`]);
  rows.push(report.headers || []);
  for (const row of (report.rows || [])) {
    if (Array.isArray(row)) {
      rows.push(row);
    } else {
      const r = (report.columns || report.headers || []).map((c) => row[c] ?? '');
      rows.push(r);
    }
  }
  if (report.summaryLine) {
    rows.push(report.summaryLine);
  }
  const sheetName = (report.id || 'Report').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 31);
  return generateZipXlsx(sheetName, rows);
}

function exportReportPDF(report) {
  const title = `${report.name || report.id} - Period: ${report.period || 'N/A'}`;
  const rows = (report.rows || []).map((row) => {
    if (Array.isArray(row)) return row.join(' | ');
    return (report.columns || report.headers || []).map((c) => {
      const v = row[c] ?? '';
      return typeof v === 'number' ? v.toFixed(2) : String(v);
    }).join(' | ');
  });
  return generatePdfBuffer({
    title,
    subtitle: `Generated: ${report.generatedAt || new Date().toISOString()}`,
    headers: report.headers,
    rows,
    grandTotal: report.summaryLine ? report.summaryLine.join(' | ') : null,
  });
}

module.exports = {
  reconcileParallelRun,
  calcLine,
  maskAccountNumber,
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
  formatPaymentNarration,
  validateBankTransferLine,
  generateBankTransferSchedule,
  exportBankTransferCSV,
  exportBankTransferXLSX,
  BANK_UPLOAD_TEMPLATES,
  calculatePeriodTrends,
  reconcileDashboardToRegister,
  generateZipXlsx,
  generatePdfBuffer,
  STANDARD_REPORTS,
  normalizeReportType,
  generateStandardReport,
  exportReportCSV,
  exportReportXLSX,
  exportReportPDF,
};
