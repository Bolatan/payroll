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
    shift: ShiftType
    std_hours: Decimal = Decimal('8.0')
    multiplier: Decimal = Decimal('1.5')

DEFAULT_SHIFT_RULES: Dict[ShiftType, ShiftRule] = {
    ShiftType.DAY: ShiftRule(ShiftType.DAY, Decimal('8.0'), Decimal('1.5')),
    ShiftType.NIGHT: ShiftRule(ShiftType.NIGHT, Decimal('8.0'), Decimal('1.75')),
    ShiftType.WEEKEND: ShiftRule(ShiftType.WEEKEND, Decimal('8.0'), Decimal('2.0')),
    ShiftType.HOLIDAY: ShiftRule(ShiftType.HOLIDAY, Decimal('8.0'), Decimal('2.5')),
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
    hours_worked: Decimal = Decimal('0.0')
    ot_hours: Decimal = Decimal('0.0')
    weekend_ot: Decimal = Decimal('0.0')
    holiday_ot: Decimal = Decimal('0.0')
    applied_multiplier: Decimal = Decimal('1.0')
    absent: bool = False
    absent_reason: str = ""
    clock_in: str = "08:00"
    clock_out: str = "16:00"
    break_hours: Decimal = Decimal('0.0')
    late_minutes: int = 0
    early_minutes: int = 0
    is_late: bool = False
    is_early_departure: bool = False
    approved: bool = True
    approved_by: Optional[str] = None
    created_by: Optional[str] = None

@dataclass
class AttendancePeriodSummary:
    emp_id: str
    days_present: int
    days_absent: int
    days_leave: int
    total_hours: Decimal
    day_ot_hours: Decimal
    night_ot_hours: Decimal
    weekend_ot_hours: Decimal
    holiday_ot_hours: Decimal
    total_ot_hours: Decimal
    late_count: int
    early_departure_count: int
    ot_capped_warning: bool = False

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
    def calculate_hours_worked(clock_in: str, clock_out: str, break_hours: Decimal = Decimal('0.0')) -> Decimal:
        """FR-ATT-04: HoursWorked = ClockOut - ClockIn - unpaid break, handles night shifts crossing midnight."""
        cin_h, cin_m = map(int, clock_in.split(':'))
        cout_h, cout_m = map(int, clock_out.split(':'))
        mins = (cout_h * 60 + cout_m) - (cin_h * 60 + cin_m)
        if mins <= 0:
            mins += 1440  # crossing midnight
        worked = Decimal(str(mins)) / Decimal('60') - break_hours
        return quantize_currency(max(Decimal('0.00'), worked))

    @staticmethod
    def resolve_highest_multiplier(
        shift: ShiftType,
        is_public_holiday: bool = False,
        is_weekend: bool = False,
        shift_rules: Dict[ShiftType, ShiftRule] = DEFAULT_SHIFT_RULES
    ) -> Decimal:
        """
        FR-ATT-07: Apply highest applicable multiplier, not compound them.
        """
        candidates = [shift_rules[shift].multiplier]
        if is_weekend:
            candidates.append(shift_rules[ShiftType.WEEKEND].multiplier)
        if is_public_holiday:
            candidates.append(shift_rules[ShiftType.HOLIDAY].multiplier)
        return max(candidates)

    @classmethod
    def process_attendance_record(
        cls,
        emp_id: str,
        date_str: str,
        shift: ShiftType,
        clock_in: str,
        clock_out: str,
        break_hours: Decimal = Decimal('0.0'),
        is_public_holiday: bool = False,
        is_weekend: bool = False,
        shift_rules: Dict[ShiftType, ShiftRule] = DEFAULT_SHIFT_RULES
    ) -> AttendanceRecord:
        """
        Processes raw punch times into structured attendance record with OT categories.
        FR-ATT-01, FR-ATT-04, FR-ATT-05, FR-ATT-06, FR-ATT-07, FR-ATT-11
        """
        hours = cls.calculate_hours_worked(clock_in, clock_out, break_hours)
        multiplier = cls.resolve_highest_multiplier(shift, is_public_holiday, is_weekend, shift_rules)

        std_hours = shift_rules[shift].std_hours
        ot_hours = Decimal('0.0')
        weekend_ot = Decimal('0.0')
        holiday_ot = Decimal('0.0')

        if shift == ShiftType.HOLIDAY or is_public_holiday:
            holiday_ot = hours
        elif shift == ShiftType.WEEKEND or is_weekend:
            weekend_ot = hours
        else:
            if hours > std_hours:
                ot_hours = hours - std_hours

        # Lateness / early departure thresholds
        in_h, in_m = map(int, clock_in.split(':'))
        in_mins = in_h * 60 + in_m
        late_mins = max(0, in_mins - (8 * 60))
        is_late = late_mins >= 15

        out_h, out_m = map(int, clock_out.split(':'))
        out_mins = out_h * 60 + out_m
        if out_mins < in_mins:
            out_mins += 1440
        sched_end = 16 * 60
        early_mins = max(0, sched_end - out_mins) if out_mins < sched_end else 0
        is_early = early_mins >= 15

        return AttendanceRecord(
            date=date_str,
            emp_id=emp_id,
            shift=shift,
            hours_worked=hours,
            ot_hours=quantize_currency(ot_hours),
            weekend_ot=quantize_currency(weekend_ot),
            holiday_ot=quantize_currency(holiday_ot),
            applied_multiplier=multiplier,
            absent=False,
            clock_in=clock_in,
            clock_out=clock_out,
            break_hours=break_hours,
            late_minutes=late_mins,
            early_minutes=early_mins,
            is_late=is_late,
            is_early_departure=is_early,
            approved=True
        )

    @staticmethod
    def summarize_attendance(
        emp_id: str,
        records: List[AttendanceRecord],
        approved_leave_days: int = 0,
        max_period_ot: Decimal = Decimal('40.0')
    ) -> AttendancePeriodSummary:
        """
        FR-ATT-12: Produces period attendance summary per employee.
        """
        days_present = 0
        days_absent = 0
        total_hours = Decimal('0.0')
        day_ot = Decimal('0.0')
        night_ot = Decimal('0.0')
        weekend_ot = Decimal('0.0')
        holiday_ot = Decimal('0.0')
        late_count = 0
        early_count = 0

        for r in records:
            if r.absent:
                days_absent += 1
            else:
                days_present += 1
                total_hours += r.hours_worked
                if r.is_late:
                    late_count += 1
                if r.is_early_departure:
                    early_count += 1

                if r.holiday_ot > Decimal('0.0'):
                    holiday_ot += r.holiday_ot
                elif r.weekend_ot > Decimal('0.0') or r.shift == ShiftType.WEEKEND:
                    weekend_ot += r.weekend_ot if r.weekend_ot > Decimal('0.0') else r.hours_worked
                elif r.shift == ShiftType.NIGHT:
                    night_ot += r.ot_hours
                else:
                    day_ot += r.ot_hours

        total_ot = quantize_currency(day_ot + night_ot + weekend_ot + holiday_ot)

        return AttendancePeriodSummary(
            emp_id=emp_id,
            days_present=days_present,
            days_absent=days_absent,
            days_leave=approved_leave_days,
            total_hours=quantize_currency(total_hours),
            day_ot_hours=quantize_currency(day_ot),
            night_ot_hours=quantize_currency(night_ot),
            weekend_ot_hours=quantize_currency(weekend_ot),
            holiday_ot_hours=quantize_currency(holiday_ot),
            total_ot_hours=total_ot,
            late_count=late_count,
            early_departure_count=early_count,
            ot_capped_warning=total_ot > max_period_ot
        )

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
