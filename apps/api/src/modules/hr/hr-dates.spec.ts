import { addDays, attendanceDay, minutesOfDay } from './hr-dates';

describe('hr-dates', () => {
  it('buckets an early-morning Kampala clock-in on the local day, not the UTC one', () => {
    // 22:30Z on the 20th is 01:30 on the 21st in Kampala (UTC+3).
    const at = new Date('2026-09-20T22:30:00.000Z');
    expect(attendanceDay(at, 'Africa/Kampala').toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(attendanceDay(at, 'UTC').toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('takes a bare YYYY-MM-DD as the calendar day it names, in any zone', () => {
    expect(attendanceDay('2026-09-21', 'America/New_York').toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(attendanceDay('2026-09-21', 'Pacific/Kiritimati').toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('reads shift minutes in the org zone', () => {
    const at = new Date('2026-09-21T05:15:00.000Z'); // 08:15 in Kampala
    expect(minutesOfDay(at, 'Africa/Kampala')).toBe(8 * 60 + 15);
    expect(minutesOfDay(at, 'UTC')).toBe(5 * 60 + 15);
  });

  it('adds whole days without drifting off UTC midnight', () => {
    const d = new Date('2026-12-31T00:00:00.000Z');
    expect(addDays(d, 1).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(addDays(d, -30).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});
