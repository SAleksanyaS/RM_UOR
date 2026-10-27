import { describe, expect, it } from 'vitest';
import { addMoscowDays, moscowEnd, moscowStart } from './time';

describe('Moscow calendar', () => {
  it('uses_moscow_calendar_boundaries', () => {
    expect(moscowStart('2026-10-23')).toBe('2026-10-22T21:00:00.000Z');
    expect(moscowEnd('2026-10-23')).toBe('2026-10-23T20:59:59.999Z');
    expect(addMoscowDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addMoscowDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addMoscowDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(moscowStart('0001-01-01')).toBe('0000-12-31T21:00:00.000Z');
    expect(() => moscowStart('2026-02-29')).toThrow();
    expect(() => addMoscowDays('2026-10-23', 0.5)).toThrow();
    expect(() => addMoscowDays('9999-12-31', 1)).toThrow();
  });
});
