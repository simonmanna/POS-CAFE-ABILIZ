import { orgDateBound, orgPostingInstant, orgToday } from './org-dates';

describe('org-dates', () => {
  const tz = 'Africa/Kampala'; // UTC+3, no DST

  it('bounds a local calendar day, not a UTC one', () => {
    expect(orgDateBound('2026-09-15', 'from', tz, 'start')!.toISOString()).toBe('2026-09-14T21:00:00.000Z');
    expect(orgDateBound('2026-09-15', 'to', tz, 'end')!.toISOString()).toBe('2026-09-15T20:59:59.999Z');
  });

  it('keeps a 01:30 Kampala sale inside that local day', () => {
    const sale = new Date('2026-09-14T22:30:00.000Z'); // 01:30 on the 15th in Kampala
    expect(orgToday(tz, sale)).toBe('2026-09-15');
    const start = orgDateBound('2026-09-15', 'from', tz, 'start')!;
    const end = orgDateBound('2026-09-15', 'to', tz, 'end')!;
    expect(sale >= start && sale <= end).toBe(true);
  });

  it('passes full timestamps through and rejects garbage', () => {
    expect(orgDateBound('2026-09-15T10:00:00Z', 'from', tz, 'start')!.toISOString()).toBe('2026-09-15T10:00:00.000Z');
    expect(() => orgDateBound('nope', 'from', tz, 'start')).toThrow();
  });

  it('posts today at now, past dates at local noon, and refuses future dates', () => {
    const now = new Date('2026-09-14T22:30:00.000Z'); // 15 Sep 01:30 local
    expect(orgPostingInstant('2026-09-15', tz, now)).toBe(now);
    expect(orgPostingInstant('2026-09-10', tz, now).toISOString()).toBe('2026-09-10T09:00:00.000Z');
    expect(() => orgPostingInstant('2026-09-16', tz, now)).toThrow();
    expect(orgPostingInstant(undefined, tz, now)).toBe(now);
  });
});
