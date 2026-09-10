/**
 * Field-level sensitivity for employee records.
 *
 * `hr:read` is the directory + dashboard permission — it is held by anyone who
 * needs to look up a colleague's department or phone number. Before this
 * module existed, `GET /hr/employees` returned the whole row to those callers,
 * which meant every salary, bank account number and national ID in the
 * organization was readable by the same permission that opens a staff list.
 *
 * Compensation-grade fields now require `hr:compensation` to READ as well as
 * to write. Payroll runs, payslips, advances and loans are unaffected — those
 * endpoints already sit behind their own privileged permissions.
 */

/** Fields redacted from an employee record unless the caller holds `hr:compensation`. */
export const HR_COMPENSATION_FIELDS = [
  'baseSalary',
  'hourlyRate',
  'bankName',
  'bankAccountName',
  'bankAccountNumber',
  'mobileMoneyProvider',
  'mobileMoneyNumber',
  'taxNumber',
  'pensionNumber',
  'socialSecurityNumber',
  'dateOfBirth',
] as const;

/**
 * Drop compensation fields from one employee row when `canSee` is false.
 *
 * Deletes the keys rather than nulling them so a client cannot mistake
 * "redacted" for "not set" — an absent key means *you may not see this*, a
 * `null` would mean *this employee has no bank account*.
 */
export function redactEmployee<T extends Record<string, any> | null | undefined>(
  row: T,
  canSee: boolean,
): T {
  if (!row || canSee) return row;
  for (const field of HR_COMPENSATION_FIELDS) {
    delete (row as Record<string, any>)[field];
  }
  return row;
}

/** `redactEmployee` over a list. Mutates and returns the same array. */
export function redactEmployees<T extends Record<string, any>>(rows: T[], canSee: boolean): T[] {
  if (canSee) return rows;
  for (const row of rows) redactEmployee(row, canSee);
  return rows;
}
