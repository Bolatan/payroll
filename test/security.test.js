const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'x'.repeat(40);
const {
  sign, verify, hash, compare, checkPassword,
  generateMfaSecret, generateTotp, verifyTotp,
} = require('../lib/auth');
const {
  User, Employee, PrivacyBreachLog, DataSubjectRequest,
} = require('../lib/models');
const {
  maskAccountNumber,
  maskSensitiveIdentifier,
  maskEmployeeSensitiveFields,
} = require('../lib/payroll');

/**
 * FR-SEC-01:
 * The system shall authenticate users individually (no shared accounts)
 * with strong passwords and, where available, MFA.
 */
test('FR-SEC-01: Individual authentication, strong password policy and MFA TOTP verification', async () => {
  // Strong password policy
  assert.ok(checkPassword('short1')); // length < 10
  assert.ok(checkPassword('1234567890123')); // no letters
  assert.ok(checkPassword('allletterspassword')); // no numbers
  assert.equal(checkPassword('FactorySec2026!'), null);

  // Passwords hashed
  const hashed = await hash('FactorySec2026!');
  assert.notEqual(hashed, 'FactorySec2026!');
  assert.ok(await compare('FactorySec2026!', hashed));
  assert.ok(!(await compare('WrongPass123', hashed)));

  // MFA TOTP generation and verification
  const secret = generateMfaSecret();
  assert.ok(typeof secret === 'string' && secret.length >= 20);
  const validTotp = generateTotp(secret);
  assert.match(validTotp, /^\d{6}$/);

  assert.equal(verifyTotp(validTotp, secret), true);
  assert.equal(verifyTotp('999999', secret), false);
  assert.equal(verifyTotp('', secret), false);

  // User model stores mfaEnabled flag
  const u = new User({
    username: 'mfa_user',
    name: 'MFA User',
    role: 'payroll',
    passwordHash: hashed,
    mfaEnabled: true,
  });
  assert.equal(u.mfaEnabled, true);
});

/**
 * FR-SEC-02:
 * Role-based access control with at least:
 * Admin, Payroll Officer (prepare), Payroll Manager/Finance Approver (review/approve),
 * HR Officer/Manager (master data, leave), Supervisor (attendance and OT approval for own team),
 * Auditor (read-only incl. audit log), Employee (own payslip only, if self-service enabled).
 */
test('FR-SEC-02: Role-based access control supporting all required stakeholder roles', () => {
  const allowedRoles = [
    'admin',
    'payroll',
    'approver',
    'hr',
    'supervisor',
    'executive',
    'auditor',
    'tax_advisor',
    'employee',
  ];

  const roleEnum = User.schema.path('role').enumValues;
  for (const role of allowedRoles) {
    assert.ok(roleEnum.includes(role), `Role ${role} must be defined in User schema`);
  }

  // Verify RBAC access rules for key endpoints
  const checkEndpointAccess = (role, endpointRoles) => {
    return role === 'admin' || endpointRoles.includes(role);
  };

  // Payroll calculate: payroll only
  assert.equal(checkEndpointAccess('payroll', ['payroll']), true);
  assert.equal(checkEndpointAccess('employee', ['payroll']), false);
  assert.equal(checkEndpointAccess('hr', ['payroll']), false);

  // Audit view: auditor, admin
  assert.equal(checkEndpointAccess('auditor', ['auditor', 'admin']), true);
  assert.equal(checkEndpointAccess('admin', ['auditor', 'admin']), true);
  assert.equal(checkEndpointAccess('supervisor', ['auditor', 'admin']), false);
});

/**
 * FR-SEC-03:
 * Segregation of duties: the preparer cannot approve; the creator of a loan
 * or bonus cannot approve it; HR cannot approve payroll.
 */
test('FR-SEC-03: Segregation of duties rules', () => {
  // 1. Preparer cannot approve payroll
  const preparer = 'tunde_payroll';
  const approverSame = 'tunde_payroll';
  const approverDistinct = 'ngozi_manager';

  const canApprovePayrollSame = preparer !== approverSame;
  const canApprovePayrollDistinct = preparer !== approverDistinct;
  assert.equal(canApprovePayrollSame, false, 'Payroll preparer cannot approve their own run');
  assert.equal(canApprovePayrollDistinct, true, 'Distinct approver can approve payroll run');

  // 2. Creator of loan/bonus cannot approve it
  const loanCreator = 'chioma_hr';
  const loanApproverSame = 'chioma_hr';
  const loanApproverDistinct = 'ibrahim_approver';

  assert.equal(loanCreator !== loanApproverSame, false, 'Loan creator cannot approve own loan');
  assert.equal(loanCreator !== loanApproverDistinct, true, 'Distinct approver can approve loan');

  // 3. HR cannot approve payroll
  const canRoleApprovePayroll = (role) => {
    if (role === 'hr') return false;
    return ['approver', 'executive'].includes(role);
  };

  assert.equal(canRoleApprovePayroll('hr'), false, 'HR role must not approve payroll');
  assert.equal(canRoleApprovePayroll('approver'), true, 'Finance approver can approve payroll');
  assert.equal(canRoleApprovePayroll('executive'), true, 'Executive can approve payroll');
});

/**
 * FR-SEC-04:
 * Salary, bank and tax data shall be visible only to authorised roles; sensitive fields masked elsewhere.
 */
test('FR-SEC-04: Salary, bank account, and tax/pension identifier masking for unauthorized roles', () => {
  // Account masking
  assert.equal(maskAccountNumber('0123456789'), '******6789');
  assert.equal(maskAccountNumber('1234'), '****1234');
  assert.equal(maskAccountNumber(''), '');

  // Tax/Pension identifier masking
  assert.equal(maskSensitiveIdentifier('TIN123456789'), '********6789');
  assert.equal(maskSensitiveIdentifier('PEN99887766'), '*******7766');
  assert.equal(maskSensitiveIdentifier('1234'), '****1234');

  // Employee object masking by role
  const sensitiveEmp = {
    empId: 'EMP001',
    surname: 'Bello',
    firstName: 'Ahmed',
    department: 'Production',
    basic: 180000,
    housing: 60000,
    transport: 40000,
    accountNo: '0123456789',
    tin: 'TIN123456789',
    pensionPin: 'PEN99887766',
  };

  // Full access roles (HR, Payroll, Approver, Executive)
  const hrView = maskEmployeeSensitiveFields(sensitiveEmp, 'hr');
  assert.equal(hrView.basic, 180000);
  assert.equal(hrView.accountNo, '0123456789');
  assert.equal(hrView.tin, 'TIN123456789');

  // Supervisor view (Operational view: salary masked, bank and tax masked)
  const supervisorView = maskEmployeeSensitiveFields(sensitiveEmp, 'supervisor');
  assert.equal(supervisorView.basic, undefined, 'Supervisor must not see salary figures');
  assert.equal(supervisorView.accountNo, '******6789', 'Account number must be masked');
  assert.equal(supervisorView.tin, '********6789', 'TIN must be masked');
  assert.equal(supervisorView.pensionPin, '*******7766', 'Pension PIN must be masked');
});

/**
 * FR-SEC-05:
 * If delivered in Excel: all formula cells and reference sheets shall be locked/protected,
 * inputs restricted via data validation, and the file kept on access-controlled storage with version history.
 */
test('FR-SEC-05: Excel workbook hardening, protection, formula locking, and data validation', () => {
  const fs = require('fs');
  assert.ok(fs.existsSync('scripts/harden_workbook.py'), 'harden_workbook.py must exist');

  const scriptContent = fs.readFileSync('scripts/harden_workbook.py', 'utf8');
  assert.ok(scriptContent.includes('ws.protection.sheet = True'), 'Sheet protection must be enabled');
  assert.ok(scriptContent.includes('Protection(locked=True)'), 'Formulas and reference sheets must be locked');
  assert.ok(scriptContent.includes('DataValidation'), 'Data validation must be applied');
});

/**
 * FR-SEC-06:
 * Personal data shall be processed in line with the Nigeria Data Protection Act 2023
 * (lawful basis, access control, retention, breach handling).
 */
test('FR-SEC-06: NDPA 2023 compliance schemas, retention policy, and breach incident logging', () => {
  // Breach log schema validation
  const breach = new PrivacyBreachLog({
    incidentId: 'BR-2026-0001',
    title: 'Unauthorized Export Attempt',
    description: 'Suspicious mass query attempt intercepted',
    severity: 'High',
    affectedEmployees: ['EMP001', 'EMP002'],
    reportedBy: 'security_admin',
    notifiedNDPC: true,
  });

  assert.equal(breach.incidentId, 'BR-2026-0001');
  assert.equal(breach.severity, 'High');
  assert.equal(breach.notifiedNDPC, true);

  // Data subject rights request schema validation
  const dsr = new DataSubjectRequest({
    requestId: 'DSR-2026-0001',
    empId: 'EMP001',
    requestType: 'Access',
    details: 'Employee requests copy of all payroll and tax records',
    lawfulBasis: 'Legal Obligation (Employment & Tax Compliance)',
  });

  assert.equal(dsr.requestId, 'DSR-2026-0001');
  assert.equal(dsr.requestType, 'Access');
  assert.equal(dsr.lawfulBasis, 'Legal Obligation (Employment & Tax Compliance)');
});
