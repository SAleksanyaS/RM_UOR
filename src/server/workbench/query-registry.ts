import type { z } from 'zod';
import type { Clock, UUIDv4 } from '../../domain/workbench/index';
import type { OwnAccessProfile } from '../../features/identity/workbench-access-policy';
import type { WorkbenchRepository } from '../storage/workbench-repository';
import { fieldProblems, WorkbenchHttpError, type QueryRequest } from './protocol';

export type QueryContext = { requestId: UUIDv4; installationId: UUIDv4; repository: WorkbenchRepository; clock: Clock; ownAccess: OwnAccessProfile };
export type QueryDescriptor<P extends QueryRequest, R> = { name: string; inputSchema: z.ZodType<P>; outputSchema: z.ZodType<R>; handler: (context: QueryContext, input: P) => Promise<R> };
export class QueryRegistry {
  private readonly descriptors = new Map<string, QueryDescriptor<any, any>>();
  register<P extends QueryRequest, R>(descriptor: QueryDescriptor<P, R>): void {
    if (!/^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)*$/.test(descriptor.name) || this.descriptors.has(descriptor.name)) throw new Error('Duplicate or invalid query descriptor: ' + descriptor.name);
    if (!descriptor.inputSchema || !descriptor.outputSchema || typeof descriptor.handler !== 'function') throw new Error('Query requires schemas and handler');
    this.descriptors.set(descriptor.name, descriptor);
  }
  listNames(): string[] { return [...this.descriptors.keys()]; }
  async execute(name: string, request: QueryRequest, context: QueryContext): Promise<unknown> {
    const descriptor = this.descriptors.get(name);
    if (!descriptor) throw new WorkbenchHttpError(404, 'QUERY_NOT_FOUND', 'Query is not registered');
    if (name.startsWith('uor.') && context.ownAccess.role === 'viewer') throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'The preparation panel requires a curator profile');
    const input = descriptor.inputSchema.safeParse(request);
    if (!input.success) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Query validation failed', fieldProblems(input.error));
    return descriptor.outputSchema.parse(await descriptor.handler(context, input.data));
  }
}
