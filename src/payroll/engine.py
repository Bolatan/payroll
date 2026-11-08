"""
Factory Payroll System Engine (Nigeria Tax Act 2025 compliant)
Implements all business rules BRL-01 through BRL-15 and functional requirements.
"""
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from typing import List, Optional, Dict
from enum import Enum

def quantize_currency(amount: Decimal) -> Decimal:
    """Rounds all monetary amounts to 2 decimal places per BRL-15."""
    return amount.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

class EmployeeStatus(str, Enum):
    ACTIVE = "Active"
    ON_LEAVE = "On Leave"
    SUSPENDED = "Suspended"
    TERMINATED = "Terminated"

class ShiftType(str, Enum):
    DAY = "Day"
    NIGHT = "Night"
    WEEKEND = "Weekend"
    HOLIDAY = "Holiday"

@dataclass
class ShiftRule:
    shift: str  # Allows standard ShiftType or user-defined string (FR-SHF-01)
    std_hours: Decimal = Decimal('8.0')
    multiplier: Decimal = Decimal('1.5')
    start_time: str = "08:00"  # FR-SHF-02
    end_time: str = "16:00"    # FR-SHF-02 (supports night shifts crossing midnight)
    break_duration: Decimal = Decimal('1.0')  # FR-SHF-02
    effective_from: str = "2026-01-01"  # FR-SHF-02

    def __post_init__(self):
        # FR-SHF-05: Shift multipliers validated as >= 1.0 and standard hours between 1 and 24
        self.std_hours = Decimal(str(self.std_hours))
        self.multiplier = Decimal(str(self.multiplier))
        self.break_duration = Decimal(str(self.break_duration))
        if self.multiplier < Decimal('1.0'):
            raise ValueError(f"Shift multiplier must be >= 1.0, got {self.multiplier}")
        if self.std_hours < Decimal('1.0') or self.std_hours > Decimal('24.0'):
            raise ValueError(f"Standard hours must be between 1 and 24, got {self.std_hours}")

@dataclass
class PublicHoliday:
    """FR-SHF-04: Public-holiday calendar (date, name)."""
    date: str  # YYYY-MM-DD
    name: str

DEFAULT_SHIFT_RULES: Dict[str, ShiftRule] = {
    ShiftType.DAY: ShiftRule(ShiftType.DAY, Decimal('8.0'), Decimal('1.5'), start_time="08:00", end_time="16:00"),
    ShiftType.NIGHT: ShiftRule(ShiftType.NIGHT, Decimal('8.0'), Decimal('1.75'), start_time="22:00", end_time="06:00"),
    ShiftType.WEEKEND: ShiftRule(ShiftType.WEEKEND, Decimal('8.0'), Decimal('2.0'), start_time="08:00", end_time="16:00"),
    ShiftType.HOLIDAY: ShiftRule(ShiftType.HOLIDAY, Decimal('8.0'), Decimal('2.5'), start_time="08:00", end_time="16:00"),
}

@dataclass
class Employee:
    emp_id: str
    surname: str
    first_name: str
    department: str
    position: str
    hire_date: str
    basic_salary: Decimal
    housing_allowance: Decimal = Decimal('0.00')
    transport_allowance: Decimal = Decimal('0.00')
    other_allowances: Decimal = Decimal('0.00')
    hourly_rate: Optional[Decimal] = None
    pension_pct: Decimal = Decimal('0.08')
    nhf_pct: Decimal = Decimal('0.025')
    nhf_enrolled: bool = True
    annual_rent: Decimal = Decimal('0.00')
    bank: str = "First Bank"
    account_no: str = "0123456789"
    status: EmployeeStatus = EmployeeStatus.ACTIVE

    def __post_init__(self):
        self.basic_salary = quantize_currency(Decimal(str(self.basic_salary)))
        self.housing_allowance = quantize_currency(Decimal(str(self.housing_allowance)))
        self.transport_allowance = quantize_currency(Decimal(str(self.transport_allowance)))
        self.other_allowances = quantize_currency(Decimal(str(self.other_allowances)))
        self.annual_rent = quantize_currency(Decimal(str(self.annual_rent)))
        self.pension_pct = Decimal(str(self.pension_pct))
        self.nhf_pct = Decimal(str(self.nhf_pct))
        if self.hourly_rate is None:
            # Default derived formula: basic_salary / 176 (22 working days * 8h)
            if self.basic_salary > Decimal('0'):
                self.hourly_rate = quantize_currency(self.basic_salary / Decimal('176'))
            else:
                self.hourly_rate = Decimal('0.00')
        else:
            self.hourly_rate = quantize_currency(Decimal(str(self.hourly_rate)))

@dataclass
class AttendanceRecord:
    date: str
    emp_id: str
    shift: ShiftType
    hours_worked: Decimal
    ot_hours: Decimal = Decimal('0.0')
    weekend_ot: Decimal = Decimal('0.0')
    holiday_ot: Decimal = Decimal('0.0')
    absent: bool = False
    approved: bool = True

@dataclass
class Loan:
    loan_id: str
    emp_id: str
    amount: Decimal
    term_months: int
    monthly_deduction: Decimal
    outstanding: Decimal
    status: str = "Active"

@dataclass
class PayrollResult:
    emp_id: str
    employee_name: str
    department: str
    period: str
    basic_salary: Decimal
    housing_allowance: Decimal
    transport_allowance: Decimal
    other_allowances: Decimal
    total_allowances: Decimal
    ot_pay: Decimal
    bonuses: Decimal
    gross_pay: Decimal
    pensionable_emoluments: Decimal
    pension_employee: Decimal
    pension_employer: Decimal
    nhf: Decimal
    annual_rent: Decimal
    rent_relief: Decimal
    annual_gross: Decimal
    annual_reliefs: Decimal
    annual_chargeable_income: Decimal
    annual_paye: Decimal
    monthly_paye: Decimal
    loan_deduction: Decimal
    other_deductions: Decimal
    net_pay: Decimal
    is_negative_blocked: bool = False

class PayrollCalculator:
    """
    Computes payroll according to Nigeria Tax Act 2025 and Nigerian Statutory Regulations.
    """
    @staticmethod
    def calculate_ot_pay(
        hourly_rate: Decimal,
        day_ot_hours: Decimal = Decimal('0'),
        night_ot_hours: Decimal = Decimal('0'),
        weekend_ot_hours: Decimal = Decimal('0'),
        holiday_ot_hours: Decimal = Decimal('0'),
        shift_rules: Dict[ShiftType, ShiftRule] = DEFAULT_SHIFT_RULES
    ) -> Decimal:
        """
        BRL-04: Overtime pay = OT hours * HourlyRate * multiplier
        Day: 1.5, Night: 1.75, Weekend: 2.0, Holiday: 2.5
        """
        total_ot = (
            day_ot_hours * hourly_rate * shift_rules[ShiftType.DAY].multiplier +
            night_ot_hours * hourly_rate * shift_rules[ShiftType.NIGHT].multiplier +
            weekend_ot_hours * hourly_rate * shift_rules[ShiftType.WEEKEND].multiplier +
            holiday_ot_hours * hourly_rate * shift_rules[ShiftType.HOLIDAY].multiplier
        )
        return quantize_currency(total_ot)

    @staticmethod
    def calculate_nta2025_tax(annual_chargeable_income: Decimal) -> Decimal:
        """
        FR-TAX-03 & BRL-05: Nigeria Tax Act 2025 Progressive Tax Bands:
        - First 800,000 @ 0%
        - Next 2,200,000 (800,001 - 3,000,000) @ 15%
        - Next 9,000,000 (3,000,001 - 12,000,000) @ 18%
        - Next 13,000,000 (12,000,001 - 25,000,000) @ 21%
        - Next 25,000,000 (25,000,001 - 50,000,000) @ 23%
        - Above 50,000,000 @ 25%
        """
        if annual_chargeable_income <= Decimal('800000'):
            return Decimal('0.00')

        rem = annual_chargeable_income - Decimal('800000')
        tax = Decimal('0.00')

        # Band 2: up to 2,200,000 @ 15%
        band2_width = Decimal('2200000')
        if rem <= band2_width:
            tax += rem * Decimal('0.15')
            return quantize_currency(tax)
        tax += band2_width * Decimal('0.15')
        rem -= band2_width

        # Band 3: up to 9,000,000 @ 18%
        band3_width = Decimal('9000000')
        if rem <= band3_width:
            tax += rem * Decimal('0.18')
            return quantize_currency(tax)
        tax += band3_width * Decimal('0.18')
        rem -= band3_width

        # Band 4: up to 13,000,000 @ 21%
        band4_width = Decimal('13000000')
        if rem <= band4_width:
            tax += rem * Decimal('0.21')
            return quantize_currency(tax)
        tax += band4_width * Decimal('0.21')
        rem -= band4_width

        # Band 5: up to 25,000,000 @ 23%
        band5_width = Decimal('25000000')
        if rem <= band5_width:
            tax += rem * Decimal('0.23')
            return quantize_currency(tax)
        tax += band5_width * Decimal('0.23')
        rem -= band5_width

        # Band 6: Above 50m @ 25%
        tax += rem * Decimal('0.25')
        return quantize_currency(tax)

    @classmethod
    def calculate_employee_payroll(
        cls,
        employee: Employee,
        period: str = "2026-11",
        ot_pay: Decimal = Decimal('0.00'),
        bonuses: Decimal = Decimal('0.00'),
        loan: Optional[Loan] = None,
        other_deductions: Decimal = Decimal('0.00'),
        unpaid_leave_days: int = 0,
        working_days_in_month: int = 22,
        pro_rate_ratio: Optional[Decimal] = None
    ) -> PayrollResult:
        """
        Full gross-to-net payroll computation per employee.
        """
        # 1. Basic Salary & Absence / Proration
        basic = employee.basic_salary
        if pro_rate_ratio is not None:
            basic = quantize_currency(basic * pro_rate_ratio)
        elif unpaid_leave_days > 0:
            # BRL-13: basic / working days * absent days
            deduction = quantize_currency((employee.basic_salary / Decimal(str(working_days_in_month))) * Decimal(str(unpaid_leave_days)))
            basic = quantize_currency(basic - deduction)

        housing = employee.housing_allowance
        transport = employee.transport_allowance
        other_allow = employee.other_allowances
        total_allowances = quantize_currency(housing + transport + other_allow)
        ot = quantize_currency(Decimal(str(ot_pay)))
        bonuses_val = quantize_currency(Decimal(str(bonuses)))

        gross_pay = quantize_currency(basic + total_allowances + ot + bonuses_val)

        # 2. Statutory Bases
        # Pensionable Emoluments = Basic + Housing + Transport
        pensionable_emoluments = quantize_currency(basic + housing + transport)
        pension_emp = quantize_currency(pensionable_emoluments * employee.pension_pct)
        pension_empr = quantize_currency(pensionable_emoluments * Decimal('0.10'))

        # NHF = 2.5% of basic salary for enrolled employees
        if employee.nhf_enrolled:
            nhf = quantize_currency(basic * employee.nhf_pct)
        else:
            nhf = Decimal('0.00')

        # 3. NTA 2025 Tax Calculation
        # Rent relief = 20% of annual rent paid, capped at 500,000
        rent_relief = quantize_currency(min(Decimal('500000.00'), employee.annual_rent * Decimal('0.20')))

        annual_gross = quantize_currency(gross_pay * Decimal('12'))
        annual_reliefs = quantize_currency((pension_emp + nhf) * Decimal('12') + rent_relief)
        chargeable_income = max(Decimal('0.00'), annual_gross - annual_reliefs)

        annual_paye = cls.calculate_nta2025_tax(chargeable_income)
        monthly_paye = quantize_currency(annual_paye / Decimal('12'))

        # 4. Loan recovery
        loan_deduction = Decimal('0.00')
        if loan and loan.outstanding > Decimal('0'):
            # BRL-08: deduction never exceeds remaining balance
            loan_deduction = quantize_currency(min(loan.monthly_deduction, loan.outstanding))

        other_ded = quantize_currency(Decimal(str(other_deductions)))

        # 5. Net Pay & Negative Check (BRL-09)
        total_deductions = pension_emp + nhf + monthly_paye + loan_deduction + other_ded
        net_pay = gross_pay - total_deductions

        is_negative_blocked = False
        if net_pay < Decimal('0.00'):
            is_negative_blocked = True
            # Retain non-negative or flag per BRL-09

        return PayrollResult(
            emp_id=employee.emp_id,
            employee_name=f"{employee.surname} {employee.first_name}",
            department=employee.department,
            period=period,
            basic_salary=basic,
            housing_allowance=housing,
            transport_allowance=transport,
            other_allowances=other_allow,
            total_allowances=total_allowances,
            ot_pay=ot,
            bonuses=bonuses_val,
            gross_pay=gross_pay,
            pensionable_emoluments=pensionable_emoluments,
            pension_employee=pension_emp,
            pension_employer=pension_empr,
            nhf=nhf,
            annual_rent=employee.annual_rent,
            rent_relief=rent_relief,
            annual_gross=annual_gross,
            annual_reliefs=annual_reliefs,
            annual_chargeable_income=chargeable_income,
            annual_paye=annual_paye,
            monthly_paye=monthly_paye,
            loan_deduction=loan_deduction,
            other_deductions=other_ded,
            net_pay=quantize_currency(net_pay),
            is_negative_blocked=is_negative_blocked
        )
