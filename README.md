# Factory Payroll (Express + MongoDB on Vercel)

Implements the Phase 1 core of the Factory Payroll requirements document: employee master, attendance with
overtime multipliers, loans, bonuses/deductions, a Nigeria Tax Act 2025 PAYE engine, payroll calculation,
segregation-of-duties approval and locking, payslips, bank CSV and an append-only audit log.

## Deploy to Vercel

1. Create a free MongoDB Atlas cluster. Create a database user and, under Network Access, allow `0.0.0.0/0`
   (Vercel uses dynamic IPs). Copy the connection string.
2. Push this folder to a GitHub repository.
3. In Vercel choose **Add New > Project**, import the repository and set **Framework Preset** to **Other**
   (if it was auto-detected as Express, change it under Settings > Build and Development, then redeploy). Leave the build command empty.
4. Add environment variables (see `.env.example`):
   - `MONGODB_URI`
   - `JWT_SECRET` (32+ random characters; see `.env.example` for a one-line generator)
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_NAME` (first administrator only)
   - `HOURS_PER_MONTH` (optional, default 176)
5. Deploy, open the site and sign in with the admin username and password. You will be asked to set a new
   password. After that, **delete `ADMIN_PASSWORD`** from the Vercel variables and redeploy.
6. Under **Users**, create accounts for hr, payroll and approver staff. Each person gets a temporary password and
   must change it at first sign-in.

Deploy details (keep `package.json`, `vercel.json`, `api/` and `public/` at the top level of the repository, and do not add a `server.js`, `app.js` or `index.js` at the root, because Vercel would run it instead of `api/index.js`): The UI is served from `public/`, the API from `api/index.js` at `/api/*`.

CLI alternative: `npm i -g vercel && vercel --prod`, then add the variables with `vercel env add`.

## Run locally

```
npm install
cp .env.example .env   # edit values
npm run dev            # http://localhost:3000
npm test               # tax and payroll unit tests (no database needed)
```

## Stakeholders & Roles Matrix

The system implements Role-Based Access Control (RBAC) and dedicated workflows tailored to the 9 factory payroll stakeholders (REQUIREMENTS.md Section 3.4 & FR-SEC-02):

| Stakeholder | System Role | Primary Responsibilities & Permissions | Dedicated Views & Endpoints |
|---|---|---|---|
| **Payroll Officer** | `payroll` | Prepares inputs, runs gross-to-net calculations, creates loans/adjustments, produces payslips, exports bank transfer schedule | `Payroll` view, `/api/payroll/:period/calculate`, `/api/payroll/:period/bank.csv` |
| **Finance / Payroll Manager** | `approver` | Reviews and approves payroll, signs off remittances, approves attendance/loans/adjustments, downloads bank payment file | `Payroll`, `Remittances`, `/api/payroll/:period/approve`, `/api/audit` |
| **HR Manager / HR Officer** | `hr` | Maintains employee master records (salaries, allowances, bank accounts, TIN, PFA), creates loan requests and adjustments | `Employees`, `Loans`, `Adjustments` (`/api/employees`) |
| **Production / Shift Supervisors** | `supervisor` | Submits shift attendance/clock times and approves attendance/overtime for shifts (with segregation of duties: cannot approve self-created attendance) | `Attendance` view (`/api/attendance`, `/api/attendance/:id/approve`) |
| **Managing Director / CFO** | `executive` | Receives executive dashboard metrics, monitors department costs and employer liabilities, reviews high-value and exception payroll, approves payroll runs | `Executive Dashboard` (`/api/dashboard/:period`), `Payroll` view |
| **Employees** | `employee` | Self-service access to view and print personal approved monthly payslips (restricted to own `empId`) | `My Payslips` view (`/api/me/payslips`, `/api/me/payslips/:period`) |
| **Internal Audit** | `auditor` | Read-only inspection of immutable append-only audit trail, employee records, attendance records, and approved payroll registers | `Audit` view (`/api/audit`), read-only payroll and employee views |
| **External Tax Advisor / Statutory bodies** | `tax_advisor` | Verifies tax bands, monitors statutory compliance (NRS, state IRS, PFAs/PenCom, FMBN, NSITF, ITF), downloads statutory remittance schedules | `Remittances` view, `/api/payroll/:period/remittances/summary`, `/api/payroll/:period/remittance/*.csv` |
| **IT Support** | `admin` | System deployment, environment configuration, database management, user provisioning, password resets, access administration | `Users` management view (`/api/users`), full system access |

### Segregation of Duties & Controls
- **Preparer vs Approver:** The user who runs the payroll calculation (`preparedBy`) cannot approve and lock it.
- **Creator vs Approver:** Users who create attendance records, loan requests, or salary adjustments cannot approve their own entries.
- **Employee Privacy:** Employees can only access payslips associated with their own `empId`.
- **Audit Immutability:** Audit records are append-only; update and delete operations are blocked at the database model layer.

## Stakeholder Workflows

### 1. Employee Self-Service Payslip Access
Employees log in with their assigned credentials and access the **My Payslips** screen. They can view the historical list of approved payslips, inspect line-item breakdowns (Basic, Allowances, Overtime, Bonuses, Gross, Pension, NHF, PAYE, Loans, Net Pay), and print their official monthly payslip.

### 2. Shift Supervisor Attendance Submission & Approval
Shift supervisors record clock-in, clock-out, unpaid break, and shift types (Day, Night, Weekend, Holiday). Overtime is calculated according to statutory multipliers. Another supervisor or the finance manager verifies and approves attendance before payroll processing.

### 3. Executive Dashboard for MD / CFO
Accessible via the **Executive** tab (`/api/dashboard/:period`), providing senior executives with:
- High-level KPIs: Paid Headcount, Total Gross, Total Net, Total PAYE, Pension (Employee + Employer), NHF, Overtime Cost/Hours, and Total Employer Cost.
- Department Cost Breakdown: Headcount, Gross Pay, Overtime, Net Pay, and Employer Cost by Department.
- Governance & Risk Controls: Immediate visibility of high-value payees (net pay ≥ ₦1,000,000), flagged lines (e.g. negative net or missing bank details), and calculation warnings.

### 4. Statutory Remittances for Tax Advisors & Statutory Bodies
Accessible via the **Remittances** tab (`/api/payroll/:period/remittances/summary`), providing:
- **PAYE Remittance Schedule (`paye.csv`):** State-by-state breakdown (Lagos, Ogun, etc.) with Employee ID, Name, TIN, Gross, Chargeable Income, and PAYE tax.
- **Pension Remittance Schedule (`pension.csv`):** Employee 8% contribution, Employer 10% statutory contribution, Total 18% contribution, Pension PIN, and Pensionable Emoluments for PFAs and PenCom.
- **National Housing Fund Schedule (`nhf.csv`):** Basic salary base and 2.5% NHF deduction for FMBN.
- **Employer Statutory Levies Summary:** Industrial Training Fund (ITF 1%) and Employees Compensation Scheme (NSITF 1%).

## Users and security

- Users live in MongoDB (`users` collection). Passwords are stored only as bcrypt hashes.
- Sign-in returns a signed token valid for 8 hours. Every request re-checks the user in the database, so
  deactivating a user, changing a role or resetting a password signs them out immediately.
- Five wrong passwords lock the account for 15 minutes. Sign-ins, failures, password changes and every user
  change are written to the audit log.
- Password rule: at least 10 characters with a letter and a number. Staff can change their own password under Account.
- The username is the permanent identity used for the approval rules (preparer cannot approve, creator cannot approve).
- Admins cannot change their own role or status, so the system cannot be left without an administrator.

## First-run walkthrough

1. Sign in as an `hr` user and add employees (include 10-digit account numbers).
2. As `payroll`, add attendance, a loan and a bonus; then sign in as `approver` and approve them.
3. As `payroll`, open Payroll, pick the month, choose Calculate payroll.
4. As `approver`, review and Approve and lock. Download the bank file as `payroll` or `approver`.

## Assumptions to confirm (from the requirements document, Section 11)

- PAYE bands are in `lib/tax.js`. Confirm them with your tax advisor before go-live (Q8).
- PAYE is annualised from the month's figures (Q7). Hourly rate is basic / `HOURS_PER_MONTH` (Q2).
- All weekend and holiday hours are overtime at 2.0 and 2.5; weekday overtime is hours beyond 8 (Q3).
- Highest-multiplier rule for overlapping premiums is not modelled: each entry has one shift type (Q4).

## Not yet included (later phases)

Leave management and unpaid-leave deductions, absence detection, part-month proration for joiners and leavers,
employer levies beyond 10% employer pension, remittance schedules, variance report, CSV attendance import,
email delivery of payslips, dashboard charts and multi-factor authentication.
Not yet included in login: multi-factor authentication and self-service password reset by email (an admin resets passwords).

## Troubleshooting a failed deployment

Open these addresses on your Vercel site, in order:

1. `/api/health` should show `{"ok":true,...}` with `MONGODB_URI` and `JWT_SECRET` both `true`.
   - A page saying the server failed to start shows the reason in `detail` (for example a missing package, which means
     `package.json` is not at the top level of the repository).
   - A bare "FUNCTION_INVOCATION_FAILED" page means something other than this app is running. Check that the repository root has no
     `server.js`, `app.js` or `index.js`, then open the failed deployment in Vercel and read **Logs**.
   - `MONGODB_URI: false` or `JWT_SECRET: false` means the variable is missing or too short for the environment (Production vs Preview),
     or the project was not redeployed after adding it.
2. `/api/health/db` should show `"database":"connected"`. If it fails, the message says why. The usual cause is Atlas
   Network Access not allowing `0.0.0.0/0`, or a wrong username or password in `MONGODB_URI`
   (special characters in the password must be URL-encoded).
