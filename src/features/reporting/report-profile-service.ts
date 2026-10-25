import { randomUUID } from 'node:crypto';
import type { Session, Draft } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { canonicalJson } from '../publishing/merge-object';
import { reportProfileSchema, reportProfileSaveSchema } from './report-profile-schema';

export async function saveReportProfile(context: ApplicationContext, session: Session, raw: unknown) {
  if (session.role !== 'curator' || !session.curatorId) throw new ActionError('Профиль отчёта может изменять только куратор УОР', 403);
  const input = reportProfileSaveSchema.parse(raw);
  const signature = () => canonicalJson({ catalog: context.db.get('catalog', 'active'), drafts: context.db.list<Draft>('drafts').filter(item => item.curatorId === session.curatorId).sort((a, b) => a.id.localeCompare(b.id)) });
  const before = signature(), catalog = await context.catalogs.readForSession(session);
  const original = input.id ? catalog.entities.find(item => item.id === input.id) : null;
  if (input.id && (!original || original.type !== 'report_profile')) throw new ActionError('Профиль не найден', 404);
  const previous = original ? reportProfileSchema.parse(original) : null;
  if ((previous?.revision ?? null) !== input.baseRevision) throw new ActionError('Профиль уже изменился. Обновите данные перед сохранением.', 409);
  if (input.profile.goalIds.some(id => !catalog.goals.some(goal => goal.id === id)) || input.profile.leaderIds.some(id => !catalog.leaders.some(leader => leader.id === id))) throw new ActionError('Выбранная цель или ИТ-лидер не найдены', 404);
  const profile = reportProfileSchema.parse({ ...input.profile, id: previous?.id ?? randomUUID(), type: 'report_profile', revision: randomUUID(), updatedAt: new Date().toISOString(), updatedBy: session.name });
  const draft = await context.catalogs.saveDraft(session, { kind: 'entity', id: profile.id, baseRevision: previous?.revision ?? null, patch: { ...profile } }, {
    beforeSave: () => { if (signature() !== before) throw new ActionError('Каталог изменился во время сохранения профиля', 409); },
    afterSave: () => context.catalogs.recordChange(session, 'report_profile_saved', profile.id, profile.name, previous ? { ...previous } : {}, { ...profile }),
  });
  return { profile, draftId: draft.id };
}
