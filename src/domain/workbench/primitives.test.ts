import { describe, expect, it } from 'vitest';
import { decimalSchema, moscowDateSchema, rationalSchema, sha256Schema, utcInstantSchema, uuidSchema, versionRefSchema } from './primitives';
import { newUuid } from './time';

describe('wire primitives', () => {
  it('validates_wire_primitives', () => {
    expect(uuidSchema.parse('00000000-0000-4000-8000-000000000001')).toBe('00000000-0000-4000-8000-000000000001');
    expect(uuidSchema.safeParse('00000000-0000-1000-8000-000000000001').success).toBe(false);
    expect(uuidSchema.safeParse(newUuid()).success).toBe(true);
    for (const value of ['92.0', '-0', '01', '1e3', 92]) expect(decimalSchema.safeParse(value).success).toBe(false);
    expect(decimalSchema.parse('-0.01')).toBe('-0.01');
    for (const value of [{ numerator: '2', denominator: '4' }, { numerator: '1', denominator: '0' }, { numerator: '1', denominator: '-1' }, { numerator: '0', denominator: '2' }, { numerator: '1', denominator: '2', extra: true }]) {
      expect(rationalSchema.safeParse(value).success).toBe(false);
    }
    expect(rationalSchema.parse({ numerator: '1', denominator: '2' })).toEqual({ numerator: '1', denominator: '2' });
    expect(moscowDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(moscowDateSchema.parse('2028-02-29')).toBe('2028-02-29');
    expect(utcInstantSchema.safeParse('2026-10-23T00:00:00').success).toBe(false);
    expect(utcInstantSchema.safeParse('2026-02-30T00:00:00Z').success).toBe(false);
    expect(utcInstantSchema.parse('2026-10-23T00:00:00.123Z')).toBe('2026-10-23T00:00:00.123Z');
    expect(sha256Schema.safeParse('sha256:' + 'a'.repeat(64)).success).toBe(true);
    expect(sha256Schema.safeParse('a'.repeat(64)).success).toBe(false);
    const ref = { entityType: 'observed_fact', id: newUuid(), revision: 1 };
    expect(versionRefSchema.parse(ref)).toEqual(ref);
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(versionRefSchema.safeParse({ ...ref, revision }).success).toBe(false);
    expect(versionRefSchema.safeParse({ ...ref, extra: true }).success).toBe(false);
  });
});
