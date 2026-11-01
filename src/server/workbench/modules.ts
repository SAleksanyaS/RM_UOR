import type { z } from 'zod';
import type { Capability, OwnAccessProfile } from '../../features/identity/workbench-access-policy';
import type { CommandDescriptor } from './command-registry';
import type { QueryDescriptor } from './query-registry';
import { fieldProblems, WorkbenchHttpError } from './protocol';

export type NavigationItem = { route: string; label: string; order: number; screen: string; accessHint: Capability };
export type SchemaDescriptor = { schemaId: string; schemaVersion: number; ownerModuleId: string; inputSchema: z.ZodType };
// Hook implementations are static imported functions. Each owning module supplies its
// concrete domain port; the platform never interprets executable user settings.
export type PlatformModuleHooks = {
  navigation?: NavigationItem[];
  search?: { search: (...args: any[]) => unknown };
  customFields?: { describe: (...args: any[]) => unknown; validate: (...args: any[]) => unknown };
  dashboard?: Array<{ blockType: string; settingsSchemaRef: { schemaId: string; schemaVersion: number }; dataQuery: string; renderer: unknown }>;
  source?: { describe: (...args: any[]) => unknown; capture: (...args: any[]) => unknown };
  jobs?: unknown;
  history?: { list: (...args: any[]) => unknown; lineage: (...args: any[]) => unknown };
  publication?: { validateDraft: (...args: any[]) => unknown; describeImpact: (...args: any[]) => unknown; serializePackage: (...args: any[]) => unknown };
  backup?: { describeOwnedData: (...args: any[]) => unknown; exportSnapshot?: (...args: any[]) => unknown; validateRestore?: (...args: any[]) => unknown; restore?: (...args: any[]) => unknown };
  exportLater?: unknown;
};
export type PlatformModule = {
  id: string; version: string; platformContractVersion: number; dependsOn: string[];
  owns: { entityTypes: string[]; namespaces: string[] }; schemas: SchemaDescriptor[];
  queries: QueryDescriptor<any, any>[]; commands: CommandDescriptor<any, any>[]; hooks: PlatformModuleHooks;
};
const unsupported = (message: string): never => { throw new WorkbenchHttpError(422, 'SCHEMA_UNSUPPORTED', message); };
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
export function validateModules(modules: PlatformModule[]): void {
  const byId = new Map<string, PlatformModule>();
  const owners = new Set<string>(), queries = new Set<string>(), commands = new Set<string>(['job.cancel', 'job.retry', 'job.openAuth']), schemas = new Set<string>(), routes = new Set<string>(defaultWorkbenchNavigation.map(item => item.route)), labels = new Set<string>(defaultWorkbenchNavigation.map(item => item.label));
  const unique = (set: Set<string>, key: string, label: string) => { if (!key || set.has(key)) throw new Error('Duplicate or invalid ' + label + ': ' + key); set.add(key); };
  for (const module of modules) {
    if (Object.keys(module).some(key => !['id', 'version', 'platformContractVersion', 'dependsOn', 'owns', 'schemas', 'queries', 'commands', 'hooks'].includes(key))) unsupported('Unknown module manifest field');
    if (Object.keys(module.owns).some(key => !['entityTypes', 'namespaces'].includes(key)) || Object.keys(module.hooks).some(key => !['navigation', 'search', 'customFields', 'dashboard', 'source', 'jobs', 'history', 'publication', 'backup', 'exportLater'].includes(key))) unsupported('Unknown module owner or hook field');
    if (!/^[a-z][a-z0-9-]*$/.test(module.id)) unsupported('Invalid module id');
    if (module.platformContractVersion !== 1) unsupported('Unsupported platform contract version');
    if (!semver.test(module.version)) throw new Error('Invalid module version');
    if (byId.has(module.id)) throw new Error('Duplicate module id'); byId.set(module.id, module);
    for (const type of module.owns.entityTypes) { if (!/^[a-z][a-z0-9_]*$/.test(type)) unsupported('Invalid entity owner'); unique(owners, 'entity:' + type, 'entity owner'); }
    for (const namespace of module.owns.namespaces) {
      if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/.test(namespace)) unsupported('Invalid namespace owner');
      // Hierarchical namespaces cannot have different owners either.
      for (const existing of owners) if (existing.startsWith('namespace:') && (existing.slice(10).startsWith(namespace + '.') || namespace.startsWith(existing.slice(10) + '.'))) throw new Error('Overlapping namespace owner');
      unique(owners, 'namespace:' + namespace, 'namespace owner');
    }
    for (const query of module.queries) {
      unique(queries, query.name, 'query'); if (!query.inputSchema?.safeParse || !query.outputSchema?.safeParse || typeof query.handler !== 'function') unsupported('Invalid query descriptor');
    }
    for (const command of module.commands) {
      unique(commands, command.name, 'command'); if (!command.inputSchema?.safeParse || !command.outputSchema?.safeParse || typeof command.handler !== 'function') unsupported('Invalid command descriptor');
      if (command.name.includes('.local.') && (!command.name.startsWith(module.id + '.local.') || command.capability !== 'personal.write' || command.effect !== 'local')) unsupported('Local tools must use their module owner, personal.write and local effect');
    }
    for (const schema of module.schemas) {
      if (schema.ownerModuleId !== module.id || !schema.schemaId.startsWith(module.id + '.') || !Number.isSafeInteger(schema.schemaVersion) || schema.schemaVersion < 1 || !schema.inputSchema?.safeParse) unsupported('Invalid schema owner or version');
      unique(schemas, schema.schemaId + '/' + schema.schemaVersion, 'schema');
    }
    for (const item of module.hooks.navigation ?? []) {
      if (!item.route.startsWith('/') || !item.label.trim() || !Number.isFinite(item.order)) unsupported('Invalid navigation descriptor');
      unique(routes, item.route, 'navigation route'); unique(labels, item.label, 'navigation label');
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Cyclic module dependency'); if (visited.has(id)) return;
    const module = byId.get(id); if (!module) throw new Error('Missing module dependency: ' + id);
    visiting.add(id); const seen = new Set<string>();
    for (const dependency of module.dependsOn) { if (seen.has(dependency)) throw new Error('Duplicate module dependency'); seen.add(dependency); visit(dependency); }
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}
export function validateRegisteredPayload(modules: PlatformModule[], payload: { schemaId: string; schemaVersion: number; value: unknown }): unknown {
  const schema = modules.flatMap(module => module.schemas).find(schema => schema.schemaId === payload.schemaId && schema.schemaVersion === payload.schemaVersion);
  if (!schema) return unsupported('Unsupported registered schema');
  const parsed = schema.inputSchema.safeParse(payload.value);
  if (!parsed.success) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Registered payload validation failed', fieldProblems(parsed.error));
  return parsed.data;
}
export const defaultWorkbenchNavigation: readonly NavigationItem[] = [
  { route: '/overview', label: 'Обзор', order: 10, screen: 'overview', accessHint: 'business.read' },
  { route: '/goals', label: 'Цели', order: 20, screen: 'goals', accessHint: 'business.read' },
  { route: '/execution', label: 'Работы и решения', order: 30, screen: 'execution', accessHint: 'business.read' },
  { route: '/data', label: 'Данные', order: 40, screen: 'data', accessHint: 'business.read' },
  { route: '/uor', label: 'Панель УОР', order: 50, screen: 'uor', accessHint: 'uor.prepare' },
];
export function workbenchNavigation(modules: PlatformModule[], ownAccess: OwnAccessProfile): Array<NavigationItem & { enabled: boolean; disabledReason: string | null }> {
  const items = [...defaultWorkbenchNavigation, ...modules.flatMap(module => module.hooks.navigation ?? [])];
  return items.sort((a, b) => a.order - b.order).map(item => ({ ...item, enabled: !(item.accessHint === 'uor.prepare' && ownAccess.role === 'viewer'), disabledReason: item.accessHint === 'uor.prepare' && ownAccess.role === 'viewer' ? 'Подготовка доступна куратору УОР' : null }));
}
