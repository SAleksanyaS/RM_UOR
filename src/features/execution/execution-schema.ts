import {readExecutionJournal,readJournalEntries,assertEntryOrder} from './execution-journal';
import { z } from 'zod';
import type { CatalogSnapshot, KnowledgeEntity } from '../../domain/contracts';
import { assertDependencyGraph } from './execution-model';
import type { ExecutionConfig, WorkPackage } from './execution-contracts';
const id = z.string().trim().min(1).max(500);
const text = z.string().trim().max(5000);
const hours = z.number().finite().nonnegative().max(1000000).nullable();
const scope = { goalId: id, leaderId: id.nullable() };
const packageFields = { ...scope, title: id, owner: id, dueDate: z.iso.date(), weight: z.number().finite().positive().max(1000000), effortHours: hours, dependencies: z.array(id).max(500) };
const configFields = { ...scope, capacityHours: hours, capacityPeriod: text, criticalService: text, product: text, mandatoryRequirement: text, cadenceDays: z.number().int().min(1).max(3650).nullable(), nextCheckDate: z.iso.date().nullable() };
export const packageInputSchema = z.object({ ...packageFields, id: id.optional(), baseRevision: id.nullable() }).strict();
export const configInputSchema = z.object({ ...configFields, id: id.optional(), baseRevision: id.nullable() }).strict().refine(v => !!v.cadenceDays === !!v.nextCheckDate, 'Для удержания укажите периодичность и дату следующей проверки').refine(v => v.capacityHours === null || v.capacityPeriod.length > 0, 'Для ёмкости укажите период и контур оценки');
const proof = { comment: text, evidence: text };
const proofRequired = (v: { comment: string; evidence: string }) => v.comment.length >= 5 || v.evidence.length >= 5;
export const completionInputSchema = z.object({ baseRevision: id, completed: z.boolean(), ...proof }).strict().refine(proofRequired, 'Нужен содержательный комментарий или ссылка на доказательство (минимум 5 символов)');
export const baselineInputSchema = z.object({ baseRevision: id }).strict();
export const checkInputSchema = z.object({ baseRevision: id, result: z.enum(['stable', 'regression', 'unknown']), ...proof }).strict().refine(proofRequired, 'Опишите проверку или приложите доказательство (минимум 5 символов)');
const completion = z.object({ id, at: z.iso.datetime({ offset: true }), actor: id, completed: z.boolean(), ...proof }).strict().refine(proofRequired);
const check = z.object({ id, at: z.iso.datetime({ offset: true }), actor: id, result: z.enum(['stable', 'regression', 'unknown']), ...proof }).strict().refine(proofRequired);
export const workPackageSchema = z.object({ id, revision: id, ...packageFields, baseline: z.object({ at: z.iso.datetime({ offset: true }), dueDate: z.iso.date(), weight: z.number().finite().positive(), effortHours: hours }).strict().nullable(), eventArchiveId:id.optional(), events: z.array(completion).max(300) }).strict();
export const executionConfigSchema = z.object({ id, revision: id, ...configFields, checkArchiveId:id.optional(), checks: z.array(check).max(300) }).strict()
  .refine(v => !!v.cadenceDays === !!v.nextCheckDate, 'Периодичность и дата проверки должны быть заданы вместе')
  .refine(v => v.capacityHours === null || v.capacityPeriod.length > 0, 'Для ёмкости требуется период и контур оценки');
export function readWorkPackage(entity: KnowledgeEntity,scope?:Pick<CatalogSnapshot,'entities'>): WorkPackage {const value=workPackageSchema.parse(JSON.parse(entity.body??'')),events=[...readJournalEntries(scope,value.eventArchiveId,{...value,kind:'events'}),...value.events] as WorkPackage['events'];assertEntryOrder(events);return{...value,events};}
export function readExecutionConfig(entity: KnowledgeEntity,scope?:Pick<CatalogSnapshot,'entities'>): ExecutionConfig {const value=executionConfigSchema.parse(JSON.parse(entity.body??'')),checks=[...readJournalEntries(scope,value.checkArchiveId,{...value,kind:'checks'}),...value.checks] as ExecutionConfig['checks'];assertEntryOrder(checks);return{...value,checks};}
/** Called before any shared version is accepted; body and outer reference cannot disagree. */
export function validateExecutionEntities(catalog: CatalogSnapshot) {
  const packages: WorkPackage[] = [], configs: ExecutionConfig[] = [];
  for(const entity of catalog.entities.filter(e=>e.type==='execution_journal')){const segment=readExecutionJournal(entity);if(!catalog.goals.some(goal=>goal.id===segment.goalId))throw new Error('Архив относится к неизвестной цели');if(segment.previousId&&!catalog.entities.some(previous=>previous.id===segment.previousId&&previous.type==='execution_journal'))throw new Error('Не найден предыдущий архивный сегмент');}
  for (const entity of catalog.entities.filter(e => e.type === 'work_package' || e.type === 'execution_config')) {
    const value = entity.type === 'work_package' ? readWorkPackage(entity,catalog) : readExecutionConfig(entity,catalog);
    if (entity.id !== value.id || entity.revision !== value.revision || entity.leaderId !== value.leaderId || entity.goalIds?.length !== 1 || entity.goalIds[0] !== value.goalId) throw new Error('Внешняя запись исполнения не соответствует содержимому');
    if (!catalog.goals.some(g => g.id === value.goalId)) throw new Error('Не найдена цель исполнения');
    if (value.leaderId && !catalog.assignments.some(a => a.goalId === value.goalId && a.leaderId === value.leaderId)) throw new Error('Не найдено назначение для контура исполнения');
    if (entity.type === 'work_package') {
      const p = value as WorkPackage;
      if (new Set(p.dependencies).size !== p.dependencies.length) throw new Error('Повторяются зависимости');
      if (p.events.some((e, i) => i > 0 && Date.parse(e.at) < Date.parse(p.events[i - 1].at))) throw new Error('Нарушен порядок событий исполнения');
      if (new Set(p.events.map(e => e.id)).size !== p.events.length) throw new Error('Повторяются события исполнения');
      packages.push(p);
    } else {
      const config = value as ExecutionConfig;
      if (new Set(config.checks.map(c => c.id)).size !== config.checks.length) throw new Error('Повторяются проверки удержания');
      if (config.checks.some((c, i) => i > 0 && Date.parse(c.at) < Date.parse(config.checks[i - 1].at))) throw new Error('Нарушен порядок проверок удержания');
      configs.push(config);
    }
  }
  assertDependencyGraph(packages);
  if (new Set(configs.map(c => JSON.stringify([c.goalId, c.leaderId]))).size !== configs.length) throw new Error('Повторяется конфигурация одного контура исполнения');
}
