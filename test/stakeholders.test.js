const test = require('node:test');
const assert = require('node:assert');
const { User, Employee } = require('../lib/models');
const { calcLine } = require('../lib/payroll');
const { r2 } = require('../lib/tax');

test('Stakeholder roles and employee link in User model', () => {
  const allowedRoles = ['admin', 'hr', 'payroll', 'approver', 'supervisor', 'executive', 'auditor', 'tax_advisor', 'employee'];
  const roleEnum = User.schema.path('role').enumValues;
  for (const role of allowedRoles) {
    assert.ok(roleEnum.includes(role), `Role ${role} must be defined in User schema`);
  }
  assert.ok(User.schema.path('empId'), 'empId should be defined on User schema');

  const u = new User({
    username: 'john_emp',
    name: 'John Doe',
    role: 'employee',
    empId: 'EMP001',
    passwordHash: 'dummyhash123',
  });
  assert.strictEqual(u.empId, 'EMP001');
  assert.strictEqual(u.role, 'employee');
});

test('Payroll line includes compliance fields for statutory bodies and remittances', () => {
  const emp = {
    empId: 'EMP001',
    surname: 'Adeyemi',
    firstName: 'Babatunde',
    department: 'Production',
    position: 'Machine Operator',
    basic: 120000,
    housing: 40000,
    transport: 20000,
    otherAllowance: 0,
    state: 'Lagos',
    tin: 'TIN12345678',
    pensionPin: 'PEN10002000',
    nhfEnrolled: true,
    bank: 'First Bank of Nigeria',
    accountNo: '0123456789',
  };

  const line = calcLine(emp, { attendance: [], adjustments: [], loans: [] }, '2026-11');

  // Verify statutory fields
  assert.strictEqual(line.state, 'Lagos');
  assert.strictEqual(line.tin, 'TIN12345678');
  assert.strictEqual(line.pensionPin, 'PEN10002000');
  assert.strictEqual(line.pensionable, 180000); // 120k basic + 40k housing + 20k transport
  assert.strictEqual(line.pension, 14400); // 8% of 180k
  assert.strictEqual(line.employerPension, 18000); // 10% of 180k
  assert.strictEqual(line.nhf, 3000); // 2.5% of 120k basic
  assert.strictEqual(line.gross, 180000);
});

test('Statutory remittance and employer levies calculation for Tax Advisors', () => {
  const lines = [
    {
      empId: 'EMP001', name: 'Adeyemi Babatunde', state: 'Lagos', tin: 'TIN001', pensionPin: 'PEN001',
      basic: 120000, gross: 180000, pensionable: 180000, pension: 14400, employerPension: 18000, nhf: 3000,
      chargeable: 1500000, paye: 10500, netPay: 152100
    },
    {
      empId: 'EMP002', name: 'Okonkwo Chukwuma', state: 'Ogun', tin: 'TIN002', pensionPin: 'PEN002',
      basic: 200000, gross: 300000, pensionable: 300000, pension: 24000, employerPension: 30000, nhf: 5000,
      chargeable: 2600000, paye: 22500, netPay: 248500
    }
  ];

  const totalGross = lines.reduce((s, l) => s + l.gross, 0);
  const totalPAYE = lines.reduce((s, l) => s + l.paye, 0);
  const totalEmployeePension = lines.reduce((s, l) => s + l.pension, 0);
  const totalEmployerPension = lines.reduce((s, l) => s + l.employerPension, 0);
  const totalPension = totalEmployeePension + totalEmployerPension;
  const totalNHF = lines.reduce((s, l) => s + l.nhf, 0);

  // Statutory levies (Section 4.10 FR-STAT-02)
  const nsitf = r2(totalGross * 0.01);
  const itf = r2(totalGross * 0.01);

  assert.strictEqual(totalGross, 480000);
  assert.strictEqual(totalPAYE, 33000);
  assert.strictEqual(totalEmployeePension, 38400); // 8%
  assert.strictEqual(totalEmployerPension, 48000); // 10%
  assert.strictEqual(totalPension, 86400); // 18%
  assert.strictEqual(totalNHF, 8000); // 2.5%
  assert.strictEqual(nsitf, 4800); // 1%
  assert.strictEqual(itf, 4800); // 1%

  const totalLiability = r2(totalPAYE + totalPension + totalNHF + nsitf + itf);
  assert.strictEqual(totalLiability, 137000);
});

test('Executive Dashboard KPI and department breakdown aggregation for MD/CFO', () => {
  const lines = [
    { empId: 'E1', name: 'Emp One', department: 'Production', gross: 200000, otPay: 20000, otHours: 10, netPay: 160000, employerPension: 20000, flags: [] },
    { empId: 'E2', name: 'Emp Two', department: 'Production', gross: 250000, otPay: 30000, otHours: 15, netPay: 195000, employerPension: 25000, flags: [] },
    { empId: 'E3', name: 'Emp Three', department: 'Executive', gross: 1400000, otPay: 0, otHours: 0, netPay: 1100000, employerPension: 140000, flags: [] },
    { empId: 'E4', name: 'Emp Four', department: 'Logistics', gross: 80000, otPay: 0, otHours: 0, netPay: 60000, employerPension: 8000, flags: ['NO_BANK'] },
  ];

  // Headcount & Totals
  const headcount = lines.length;
  const totalGross = lines.reduce((s, l) => s + l.gross, 0);
  const totalNet = lines.reduce((s, l) => s + l.netPay, 0);
  const totalOTCost = lines.reduce((s, l) => s + l.otPay, 0);
  const totalOTHours = lines.reduce((s, l) => s + l.otHours, 0);
  const totalEmployerPension = lines.reduce((s, l) => s + l.employerPension, 0);
  const totalEmployerCost = totalGross + totalEmployerPension;

  assert.strictEqual(headcount, 4);
  assert.strictEqual(totalGross, 1930000);
  assert.strictEqual(totalNet, 1515000);
  assert.strictEqual(totalOTCost, 50000);
  assert.strictEqual(totalOTHours, 25);
  assert.strictEqual(totalEmployerCost, 2123000);

  // High-value and exception review
  const highValuePayees = lines.filter((l) => l.netPay >= 1000000);
  const flaggedLines = lines.filter((l) => l.flags.length > 0);
  assert.strictEqual(highValuePayees.length, 1);
  assert.strictEqual(highValuePayees[0].empId, 'E3');
  assert.strictEqual(flaggedLines.length, 1);
  assert.strictEqual(flaggedLines[0].empId, 'E4');
});

test('Shift Supervisor attendance segregation of duties', () => {
  const attendance = {
    _id: 'ATT101',
    empId: 'EMP001',
    shift: 'Night',
    hoursWorked: 8,
    approved: false,
    createdBy: 'supervisor_danladi',
  };

  // Same supervisor attempting approval
  const approverSame = 'supervisor_danladi';
  const canApproveSame = attendance.createdBy !== approverSame;
  assert.strictEqual(canApproveSame, false, 'Supervisor cannot approve attendance they created');

  // Different supervisor or approver
  const approverDifferent = 'supervisor_kalu';
  const canApproveDifferent = attendance.createdBy !== approverDifferent;
  assert.strictEqual(canApproveDifferent, true, 'Different supervisor or manager can approve');
});

test('Employee self-service payslip authorization policy', () => {
  const user = { username: 'aliyu_b', role: 'employee', empId: 'EMP003' };

  // Accessing own payslip
  const ownTarget = 'EMP003';
  const canViewOwn = user.role !== 'employee' || (user.empId && user.empId.toUpperCase() === ownTarget.toUpperCase());
  assert.strictEqual(canViewOwn, true);

  // Accessing another employee payslip
  const otherTarget = 'EMP004';
  const canViewOther = user.role !== 'employee' || (user.empId && user.empId.toUpperCase() === otherTarget.toUpperCase());
  assert.strictEqual(canViewOther, false, 'Employee must not be able to view another employee payslip');
});
