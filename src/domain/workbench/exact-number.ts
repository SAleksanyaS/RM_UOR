import type { Decimal, ExactNumber, IntString, Rational } from './primitives';
import { WorkbenchError } from './errors';

const integerPattern = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;

export function canonicalDecimal(input: string): Decimal {
  if (typeof input !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(input)) throw new WorkbenchError('INVALID_DECIMAL');
  const negative = input.startsWith('-');
  const [whole, fraction = ''] = (negative ? input.slice(1) : input).split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const trimmed = fraction.replace(/0+$/, '');
  const magnitude = integer + (trimmed ? '.' + trimmed : '');
  return negative && magnitude !== '0' ? '-' + magnitude : magnitude;
}

export function rational(numerator: IntString, denominator: IntString): Rational {
  if (!integerPattern.test(numerator) || !integerPattern.test(denominator)) throw new WorkbenchError('INVALID_INTEGER');
  let n = BigInt(numerator);
  let d = BigInt(denominator);
  if (d === 0n) throw new WorkbenchError('DIVISION_BY_ZERO');
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n;
  let b = d;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: (n / a).toString(), denominator: (d / a).toString() };
}

export function toRational(value: ExactNumber): Rational {
  if (typeof value !== 'string') return rational(value.numerator, value.denominator);
  const decimal = canonicalDecimal(value);
  const places = decimal.includes('.') ? decimal.length - decimal.indexOf('.') - 1 : 0;
  return rational(BigInt(decimal.replace('.', '')).toString(), (10n ** BigInt(places)).toString());
}

function parts(value: ExactNumber): [bigint, bigint] {
  const r = toRational(value);
  return [BigInt(r.numerator), BigInt(r.denominator)];
}

export function add(a: ExactNumber, b: ExactNumber): Rational {
  const [an, ad] = parts(a); const [bn, bd] = parts(b);
  return rational((an * bd + bn * ad).toString(), (ad * bd).toString());
}

export function subtract(a: ExactNumber, b: ExactNumber): Rational {
  const [bn, bd] = parts(b);
  return add(a, rational((-bn).toString(), bd.toString()));
}

export function multiply(a: ExactNumber, b: ExactNumber): Rational {
  const [an, ad] = parts(a); const [bn, bd] = parts(b);
  return rational((an * bn).toString(), (ad * bd).toString());
}

export function divide(a: ExactNumber, b: ExactNumber): Rational {
  const [an, ad] = parts(a); const [bn, bd] = parts(b);
  return rational((an * bd).toString(), (ad * bn).toString());
}

export function compare(a: ExactNumber, b: ExactNumber): -1 | 0 | 1 {
  const [an, ad] = parts(a); const [bn, bd] = parts(b);
  const difference = an * bd - bn * ad;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** Half-up means ties away from zero, for both signs. Arithmetic never rounds. */
export function formatExact(value: ExactNumber, places = 2): string {
  if (!Number.isSafeInteger(places) || places < 0 || places > 1000) throw new WorkbenchError('INVALID_PRECISION');
  const [n, d] = parts(value);
  const negative = n < 0n;
  const scaled = (negative ? -n : n) * (10n ** BigInt(places));
  const rounded = scaled / d + (2n * (scaled % d) >= d ? 1n : 0n);
  const digits = rounded.toString().padStart(places + 1, '0');
  const unsigned = places === 0 ? digits : canonicalDecimal(digits.slice(0, -places) + '.' + digits.slice(-places));
  return negative && rounded !== 0n ? '-' + unsigned : unsigned;
}
