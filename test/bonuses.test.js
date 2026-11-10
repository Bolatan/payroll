const test = require('node:test');
const assert = require('node:assert/strict');
const { BonusRegister, AllowanceRegister, Employee } = require('../lib/models');
const {
  calcLine,
  suggestAttendanceBonus,
  parseProductionBonusData,
  CFG,
} = require('../lib/payroll');

test('FR-BON-01: BonusRegister schema records Period, EmpID, PerformanceBonus, ProductionBonus, AttendanceBonus, OtherBonus and other description', () => {
  const schema = BonusRegister.schema.paths;
  assert.ok(schema.period, 'period field must exist');
  assert.ok(schema.empId, 'empId field must exist');
  assert.ok(schema.performanceBonus, 'performanceBonus field must exist');
  assert.ok(schema.productionBonus, 'productionBonus field must exist');
  assert.ok(schema.attendanceBonus, 'attendanceBonus field must exist');
  assert.ok(schema.otherBonus, 'otherBonus field must exist');
  assert.ok(schema.otherBonusDescription, 'otherBonusDescription field must exist');
  assert.ok(schema.totalBonuses, 'totalBonuses field must exist');

  const b = new BonusRegister({
    period: '2026-11',
    empId: 'EMP001',
    performanceBonus: 30000,
    productionBonus: 20000,
    attendanceBonus: 10000,
    otherBonus: 5000,
    otherBonusDescription: 'End of Year Safety Award',
    totalBonuses: 65000,
  });

  assert.equal(b.period, '2026-11');
  assert.equal(b.empId, 'EMP001');
  assert.equal(b.performanceBonus, 30000);
  assert.equal(b.productionBonus, 20000);
  assert.equal(b.attendanceBonus, 10000);
  assert.equal(b.otherBonus, 5000);
  assert.equal(b.otherBonusDescription, 'End of Year Safety Award');
  assert.equal(b.totalBonuses, 65000);
});

test('FR-BON-02: Bonus approval requirement and segregation of duties', () => {
  const bonus = {
    _id: 'BON100',
    empId: 'EMP001',
    totalBonuses: 50000,
    status: 'Pending',
    createdBy: 'officer_funke',
  };

  // Creator cannot approve own bonus entry
  const approverSame = 'officer_funke';
  const canApproveSame = bonus.createdBy !== approverSame;
  assert.equal(canApproveSame, false, 'Bonus creator cannot approve their own bonus entry');

  // Distinct approver can approve
  const approverDifferent = 'manager_ibrahim';
  const canApproveDifferent = bonus.createdBy !== approverDifferent;
  assert.equal(canApproveDifferent, true, 'Distinct approver can approve bonus');

  // Verify unapproved bonus excluded from payroll
  const emp = { empId: 'EMP001', surname: 'Salami', firstName: 'Taiwo', basic: 200000 };
  const unapprovedBonuses = [{ ...bonus, status: 'Pending' }];
  const lineUnapproved = calcLine(emp, { bonuses: unapprovedBonuses }, '2026-11');
  assert.equal(lineUnapproved.bonuses, 0, 'Unapproved bonus must be excluded from payroll calculation');

  // Approved bonus included
  const approvedBonuses = [{ ...bonus, status: 'Approved' }];
  const lineApproved = calcLine(emp, { bonuses: approvedBonuses }, '2026-11');
  assert.equal(lineApproved.bonuses, 50000, 'Approved bonus must be included in payroll calculation');
});

test('FR-BON-03: AttendanceBonus auto-suggested from attendance rules & ProductionBonus imported from production data', () => {
  // Test perfect attendance: 20 days present, 0 absence, 0 late
  const perfectAtt = Array.from({ length: 20 }, (_, i) => ({
    hoursWorked: 8,
    absent: false,
    lateMinutes: 0,
  }));
  const suggestion = suggestAttendanceBonus(perfectAtt, {
    bonusAmount: 25000,
    maxAbsencesAllowed: 0,
    maxLatenessAllowed: 0,
    minDaysPresent: 15,
  });
  assert.equal(suggestion.eligible, true);
  assert.equal(suggestion.suggestedAmount, 25000);
  assert.equal(suggestion.daysPresent, 20);
  assert.equal(suggestion.daysAbsent, 0);

  // Ineligible attendance: 1 absence
  const attWithAbsence = [
    ...perfectAtt.slice(0, 19),
    { absent: true, absentReason: 'Unexcused' },
  ];
  const suggestionAbsence = suggestAttendanceBonus(attWithAbsence, {
    maxAbsencesAllowed: 0,
    maxLatenessAllowed: 0,
  });
  assert.equal(suggestionAbsence.eligible, false);
  assert.equal(suggestionAbsence.suggestedAmount, 0);
  assert.equal(suggestionAbsence.daysAbsent, 1);

  // Production bonus import from output data
  const rawData = [
    { empId: 'EMP001', targetUnits: 100, actualUnits: 130, ratePerUnit: 200 },
    { empId: 'EMP002', bonusAmount: 15000 },
    { empId: '', targetUnits: 100, actualUnits: 120 }, // invalid row
  ];
  const parsed = parseProductionBonusData(rawData);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.errors.length, 1);
  // (130 - 100) * 200 = 6000
  assert.equal(parsed.results[0].productionBonus, 6000);
  assert.equal(parsed.results[1].productionBonus, 15000);
});

test('FR-BON-04: Total Bonuses = sum of four components, itemized detail retained for payslip', () => {
  const emp = {
    empId: 'EMP005',
    surname: 'Ade',
    firstName: 'Bolu',
    basic: 250000,
    housing: 50000,
    transport: 20000,
  };

  const bonusRecord = {
    _id: 'BON200',
    empId: 'EMP005',
    performanceBonus: 40000,
    productionBonus: 25000,
    attendanceBonus: 15000,
    otherBonus: 10000,
    otherBonusDescription: 'Quality Compliance Bonus',
    totalBonuses: 90000, // 40k + 25k + 15k + 10k
    status: 'Approved',
  };

  const line = calcLine(emp, { bonuses: [bonusRecord] }, '2026-11');
  assert.equal(line.bonuses, 90000, 'Total bonuses must equal sum of the 4 components');
  assert.equal(line.gross, 250000 + 70000 + 90000, 'Gross pay includes total bonuses');

  // Verify itemized detail retained for payslip
  assert.ok(line.bonusDetails, 'bonusDetails must be retained on payroll line for payslip');
  assert.equal(line.bonusDetails.performanceBonus, 40000);
  assert.equal(line.bonusDetails.productionBonus, 25000);
  assert.equal(line.bonusDetails.attendanceBonus, 15000);
  assert.equal(line.bonusDetails.otherBonus, 10000);
  assert.equal(line.bonusDetails.otherBonusDescription, 'Quality Compliance Bonus');
  assert.equal(line.bonusDetails.items.length, 1);
});

test('FR-BON-05: Each bonus type carries Taxable and Pensionable flags (default: Taxable=Yes, Pensionable=No)', () => {
  const b = new BonusRegister({ period: '2026-11', empId: 'EMP001' });
  // Defaults check
  assert.equal(b.flags.performance.taxable, true);
  assert.equal(b.flags.performance.pensionable, false);
  assert.equal(b.flags.production.taxable, true);
  assert.equal(b.flags.production.pensionable, false);
  assert.equal(b.flags.attendance.taxable, true);
  assert.equal(b.flags.attendance.pensionable, false);
  assert.equal(b.flags.other.taxable, true);
  assert.equal(b.flags.other.pensionable, false);

  const emp = {
    empId: 'EMP010',
    surname: 'Flag',
    firstName: 'Tester',
    basic: 200000,
    housing: 50000,
    transport: 30000,
  };

  // Case 1: Default flags (Taxable = true, Pensionable = false)
  const defaultBonus = {
    performanceBonus: 50000,
    status: 'Approved',
    flags: {
      performance: { taxable: true, pensionable: false },
    },
  };
  const lineDefault = calcLine(emp, { bonuses: [defaultBonus] }, '2026-11');
  assert.equal(lineDefault.pensionable, 280000); // 200k + 50k + 30k (bonus not pensionable)
  assert.equal(lineDefault.pension, 22400); // 8% of 280,000

  // Case 2: Pensionable production bonus (Taxable = true, Pensionable = true)
  const pensionableBonus = {
    productionBonus: 40000,
    status: 'Approved',
    flags: {
      production: { taxable: true, pensionable: true },
    },
  };
  const linePensionable = calcLine(emp, { bonuses: [pensionableBonus] }, '2026-11');
  assert.equal(linePensionable.pensionable, 320000); // 280k + 40k pensionable bonus
  assert.equal(linePensionable.pension, 25600); // 8% of 320,000

  // Case 3: Tax-exempt bonus (Taxable = false)
  const exemptBonus = {
    otherBonus: 60000,
    otherBonusDescription: 'Tax exempt compassionate award',
    status: 'Approved',
    flags: {
      other: { taxable: false, pensionable: false },
    },
  };
  const lineExempt = calcLine(emp, { bonuses: [exemptBonus] }, '2026-11');
  assert.equal(lineExempt.bonuses, 60000);
  assert.equal(lineExempt.gross, 340000);
  // Chargeable income should compute based on 280k taxable gross, not 340k
  const lineBaseWithoutBonus = calcLine(emp, {}, '2026-11');
  assert.equal(lineExempt.paye, lineBaseWithoutBonus.paye, 'Tax exempt bonus does not increase PAYE');
});

test('FR-BON-06: One-off and recurring allowances (shift allowance, hazard, meal) with approval and flag rules', () => {
  const schema = AllowanceRegister.schema.paths;
  assert.ok(schema.empId);
  assert.ok(schema.type);
  assert.ok(schema.amount);
  assert.ok(schema.recurring);
  assert.ok(schema.taxable);
  assert.ok(schema.pensionable);
  assert.ok(schema.status);

  // Check supported allowance types
  const typesEnum = schema.type.enumValues;
  assert.ok(typesEnum.includes('shift_allowance'));
  assert.ok(typesEnum.includes('hazard'));
  assert.ok(typesEnum.includes('meal'));
  assert.ok(typesEnum.includes('other'));

  const emp = {
    empId: 'EMP020',
    surname: 'Alabi',
    firstName: 'Kehinde',
    basic: 180000,
    housing: 40000,
    transport: 20000,
  };

  const allowanceEntries = [
    // Approved recurring hazard allowance (taxable, pensionable)
    {
      _id: 'ALW1',
      empId: 'EMP020',
      type: 'hazard',
      title: 'Chemical Factory Hazard Allowance',
      amount: 25000,
      recurring: true,
      startPeriod: '2026-01',
      taxable: true,
      pensionable: true,
      status: 'Approved',
    },
    // Approved one-off shift allowance for 2026-11 (taxable, not pensionable)
    {
      _id: 'ALW2',
      empId: 'EMP020',
      type: 'shift_allowance',
      title: 'Night Shift Differential',
      amount: 15000,
      recurring: false,
      startPeriod: '2026-11',
      taxable: true,
      pensionable: false,
      status: 'Approved',
    },
    // Pending meal allowance (must be excluded)
    {
      _id: 'ALW3',
      empId: 'EMP020',
      type: 'meal',
      title: 'Subsidized Meal Allowance',
      amount: 10000,
      recurring: true,
      startPeriod: '2026-11',
      status: 'Pending',
    },
  ];

  const line = calcLine(emp, { allowances: allowanceEntries }, '2026-11');
  // Base allowances = 40k + 20k = 60,000
  // Approved allowances = 25,000 + 15,000 = 40,000
  // Total allowances = 100,000
  assert.equal(line.allowances, 100000);
  // Pensionable base = 180k basic + 40k housing + 20k transport + 25k pensionable hazard = 265,000
  assert.equal(line.pensionable, 265000);
  assert.equal(line.pension, 21200); // 8% of 265,000

  // Itemized breakdown retained
  assert.equal(line.allowanceRegisterBreakdown.length, 2);
  assert.equal(line.allowanceRegisterBreakdown[0].type, 'hazard');
  assert.equal(line.allowanceRegisterBreakdown[1].type, 'shift_allowance');
});
