# Comprehensive Factory Payroll System

A robust, fully compliant payroll system tailored for factory operations in the Federal Republic of Nigeria, compliant with the **Nigeria Tax Act 2025** (effective 1 January 2026), the Pension Reform Act, and National Housing Fund (NHF) statutory provisions.

## Key Deliverables in this Repository

1. **Requirements & Architecture (`REQUIREMENTS.md`):**
   - Full Business Requirements Document (BRD) & Functional Requirements Document (FRD).
   - 35 User Stories with testable Given/When/Then Acceptance Criteria across 8 Epics.
   - Comprehensive traceability matrix and Definition of Done (DoD).

2. **Hardened Excel Workbooks (`Comprehensive_Factory_Payroll_System.xlsx` & `Comprehensive_Factory_Payroll_System (1).xlsx`):**
   - **`PAYE_Bands`**: Updated to progressive Nigeria Tax Act 2025 bands (first ₦800k @ 0%, next ₦2.2m @ 15%, etc.) with historical PITA tables retained.
   - **`Employee_Master`**: Expanded with statutory fields (Housing, Transport, Annual Rent, NHF enrollment, NUBAN account validation).
   - **`Payroll_Register`**: Hardened gross-to-net formulas calculating pension on pensionable emoluments (Basic + Housing + Transport), NHF on basic salary, 20% rent relief (capped at ₦500,000), and progressive PAYE.
   - **`Payslip_Template` & `Bank_Transfer`**: Formula-linked payslip layout and bank schedule with control total reconciliation.
   - **`Dashboard` & `Audit_Log`**: Management KPI summary and automated change auditing.

3. **Python Reference Payroll Engine & Test Pack (`src/payroll` & `tests/`):**
   - Python 3 implementation of business rules (BRL-01 to BRL-15), shift overtime multipliers, loan deductions, and NTA 2025 progressive tax bands.
   - Test suite (`pytest`) executing the regression pack of 25 reference employees with kobo-level reconciliation (`Gross - Deductions = Net`).

## Running the Tests

To run the regression test suite:

```bash
python3 -m pytest tests/ -v
```

All 11 test cases (including the 25-employee regression pack and edge case scenarios) pass with zero errors.
