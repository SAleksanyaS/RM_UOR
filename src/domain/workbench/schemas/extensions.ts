import { z } from 'zod';
import type { CustomFieldDef, CustomFieldValue } from '../entities/extensions';
import { WorkbenchError } from '../errors';
import { decimalSchema, entityRefSchema, headerShape, moscowDateSchema, positiveIntSchema, sha256Schema, utcInstantSchema, uuidSchema } from '../primitives';
import { idsSchema, publicUrlSchema, refOf, safeCountSchema, textSchema, unique } from './core';

export const customFieldDefSchema = z.strictObject({ ...headerShape, name: textSchema, entityTypes: z.array(textSchema).min(1).refine(v => unique(v)), valueType: z.enum(['text', 'long_text', 'decimal', 'boolean', 'date', 'enum', 'multi_enum']), enumValues: z.array(textSchema).min(1).refine(v => unique(v)).nullable() }).refine(v => ['enum', 'multi_enum'].includes(v.valueType) ? v.enumValues !== null : v.enumValues === null);
export const customFieldValueSchema = z.strictObject({ ...headerShape, objectRef: entityRefSchema, fieldRef: refOf('custom_field_def'), value: z.union([z.string(), z.array(z.string()), z.boolean(), z.null()]) });
export function validateCustomFieldValue(value: CustomFieldValue, definition: CustomFieldDef): void {
  const v = customFieldValueSchema.parse(value); const field = customFieldDefSchema.parse(definition);
  if (v.fieldRef.id !== field.id || v.fieldRef.revision !== field.revision || !field.entityTypes.includes(v.objectRef.entityType)) throw new WorkbenchError('CUSTOM_FIELD_DEFINITION_MISMATCH');
  validateCustomFieldScalar(field, v.value);
}
export function validateCustomFieldScalar(definition: CustomFieldDef, candidate: CustomFieldValue['value']): void {
  const field = customFieldDefSchema.parse(definition);
  if (candidate === null) return;
  const valid = (() => {
    switch (field.valueType) {
      case 'text': case 'long_text': return typeof candidate === 'string';
      case 'decimal': return decimalSchema.safeParse(candidate).success;
      case 'boolean': return typeof candidate === 'boolean';
      case 'date': return moscowDateSchema.safeParse(candidate).success;
      case 'enum': return typeof candidate === 'string' && field.enumValues!.includes(candidate);
      case 'multi_enum': return Array.isArray(candidate) && unique(candidate) && candidate.every(item => field.enumValues!.includes(item));
    }
  })();
  if (!valid) throw new WorkbenchError('INVALID_CUSTOM_FIELD_VALUE', { fieldId: field.id });
}
export const commentarySchema = z.strictObject({ ...headerShape, targetRef: entityRefSchema, text: textSchema });
export const fileArtifactRefSchema = z.strictObject({ artifactId: uuidSchema, hash: sha256Schema, mimeType: textSchema, bytes: safeCountSchema });
export const evidenceSchema = z.discriminatedUnion('kind', [z.strictObject({ ...headerShape, kind: z.literal('file'), file: fileArtifactRefSchema }), z.strictObject({ ...headerShape, kind: z.literal('url'), url: publicUrlSchema })]);
export const registeredPayloadSchema = z.strictObject({ schemaId: textSchema, schemaVersion: positiveIntSchema, value: z.record(z.string(), z.unknown()) });
export const dashboardDefSchema = z.strictObject({ ...headerShape, title: textSchema, blocks: z.array(z.strictObject({ id: uuidSchema, typeId: textSchema, settings: registeredPayloadSchema })).refine(v => unique(v, item => item.id)), filters: z.array(registeredPayloadSchema) });
export const businessCalendarSchema = z.strictObject({ ...headerShape, timeZone: z.literal('Europe/Moscow'), workingWeekdays: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)])).refine(v => unique(v)), exceptions: z.array(z.strictObject({ date: moscowDateSchema, working: z.boolean() })).refine(v => unique(v, item => item.date)) });
export const reminderSettingsSchema = z.strictObject({ ...headerShape, calendarId: uuidSchema, dailyAt: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), repeatEveryWorkdays: positiveIntSchema });
export const personalOwnerSchema = z.strictObject({ installationId: uuidSchema, profilePersonId: uuidSchema.nullable() });
export const notificationSubscriptionSchema = z.strictObject({ schemaVersion: z.literal(1), id: uuidSchema, owner: personalOwnerSchema, goalId: uuidSchema, enabled: z.boolean(), createdAt: utcInstantSchema });
export const notificationReadStateSchema = z.strictObject({ schemaVersion: z.literal(1), owner: personalOwnerSchema, eventId: uuidSchema, readAt: utcInstantSchema.nullable() });
