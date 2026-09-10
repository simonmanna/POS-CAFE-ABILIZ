import {
  HR_COMPENSATION_FIELDS,
  redactEmployee,
  redactEmployees,
} from './hr-employee-projection';

/**
 * `hr:read` is the employee-directory permission. Before the projection existed
 * it also handed out every salary, bank account number and national ID in the
 * organization, because the service returned the whole Prisma row.
 */
describe('HR employee compensation projection', () => {
  const employee = () => ({
    id: 'emp-1',
    employeeCode: 'EMP-00001',
    firstName: 'Ada',
    lastName: 'Byron',
    phone: '+256700000000',
    departmentId: 'dept-1',
    baseSalary: '1500000',
    hourlyRate: '9000',
    bankName: 'Stanbic',
    bankAccountName: 'Ada Byron',
    bankAccountNumber: '9030001234567',
    mobileMoneyProvider: 'MTN',
    mobileMoneyNumber: '+256770000000',
    taxNumber: 'TIN-123',
    pensionNumber: 'NSSF-9',
    socialSecurityNumber: 'SSN-4',
    dateOfBirth: new Date('1990-01-01'),
  });

  it('strips every compensation field when the caller lacks hr:compensation', () => {
    const row = redactEmployee(employee(), false)!;
    for (const field of HR_COMPENSATION_FIELDS) {
      expect(row).not.toHaveProperty(field);
    }
  });

  it('keeps directory fields readable', () => {
    const row = redactEmployee(employee(), false)!;
    expect(row.firstName).toBe('Ada');
    expect(row.phone).toBe('+256700000000');
    expect(row.departmentId).toBe('dept-1');
    expect(row.employeeCode).toBe('EMP-00001');
  });

  it('returns everything when the caller holds hr:compensation', () => {
    const row = redactEmployee(employee(), true)!;
    expect(row.baseSalary).toBe('1500000');
    expect(row.bankAccountNumber).toBe('9030001234567');
    expect(row.socialSecurityNumber).toBe('SSN-4');
  });

  it('deletes the key rather than nulling it, so redacted is distinguishable from unset', () => {
    const row = redactEmployee(employee(), false)! as Record<string, unknown>;
    // `'bankAccountNumber' in row === false` is the signal the client needs:
    // a null would wrongly read as "this employee has no bank account".
    expect('bankAccountNumber' in row).toBe(false);
  });

  it('redacts every row in a list', () => {
    const rows = redactEmployees([employee(), employee()], false);
    for (const row of rows) {
      expect(row).not.toHaveProperty('baseSalary');
      expect(row).not.toHaveProperty('taxNumber');
    }
  });

  it('tolerates null and undefined rows', () => {
    expect(redactEmployee(null, false)).toBeNull();
    expect(redactEmployee(undefined, false)).toBeUndefined();
  });
});
