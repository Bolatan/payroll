# Factory Payroll (Express + MongoDB on Vercel)

Implements the Phase 1 core of the Factory Payroll requirements document: employee master, attendance with
overtime multipliers, loans, bonuses/deductions, a Nigeria Tax Act 2025 PAYE engine, payroll calculation,
segregation-of-duties approval and locking, payslips, bank CSV and an append-only audit log.

## Deploy to Vercel

1. Create a free MongoDB Atlas cluster. Create a database user and, under Network Access, allow `0.0.0.0/0`
   (Vercel uses dynamic IPs). Copy the connection string.
2. Push this folder to a GitHub repository.
3. In Vercel choose **Add New > Project**, import the repository and leave the framework preset as **Other**.
4. Add environment variables (see `.env.example`):
   - `MONGODB_URI`
   - `USERS` (JSON array of name, key, role). Use long random keys.
   - `HOURS_PER_MONTH` (optional, default 176)
5. Deploy. The UI is served from `public/`, the API from `api/index.js` at `/api/*`.

CLI alternative: `npm i -g vercel && vercel --prod`, then add the variables with `vercel env add`.

## Run locally

```
npm install
cp .env.example .env   # edit values
npm run dev            # http://localhost:3000
npm test               # tax and payroll unit tests (no database needed)
```

## Roles

| Role | Can do |
|---|---|
| hr | Employees, loans, adjustments (create) |
| payroll | Attendance, loans and adjustments (create), calculate payroll, payslips, bank file |
| approver | Approve attendance, loans, adjustments and payroll; view audit log |
| admin | Everything |

The person who calculates payroll cannot approve it, and creators cannot approve their own loans or adjustments.

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
email delivery of payslips, dashboard charts and a database-backed login with password hashing.
The shared-key login is suitable for a pilot; replace it with proper authentication before wider use.
