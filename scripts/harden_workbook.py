"""
Hardens and updates the Comprehensive Factory Payroll System Excel workbook
according to Phase 0 and Phase 1 specifications.
"""
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, Protection
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

WORKBOOK_PASSWORD = 'FactoryPayrollSecure2026!'

def harden_workbook(filename, output_filenames):
    wb = openpyxl.load_workbook(filename)

    # 1. Update PAYE_Bands
    ws_tax = wb['PAYE_Bands']
    # Clear existing rows
    ws_tax.delete_rows(1, ws_tax.max_row)

    # Let's organize PAYE_Bands clearly:
    # Table 1: Nigeria Tax Act 2025 (Effective 1 January 2026)
    # Table 2: Pre-2026 PITA Historical Bands
    headers_tax = ['Tax Regime', 'Band', 'From (NGN)', 'To (NGN)', 'Band Width (NGN)', 'Rate %', 'Cumulative Lower (NGN)']
    ws_tax.append(headers_tax)

    # NTA 2025 bands
    # Band 1: 0 - 800,000 @ 0%
    # Band 2: 800,000 - 3,000,000 @ 15% (width 2,200,000)
    # Band 3: 3,000,000 - 12,000,000 @ 18% (width 9,000,000)
    # Band 4: 12,000,000 - 25,000,000 @ 21% (width 13,000,000)
    # Band 5: 25,000,000 - 50,000,000 @ 23% (width 25,000,000)
    # Band 6: Above 50,000,000 @ 25% (open-ended)
    nta_bands = [
        ['NTA 2025 (Active)', 1, 0, 800000, 800000, 0.00, 0],
        ['NTA 2025 (Active)', 2, 800000, 3000000, 2200000, 0.15, 800000],
        ['NTA 2025 (Active)', 3, 3000000, 12000000, 9000000, 0.18, 3000000],
        ['NTA 2025 (Active)', 4, 12000000, 25000000, 13000000, 0.21, 12000000],
        ['NTA 2025 (Active)', 5, 25000000, 50000000, 25000000, 0.23, 25000000],
        ['NTA 2025 (Active)', 6, 50000000, 'Above', 'Open', 0.25, 50000000],
    ]
    for row in nta_bands:
        ws_tax.append(row)

    ws_tax.append([])
    ws_tax.append(['Historical PITA Bands (Pre-2026)', 'Band', 'From (NGN)', 'To (NGN)', 'Band Width (NGN)', 'Rate %', 'Cumulative Lower (NGN)'])
    pita_bands = [
        ['PITA (Historical)', 1, 0, 300000, 300000, 0.07, 0],
        ['PITA (Historical)', 2, 300000, 600000, 300000, 0.11, 300000],
        ['PITA (Historical)', 3, 600000, 1100000, 500000, 0.15, 600000],
        ['PITA (Historical)', 4, 1100000, 1600000, 500000, 0.19, 1100000],
        ['PITA (Historical)', 5, 1600000, 3200000, 1600000, 0.21, 1600000],
        ['PITA (Historical)', 6, 3200000, 'Above', 'Open', 0.24, 3200000],
    ]
    for row in pita_bands:
        ws_tax.append(row)

    # 2. Update Employee_Master to include essential compliance columns (FR-EMP-01 through FR-EMP-08)
    ws_emp = wb['Employee_Master']
    emp_headers = [
        'EmpID', 'Surname', 'FirstName', 'Department', 'Position', 'EmploymentType', 'PayFrequency', 'HireDate',
        'BasicSalary', 'HousingAllowance', 'TransportAllowance', 'OtherAllowances',
        'HourlyRate', 'HourlyRateOverrideReason', 'Pension%', 'NHF%', 'NHF_Enrolled', 'AnnualRent', 'RentEvidenceRef',
        'Bank', 'BankCode', 'AccountNo', 'State', 'TIN', 'PensionPIN', 'PFA', 'NHFNumber', 'DOB', 'Phone', 'Email', 'EmergencyContact', 'Status'
    ]
    ws_emp.delete_rows(1, ws_emp.max_row)
    ws_emp.append(emp_headers)

    # 3. Update Shift_Setup: Day, Night, Weekend, Holiday
    # Keep Shift_Setup clear and well-formatted
    ws_shift = wb['Shift_Setup']
    ws_shift.delete_rows(1, ws_shift.max_row)
    ws_shift.append(['Shift', 'StdHours', 'OTMultiplier', 'Description'])
    ws_shift.append(['Day', 8, 1.50, 'Standard weekday day shift (overtime > 8h @ 1.5x)'])
    ws_shift.append(['Night', 8, 1.75, 'Standard night shift (overtime > 8h @ 1.75x)'])
    ws_shift.append(['Weekend', 8, 2.00, 'Weekend shift (hours @ 2.0x)'])
    ws_shift.append(['Holiday', 8, 2.50, 'Public holiday shift (hours @ 2.5x)'])

    # 4. Attendance sheet
    ws_att = wb['Attendance']
    ws_att.delete_rows(1, ws_att.max_row)
    ws_att.append(['Date', 'EmpID', 'Shift', 'ClockIn', 'ClockOut', 'HoursWorked', 'OTHours', 'WeekendOT', 'HolidayOT', 'Absent', 'Approved'])

    # 5. Loans sheet
    ws_ln = wb['Loans']
    ws_ln.delete_rows(1, ws_ln.max_row)
    ws_ln.append(['LoanID', 'EmpID', 'Amount', 'StartDate', 'TermMonths', 'MonthlyDeduction', 'Outstanding', 'Status'])

    # 6. Leave_Register sheet
    ws_lv = wb['Leave_Register']
    ws_lv.delete_rows(1, ws_lv.max_row)
    ws_lv.append(['LeaveID', 'EmpID', 'LeaveType', 'StartDate', 'EndDate', 'Days', 'PaidStatus', 'ApprovalStatus'])

    # 7. Bonus_Register sheet
    ws_bon = wb['Bonus_Register']
    ws_bon.delete_rows(1, ws_bon.max_row)
    ws_bon.append(['Period', 'EmpID', 'PerformanceBonus', 'ProductionBonus', 'AttendanceBonus', 'OtherBonus', 'TotalBonuses', 'ApprovalStatus'])

    # 8. Payroll_Input sheet
    ws_inp = wb['Payroll_Input']
    ws_inp.delete_rows(1, ws_inp.max_row)
    ws_inp.append([
        'Period', 'EmpID', 'BasicSalary', 'HousingAllowance', 'TransportAllowance',
        'OtherAllowances', 'TotalAllowances', 'OTPay', 'Bonuses',
        'LoanDeduction', 'OtherDeductions', 'UnpaidLeaveDeduction'
    ])

    # 9. Payroll_Register sheet
    # Comprehensive gross-to-net register with clear separation of statutory bases and progressive tax
    ws_reg = wb['Payroll_Register']
    ws_reg.delete_rows(1, ws_reg.max_row)
    reg_headers = [
        'Period', 'EmpID', 'BasicSalary', 'HousingAllowance', 'TransportAllowance',
        'OtherAllowances', 'Allowances', 'OTPay', 'Bonuses', 'GrossPay',
        'PensionableEmoluments', 'PensionRate', 'PensionEmployee', 'PensionEmployer',
        'NHF_Enrolled', 'NHFRate', 'NHF', 'AnnualRent', 'AnnualRentRelief',
        'AnnualGross', 'AnnualReliefs', 'AnnualChargeableIncome',
        'AnnualPAYE', 'MonthlyPAYE', 'LoanDeduction', 'OtherDeductions', 'NetPay'
    ]
    ws_reg.append(reg_headers)

    # Let's populate rows 2 to 26 in Payroll_Register with dynamic, robust Excel formulas!
    # Let row r be between 2 and 26.
    # Columns in Payroll_Register:
    # A: Period
    # B: EmpID
    # C: BasicSalary
    # D: HousingAllowance
    # E: TransportAllowance
    # F: OtherAllowances
    # G: Allowances = D + E + F -> =SUM(D{r}:F{r})
    # H: OTPay
    # I: Bonuses
    # J: GrossPay = C + G + H + I -> =C{r}+G{r}+H{r}+I{r}
    # K: PensionableEmoluments = C + D + E -> =C{r}+D{r}+E{r}
    # L: PensionRate (default 0.08)
    # M: PensionEmployee = K * L -> =ROUND(K{r}*L{r}, 2)
    # N: PensionEmployer = K * 0.10 -> =ROUND(K{r}*0.10, 2)
    # O: NHF_Enrolled ("Yes"/"No")
    # P: NHFRate (default 0.025)
    # Q: NHF = IF(O{r}="Yes", ROUND(C{r}*P{r}, 2), 0)
    # R: AnnualRent
    # S: AnnualRentRelief = MIN(500000, ROUND(R{r}*0.20, 2))
    # T: AnnualGross = J * 12 -> =J{r}*12
    # U: AnnualReliefs = (M + Q) * 12 + S -> =(M{r}+Q{r})*12+S{r}
    # V: AnnualChargeableIncome = MAX(0, T - U) -> =MAX(0, T{r}-U{r})
    # W: AnnualPAYE -> Progressive NTA 2025 formula:
    #    Band 1: 0 to 800,000 @ 0%
    #    Band 2: 800,000 to 3,000,000 (width 2.2m) @ 15%
    #    Band 3: 3,000,000 to 12,000,000 (width 9m) @ 18%
    #    Band 4: 12,000,000 to 25,000,000 (width 13m) @ 21%
    #    Band 5: 25,000,000 to 50,000,000 (width 25m) @ 23%
    #    Band 6: > 50,000,000 @ 25%
    # X: MonthlyPAYE = ROUND(W{r} / 12, 2)
    # Y: LoanDeduction
    # Z: OtherDeductions
    # AA: NetPay = J - M - Q - X - Y - Z -> =J{r}-M{r}-Q{r}-X{r}-Y{r}-Z{r}

    for r in range(2, 27):
        formula_G = f"=SUM(D{r}:F{r})"
        formula_J = f"=C{r}+G{r}+H{r}+I{r}"
        formula_K = f"=C{r}+D{r}+E{r}"
        formula_M = f"=ROUND(K{r}*L{r}, 2)"
        formula_N = f"=ROUND(K{r}*0.10, 2)"
        formula_Q = f'=IF(O{r}="Yes", ROUND(C{r}*P{r}, 2), 0)'
        formula_S = f"=MIN(500000, ROUND(R{r}*0.20, 2))"
        formula_T = f"=J{r}*12"
        formula_U = f"=(M{r}+Q{r})*12+S{r}"
        formula_V = f"=MAX(0, T{r}-U{r})"
        # Formula for W (Annual PAYE under NTA 2025):
        # We can write this cleanly using nested IFs or cumulative band math:
        # =ROUND(IF(V{r}<=800000, 0,
        #   IF(V{r}<=3000000, (V{r}-800000)*0.15,
        #   IF(V{r}<=12000000, 330000 + (V{r}-3000000)*0.18,
        #   IF(V{r}<=25000000, 1950000 + (V{r}-12000000)*0.21,
        #   IF(V{r}<=50000000, 4680000 + (V{r}-25000000)*0.23,
        #   10430000 + (V{r}-50000000)*0.25))))), 2)
        # Note:
        # Band 2 max = 2,200,000 * 0.15 = 330,000
        # Band 3 max = 9,000,000 * 0.18 = 1,620,000 -> cumulative 1,950,000
        # Band 4 max = 13,000,000 * 0.21 = 2,730,000 -> cumulative 4,680,000
        # Band 5 max = 25,000,000 * 0.23 = 5,750,000 -> cumulative 10,430,000
        formula_W = (
            f'=ROUND(IF(V{r}<=800000, 0, '
            f'IF(V{r}<=3000000, (V{r}-800000)*0.15, '
            f'IF(V{r}<=12000000, 330000+(V{r}-3000000)*0.18, '
            f'IF(V{r}<=25000000, 1950000+(V{r}-12000000)*0.21, '
            f'IF(V{r}<=50000000, 4680000+(V{r}-25000000)*0.23, '
            f'10430000+(V{r}-50000000)*0.25))))), 2)'
        )
        formula_X = f"=ROUND(W{r}/12, 2)"
        formula_AA = f"=J{r}-M{r}-Q{r}-X{r}-Y{r}-Z{r}"

        # Initialize empty or formula row
        row_data = [
            None, None, 0, 0, 0, 0, formula_G, 0, 0, formula_J,
            formula_K, 0.08, formula_M, formula_N, "Yes", 0.025, formula_Q, 0, formula_S,
            formula_T, formula_U, formula_V, formula_W, formula_X, 0, 0, formula_AA
        ]
        ws_reg.append(row_data)

    # 10. Update Payslip_Template
    ws_slp = wb['Payslip_Template']
    ws_slp.delete_rows(1, ws_slp.max_row)
    slp_content = [
        ['FACTORY PAYROLL SYSTEM - EMPLOYEE PAYSLIP', None, None, None],
        ['Period:', '2026-11', 'Pay Date:', '30/11/2026'],
        ['Company:', 'Lagos Manufacturing Factory Ltd', 'Tax Jurisdiction:', 'Federal Republic of Nigeria / Lagos State'],
        [],
        ['EMPLOYEE INFORMATION', None, None, None],
        ['Employee ID:', '=Payroll_Register!B2', 'Position:', 'Production Operator'],
        ['Employee Name:', '=Employee_Master!B2&" "&Employee_Master!C2', 'Department:', 'Production'],
        ['Bank:', '=Employee_Master!P2', 'Account No:', '******1234'],
        [],
        ['EARNINGS (NGN)', 'AMOUNT', 'DEDUCTIONS (NGN)', 'AMOUNT'],
        ['Basic Salary', '=Payroll_Register!C2', 'Employee Pension (8%)', '=Payroll_Register!M2'],
        ['Housing Allowance', '=Payroll_Register!D2', 'NHF (2.5%)', '=Payroll_Register!Q2'],
        ['Transport Allowance', '=Payroll_Register!E2', 'PAYE Tax (NTA 2025)', '=Payroll_Register!X2'],
        ['Other Allowances', '=Payroll_Register!F2', 'Loan Deduction', '=Payroll_Register!Y2'],
        ['Overtime Pay', '=Payroll_Register!H2', 'Other Deductions', '=Payroll_Register!Z2'],
        ['Bonuses', '=Payroll_Register!I2', None, None],
        [],
        ['GROSS PAY', '=Payroll_Register!J2', 'TOTAL DEDUCTIONS', '=SUM(D11:D15)'],
        [],
        ['NET PAY (NGN)', '=Payroll_Register!AA2', None, None],
        [],
        ['LOAN & YEAR-TO-DATE INFORMATION', None, None, None],
        ['Remaining Loan Balance:', '=Loans!G2', 'YTD Gross Pay:', '=Payroll_Register!J2'],
        ['YTD PAYE Tax:', '=Payroll_Register!X2', 'YTD Employee Pension:', '=Payroll_Register!M2'],
        ['Employer Pension (10%):', '=Payroll_Register!N2', 'Status:', 'APPROVED / CONFIRMED']
    ]
    for row in slp_content:
        ws_slp.append(row)

    # 11. Update Bank_Transfer
    ws_bnk = wb['Bank_Transfer']
    ws_bnk.delete_rows(1, ws_bnk.max_row)
    ws_bnk.append(['EmpID', 'EmployeeName', 'Bank', 'AccountNo', 'NetPay', 'PaymentNarration', 'PaymentStatus'])
    # Add formulas referencing Payroll_Register and Employee_Master
    for r in range(2, 27):
        reg_r = r
        ws_bnk.append([
            f'=Payroll_Register!B{reg_r}',
            f'=Employee_Master!B{reg_r}&" "&Employee_Master!C{reg_r}',
            f'=Employee_Master!P{reg_r}',
            f'=Employee_Master!Q{reg_r}',
            f'=Payroll_Register!AA{reg_r}',
            'Salary November 2026',
            'Pending Payment'
        ])
    # Control total row
    ws_bnk.append(['TOTAL', None, None, 'Payable Count: =COUNTA(E2:E26)', '=SUM(E2:E26)', None, None])

    # 12. Update Dashboard
    ws_dsh = wb['Dashboard']
    ws_dsh.delete_rows(1, ws_dsh.max_row)
    dsh_content = [
        ['FACTORY PAYROLL MANAGEMENT DASHBOARD', None, None],
        ['Period:', 'November 2026', 'Currency: NGN (₦)'],
        [],
        ['Metric / KPI', 'Value (NGN / Count)', 'Verification & Reconciliation Formula'],
        ['Total Paid Headcount', '=COUNTA(Payroll_Register!B2:B26)', 'Active employees with pay'],
        ['Total Basic Salary', '=SUM(Payroll_Register!C2:C26)', 'Sum of basic salary'],
        ['Total Allowances', '=SUM(Payroll_Register!G2:G26)', 'Housing, transport and other allowances'],
        ['Total Overtime Pay', '=SUM(Payroll_Register!H2:H26)', 'Shift and premium overtime'],
        ['Total Bonuses', '=SUM(Payroll_Register!I2:I26)', 'Performance, attendance and production bonuses'],
        ['Total Gross Payroll', '=SUM(Payroll_Register!J2:J26)', 'Basic + Allowances + OT + Bonuses'],
        ['Total Employee Pension (8%)', '=SUM(Payroll_Register!M2:M26)', 'Statutory employee pension'],
        ['Total Employer Pension (10%)', '=SUM(Payroll_Register!N2:N26)', 'Statutory employer pension'],
        ['Total NHF (2.5%)', '=SUM(Payroll_Register!Q2:Q26)', 'National Housing Fund'],
        ['Total Annual Rent Relief Applied', '=SUM(Payroll_Register!S2:S26)', 'Rent relief under NTA 2025'],
        ['Total PAYE Tax', '=SUM(Payroll_Register!X2:X26)', 'Progressive PAYE under NTA 2025'],
        ['Total Loan Deductions', '=SUM(Payroll_Register!Y2:Y26)', 'Loan recoveries'],
        ['Total Other Deductions', '=SUM(Payroll_Register!Z2:Z26)', 'Union dues, advances, etc.'],
        ['Total Net Payroll', '=SUM(Payroll_Register!AA2:AA26)', 'Total payment via bank schedule'],
        [],
        ['RECONCILIATION CHECK', 'Status', 'Formula Check'],
        ['Gross - Total Deductions = Net', '=IF(ROUND(B10-B11-B13-B15-B16-B17, 2)=ROUND(B18, 2), "RECONCILED / BALANCED", "OUT OF BALANCE")', 'Checks line-by-line and grand total integrity'],
        ['Bank Schedule = Register Net', '=IF(ROUND(Bank_Transfer!E27, 2)=ROUND(B18, 2), "RECONCILED / BALANCED", "OUT OF BALANCE")', 'Matches bank payment total with register']
    ]
    for row in dsh_content:
        ws_dsh.append(row)

    # 13. Audit_Log Sheet
    ws_aud = wb['Audit_Log']
    ws_aud.delete_rows(1, ws_aud.max_row)
    ws_aud.append(['LogID', 'Timestamp (UTC+1)', 'User', 'Role', 'Action', 'Entity', 'RecordID', 'OldValue', 'NewValue', 'Reason'])
    ws_aud.append([1, '2026-11-01 08:30:00', 'admin', 'Administrator', 'INITIALIZE', 'System', 'ALL', None, 'Version 1.0', 'Initial system configuration'])
    ws_aud.append([2, '2026-11-01 09:00:00', 'payroll_mgr', 'Payroll Manager', 'UPDATE_TAX_BANDS', 'PAYE_Bands', 'NTA_2025', 'PITA 7-24%', 'NTA 2025 0-25%', 'Compliance with Nigeria Tax Act 2025'])

    # 14. Instructions Sheet
    ws_inst = wb['Instructions']
    ws_inst.delete_rows(1, ws_inst.max_row)
    inst_content = [
        ['Comprehensive Factory Payroll Template - Hardened Edition (NTA 2025 Compliant)'],
        ['Overview:'],
        ['This workbook supports the complete factory payroll lifecycle under the Nigeria Tax Act 2025 and Nigerian statutory requirements.'],
        ['Key Features and Calculation Flow:'],
        ['1. Shift_Setup & Attendance: Supports Day (1.5x), Night (1.75x), Weekend (2.0x), and Holiday (2.5x) overtime multipliers.'],
        ['2. Employee_Master: Captures basic, housing, transport, pension%, NHF%, annual rent, bank NUBAN, and status.'],
        ['3. Statutory Deductions:'],
        ['   - Employee Pension: 8% of Pensionable Emoluments (Basic + Housing + Transport).'],
        ['   - Employer Pension: 10% statutory contribution.'],
        ['   - NHF: 2.5% of Basic Salary for enrolled staff.'],
        ['   - PAYE: Progressive progressive tax bands under the Nigeria Tax Act 2025 with first 800,000 tax-free and 20% rent relief (up to 500,000).'],
        ['4. Payslips & Bank Transfer: Fully formula-linked and reconciled to the Payroll Register and Dashboard.'],
        ['5. Auditability & Protection: Audit log tracking changes, formula cells protected, and data validation rules enforced.']
    ]
    for row in inst_content:
        ws_inst.append(row)

    # Add Styling and Column Width Auto-Fitting
    header_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")

    for sheetname in wb.sheetnames:
        ws = wb[sheetname]
        ws.views.sheetView[0].showGridLines = True

        # Style headers on row 1 if appropriate
        if sheetname not in ['Payslip_Template', 'Dashboard', 'Instructions']:
            for cell in ws[1]:
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

        # Auto-adjust column widths
        for col in ws.columns:
            max_len = 0
            col_letter = get_column_letter(col[0].column)
            for cell in col:
                val_str = str(cell.value or '')
                if '\n' in val_str:
                    val_str = max(val_str.split('\n'), key=len)
                if len(val_str) > max_len:
                    max_len = len(val_str)
            ws.column_dimensions[col_letter].width = max(max_len + 3, 12)

    # ========================================================
    # FR-SEC-05: Excel Hardening - Sheet Protection & Data Validations
    # - Formula cells and reference sheets shall be locked/protected
    # - User inputs restricted via data validation
    # ========================================================

    # 1. Data Validations
    # Employee_Master validations
    dv_status = DataValidation(type="list", formula1='"Active,On Leave,Suspended,Terminated"', allow_blank=True)
    ws_emp.add_data_validation(dv_status)
    dv_status.add("AF2:AF100")

    dv_emp_type = DataValidation(type="list", formula1='"Permanent,Contract,Casual"', allow_blank=True)
    ws_emp.add_data_validation(dv_emp_type)
    dv_emp_type.add("F2:F100")

    dv_pay_freq = DataValidation(type="list", formula1='"Monthly,Weekly,Bi-Weekly"', allow_blank=True)
    ws_emp.add_data_validation(dv_pay_freq)
    dv_pay_freq.add("G2:G100")

    dv_nhf_enroll = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True)
    ws_emp.add_data_validation(dv_nhf_enroll)
    dv_nhf_enroll.add("Q2:Q100")

    # Shift_Setup validations on Attendance
    dv_shift = DataValidation(type="list", formula1='"Day,Night,Weekend,Holiday"', allow_blank=True)
    ws_att.add_data_validation(dv_shift)
    dv_shift.add("C2:C1000")

    dv_absent = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True)
    ws_att.add_data_validation(dv_absent)
    dv_absent.add("J2:J1000")

    # Leave_Register validations
    dv_leave_type = DataValidation(type="list", formula1='"Annual,Sick,Maternity,Paternity,Compassionate,Study,Unpaid"', allow_blank=True)
    ws_lv.add_data_validation(dv_leave_type)
    dv_leave_type.add("C2:C500")

    # 2. Formula Locking & Sheet Protection (FR-SEC-05)
    # Unlock input cells while keeping formula cells locked
    unlocked_protection = Protection(locked=False)
    locked_protection = Protection(locked=True)

    # In Employee_Master, data input cells are unlocked
    for row in ws_emp.iter_rows(min_row=2, max_row=100, min_col=1, max_col=len(emp_headers)):
        for cell in row:
            cell.protection = unlocked_protection

    # In Attendance, input columns A to E and J are unlocked
    for row in ws_att.iter_rows(min_row=2, max_row=1000, min_col=1, max_col=11):
        for col_idx, cell in enumerate(row, start=1):
            if col_idx in [1, 2, 3, 4, 5, 10]:  # Date, EmpID, Shift, ClockIn, ClockOut, Absent
                cell.protection = unlocked_protection
            else:
                cell.protection = locked_protection

    # In Payroll_Register, formulas are in G, J, K, M, N, Q, S, T, U, V, W, X, AA
    formula_cols_reg = [7, 10, 11, 13, 14, 17, 19, 20, 21, 22, 23, 24, 27]
    for row in ws_reg.iter_rows(min_row=2, max_row=ws_reg.max_row, min_col=1, max_col=len(reg_headers)):
        for col_idx, cell in enumerate(row, start=1):
            if col_idx in formula_cols_reg:
                cell.protection = locked_protection
            else:
                cell.protection = unlocked_protection

    # Reference sheets: PAYE_Bands, Shift_Setup, Instructions, Dashboard are fully locked
    for sheetname in ['PAYE_Bands', 'Shift_Setup', 'Instructions', 'Dashboard', 'Audit_Log', 'Payroll_Register']:
        wb[sheetname].protection.set_password(WORKBOOK_PASSWORD)
        wb[sheetname].protection.sheet = True
        wb[sheetname].protection.enable()

    # Protect remaining sheets to enforce unlocked cell editing only
    for sheetname in ['Employee_Master', 'Attendance', 'Loans', 'Leave_Register', 'Bonus_Register', 'Payroll_Input', 'Payslip_Template', 'Bank_Transfer']:
        wb[sheetname].protection.set_password(WORKBOOK_PASSWORD)
        wb[sheetname].protection.sheet = True
        wb[sheetname].protection.enable()

    # Save to all requested output filenames
    for out_f in output_filenames:
        wb.save(out_f)
        print(f"Saved hardened workbook to {out_f}")

if __name__ == '__main__':
    targets = [
        'Comprehensive_Factory_Payroll_System (1).xlsx',
        'Comprehensive_Factory_Payroll_System.xlsx'
    ]
    harden_workbook('Comprehensive_Factory_Payroll_System (1).xlsx', targets)
