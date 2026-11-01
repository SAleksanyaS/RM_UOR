import { describe, expect, it } from 'vitest';
import { add, canonicalDecimal, compare, divide, formatExact, multiply, rational, subtract, toRational } from './exact-number';

const R = (numerator: string, denominator = '1') => ({ numerator, denominator });

describe('exact arithmetic', () => {
  it('keeps_exact_comparison_before_display_rounding', () => {
    expect(canonicalDecimal('00092.000')).toBe('92');
    expect(canonicalDecimal('-0.000')).toBe('0');
    expect(divide(multiply('92', '100'), '90')).toEqual(R('920', '9'));
    expect(add('9007199254740993.01', '0.09')).toEqual(R('90071992547409931', '10'));
    expect(formatExact('99.995')).toBe('100');
    expect(compare('99.995', '100')).toBe(-1);
    expect(formatExact('-1.235')).toBe('-1.24');
    expect(() => divide('1', '0')).toThrowError(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
    for (const value of ['NaN', 'Infinity', '1e3', '+1', ' 1 ', '', '.', '1.']) {
      expect(() => canonicalDecimal(value)).toThrow();
    }
  });

  it('reduces signs, zero and exact decimal fractions', () => {
    expect(rational('2', '-4')).toEqual(R('-1', '2'));
    expect(rational('0', '-7')).toEqual(R('0'));
    expect(toRational('-0.125')).toEqual(R('-1', '8'));
    expect(subtract('0.3', '0.2')).toEqual(R('1', '10'));
    expect(compare(R('1', '3'), R('2', '6'))).toBe(0);
    expect(multiply('-1.5', '2')).toEqual(R('-3'));
    expect(divide('-3', '-2')).toEqual(R('3', '2'));
    expect(() => rational('1', '0')).toThrowError(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
    expect(() => rational('01', '2')).toThrow();
  });

  it('rounds only for display with arbitrary magnitude and requested precision', () => {
    expect(formatExact(R('1', '3'))).toBe('0.33');
    expect(formatExact(R('-1', '200'))).toBe('-0.01');
    expect(formatExact('-0.004')).toBe('0');
    expect(formatExact('2.5', 0)).toBe('3');
    expect(formatExact('-2.5', 0)).toBe('-3');
    expect(formatExact('90071992547409931234567890.129', 2)).toBe('90071992547409931234567890.13');
    expect(formatExact('1.23000', 5)).toBe('1.23');
    expect(() => formatExact('1', -1)).toThrow();
    expect(() => formatExact('1', 1.5)).toThrow();
  });
});
