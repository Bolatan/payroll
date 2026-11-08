# Factory Payroll System: Business & Functional Requirements, User Stories and Acceptance Criteria

**Source artefact:** `Comprehensive_Factory_Payroll_System.xlsx` (14 worksheets)
**Document version:** 1.0 (Draft for review)
**Date:** 7 November 2026
**Jurisdiction:** Federal Republic of Nigeria (Lagos-based factory operations assumed)
**Status:** Draft: requires sign-off from Finance, HR, Operations and Tax Advisor

---

## 1. Document Control and Purpose

### 1.1 Purpose
This document converts the existing Excel-based "Comprehensive Factory Payroll Template" into a formal set of business requirements (BRD), functional requirements (FRD), user stories and testable acceptance criteria. It is intended to guide either (a) hardening the workbook into a controlled, formula-driven payroll tool, or (b) specifying a purpose-built payroll application that replaces it.

### 1.2 Audience
Finance/Payroll Manager, HR Manager, Factory/Production Managers, Internal Audit, IT/Application Developers, Business Analysts, QA Testers, external Tax Advisor.

### 1.3 How to read this document
- **BR-xx** = Business Requirement. **BRL-xx** = Business Rule. **FR-xx** = Functional Requirement. **NFR-xx** = Non-Functional Requirement. **US-xx** = User Story. **AC** = Acceptance Criteria (Given / When / Then).
- Priority uses MoSCoW: Must, Should, Could, Won't (this release).
- Items marked `[ASSUMPTION]` or `[OPEN]` need stakeholder confirmation (see Section 11).

---

## 2. Executive Summary and Workbook Assessment

### 2.1 What the workbook is
The workbook is a payroll template covering the full payroll cycle for a shift-based factory: employee master data, attendance and shifts, overtime, loans, leave, bonuses, payroll inputs, a payroll register, PAYE bands, a payslip layout, a bank transfer schedule, an audit log and a dashboard.

### 2.2 Worksheet inventory
| # | Worksheet | Columns / content found | State in file |
|---|---|---|---|
| 1 | `Employee_Master` | EmpID, Surname, FirstName, Department, Position, HireDate, BasicSalary, HourlyRate, Pension%, PAYE%, NHF%, Bank, AccountNo, Status | Headers only |
| 2 | `Attendance` | Date, EmpID, Shift, ClockIn, ClockOut, HoursWorked, OTHours, WeekendOT, HolidayOT, Absent | Headers only |
| 3 | `Shift_Setup` | Shift, StdHours, OTMultiplier: Day 8h/1.5, Night 8h/1.75, Weekend 8h/2.0, Holiday 8h/2.5 | Populated |
| 4 | `Loans` | LoanID, EmpID, Amount, StartDate, TermMonths, MonthlyDeduction, Outstanding | Headers only |
| 5 | `Leave_Register` | EmpID, LeaveType, StartDate, EndDate, Days | Headers only |
| 6 | `Bonus_Register` | Period, EmpID, PerformanceBonus, ProductionBonus, AttendanceBonus, OtherBonus | Headers only |
| 7 | `Payroll_Input` | Period, EmpID, BasicSalary, OTPay, Allowances, Bonuses, LoanDeduction, OtherDeductions | Headers only |
| 8 | `Payroll_Register` | Period, EmpID, BasicSalary, OTPay, Allowances, Bonuses, GrossPay, Pension, NHF, TaxablePay, PAYE, LoanDeduction, OtherDeductions, NetPay | Headers + one row of formulas |
| 9 | `PAYE_Bands` | From/To/Rate%: 0–300,000 @7%; 300,001–600,000 @11%; 600,001–1,100,000 @15%; 1,100,001–1,600,000 @19%; 1,600,001–3,200,000 @21%; above 3,200,000 @24% | Populated |
| 10 | `Payslip_Template` | Layout labels only (ID, Name, Dept, Basic, OT, Allowances, Bonuses, Gross, Pension, NHF, PAYE, Loan, Net) | Labels only |
| 11 | `Bank_Transfer` | EmpID, EmployeeName, Bank, AccountNo, NetPay | Headers only |
| 12 | `Audit_Log` | Date, User, Action, Details | Headers only |
| 13 | `Dashboard` | Total Employees, Total Gross, Total PAYE, Total Pension, Total Net | Labels only (no values) |
| 14 | `Instructions` | One-line description | Text only |

### 2.3 Calculation logic found in Payroll_Register (row 2)
| Field | Formula in workbook |
|---|---|
| GrossPay | `=SUM(C2:F2)` (Basic + OT + Allowances + Bonuses) |
| Pension | `=GrossPay * 0.08` |
| NHF | `=GrossPay * 0.025` |
| TaxablePay | `=Gross - Pension - NHF` |
| PAYE | `=TaxablePay * 0.10` |
| NetPay | `=Gross - Pension - NHF - PAYE - Loan - OtherDeductions` |

### 2.4 Key gaps and defects the new requirements must resolve
| ID | Finding | Impact | Addressed by |
|---|---|---|---|
| G-01 | PAYE is a flat 10% hardcoded; the PAYE_Bands sheet and the per-employee PAYE% column are never used. | Incorrect tax for almost every employee. | FR-PAY-05, BRL-05 |
| G-02 | PAYE_Bands hold the pre-2026 (PITA) bands (7%–24%). The Nigeria Tax Act 2025 took effect on 1 January 2026, repealed PITA and introduced new bands, a ₦800,000 tax-free first band and rent relief in place of CRA. | Non-compliance exposure from January 2026 payroll onward. | FR-TAX-01 to 06 |
| G-03 | Pension (8%) and NHF (2.5%) are hardcoded and applied to gross pay. Per-employee Pension%/NHF% in Employee_Master are ignored. Pension is normally on pensionable emoluments (basic + housing + transport) and NHF on basic salary. | Over/under-deduction; breach of statutory base. | FR-PAY-03, FR-PAY-04 |
| G-04 | Overtime pay is a manual input; there is no formula linking Attendance, HourlyRate and Shift_Setup multipliers. | Manual error, disputes, no audit trail. | FR-ATT-05 to 09 |
| G-05 | Loan deduction is manual; Outstanding balance is not reduced automatically. | Loans over-/under-recovered. | FR-LN-03 to 06 |
| G-06 | Leave_Register has no link to payroll (unpaid leave, leave allowance, absent days). | Absent staff paid in full. | FR-LV-04 to 06 |
| G-07 | Allowances are one lump figure; no component breakdown (housing, transport, etc.). Taxability and pensionability cannot be determined. | Wrong pension and tax bases. | FR-EMP-06 |
| G-08 | No employer-side contributions (pension 10%, NSITF, ITF) or remittance schedules. | Incomplete statutory compliance and cost reporting. | FR-STAT-01 to 05 |
| G-09 | Payroll_Input duplicates data held in Payroll_Register, Attendance and Bonus_Register with no defined data flow. | Reconciliation errors. | Section 6 |
| G-10 | No payroll period locking, approval workflow, access control or protection of formulas; Audit_Log is a free-form sheet anyone can edit. | Fraud and tampering risk. | FR-SEC-01 to 06, FR-AUD-01 to 05 |
| G-11 | Payslip_Template has no period, pay date, YTD figures, other deductions, or employer details; Net Pay layout omits Other Deductions. | Payslip does not reconcile to register. | FR-SLP-01 to 06 |
| G-12 | PAYE band boundaries use 300,001 etc. (integer gaps) and an arbitrary upper limit of 999,999,999. | Fractional naira fall between bands; fragile. | FR-TAX-02 |
| G-13 | No validation (duplicate EmpID, bank account format, date logic, negative numbers). | Bad data enters payroll. | NFR-DQ-01 to 05 |

---

## 3. Business Requirements (BRD)

### 3.1 Business background and problem statement
The factory pays a mix of salaried and hourly production staff across day, night, weekend and holiday shifts. Pay depends on attendance, overtime at tiered multipliers, bonuses, loan recoveries and statutory deductions. The current spreadsheet model is largely manual, uses incorrect and outdated tax logic, and lacks controls, so payroll is slow, error-prone and hard to audit.

### 3.2 Business objectives
| ID | Objective | Measure of success |
|---|---|---|
| BO-1 | Pay every employee accurately and on time | ≥ 99.5% of payslips error-free; payroll closed ≤ 3 working days after period end |
| BO-2 | Comply with Nigerian statutory requirements (PAYE, pension, NHF, and other applicable levies) | Zero penalties; remittances before statutory deadlines |
| BO-3 | Automate overtime, loan, leave and bonus processing | Manual payroll inputs reduced by ≥ 80% |
| BO-4 | Establish strong internal controls and a full audit trail | 100% of changes to pay-affecting data logged with who/when/before/after |
| BO-5 | Provide management visibility of payroll cost | Dashboard available at period close with department-level breakdown |
| BO-6 | Reduce payment errors and fraud | Bank file generated from approved payroll only; zero unauthorised changes post-approval |

### 3.2.1 Business requirements
| ID | Business Requirement | Priority | Objective |
|---|---|---|---|
| BR-01 | The business shall maintain a single authoritative record of every employee, including pay, statutory and bank details. | M | BO-1 |
| BR-02 | The business shall capture time and attendance by shift and derive hours worked, overtime and absences from it. | M | BO-1, BO-3 |
| BR-03 | The business shall pay overtime at configurable multipliers by shift type (Day, Night, Weekend, Holiday). | M | BO-1 |
| BR-04 | The business shall compute pension, NHF and PAYE according to prevailing Nigerian law, with rates and bands maintained as effective-dated reference data (not hardcoded). | M | BO-2 |
| BR-05 | The business shall administer staff loans and recover instalments automatically through payroll until fully repaid. | M | BO-3 |
| BR-06 | The business shall track leave and reflect paid/unpaid leave correctly in pay. | S | BO-1 |
| BR-07 | The business shall support performance, production, attendance and other bonuses, with defined taxability. | M | BO-1 |
| BR-08 | The business shall produce a payroll register per period with reconciled totals. | M | BO-1, BO-5 |
| BR-09 | The business shall issue an individual payslip to every employee each period. | M | BO-1 |
| BR-10 | The business shall generate a bank payment schedule/file from approved payroll. | M | BO-1, BO-6 |
| BR-11 | The business shall maintain an immutable audit log of all significant actions. | M | BO-4 |
| BR-12 | The business shall provide a management dashboard and statutory/management reports. | S | BO-5 |
| BR-13 | The business shall enforce role-based access, segregation of duties and a review-and-approval workflow before payment. | M | BO-4, BO-6 |
| BR-14 | The business shall be able to correct prior-period errors via controlled adjustments without altering closed periods. | S | BO-1, BO-4 |

### 3.3 Scope
- **In scope:** employee master data; shift configuration; attendance and overtime; loans; leave; bonuses; payroll input consolidation; gross-to-net calculation; statutory deductions (employee pension, NHF, PAYE) and employer contributions; payroll register; payslips; bank transfer schedule; audit log; dashboard and reports; period open/lock/approval; access control.
- **Out of scope (this release):** recruitment and performance appraisal; full HR self-service portal; general-ledger posting (journal export only); automated direct payment API integration with banks; multi-currency; multi-country payroll; time-clock hardware integration (CSV/Excel import supported instead). `[ASSUMPTION]`

### 3.4 Stakeholders
| Stakeholder | Role / interest |
|---|---|
| Payroll Officer | Prepares inputs, runs calculations, produces payslips and bank file |
| Finance/Payroll Manager | Reviews and approves payroll, signs off remittances |
| HR Manager / HR Officer | Owns employee master data, leave, contracts |
| Production/Shift Supervisors | Submit and approve attendance and overtime |
| Managing Director / CFO | Receives dashboards; final approver for high-value or exception payroll |
| Employees | Receive accurate and timely pay; view payslips |
| Internal Audit | Reviews controls and the audit log |
| External Tax Advisor / Statutory bodies (NRS, state IRS, PFAs, FMBN, NSITF, ITF) | Rates, bands, remittance requirements |
| IT Support | Hosting, backups, access administration |

### 3.5 Business rules
- **BRL-01:** Each employee has a unique EmpID that is never reused.
- **BRL-02:** Only employees with Status = Active (or on paid leave) on any day within the period are paid; Terminated/Suspended employees are excluded unless an approved final-pay or arrears entry exists.
- **BRL-03:** Pay period is one calendar month unless configured otherwise `[OPEN: confirm monthly vs weekly/fortnightly for hourly staff]`.
- **BRL-04:** Overtime pay = OT hours × employee HourlyRate × multiplier for the applicable shift type (defaults: Day 1.5, Night 1.75, Weekend 2.0, Holiday 2.5). Standard hours per shift default to 8.
- **BRL-05:** PAYE is computed progressively on chargeable income using the effective-dated tax bands, after allowable reliefs and deductions. Flat percentages are not permitted.
- **BRL-06:** Employee pension = Pension% (default 8%) × pensionable emoluments; employer pension = 10% minimum of the same base (statutory minimum).
- **BRL-07:** NHF = NHF% (default 2.5%) × basic salary, for employees enrolled in NHF.
- **BRL-08:** A loan instalment is deducted monthly until Outstanding = 0; the deduction in any month never exceeds the remaining balance.
- **BRL-09:** Total deductions may not make Net Pay negative; any shortfall is carried forward as a recoverable balance or flagged for manager decision `[OPEN: policy on max deduction % of net]`.
- **BRL-10:** Once a period is Approved/Locked, no pay-affecting data for that period can be changed; corrections are posted as adjustments in a later open period.
- **BRL-11:** The user who prepares payroll cannot be the user who approves it.
- **BRL-12:** Bank details must be validated (valid bank, 10-digit NUBAN account number) before an employee can be included in the bank file.
- **BRL-13:** Absence without approved leave reduces pay proportionally (basic ÷ working days × absent days) `[OPEN: confirm policy for salaried vs hourly staff]`.
- **BRL-14:** Bonuses are taxable and are included in gross unless flagged as exempt by the Tax Advisor.
- **BRL-15:** All monetary amounts are in Nigerian Naira (₦), rounded to 2 decimal places using a single documented rounding rule applied at line level.

### 3.6 Assumptions and constraints
- `[ASSUMPTION]` Single legal entity, single payroll currency (NGN), single tax jurisdiction for remittance, with state of residence captured per employee for PAYE remittance.
- `[ASSUMPTION]` The Nigeria Tax Act 2025 (effective 1 January 2026) governs PAYE for all periods from January 2026. Bands and rates are held as reference data and must be confirmed by the Tax Advisor before go-live.
- `[ASSUMPTION]` Time and attendance data arrive by manual entry or file import; no biometric integration this release.
- Constraint: If delivered in Excel, formulas must be sheet-protected and the workbook stored on access-controlled storage. Excel cannot enforce true segregation of duties or an immutable audit log; a database-backed application is recommended for those requirements.

### 3.7 Key risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tax rules change or are misinterpreted | M | H | Effective-dated reference data; Tax Advisor sign-off; regression test pack |
| Incorrect attendance/overtime data inflates pay | H | H | Supervisor approval, anomaly flags, caps |
| Unauthorised edits of pay data | M | H | RBAC, locking, audit log |
| Bank file errors cause misdirected payments | L | H | Validation, dual approval, reconciliation |
| User adoption resistance | M | M | Training, parallel run for two cycles |

---

## 4. Functional Requirements (FRD)

### 4.1 Employee Master (maps to Employee_Master)
| ID | Requirement | Pri |
|---|---|---|
| FR-EMP-01 | The system shall create, view, edit and deactivate employee records with: EmpID, Surname, FirstName, Department, Position, HireDate, BasicSalary, HourlyRate, Pension%, NHF%, Bank, AccountNo, Status. | M |
| FR-EMP-02 | EmpID shall be unique and system-generated (or validated unique if entered). | M |
| FR-EMP-03 | Status shall be a controlled list: Active, On Leave, Suspended, Terminated. Terminated records are retained, never deleted. | M |
| FR-EMP-04 | HourlyRate shall be derived as BasicSalary ÷ standard monthly hours for hourly-computed staff, with manual override requiring a reason. `[OPEN: confirm formula]` | S |
| FR-EMP-05 | Pension% and NHF% shall default from the statutory reference data, be editable only by HR Manager, and each change shall be logged. The per-employee PAYE% field shall be removed or repurposed (PAYE is band-computed; see FR-TAX). | M |
| FR-EMP-06 | The system shall hold pay components per employee (Basic, Housing, Transport, Utility/Other allowances), each flagged Taxable, Pensionable and Recurring. | M |
| FR-EMP-07 | The system shall capture additional fields needed for compliance: employment type (Permanent/Contract/Casual), pay frequency, state of residence, Tax ID (TIN), pension PIN and PFA, NHF number, annual rent paid and rent evidence reference (for rent relief), date of birth, phone, email, emergency contact. | M |
| FR-EMP-08 | Bank name shall be chosen from a maintained bank list with CBN bank codes; AccountNo shall be validated as 10 digits (NUBAN) and unique per employee. | M |
| FR-EMP-09 | The system shall maintain salary history (effective-dated) so back-dated changes and arrears can be computed. | S |
| FR-EMP-10 | The system shall support bulk import/export of employee data (CSV/XLSX) with row-level validation reporting. | S |
| FR-EMP-11 | New hires and leavers part-way through a period shall be pro-rated by calendar days or working days, per configuration. | M |

### 4.2 Shift Setup (maps to Shift_Setup)
| ID | Requirement | Pri |
|---|---|---|
| FR-SHF-01 | The system shall maintain shift types (Day, Night, Weekend, Holiday and user-defined) each with StdHours and OTMultiplier. Defaults: 8h with 1.5, 1.75, 2.0 and 2.5 respectively. | M |
| FR-SHF-02 | Each shift shall have configurable start and end times (to support night shifts crossing midnight), break duration, and effective-from date. | M |
| FR-SHF-03 | Changes to multipliers or standard hours shall apply prospectively by effective date and be logged. | M |
| FR-SHF-04 | The system shall maintain a public-holiday calendar (date, name) used to classify Holiday shifts. | M |
| FR-SHF-05 | Shift multipliers shall be validated as ≥ 1.0 and standard hours as between 1 and 24. | M |

### 4.3 Attendance, Hours and Overtime (maps to Attendance)
| ID | Requirement | Pri |
|---|---|---|
| FR-ATT-01 | The system shall record one attendance entry per employee per date per shift: Date, EmpID, Shift, ClockIn, ClockOut. | M |
| FR-ATT-02 | Attendance shall be enterable manually, edited in bulk, or imported from CSV/XLSX time-clock exports with row-level error reporting. | M |
| FR-ATT-03 | The system shall reject duplicate/overlapping entries for the same employee and time range. | M |
| FR-ATT-04 | HoursWorked shall be calculated as (ClockOut − ClockIn − unpaid break), correctly handling night shifts that cross midnight. | M |
| FR-ATT-05 | OTHours shall be calculated as HoursWorked − StdHours when positive, for weekday Day/Night shifts. | M |
| FR-ATT-06 | For shifts worked on a weekend or public holiday, all (or the configured share of) hours shall be classified WeekendOT or HolidayOT and priced at the Weekend/Holiday multiplier. `[OPEN: confirm whether ALL weekend/holiday hours or only hours beyond StdHours are overtime]` | M |
| FR-ATT-07 | Where a day qualifies for more than one multiplier (e.g., night shift on a public holiday), the system shall apply the highest applicable multiplier, not compound them, unless configured otherwise. `[OPEN]` | M |
| FR-ATT-08 | Overtime shall require approval by the employee's supervisor before it flows to payroll; unapproved OT is excluded and listed on an exceptions report. | M |
| FR-ATT-09 | The system shall support a configurable maximum OT hours per employee per period/day and warn when exceeded. | S |
| FR-ATT-10 | Absent shall be set automatically for scheduled working days with no attendance and no approved leave; supervisors may override with a reason. | M |
| FR-ATT-11 | Late arrival and early departure thresholds shall be configurable and reported (may feed attendance bonus eligibility). | S |
| FR-ATT-12 | A period attendance summary per employee shall be produced: days present, absent, leave, OT hours by category, total hours. | M |
| FR-ATT-13 | Attendance for a locked period shall be read-only. | M |

### 4.4 Loans and Deductions (maps to Loans)
| ID | Requirement | Pri |
|---|---|---|
| FR-LN-01 | The system shall record loans: LoanID, EmpID, Amount, StartDate, TermMonths, and calculate MonthlyDeduction (Amount ÷ TermMonths, plus interest if configured). | M |
| FR-LN-02 | Loans shall require approval by an authorised approver before activation; the approver cannot be the requestor. | M |
| FR-LN-03 | Each payroll run shall automatically pull the instalment for every active loan whose StartDate ≤ period end and Outstanding > 0. | M |
| FR-LN-04 | On approval of payroll, Outstanding shall reduce by the amount deducted and a repayment-ledger line shall be written (LoanID, period, amount deducted, balance after). | M |
| FR-LN-05 | The final instalment shall equal the remaining balance (no over-recovery). | M |
| FR-LN-06 | The system shall support loan top-up, early settlement, restructuring (term change), and instalment holiday, each logged and approved. | S |
| FR-LN-07 | On termination, any outstanding loan balance shall be flagged for recovery from final pay. | S |
| FR-LN-08 | Total monthly deductions per employee shall be checked against the maximum-deduction policy (see BRL-09) and exceptions flagged. | M |
| FR-LN-09 | Other recurring/one-off deductions (e.g., cooperative, union dues, damages, salary advance) shall be recorded in a deductions register with type, amount, start/end period and approval. | M |

### 4.5 Leave (maps to Leave_Register)
| ID | Requirement | Pri |
|---|---|---|
| FR-LV-01 | The system shall record leave: EmpID, LeaveType, StartDate, EndDate, Days (system-calculated excluding weekends/holidays per configuration). | M |
| FR-LV-02 | LeaveType shall be a controlled list with pay treatment: Annual (paid), Sick (paid/partially paid), Maternity (paid), Paternity (paid), Compassionate (paid), Study (policy-based), Unpaid. | M |
| FR-LV-03 | Leave shall require approval before it affects attendance/payroll. | M |
| FR-LV-04 | Approved leave days shall be marked on the attendance calendar and not counted as Absent. | M |
| FR-LV-05 | Unpaid leave days shall reduce pay per BRL-13. | M |
| FR-LV-06 | The system shall maintain leave balances per employee per leave year, reject requests exceeding balance (unless overridden), and optionally compute leave allowance payments. | S |
| FR-LV-07 | The system shall reject overlapping leave records for the same employee. | M |

### 4.6 Bonuses and Allowances (maps to Bonus_Register)
| ID | Requirement | Pri |
|---|---|---|
| FR-BON-01 | The system shall record bonuses per Period and EmpID with PerformanceBonus, ProductionBonus, AttendanceBonus and OtherBonus (with description for Other). | M |
| FR-BON-02 | Bonus entries shall require approval before inclusion in payroll. | M |
| FR-BON-03 | AttendanceBonus shall be auto-suggested from attendance (e.g., zero absences and lateness in period) using configurable rules; ProductionBonus may be imported from production output data. | S |
| FR-BON-04 | Total Bonuses = sum of the four components, flowing to Payroll_Input and the register as one line with component detail retained for the payslip. | M |
| FR-BON-05 | Each bonus type shall carry Taxable and Pensionable flags (default: Taxable = Yes, Pensionable = No). | M |
| FR-BON-06 | One-off and recurring allowances (shift allowance, hazard, meal) shall be managed with the same approval and flag rules. | S |

### 4.7 Payroll Period and Inputs (maps to Payroll_Input)
| ID | Requirement | Pri |
|---|---|---|
| FR-INP-01 | The system shall manage payroll periods with states: Open → Inputs Frozen → Calculated → Under Review → Approved → Paid/Locked. | M |
| FR-INP-02 | On "Prepare Inputs", the system shall automatically assemble Payroll_Input per active employee: BasicSalary (pro-rated, after unpaid leave/absence), OTPay (from approved attendance), Allowances (from components), Bonuses (approved), LoanDeduction (due instalments), OtherDeductions (deductions register). Users shall not retype these values. | M |
| FR-INP-03 | Users with permission may add manual adjustments (earnings or deductions) with a mandatory reason; each is logged. | M |
| FR-INP-04 | Pre-calculation validation shall list exceptions: missing bank details, zero/negative salary, missing pension/NHF/TIN data, unapproved OT/bonus/leave, employees with no attendance, duplicate EmpIDs. Payroll cannot move to Approved with unresolved blocking exceptions. | M |
| FR-INP-05 | The system shall allow recalculation any number of times until the period is Approved. | M |
| FR-INP-06 | The system shall support arrears and back-pay for prior periods through adjustment lines. | S |

### 4.8 Gross-to-Net Calculation (maps to Payroll_Register)
| ID | Requirement | Pri |
|---|---|---|
| FR-PAY-01 | The system shall calculate, per employee per period: Basic (pro-rated), OTPay, Allowances, Bonuses, GrossPay = sum of all earnings. | M |
| FR-PAY-02 | The system shall derive and store the following bases separately: Pensionable Emoluments, NHF base (basic salary), Taxable Gross. | M |
| FR-PAY-03 | Pension (employee) = Pension% × pensionable emoluments (default 8%). Replaces the hardcoded Gross × 0.08. | M |
| FR-PAY-04 | NHF = NHF% × basic salary (default 2.5%) for NHF-enrolled employees. Replaces the hardcoded Gross × 0.025. | M |
| FR-PAY-05 | PAYE shall be computed using the tax engine in Section 4.9, not a flat percentage. | M |
| FR-PAY-06 | NetPay = GrossPay − Pension − NHF − PAYE − LoanDeduction − OtherDeductions (− any other statutory deductions enabled). | M |
| FR-PAY-07 | The register shall retain full computation detail per employee (inputs, bases, band-by-band tax) so any figure can be explained and reproduced. | M |
| FR-PAY-08 | Net Pay below zero shall be blocked and flagged per BRL-09. | M |
| FR-PAY-09 | Register totals shall reconcile: sum of employee Net Pay = bank file total; Gross − all deductions = Net at both employee and total levels. Any imbalance blocks approval. | M |
| FR-PAY-10 | Variance analysis shall compare each employee's Gross and Net against the previous period and flag changes above a configurable threshold (default 10%). | S |
| FR-PAY-11 | Payroll shall be runnable for all employees or a filtered subset (department, employee type) and re-runnable until approval. | S |
| FR-PAY-12 | Year-to-date totals (gross, taxable pay, PAYE, pension, NHF) shall be maintained per employee for the calendar year. | M |

### 4.9 Tax Engine and Statutory Reference Data (maps to PAYE_Bands)
| ID | Requirement | Pri |
|---|---|---|
| FR-TAX-01 | PAYE bands, rates, relief rules and statutory percentages shall be stored as effective-dated reference data maintained by an authorised user (Payroll Manager or Tax Admin), never hardcoded in formulas. | M |
| FR-TAX-02 | The band table shall use progressive, contiguous bands defined by cumulative lower bound and rate, with an open-ended top band, so no amount can fall between bands. | M |
| FR-TAX-03 | Load the Nigeria Tax Act 2025 bands as the active table from 1 January 2026 and retain the existing (PITA) bands as historical data for periods before that date. Bands to be confirmed by the Tax Advisor; as understood at drafting: first ₦800,000 @ 0%; next ₦2.2m @ 15%; next ₦9m @ 18%; next ₦13m @ 21%; next ₦25m @ 23%; above ₦50m @ 25%. | M |
| FR-TAX-04 | The system shall compute annualised chargeable income = annual gross taxable emoluments − allowable deductions (employee pension, NHF, NHIS and other approved reliefs) − rent relief, apply progressive bands, and divide by 12 (or the period count) for the period's PAYE. `[OPEN: confirm annualisation vs cumulative-YTD method]` | M |
| FR-TAX-05 | Rent relief shall equal 20% of annual rent paid, capped at ₦500,000, applied only where rent and supporting evidence are recorded on the employee record. The old Consolidated Relief Allowance shall not be applied for periods from 1 January 2026. | M |
| FR-TAX-06 | Employees whose annual income falls within the tax-free band or at/below the configured exemption threshold (e.g., minimum wage rule) shall compute PAYE of zero; the rule shall be configurable and shown in the calculation detail. | M |
| FR-TAX-07 | The tax calculation shall be selected by the period end date so historical periods recalculate under the rules in force at that time. | M |
| FR-TAX-08 | The system shall provide a PAYE test calculator (enter gross and reliefs, see band-by-band result) for validation and training. | S |
| FR-TAX-09 | A regression test pack of reference employees with expected PAYE shall be maintained and re-run whenever reference data changes. | M |

#### Illustrative Calculation (from Section 4.9)
Monthly: Basic ₦150,000, Housing ₦60,000, Transport ₦40,000 (all pensionable), gross ₦250,000 (₦3,000,000 a year); annual rent ₦600,000.
| Step | Annual (₦) | Monthly (₦) |
|---|---|---|
| Gross | 3,000,000.00 | 250,000.00 |
| Employee pension (8% of basic+housing+transport) | 240,000.00 | 20,000.00 |
| NHF (2.5% of basic) | 45,000.00 | 3,750.00 |
| Rent relief (20% × 600,000) | 120,000.00 | n/a |
| Chargeable income (3,000,000 − 240,000 − 45,000 − 120,000) | 2,595,000.00 | n/a |
| Tax: first 800,000 @ 0% | 0.00 | n/a |
| Tax: remaining 1,795,000 @ 15% | 269,250.00 | n/a |
| PAYE | 269,250.00 | 22,437.50 |
| Net pay (250,000 − 20,000 − 3,750 − 22,437.50, before loans/other) | n/a | 203,812.50 |

### 4.10 Employer Contributions and Statutory Remittances
| ID | Requirement | Pri |
|---|---|---|
| FR-STAT-01 | The system shall compute employer pension contribution (minimum 10% of pensionable emoluments) and show it in employer cost reports. | M |
| FR-STAT-02 | The system shall support other employer levies as configurable items with rate, base and effective date (e.g., NSITF, ITF, group life, NHIS/HMO). Applicability to be confirmed by Tax Advisor. | S |
| FR-STAT-03 | The system shall produce remittance schedules per period: PAYE by state of residence/tax authority, pension by PFA (employee + employer), NHF, NSITF/ITF where applicable, each with employee-level detail. | M |
| FR-STAT-04 | Remittance due dates shall be configurable, tracked, and surfaced as reminders; remittance status (Pending, Paid, Reference no.) shall be recorded. | S |
| FR-STAT-05 | Annual PAYE/tax returns data and employee annual tax summaries shall be exportable for the calendar year. | S |

### 4.11 Payroll Register Output (maps to Payroll_Register)
| ID | Requirement | Pri |
|---|---|---|
| FR-REG-01 | The register shall list, per period and employee: Period, EmpID, Name, Department, Basic, OTPay, Allowances, Bonuses, GrossPay, Pension, NHF, TaxablePay (chargeable income basis), PAYE, LoanDeduction, OtherDeductions, NetPay. | M |
| FR-REG-02 | The register shall show subtotals by department and a grand total, and be filterable, sortable and exportable (XLSX, PDF, CSV). | M |
| FR-REG-03 | The register shall display period status and be watermarked "DRAFT" until approved. | S |
| FR-REG-04 | Approved registers shall be immutable; a version stamp and approver/time shall be recorded. | M |

### 4.12 Payslips (maps to Payslip_Template)
| ID | Requirement | Pri |
|---|---|---|
| FR-SLP-01 | A payslip shall be generated per employee per period containing: company name/logo, Period, Pay date, Employee ID, Name, Department, Position, Bank/Account (masked), Basic, Overtime (hours and amount), Allowances (itemised), Bonuses (itemised), Gross Pay, Pension, NHF, PAYE, Loan Deduction, Other Deductions, Total Deductions, Net Pay. | M |
| FR-SLP-02 | The payslip shall show remaining loan balance and year-to-date gross, PAYE and pension. | S |
| FR-SLP-03 | Payslips shall be generated only for Approved periods and be reproducible identically at any later date. | M |
| FR-SLP-04 | Payslips shall be producible individually or as a batch PDF, and distributable by email or portal/print, with delivery status logged. | M |
| FR-SLP-05 | Payslip figures shall reconcile exactly to the payroll register. | M |
| FR-SLP-06 | Payslips shall protect personal data (password-protected PDF or authenticated access). | S |

### 4.13 Bank Transfer Schedule (maps to Bank_Transfer)
| ID | Requirement | Pri |
|---|---|---|
| FR-BNK-01 | The system shall generate the bank schedule from Approved payroll: EmpID, EmployeeName, Bank, AccountNo, NetPay, with payment narration (e.g., "Salary Oct 2026") and a control total. | M |
| FR-BNK-02 | The schedule shall exclude employees with Net Pay ≤ 0 or invalid bank details, listing them on an exceptions report. | M |
| FR-BNK-03 | The schedule shall be exportable in the bank's bulk-payment upload format (configurable template) as well as XLSX/CSV. | S |
| FR-BNK-04 | Control total and count shall equal the register's Net Pay total and payable headcount. | M |
| FR-BNK-05 | Generation of the bank file shall require the Approved status and be logged; re-generation shall create a versioned file. | M |
| FR-BNK-06 | The system shall support recording payment confirmation/reconciliation and flagging failed payments for re-payment. | S |

### 4.14 Audit Log (maps to Audit_Log)
| ID | Requirement | Pri |
|---|---|---|
| FR-AUD-01 | The system shall automatically record, without user action, Date-time, User, Action, and Details (entity, record ID, old value, new value, reason) for every create/update/delete/approve/reject/lock/export/login event affecting payroll data. | M |
| FR-AUD-02 | Audit entries shall be append-only and not editable or deletable by any user including administrators. | M |
| FR-AUD-03 | The log shall be searchable and filterable by date range, user, action and employee, and exportable. | M |
| FR-AUD-04 | Access to view sensitive audit data shall be restricted to Auditor and Admin roles. | M |
| FR-AUD-05 | Audit records shall be retained for at least six years `[OPEN: confirm retention policy]`. | S |

### 4.15 Dashboard and Reports (maps to Dashboard)
| ID | Requirement | Pri |
|---|---|---|
| FR-DSH-01 | The dashboard shall show, for the selected period: Total Employees (paid headcount), Total Gross Payroll, Total PAYE, Total Pension (employee and employer), Total Net Payroll. | M |
| FR-DSH-02 | The dashboard shall also show: total NHF, total loan recoveries, total overtime cost and hours, total bonuses, employer cost, and headcount by department. | S |
| FR-DSH-03 | The dashboard shall provide period-over-period trend charts for gross, net, overtime and PAYE, and a department cost breakdown. | S |
| FR-DSH-04 | Dashboard figures shall be formula/query-driven from the register and reconcile to it exactly. | M |
| FR-DSH-05 | Standard reports: payroll register, payslips, PAYE remittance, pension remittance, NHF remittance, bank schedule, overtime report, loan ledger, leave report, bonus report, variance report, exceptions report, audit report, employer cost report. | M |
| FR-DSH-06 | Reports shall export to PDF and XLSX/CSV. | M |

### 4.16 Security, Roles and Access (cross-cutting)
| ID | Requirement | Pri |
|---|---|---|
| FR-SEC-01 | The system shall authenticate users individually (no shared accounts) with strong passwords and, where available, MFA. | M |
| FR-SEC-02 | Role-based access control with at least: Admin, Payroll Officer (prepare), Payroll Manager/Finance Approver (review/approve), HR Officer/Manager (master data, leave), Supervisor (attendance and OT approval for own team), Auditor (read-only incl. audit log), Employee (own payslip only, if self-service enabled). | M |
| FR-SEC-03 | Segregation of duties: the preparer cannot approve; the creator of a loan or bonus cannot approve it; HR cannot approve payroll. | M |
| FR-SEC-04 | Salary, bank and tax data shall be visible only to authorised roles; sensitive fields masked elsewhere. | M |
| FR-SEC-05 | If delivered in Excel: all formula cells and reference sheets shall be locked/protected, inputs restricted via data validation, and the file kept on access-controlled storage with version history. | M |
| FR-SEC-06 | Personal data shall be processed in line with the Nigeria Data Protection Act 2023 (lawful basis, access control, retention, breach handling). | M |

---

## 5. Non-Functional Requirements
| ID | Category | Requirement | Pri |
|---|---|---|---|
| NFR-ACC-01 | Accuracy | All monetary calculations use fixed-point/decimal arithmetic, 2 decimal places, one rounding rule (BRL-15); totals equal sum of rounded lines. | M |
| NFR-PERF-01 | Performance | Full payroll calculation for up to 1,000 employees completes in ≤ 60 seconds; payslip batch of 1,000 in ≤ 5 minutes. | S |
| NFR-AVL-01 | Availability | System available during payroll processing windows (target 99.5% monthly). | S |
| NFR-BAK-01 | Backup/Recovery | Daily backups; RPO ≤ 24 hours, RTO ≤ 8 hours; tested restore at least quarterly. | M |
| NFR-DQ-01 | Data quality | Mandatory-field, type and range validation on every input; negative salaries, hours > 24/day and dates in the future for attendance rejected. | M |
| NFR-DQ-02 | Data quality | Dropdowns for Department, Position, Bank, Shift, LeaveType, Status; no free-text for controlled data. | M |
| NFR-DQ-03 | Data quality | Duplicate detection for EmpID, AccountNo, loan IDs, attendance entries. | M |
| NFR-USE-01 | Usability | A trained payroll officer can complete a monthly cycle without developer help; inline help and error messages in plain English. | S |
| NFR-AUD-01 | Auditability | Every payroll figure traceable to source inputs and rules in force. | M |
| NFR-CMP-01 | Compliance | Reference data changes require dual approval and are version-controlled. | M |
| NFR-SCL-01 | Scalability | Supports at least 2,000 active employees and 5 years of history without redesign. | S |
| NFR-LOC-01 | Localisation | Currency ₦, Nigerian date format (DD/MM/YYYY), Africa/Lagos time zone. | M |
| NFR-ACS-01 | Accessibility | Usable on desktop browsers/Excel; payslips readable on mobile. | C |
| NFR-MNT-01 | Maintainability | Rates, bands, multipliers, thresholds and holiday calendar editable without code changes. | M |

---

## 6. Data and Process Requirements

### 6.1 End-to-end payroll process
1. **Maintain master data (HR):** hires, leavers, salary changes, bank and statutory details, rent declarations.
2. **Capture attendance and leave (Supervisors/HR):** daily entries or import; supervisors approve overtime; leave approved.
3. **Register bonuses, loans and deductions (Payroll/HR):** with approval.
4. **Open period and prepare inputs (Payroll Officer):** system assembles `Payroll_Input` automatically; exceptions resolved.
5. **Calculate payroll (Payroll Officer):** gross-to-net, tax engine, register produced.
6. **Review (Payroll Manager):** variance and exception review; adjustments with reasons.
7. **Approve (Finance Approver; may escalate to MD/CFO):** period locked; loan balances updated.
8. **Pay:** bank schedule generated, uploaded to bank, payments reconciled.
9. **Distribute payslips and publish dashboard.**
10. **Remit statutory deductions (PAYE, pension, NHF, others)** and record references.
11. **Archive and audit:** period closed; reports retained.

### 6.2 Data flow
| Source | Feeds | Rule |
|---|---|---|
| Employee_Master | Payroll_Input (Basic, allowances, pension%, NHF%), Bank_Transfer (bank details), Payslip | Single source of truth; no re-keying |
| Shift_Setup + Attendance | OTPay in Payroll_Input | HoursWorked, OT category and multiplier × HourlyRate |
| Leave_Register + Attendance | Basic proration/absence deduction | Unpaid leave and absences only |
| Bonus_Register | Bonuses in Payroll_Input | Approved rows for the period |
| Loans | LoanDeduction in Payroll_Input; updates Outstanding on approval | Instalment ≤ outstanding |
| PAYE_Bands (reference) | PAYE in Payroll_Register | Selected by period end date |
| Payroll_Input | Payroll_Register | Calculation engine |
| Payroll_Register | Payslip, Bank_Transfer, Dashboard, remittance reports | Approved periods only |
| All sheets/modules | Audit_Log | Automatic |

---

## 7. User Stories and Acceptance Criteria

*(Refer to US-01 through US-35 in the project documentation above for detailed Given / When / Then criteria across Epics 1 to 8).*

---

## 8. Cross-Cutting Acceptance Criteria and Definition of Done
- **DoD-1:** All Must-have requirements in Section 4 are implemented and traceable to passing test cases.
- **DoD-2:** The regression pack of at least 25 reference employees (covering tax-free, mid-band, top-band, rent relief, loans, OT categories, leave, bonus, new hire, leaver) matches independently calculated results to the kobo.
- **DoD-3:** Two parallel payroll runs (old process vs new) are reconciled with every variance explained and signed off by Finance.
- **DoD-4:** Register, payslip, bank schedule and dashboard totals reconcile at every test.
- **DoD-5:** Role/permission, segregation-of-duties and period-lock tests pass; no user can edit an approved period.
- **DoD-6:** Audit log captures 100% of defined events in testing and cannot be altered.
- **DoD-7:** The Tax Advisor has signed off bands, reliefs, pension/NHF bases and levies in writing.
- **DoD-8:** Users are trained, user guide and payroll calendar delivered, backup/restore tested.
- **DoD-9:** Open questions in Section 11 marked Blocking are closed before build of the affected feature.

---

## 9. Traceability Matrix
*(Business Requirement → Functional Requirement → User Story as detailed in Section 9).*

---

## 10. Delivery Approach and Phasing
- **Phase 0: Immediate fixes to the current workbook**
  Replace flat 10% PAYE with a band-driven formula on a corrected NTA 2025 band table; compute pension on pensionable pay and NHF on basic; make Employee_Master Pension%/NHF% drive the formulas; add data validation and sheet protection; add Period/Name/Other Deductions to the payslip; fill in dashboard formulas.
- **Phase 1: Core payroll (MVP)**
- **Phase 2: Completeness**
- **Phase 3: Enhancement**

---

## 11. Open Questions and Decisions Required
Refer to Q1 through Q15 in Section 11.
