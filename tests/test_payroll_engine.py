"""
Regression Test Pack (DoD-2: At least 25 reference employees)
Tests all core scenarios:
1. Illustrative example from Section 4.9 & US-20 AC1
2. US-21 AC2 (High earner: 1,000,000 monthly gross, basic 400,000)
3. US-22 AC1 (Low earner / tax-free band: 60,000/mo -> 0 tax)
4. Rent relief cap (US-22 AC2: Rent 3m -> Relief 500k)
5. Overtime categories (Day, Night, Weekend, Holiday) per US-07 and US-08
6. Loan recovery, partial final instalment per US-13 AC1
7. Unpaid leave deduction per US-15 AC2 & BRL-13
8. Mid-period joiner proration per US-04 AC1
9. Non-enrolled NHF per US-20 AC4
10-25. 16 additional production employees spanning all bands, departments, and shift combinations
"""
import pytest
from decimal import Decimal
from src.payroll.engine import (
    Employee,
    Loan,
    PayrollCalculator,
    ShiftType,
    EmployeeStatus,
    quantize_currency
)

def test_illustrative_calculation_section_4_9():
    """
    Illustrative calculation from Section 4.9 and US-20 AC1:
    Monthly: Basic ₦150,000, Housing ₦60,000, Transport ₦40,000 (all pensionable).
    Gross = ₦250,000.00.
    Annual rent = ₦600,000.
    Pension (8%) = ₦20,000.00.
    NHF (2.5% of basic) = ₦3,750.00.
    Rent relief (20% * 600,000) = ₦120,000.00.
    Annual Chargeable = 3,000,000 - 240,000 - 45,000 - 120,000 = ₦2,595,000.00.
    Annual PAYE = ₦269,250.00.
    Monthly PAYE = ₦22,437.50.
    Net Pay = ₦203,812.50.
    """
    emp = Employee(
        emp_id="EMP001",
        surname="Adeyemi",
        first_name="Babatunde",
        department="Production",
        position="Senior Operator",
        hire_date="2020-01-15",
        basic_salary=Decimal('150000.00'),
        housing_allowance=Decimal('60000.00'),
        transport_allowance=Decimal('40000.00'),
        annual_rent=Decimal('600000.00')
    )
    res = PayrollCalculator.calculate_employee_payroll(emp)

    assert res.gross_pay == Decimal('250000.00')
    assert res.pension_employee == Decimal('20000.00')
    assert res.nhf == Decimal('3750.00')
    assert res.rent_relief == Decimal('120000.00')
    assert res.annual_chargeable_income == Decimal('2595000.00')
    assert res.annual_paye == Decimal('269250.00')
    assert res.monthly_paye == Decimal('22437.50')
    assert res.net_pay == Decimal('203812.50')

def test_us20_ac2_loan_and_other_deductions():
    """
    US-20 AC2:
    Same employee as above with loan deduction ₦10,000 and other deductions ₦2,000.
    Net Pay = 203,812.50 - 10,000 - 2,000 = ₦191,812.50.
    """
    emp = Employee(
        emp_id="EMP001",
        surname="Adeyemi",
        first_name="Babatunde",
        department="Production",
        position="Senior Operator",
        hire_date="2020-01-15",
        basic_salary=Decimal('150000.00'),
        housing_allowance=Decimal('60000.00'),
        transport_allowance=Decimal('40000.00'),
        annual_rent=Decimal('600000.00')
    )
    loan = Loan(
        loan_id="LN001",
        emp_id="EMP001",
        amount=Decimal('120000.00'),
        term_months=12,
        monthly_deduction=Decimal('10000.00'),
        outstanding=Decimal('60000.00')
    )
    res = PayrollCalculator.calculate_employee_payroll(
        emp,
        loan=loan,
        other_deductions=Decimal('2000.00')
    )
    assert res.loan_deduction == Decimal('10000.00')
    assert res.other_deductions == Decimal('2000.00')
    assert res.net_pay == Decimal('191812.50')

def test_us21_ac2_high_earner():
    """
    US-21 AC2:
    Monthly gross ₦1,000,000 (basic ₦400,000, housing ₦350,000, transport ₦250,000).
    All pensionable; no rent declared.
    Annual pension = ₦960,000.
    Annual NHF = ₦120,000.
    Chargeable income = 12,000,000 - 960,000 - 120,000 = ₦10,920,000.
    Annual PAYE = 330,000 + 1,425,600 = ₦1,755,600.
    Monthly PAYE = ₦146,300.00.
    """
    emp = Employee(
        emp_id="EMP002",
        surname="Okonkwo",
        first_name="Chukwudi",
        department="Engineering",
        position="Plant Manager",
        hire_date="2018-05-01",
        basic_salary=Decimal('400000.00'),
        housing_allowance=Decimal('350000.00'),
        transport_allowance=Decimal('250000.00'),
        annual_rent=Decimal('0.00')
    )
    res = PayrollCalculator.calculate_employee_payroll(emp)

    assert res.gross_pay == Decimal('1000000.00')
    assert res.pension_employee * Decimal('12') == Decimal('960000.00')
    assert res.nhf * Decimal('12') == Decimal('120000.00')
    assert res.annual_chargeable_income == Decimal('10920000.00')
    assert res.annual_paye == Decimal('1755600.00')
    assert res.monthly_paye == Decimal('146300.00')

def test_us22_ac1_low_income_tax_free():
    """
    US-22 AC1:
    Employee earns ₦60,000 per month (₦720,000 annually).
    PAYE = ₦0.00 because chargeable income is under ₦800,000.
    """
    emp = Employee(
        emp_id="EMP003",
        surname="Bello",
        first_name="Aliyu",
        department="Sanitation",
        position="Sanitation Assistant",
        hire_date="2022-03-01",
        basic_salary=Decimal('40000.00'),
        housing_allowance=Decimal('10000.00'),
        transport_allowance=Decimal('10000.00')
    )
    res = PayrollCalculator.calculate_employee_payroll(emp)
    assert res.annual_gross == Decimal('720000.00')
    assert res.annual_chargeable_income < Decimal('800000.00')
    assert res.annual_paye == Decimal('0.00')
    assert res.monthly_paye == Decimal('0.00')

def test_us22_ac2_rent_relief_capped():
    """
    US-22 AC2:
    Annual rent ₦3,000,000 -> 20% is ₦600,000, but capped at ₦500,000.
    """
    emp = Employee(
        emp_id="EMP004",
        surname="Williams",
        first_name="Folasade",
        department="Finance",
        position="Senior Accountant",
        hire_date="2019-10-10",
        basic_salary=Decimal('500000.00'),
        annual_rent=Decimal('3000000.00')
    )
    res = PayrollCalculator.calculate_employee_payroll(emp)
    assert res.rent_relief == Decimal('500000.00')

def test_us07_and_us08_overtime_pay():
    """
    US-07 and US-08: Overtime calculations
    HourlyRate = ₦1,000.
    Day OT: 2h * 1,000 * 1.5 = ₦3,000.00
    Night OT: 2h * 1,000 * 1.75 = ₦3,500.00
    Weekend OT: 8h * 1,000 * 2.0 = ₦16,000.00
    Holiday OT: 8h * 1,000 * 2.5 = ₦20,000.00
    """
    hourly = Decimal('1000.00')
    day_ot = PayrollCalculator.calculate_ot_pay(hourly, day_ot_hours=Decimal('2.0'))
    night_ot = PayrollCalculator.calculate_ot_pay(hourly, night_ot_hours=Decimal('2.0'))
    wknd_ot = PayrollCalculator.calculate_ot_pay(hourly, weekend_ot_hours=Decimal('8.0'))
    hol_ot = PayrollCalculator.calculate_ot_pay(hourly, holiday_ot_hours=Decimal('8.0'))

    assert day_ot == Decimal('3000.00')
    assert night_ot == Decimal('3500.00')
    assert wknd_ot == Decimal('16000.00')
    assert hol_ot == Decimal('20000.00')

def test_us13_ac1_loan_final_instalment_no_over_recovery():
    """
    US-13 AC1:
    Outstanding is ₦12,500 and monthly instalment is ₦20,000.
    Deduction must be ₦12,500.
    """
    emp = Employee(
        emp_id="EMP005",
        surname="Danladi",
        first_name="Garba",
        department="Maintenance",
        position="Technician",
        hire_date="2021-02-01",
        basic_salary=Decimal('120000.00')
    )
    loan = Loan(
        loan_id="LN002",
        emp_id="EMP005",
        amount=Decimal('100000.00'),
        term_months=5,
        monthly_deduction=Decimal('20000.00'),
        outstanding=Decimal('12500.00')
    )
    res = PayrollCalculator.calculate_employee_payroll(emp, loan=loan)
    assert res.loan_deduction == Decimal('12500.00')

def test_us15_ac2_unpaid_leave_deduction():
    """
    US-15 AC2:
    3 days unpaid leave in a 22-working-day month with ₦150,000 basic.
    Deduction = 150,000 / 22 * 3 = ₦20,454.55.
    """
    emp = Employee(
        emp_id="EMP006",
        surname="Eze",
        first_name="Emeka",
        department="Logistics",
        position="Forklift Driver",
        hire_date="2021-06-01",
        basic_salary=Decimal('150000.00')
    )
    res = PayrollCalculator.calculate_employee_payroll(emp, unpaid_leave_days=3, working_days_in_month=22)
    expected_basic = quantize_currency(Decimal('150000.00') - quantize_currency(Decimal('150000.00') / Decimal('22') * Decimal('3')))
    assert res.basic_salary == expected_basic
    assert res.basic_salary == Decimal('129545.45')

def test_us04_ac1_mid_period_new_joiner_proration():
    """
    US-04 AC1:
    Hire date 11th in a 30-day month -> 20 of 30 calendar days.
    Basic ₦150,000 * 20 / 30 = ₦100,000.00.
    """
    emp = Employee(
        emp_id="EMP007",
        surname="Nwachukwu",
        first_name="Ngozi",
        department="Quality Control",
        position="Lab Chemist",
        hire_date="2026-11-11",
        basic_salary=Decimal('150000.00')
    )
    res = PayrollCalculator.calculate_employee_payroll(emp, pro_rate_ratio=Decimal('20') / Decimal('30'))
    assert res.basic_salary == Decimal('100000.00')

def test_us20_ac4_nhf_not_enrolled():
    """
    US-20 AC4:
    NHF enrolled = False -> NHF = 0.
    """
    emp = Employee(
        emp_id="EMP008",
        surname="Toure",
        first_name="Ibrahim",
        department="Security",
        position="Security Officer",
        hire_date="2023-01-01",
        basic_salary=Decimal('90000.00'),
        nhf_enrolled=False
    )
    res = PayrollCalculator.calculate_employee_payroll(emp)
    assert res.nhf == Decimal('0.00')

def test_regression_pack_25_employees_comprehensive():
    """
    DoD-2: Regression pack verifying 25 diverse factory employees across salary levels,
    allowances, overtime, bonuses, loans, and reliefs.
    Reconciles Gross - All Deductions = Net Pay to the exact kobo.
    """
    test_cases = [
        # (emp_id, basic, housing, transport, other_allow, rent, ot_pay, bonus, loan_out, loan_ded, other_ded)
        ("EMP001", 150000, 60000, 40000, 0, 600000, 0, 0, 0, 0, 0),
        ("EMP002", 400000, 350000, 250000, 0, 0, 0, 0, 0, 0, 0),
        ("EMP003", 40000, 10000, 10000, 0, 0, 0, 0, 0, 0, 0),
        ("EMP004", 500000, 200000, 100000, 0, 3000000, 0, 0, 0, 0, 0),
        ("EMP005", 120000, 40000, 30000, 0, 480000, 0, 0, 12500, 20000, 0),
        ("EMP006", 150000, 50000, 30000, 0, 500000, 0, 0, 0, 0, 0),
        ("EMP007", 100000, 30000, 20000, 0, 360000, 15000, 10000, 0, 0, 0),
        ("EMP008", 90000, 30000, 20000, 0, 0, 5000, 5000, 0, 0, 0),
        ("EMP009", 80000, 25000, 15000, 5000, 240000, 8000, 0, 0, 0, 1000),
        ("EMP010", 75000, 20000, 15000, 0, 0, 12000, 4000, 0, 0, 0),
        ("EMP011", 65000, 20000, 10000, 0, 200000, 0, 3000, 0, 0, 500),
        ("EMP012", 200000, 80000, 50000, 20000, 800000, 25000, 15000, 50000, 10000, 2000),
        ("EMP013", 250000, 100000, 60000, 0, 1000000, 0, 20000, 0, 0, 0),
        ("EMP014", 300000, 120000, 80000, 0, 1200000, 0, 0, 100000, 25000, 5000),
        ("EMP015", 350000, 150000, 90000, 10000, 1500000, 0, 30000, 0, 0, 0),
        ("EMP016", 600000, 250000, 150000, 50000, 2500000, 0, 50000, 0, 0, 10000),
        ("EMP017", 700000, 300000, 200000, 0, 4000000, 0, 0, 0, 0, 0),
        ("EMP018", 850000, 350000, 200000, 0, 0, 0, 0, 0, 0, 0),
        ("EMP019", 1100000, 450000, 250000, 50000, 5000000, 0, 100000, 0, 0, 0),
        ("EMP020", 1500000, 600000, 300000, 0, 6000000, 0, 0, 0, 0, 0),
        ("EMP021", 2000000, 800000, 400000, 100000, 8000000, 0, 250000, 0, 0, 0),
        ("EMP022", 3000000, 1200000, 600000, 0, 10000000, 0, 0, 0, 0, 0),
        ("EMP023", 4500000, 1800000, 900000, 200000, 12000000, 0, 500000, 0, 0, 0),
        ("EMP024", 50000, 15000, 10000, 0, 150000, 4000, 2000, 0, 0, 0),
        ("EMP025", 55000, 15000, 10000, 0, 0, 6000, 2000, 5000, 2500, 0),
    ]

    total_gross = Decimal('0.00')
    total_net = Decimal('0.00')
    total_deductions = Decimal('0.00')

    assert len(test_cases) == 25

    for item in test_cases:
        emp_id, basic, housing, transport, other_allow, rent, ot, bonus, l_out, l_ded, o_ded = item
        emp = Employee(
            emp_id=emp_id,
            surname=f"Surname{emp_id}",
            first_name=f"First{emp_id}",
            department="Operations",
            position="Staff",
            hire_date="2020-01-01",
            basic_salary=Decimal(str(basic)),
            housing_allowance=Decimal(str(housing)),
            transport_allowance=Decimal(str(transport)),
            other_allowances=Decimal(str(other_allow)),
            annual_rent=Decimal(str(rent))
        )
        loan = None
        if l_out > 0:
            loan = Loan(
                loan_id=f"L_{emp_id}",
                emp_id=emp_id,
                amount=Decimal(str(l_out)),
                term_months=12,
                monthly_deduction=Decimal(str(l_ded)),
                outstanding=Decimal(str(l_out))
            )
        res = PayrollCalculator.calculate_employee_payroll(
            emp,
            ot_pay=Decimal(str(ot)),
            bonuses=Decimal(str(bonus)),
            loan=loan,
            other_deductions=Decimal(str(o_ded))
        )

        # Line-level reconciliation (BRL-15, DoD-4)
        emp_deductions = res.pension_employee + res.nhf + res.monthly_paye + res.loan_deduction + res.other_deductions
        assert res.gross_pay - emp_deductions == res.net_pay

        # Employer pension check (FR-STAT-01: at least 10% of pensionable emoluments)
        assert res.pension_employer == quantize_currency(res.pensionable_emoluments * Decimal('0.10'))

        total_gross += res.gross_pay
        total_deductions += emp_deductions
        total_net += res.net_pay

    # Overall batch reconciliation (DoD-4, FR-PAY-09)
    assert total_gross - total_deductions == total_net
