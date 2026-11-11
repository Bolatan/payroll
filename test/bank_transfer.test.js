const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateBankTransferSchedule,
  validateBankTransferLine,
  formatPaymentNarration,
  exportBankTransferCSV,
  exportBankTransferXLSX,
  BANK_UPLOAD_TEMPLATES,
} = require('../lib/payroll');
const { BankSchedule } = require('../lib/models');

/**
 * 4.13 Bank Transfer Schedule Test Suite (FR-BNK-01 through FR-BNK-06)
 */

test('FR-BNK-01: Generate bank schedule from Approved payroll with EmpID, Name, Bank, AccountNo, NetPay, Narration & Control Total', () => {
  const approvedRun = {
    period: '2026-10',
    status: 'Approved',
    totals: { net: 450000 },
    lines: [
      { empId: 'EMP001', name: 'Adeyemi Babatunde', bank: 'Zenith Bank', bankCode: '057', accountNo: '0123456789', netPay: 250000 },
      { empId: 'EMP002', name: 'Okonkwo Chukwuma', bank: 'Guaranty Trust Bank', bankCode: '058', accountNo: '0987654321', netPay: 200000 },
    ],
  };

  const schedule = generateBankTransferSchedule(approvedRun);

  assert.equal(schedule.period, '2026-10');
  assert.equal(schedule.payableHeadcount, 2);
  assert.equal(schedule.controlTotal, 450000);
  assert.equal(schedule.narration, 'Salary Oct 2026');
  assert.equal(schedule.items.length, 2);

  const item1 = schedule.items[0];
  assert.equal(item1.empId, 'EMP001');
  assert.equal(item1.name, 'Adeyemi Babatunde');
  assert.equal(item1.bank, 'Zenith Bank');
  assert.equal(item1.accountNo, '0123456789');
  assert.equal(item1.netPay, 250000);
  assert.equal(item1.narration, 'Salary Oct 2026');
});

test('FR-BNK-02: Exclude employees with Net Pay <= 0 or invalid bank details with exceptions report', () => {
  const runWithInvalid = {
    period: '2026-11',
    status: 'Approved',
    totals: { net: 300000 },
    lines: [
      { empId: 'EMP001', name: 'Valid User', bank: 'Zenith Bank', accountNo: '0123456789', netPay: 300000 },
      { empId: 'EMP002', name: 'Zero Net', bank: 'First Bank of Nigeria', accountNo: '1111111111', netPay: 0 },
      { empId: 'EMP003', name: 'Negative Net', bank: 'Access Bank', accountNo: '2222222222', netPay: -5000 },
      { empId: 'EMP004', name: 'Missing Account', bank: 'Zenith Bank', accountNo: '', netPay: 150000 },
      { empId: 'EMP005', name: 'Short Account (Not 10 Digits)', bank: 'Zenith Bank', accountNo: '123456', netPay: 150000 },
      { empId: 'EMP006', name: 'Missing Bank Name', bank: '', accountNo: '3333333333', netPay: 150000 },
    ],
  };

  const schedule = generateBankTransferSchedule(runWithInvalid);

  assert.equal(schedule.payableHeadcount, 1, 'Only valid employee with Net > 0 and valid bank should be included');
  assert.equal(schedule.items[0].empId, 'EMP001');

  // Verify exceptions report
  assert.equal(schedule.exceptions.length, 5, 'All 5 invalid entries must appear on exceptions report');

  const zeroNetEx = schedule.exceptions.find((x) => x.empId === 'EMP002');
  assert.ok(zeroNetEx);
  assert.ok(zeroNetEx.reasons.some((r) => r.includes('Net Pay must be greater than zero')));

  const negativeNetEx = schedule.exceptions.find((x) => x.empId === 'EMP003');
  assert.ok(negativeNetEx);
  assert.ok(negativeNetEx.reasons.some((r) => r.includes('Net Pay must be greater than zero')));

  const shortAccEx = schedule.exceptions.find((x) => x.empId === 'EMP005');
  assert.ok(shortAccEx);
  assert.ok(shortAccEx.reasons.some((r) => r.includes('must be exactly 10 digits (NUBAN)')));

  const noBankEx = schedule.exceptions.find((x) => x.empId === 'EMP006');
  assert.ok(noBankEx);
  assert.ok(noBankEx.reasons.some((r) => r.includes('Bank name is missing')));
});

test('FR-BNK-03: Bank schedule exportable in bank bulk-payment upload format (configurable template) and XLSX/CSV', () => {
  const approvedRun = {
    period: '2026-11',
    status: 'Approved',
    totals: { net: 450000 },
    lines: [
      { empId: 'EMP001', name: 'Adeyemi Babatunde', bank: 'Zenith Bank', bankCode: '057', accountNo: '0123456789', netPay: 250000 },
      { empId: 'EMP002', name: 'Okonkwo Chukwuma', bank: 'GTBank', bankCode: '058', accountNo: '0987654321', netPay: 200000 },
    ],
  };

  const schedule = generateBankTransferSchedule(approvedRun);

  // 1. Generic Bank CSV export
  const csvExport = exportBankTransferCSV(schedule, 'GENERIC_BANK');
  assert.ok(csvExport.includes('EmpID,EmployeeName,Bank,AccountNo,NetPay,Narration,PaymentStatus'));
  assert.ok(csvExport.includes('EMP001,"Adeyemi Babatunde","Zenith Bank",0123456789,250000.00,"Salary Nov 2026",Pending'));
  assert.ok(csvExport.includes('TOTAL,2 payments,,,450000.00,,'));

  // 2. Configurable Bank Bulk Upload Format (NIBSS / NIP format)
  assert.ok(BANK_UPLOAD_TEMPLATES.STANDARD_NIBSS);
  const nipExport = exportBankTransferCSV(schedule, 'STANDARD_NIBSS');
  assert.ok(nipExport.includes('PaymentReference,BeneficiaryName,BeneficiaryBankCode,BeneficiaryAccountNumber,Amount,Narration'));
  assert.ok(nipExport.includes('NIP-202611-0001,"Adeyemi Babatunde",057,0123456789,250000.00,"Salary Nov 2026"'));

  // 3. XLSX format (SpreadsheetML XML format natively opened in Excel)
  const xlsxExport = exportBankTransferXLSX(schedule);
  assert.ok(xlsxExport.includes('<?xml version="1.0"?>'));
  assert.ok(xlsxExport.includes('<Worksheet ss:Name="Bank_Transfer">'));
  assert.ok(xlsxExport.includes('<Data ss:Type="String">EMP001</Data>'));
  assert.ok(xlsxExport.includes('<Data ss:Type="Number">250000.00</Data>'));
  assert.ok(xlsxExport.includes('<Data ss:Type="Number">450000.00</Data>'));
});

test('FR-BNK-04: Control total and count equal register Net Pay total and payable headcount', () => {
  const balancedRun = {
    period: '2026-11',
    status: 'Approved',
    totals: { net: 500000 },
    lines: [
      { empId: 'E1', name: 'Emp 1', bank: 'Access Bank', accountNo: '1000000001', netPay: 300000 },
      { empId: 'E2', name: 'Emp 2', bank: 'Zenith Bank', accountNo: '1000000002', netPay: 200000 },
    ],
  };

  const schedule = generateBankTransferSchedule(balancedRun);
  assert.equal(schedule.controlTotal, balancedRun.totals.net);
  assert.equal(schedule.payableHeadcount, 2);
  assert.equal(schedule.registerNetTotal, balancedRun.totals.net);
  assert.equal(schedule.registerPayableHeadcount, 2);
  assert.equal(schedule.isBalanced, true);

  // If there are exceptions, isBalanced is false
  const unBalancedRun = {
    period: '2026-11',
    status: 'Approved',
    totals: { net: 500000 },
    lines: [
      { empId: 'E1', name: 'Emp 1', bank: 'Access Bank', accountNo: '1000000001', netPay: 300000 },
      { empId: 'E2', name: 'Emp 2', bank: 'Zenith Bank', accountNo: 'INVALID', netPay: 200000 },
    ],
  };
  const unBalancedSchedule = generateBankTransferSchedule(unBalancedRun);
  assert.equal(unBalancedSchedule.isBalanced, false);
  assert.equal(unBalancedSchedule.controlTotal, 300000);
});

test('FR-BNK-05: Require Approved status and support versioned file generation', () => {
  const draftRun = {
    period: '2026-11',
    status: 'Draft',
    lines: [],
  };

  assert.throws(
    () => generateBankTransferSchedule(draftRun),
    /Bank transfer schedule can only be generated from Approved payroll/
  );

  const calculatedRun = {
    period: '2026-11',
    status: 'Calculated',
    lines: [],
  };

  assert.throws(
    () => generateBankTransferSchedule(calculatedRun),
    /Bank transfer schedule can only be generated from Approved payroll/
  );

  // Versioning support
  const approvedRun = {
    period: '2026-11',
    status: 'Approved',
    totals: { net: 100000 },
    lines: [{ empId: 'E1', name: 'Emp 1', bank: 'Zenith Bank', accountNo: '1000000001', netPay: 100000 }],
  };

  const v1 = generateBankTransferSchedule(approvedRun, { version: 1 });
  assert.equal(v1.version, 1);

  const v2 = generateBankTransferSchedule(approvedRun, { version: 2 });
  assert.equal(v2.version, 2);
});

test('FR-BNK-06: BankSchedule model supports recording payment confirmation/reconciliation and flagging failed payments for re-payment', () => {
  const schema = BankSchedule.schema;
  const paths = schema.paths;

  assert.ok(paths.scheduleId);
  assert.ok(paths.period);
  assert.ok(paths.version);
  assert.ok(paths.narration);
  assert.ok(paths.payableHeadcount);
  assert.ok(paths.controlTotal);
  assert.ok(paths.items);
  assert.ok(paths.exceptions);
  assert.ok(paths.status);

  // Subdocument item paths
  const itemSchema = schema.path('items').schema.paths;
  assert.ok(itemSchema.paymentStatus);
  assert.deepEqual(itemSchema.paymentStatus.enumValues, ['Pending', 'Success', 'Failed', 'Paid']);
  assert.ok(itemSchema.reconciliationNote);
  assert.ok(itemSchema.reconciledAt);
  assert.ok(itemSchema.reconciledBy);
});
