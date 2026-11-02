import { z } from 'zod';
import type { QueryRegistry } from '../../../server/workbench/query-registry';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { ownQueryRequestSchema } from '../../../server/workbench/protocol';
import { templateSchema } from '../../../domain/workbench/schemas/core';
export function registerGoalBuilderQueries(queries: QueryRegistry, repository: WorkbenchRepository) { queries.register({ name: 'goal.templates', inputSchema: ownQueryRequestSchema.extend({ filter: z.strictObject({}) }), outputSchema: z.array(templateSchema), async handler() { return repository.readPublishedCatalog().filter(v => v.entityType === 'template').map(v => templateSchema.parse(v.value)); } }); }
