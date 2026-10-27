import { z } from 'zod';
import { canonicalDecimal, rational } from './exact-number';

export type UUIDv4 = string;
export type PositiveInt = number;
export type Decimal = string;
export type IntString = string;
export type Rational = { numerator: IntString; denominator: IntString };
export type ExactNumber = Decimal | Rational;
export type UtcInstant = string;
export type MoscowDate = string;
export type Sha256 = string;
export type EntityRef = { entityType: string; id: UUIDv4 };
export type VersionRef = EntityRef & { revision: PositiveInt };
export type ScopeRef = { kind: 'dit' | 'cluster' | 'product' | 'team'; id: UUIDv4 };
export type ActorRef = { hostname: string; installationId: UUIDv4; profilePersonId: UUIDv4 | null };
export type Header = { schemaVersion: 1; id: UUIDv4; revision: PositiveInt; recordedAt: UtcInstant; actor: ActorRef; publicationAnchorId: UUIDv4 | null };
export type BusinessTime = { kind: 'as_of'; date: MoscowDate } | { kind: 'period'; startInclusive: MoscowDate; endExclusive: MoscowDate } | { kind: 'unknown' };
export type DateRange = { startInclusive: MoscowDate; endExclusive: MoscowDate | null };
export type EvaluationContext = { evaluatedAt: UtcInstant; businessTime: Exclude<BusinessTime, { kind: 'unknown' }> };
export type Clock = { now(): UtcInstant };

export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const positiveIntSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const decimalSchema = z.string().refine(value => {
  try { return canonicalDecimal(value) === value; } catch { return false; }
}, 'Expected canonical decimal');
export const intStringSchema = z.string().regex(/^(?:0|-[1-9]\d*|[1-9]\d*)$/);
export const rationalSchema = z.strictObject({ numerator: intStringSchema, denominator: z.string().regex(/^[1-9]\d*$/) }).refine(value => {
  try {
    const normalized = rational(value.numerator, value.denominator);
    return normalized.numerator === value.numerator && normalized.denominator === value.denominator;
  } catch { return false; }
}, 'Expected reduced rational');
export const exactNumberSchema = z.union([decimalSchema, rationalSchema]);
export const moscowDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const instant = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(instant.getTime()) && value >= '0001-01-01' && instant.toISOString().slice(0, 10) === value;
}, 'Expected existing calendar date');
export const utcInstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).refine(value => {
  const instant = new Date(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return Number.isFinite(instant.getTime()) && instant.toISOString() === canonical;
}, 'Expected UTC instant');
export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const entityRefSchema = z.strictObject({ entityType: z.string().regex(/^[a-z][a-z0-9_]*$/), id: uuidSchema });
export const versionRefSchema = entityRefSchema.extend({ revision: positiveIntSchema });
export const scopeRefSchema = z.strictObject({ kind: z.enum(['dit', 'cluster', 'product', 'team']), id: uuidSchema });
export const actorRefSchema = z.strictObject({ hostname: z.string().min(1), installationId: uuidSchema, profilePersonId: uuidSchema.nullable() });
export const headerShape = { schemaVersion: z.literal(1), id: uuidSchema, revision: positiveIntSchema, recordedAt: utcInstantSchema, actor: actorRefSchema, publicationAnchorId: uuidSchema.nullable() };
export const headerSchema = z.strictObject(headerShape);
export const businessTimeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('as_of'), date: moscowDateSchema }),
  z.strictObject({ kind: z.literal('period'), startInclusive: moscowDateSchema, endExclusive: moscowDateSchema }).refine(value => value.startInclusive < value.endExclusive),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export const dateRangeSchema = z.strictObject({ startInclusive: moscowDateSchema, endExclusive: moscowDateSchema.nullable() }).refine(value => value.endExclusive === null || value.startInclusive < value.endExclusive);
export const evaluationContextSchema = z.strictObject({ evaluatedAt: utcInstantSchema, businessTime: z.union([businessTimeSchema.options[0], businessTimeSchema.options[1]]) });

export function newUuid(): UUIDv4 { return globalThis.crypto.randomUUID(); }
