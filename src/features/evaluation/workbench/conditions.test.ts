import { describe, expect, it } from 'vitest';
import type { MetricRule } from '../../../domain/workbench/entities';
import { makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { normalizeMetric, testCondition } from './conditions';

const R = (numerator: string, denominator = '1') => ({ numerator, denominator });
const fixture = () => { const input = makeNumericFixture(); if (input.method.mode !== 'numeric') throw new Error('numeric'); return { rule: input.method.rules[0], metric: input.metrics[0] }; };

describe('exact normalization', () => {
  it('matches_exact_normalization_vectors', () => {
    const { rule, metric } = fixture();
    expect(normalizeMetric('120', rule, metric)).toEqual(R('120'));
    expect(normalizeMetric('92', { ...rule, condition: { op: 'gte', target: '90' } }, metric)).toEqual(R('920', '9'));
    const decrease: MetricRule = { ...rule, condition: { op: 'lte', target: '10' }, normalization: { kind: 'decrease_ratio_capped_v1', maxPercent: '200' } };
    expect(normalizeMetric('8', decrease, metric)).toEqual(R('125'));
    for (const value of ['5', '1', '0']) expect(normalizeMetric(value, decrease, metric)).toEqual(R('200'));
    const zero: MetricRule = { ...rule, condition: { op: 'lte', target: '0' }, normalization: { kind: 'zero_counter_v1' } };
    const counter = { ...metric, domain: 'nonnegative_integer' as const };
    expect(normalizeMetric('0', zero, counter)).toEqual(R('100'));
    expect(normalizeMetric('3', zero, counter)).toEqual(R('0'));
    expect(normalizeMetric(null, zero, counter)).toBeNull();
    const binary: MetricRule = { ...rule, condition: { op: 'eq', target: '1' }, normalization: { kind: 'binary_condition_v1' } };
    expect(normalizeMetric('1', binary, metric)).toEqual(R('100'));
    expect(normalizeMetric('1.0001', binary, metric)).toEqual(R('0'));
    const range: MetricRule = { ...binary, condition: { op: 'range', min: '1', max: '2' } };
    for (const value of ['1', '2']) expect(normalizeMetric(value, range, metric)).toEqual(R('100'));
    for (const value of ['0.9999', '2.0001']) expect(normalizeMetric(value, range, metric)).toEqual(R('0'));
    expect(normalizeMetric(null, range, metric)).toBeNull();
    expect(testCondition('99.995', { op: 'gte', target: '100' })).toBe(false);
    expect(testCondition('0', { op: 'lte', target: '0' })).toBe(true);
  });

  it('rejects incompatible domains and configurations without a fallback', () => {
    const { rule, metric } = fixture();
    expect(() => normalizeMetric('-1', rule, metric)).toThrow();
    expect(() => normalizeMetric('1', rule, { ...metric, domain: 'signed_decimal' })).toThrow();
    const binary: MetricRule = { ...rule, condition: { op: 'eq', target: '-1' }, normalization: { kind: 'binary_condition_v1' } };
    expect(normalizeMetric('-1', binary, { ...metric, domain: 'signed_decimal' })).toEqual(R('100'));
    const decrease: MetricRule = { ...rule, condition: { op: 'lte', target: '10' }, normalization: { kind: 'decrease_ratio_capped_v1', maxPercent: '100' } };
    expect(() => normalizeMetric('2', decrease, metric)).toThrow();
    expect(() => normalizeMetric('2', { ...decrease, normalization: { kind: 'decrease_ratio_capped_v1', maxPercent: 'Infinity' } }, metric)).toThrow();
    expect(() => normalizeMetric('2', { ...rule, condition: { op: 'gte', target: '0' } }, metric)).toThrow();
    expect(() => normalizeMetric('1', { ...binary, condition: { op: 'range', min: '2', max: '1' } }, metric)).toThrow();
    expect(() => normalizeMetric('0.5', { ...rule, condition: { op: 'lte', target: '0' }, normalization: { kind: 'zero_counter_v1' } }, { ...metric, domain: 'nonnegative_integer' })).toThrow();
    expect(() => normalizeMetric('1.1', binary, { ...metric, domain: 'nonnegative_integer' })).toThrow();
    expect(() => Reflect.apply(normalizeMetric, undefined, ['1', { ...rule, normalization: { kind: 'unknown' } }, metric])).toThrow();
  });
});
