import { z } from 'zod';
import { ownQueryRequestSchema, revisionTokenSchema } from '../../server/workbench/protocol';
import type { QueryRegistry } from '../../server/workbench/query-registry';
import { personalPreferencesSchema, type PreferencesService } from './workbench-preferences';

export const preferencesReadSchema = z.strictObject({ values: personalPreferencesSchema, editToken: revisionTokenSchema.nullable() });
export type PreferencesRead = z.infer<typeof preferencesReadSchema>;
/** This personal read has no business context and no caller-selected installation. */
export function registerPreferencesQueries(registry: QueryRegistry, preferences: PreferencesService): void {
  registry.register({ name: 'preferences.get', inputSchema: ownQueryRequestSchema.extend({ filter: z.strictObject({}), sort: z.array(z.never()).max(0) }), outputSchema: preferencesReadSchema,
    async handler(context) { return { values: preferences.get(context.installationId), editToken: preferences.editToken(context.installationId) }; },
  });
}
