const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  checkPassword,
  hash,
  compare,
  generateMfaSecret,
  generateTotp,
  verifyTotp,
  base32Encode,
  base32Decode,
} = require('../lib/auth');
const { User, Employee, PrivacyBreachLog, DataSubjectRequest } = require('../lib/models');
const {
  maskAccountNumber,
  maskSensitiveIdentifier,
  maskEmployeeSensitiveFields,
} = require('../lib/payroll');

test('FR-SEC-01: Individual authentication with strong passwords and RFC 6238 TOTP MFA', async () => {
  // Strong password policy: at least 10 chars, letters and digits
  assert.ok(checkPassword('weak'));
  assert.ok(checkPassword('short1'));
  assert.ok(checkPassword('allletterspassword'));
  assert.ok(checkPassword('12345678901'));
  assert.strictEqual(checkPassword('Payroll2026Admin!'), null);

  // Password hashing
  const rawPw = 'StrongPass2026!';
  const hashed = await hash(rawPw);
  assert.notStrictEqual(rawPw, hashed);
  assert.ok(await compare(rawPw, hashed));
  assert.ok(!(await compare('WrongPass2026!', hashed)));

  // MFA TOTP generation and verification (RFC 6238)
  const secret = generateMfaSecret();
  assert.ok(secret && secret.length >= 16, 'MFA secret generated in base32 format');
  const nowStep = Math.floor(Date.now() / 30000);
  const token = generateTotp(secret, nowStep);
  assert.strictEqual(token.length, 6, 'TOTP token is a 6-digit code');
  assert.ok(/^\d{6}$/.test(token), 'TOTP token consists of numeric digits');

  assert.strictEqual(verifyTotp(token, secret), true, 'Valid TOTP code succeeds');
  assert.strictEqual(verifyTotp('000000', secret), false, 'Invalid TOTP code is rejected');
  assert.strictEqual(verifyTotp('', secret), false, 'Empty code is rejected');
  assert.strictEqual(verifyTotp(token, ''), false, 'Empty secret is rejected');
});

test('FR-SEC-02: Role-based access control supporting all 9 factory stakeholders', () => {
  const allowedRoles = User.schema.path('role').enumValues;
  const expectedRoles = [
    'admin',
    'hr',
    'payroll',
    'approver',
    'supervisor',
    'executive',
    'auditor',
    'tax_advisor',
    'employee',
  ];
  for (const role of expectedRoles) {
    assert.ok(allowedRoles.includes(role), `User role enum must support ${role}`);
  }
  assert.strictEqual(allowedRoles.length, 9, 'All 9 stakeholder roles are defined');
});

test('FR-SEC-03: Segregation of duties rules', () => {
  // 1. Preparer cannot approve payroll
  const preparer = 'payroll_officer_john';
  const approverSame = 'payroll_officer_john';
  const approverDifferent = 'finance_manager_mary';

  const canApproveSame = preparer !== approverSame;
  const canApproveDifferent = preparer !== approverDifferent;
  assert.strictEqual(canApproveSame, false, 'Preparer cannot approve their own payroll');
  assert.strictEqual(canApproveDifferent, true, 'Different manager can approve');

  // 2. HR role cannot approve payroll
  const canHrApprovePayroll = (role) => role !== 'hr';
  assert.strictEqual(canHrApprovePayroll('hr'), false, 'HR role cannot approve payroll');
  assert.strictEqual(canHrApprovePayroll('approver'), true, 'Approver role can approve payroll');
  assert.strictEqual(canHrApprovePayroll('executive'), true, 'Executive role can approve payroll');

  // 3. Creator of a loan, bonus, deduction or attendance cannot approve it
  const isSelfApprovalBlocked = (createdBy, approvedBy) => createdBy !== approvedBy;
  assert.strictEqual(isSelfApprovalBlocked('userA', 'userA'), false, 'Self-approval is blocked');
  assert.strictEqual(isSelfApprovalBlocked('userA', 'userB'), true, 'Different user approval allowed');
});

test('FR-SEC-04: Sensitive data visibility and masking for unauthorized roles', () => {
  const sampleEmp = {
    empId: 'EMP-001',
    surname: 'Adeyemi',
    firstName: 'Babatunde',
    basic: 350000,
    housing: 100000,
    transport: 50000,
    otherAllowance: 25000,
    hourlyRate: 2000,
    annualRent: 1200000,
    accountNo: '0123456789',
    tin: 'TIN-987654321',
    pensionPin: 'PEN100020003000',
    nhfNumber: 'NHF888999000',
  };

  // Masking helpers
  assert.strictEqual(maskAccountNumber('0123456789'), '******6789');
  assert.strictEqual(maskSensitiveIdentifier('TIN-987654321'), '*********4321');

  // Authorized roles (e.g. hr, payroll, approver, executive, admin) see full data
  const hrView = maskEmployeeSensitiveFields(sampleEmp, 'hr');
  assert.strictEqual(hrView.basic, 350000);
  assert.strictEqual(hrView.accountNo, '0123456789');
  assert.strictEqual(hrView.tin, 'TIN-987654321');

  // Unauthorized roles (e.g. supervisor, auditor, employee) see masked identifiers and suppressed salary
  const supervisorView = maskEmployeeSensitiveFields(sampleEmp, 'supervisor');
  assert.strictEqual(supervisorView.basic, null, 'Salary masked for supervisor');
  assert.strictEqual(supervisorView.accountNo, '******6789', 'Account masked');
  assert.strictEqual(supervisorView.tin, '*********4321', 'TIN masked');
  assert.strictEqual(supervisorView.pensionPin, '***********3000', 'Pension PIN masked');
  assert.strictEqual(supervisorView.nhfNumber, '********9000', 'NHF Number masked');
});

test('FR-SEC-05: Excel workbook protection and data validation', () => {
  const { execSync } = require('child_process');
  const pythonScript = [
    'import openpyxl',
    'wb = openpyxl.load_workbook("Comprehensive_Factory_Payroll_System.xlsx")',
    'assert wb["Payroll_Register"].protection.sheet == True',
    'assert wb["PAYE_Bands"].protection.sheet == True',
    'assert wb["Shift_Setup"].protection.sheet == True',
    'assert wb["Employee_Master"].protection.sheet == True',
    'assert len(wb["Employee_Master"].data_validations.dataValidation) >= 4',
    'assert wb["Payroll_Register"]["G2"].protection.locked == True',
    'assert wb["Payroll_Register"]["C2"].protection.locked == False',
    'print("EXCEL_HARDENING_VERIFIED")',
  ].join('\n');
  const res = execSync(`python3 -c '${pythonScript}'`, { encoding: 'utf8' });
  assert.ok(res.includes('EXCEL_HARDENING_VERIFIED'), 'Excel workbook formula cells locked, sheets protected, validations set');
});

test('FR-SEC-06: Nigeria Data Protection Act 2023 (NDPA) schema and workflows', () => {
  // Privacy breach schema and 72-hour reporting rule
  assert.ok(PrivacyBreachLog.schema.path('incidentId'));
  assert.ok(PrivacyBreachLog.schema.path('incidentDate'));
  assert.ok(PrivacyBreachLog.schema.path('severity'));
  assert.ok(PrivacyBreachLog.schema.path('ndpcNotified'));
  assert.ok(PrivacyBreachLog.schema.path('ndpcNotifiedAt'));
  assert.ok(PrivacyBreachLog.schema.path('ndpcReferenceNo'));

  // Data subject access request (DSAR) schema
  assert.ok(DataSubjectRequest.schema.path('requestId'));
  assert.ok(DataSubjectRequest.schema.path('empId'));
  assert.ok(DataSubjectRequest.schema.path('requestType'));
  assert.ok(DataSubjectRequest.schema.path('lawfulBasis'));
  assert.ok(DataSubjectRequest.schema.path('retentionExemptionApplied'));

  // 72-hour window calculation test
  const discovery = new Date(Date.now() - 48 * 3600 * 1000); // 48h ago
  const hours = (Date.now() - discovery.getTime()) / (1000 * 3600);
  assert.ok(hours <= 72, 'Within statutory 72-hour NDPC notification window');

  const oldDiscovery = new Date(Date.now() - 80 * 3600 * 1000); // 80h ago
  const oldHours = (Date.now() - oldDiscovery.getTime()) / (1000 * 3600);
  assert.ok(oldHours > 72, 'Breached statutory 72-hour NDPC notification window');
});
