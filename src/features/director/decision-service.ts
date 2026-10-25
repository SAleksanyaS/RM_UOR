import { randomUUID } from 'node:crypto';
import type { Draft, Session } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { canonicalJson } from '../publishing/merge-object';
import { decisionEntitySchema, decisionSaveSchema, type DecisionSaveInput } from './decision-schema';

const signature = (context: ApplicationContext, session: Session) => canonicalJson({ catalog: context.db.get('catalog', 'active'), drafts: context.db.list<Draft>('drafts').filter(item => item.curatorId === session.curatorId).sort((a, b) => a.id.localeCompare(b.id)) });
export async function saveDecision(context: ApplicationContext, session: Session, raw: DecisionSaveInput) {
  if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Решения может изменять только куратор УОР', 403);
  const input = decisionSaveSchema.parse(raw), beforeSignature = signature(context, session);
  const catalog = await context.catalogs.readForSession(session);
  const original = input.id ? catalog.entities.find(item => item.id === input.id) : undefined;
  if (input.id && (!original || original.type !== 'decision')) throw new ActionError('Решение не найдено', 404);
  const previous = original ? decisionEntitySchema.parse(original) : null;
  if ((previous?.revision ?? null) !== input.baseRevision) throw new ActionError('Решение уже изменилось. Обновите данные перед сохранением. Введённые значения остаются в форме.', 409);
  if (input.decision.goalId && !catalog.goals.some(goal => goal.id === input.decision.goalId)) throw new ActionError('Цель не найдена', 404);
  const decision = decisionEntitySchema.parse({ ...input.decision, id: previous?.id ?? randomUUID(), type: 'decision', revision: randomUUID(), updatedBy: session.name, updatedAt: new Date().toISOString() });
  const draft = await context.catalogs.saveDraft(session, { kind: 'entity', id: decision.id, baseRevision: previous?.revision ?? null, patch: { ...decision } }, {
    beforeSave: () => { if (signature(context, session) !== beforeSignature) throw new ActionError('Каталог изменился во время сохранения. Обновите данные и повторите действие.', 409); },
    afterSave: () => context.catalogs.recordChange(session, previous ? decision.state === 'closed' && previous.state !== 'closed' ? 'decision_closed' : 'decision_updated' : 'decision_added', decision.id, decision.name, previous ? { ...previous } : {}, { ...decision }),
  });
  return { decision, draftId: draft.id };
}
