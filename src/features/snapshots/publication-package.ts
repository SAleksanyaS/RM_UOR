import type { CuratorSession, LocalSnapshot } from '../../domain/contracts';
import { validateEvaluationBasis } from '../publishing/validate-version';
export interface PublicationFile { path: string; content: string }
export interface PublicationPackage { snapshotId: string; classification: LocalSnapshot['classification']; files: PublicationFile[]; manifest: Omit<LocalSnapshot, 'observations'> & { schemaVersion: 1 } }
const safeSegment = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(value)
  && !value.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);

/** A pure allowlist export; it never copies browser state, local files, or confirmation history. */
export function preparePublication(session: CuratorSession, snapshot: LocalSnapshot, publicationMode: 'demo-only' | 'internal'): PublicationPackage {
  if (session.role !== 'curator' || !session.curatorId) throw new Error('Публиковать проверенные данные может только куратор УОР');
  if (snapshot.status !== 'validated') throw new Error('Сначала подтвердите проверку данных и визуализации');
  if (!snapshot.curatorId || !snapshot.curatorName || !snapshot.validatedAt || !Number.isFinite(Date.parse(snapshot.validatedAt))) {
    throw new Error('Не указаны куратор и дата проверки набора данных');
  }
  if (!['demo-only', 'internal'].includes(publicationMode)) throw new Error('Неизвестный режим публикации');
  if (snapshot.classification !== 'demo' && snapshot.classification !== 'corporate') throw new Error('Не указана классификация данных');
  if (publicationMode === 'demo-only' && snapshot.classification === 'corporate') throw new Error('Корпоративные данные нельзя публиковать в демонстрационном репозитории');
  if (!safeSegment(snapshot.id) || !safeSegment(snapshot.sourceId)) throw new Error('Недопустимый идентификатор источника или снимка');
  if (!snapshot.observations.length) throw new Error('В проверенном снимке нет наблюдений');
  if (snapshot.observations.some(row => row.period !== snapshot.period)) throw new Error('Период наблюдений отличается от периода снимка');
  if (snapshot.observations.some(row => row.sourceId !== snapshot.sourceId)) throw new Error('Наблюдения относятся к другому источнику');
  const observations = snapshot.observations.map(row => ({
    id: row.id, goalId: row.goalId, leaderId: row.leaderId, participantId: row.participantId,
    participantName: row.participantName, metricId: row.metricId, metricName: row.metricName,
    value: row.value, target: row.target, unit: row.unit, state: row.state, reason: row.reason,
    period: row.period, sourceId: row.sourceId, sourceUpdatedAt: row.sourceUpdatedAt, downloadedAt: row.downloadedAt,
  }));
  const manifest: PublicationPackage['manifest'] = {
    schemaVersion: 1, id: snapshot.id, classification: snapshot.classification, sourceId: snapshot.sourceId,
    period: snapshot.period, collectedAt: snapshot.collectedAt, sourceUpdatedAt: snapshot.sourceUpdatedAt,
    origin: snapshot.origin, dataHash: snapshot.dataHash, status: snapshot.status, curatorId: snapshot.curatorId,
    curatorName: snapshot.curatorName, validatedAt: snapshot.validatedAt, limitations: [...snapshot.limitations],
    // Evidence is a separate reviewed publishing flow; local attachment paths never enter this package.
    evidenceIds: [],
    ...(snapshot.evaluationBasis ? { evaluationBasis: validateEvaluationBasis(snapshot.evaluationBasis) } : {}),
  };
  const base = `published/snapshots/${snapshot.sourceId}/${snapshot.id}`;
  return { snapshotId: snapshot.id, classification: snapshot.classification, manifest, files: [
    { path: `${base}/manifest.json`, content: JSON.stringify(manifest, null, 2) + '\n' },
    { path: `${base}/observations.json`, content: JSON.stringify(observations, null, 2) + '\n' },
  ] };
}
