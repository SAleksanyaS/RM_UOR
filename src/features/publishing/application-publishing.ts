import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attestation, CatalogSnapshot, CuratorSession, DomainChangeEvent, Draft, LocalSnapshot } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { canonicalJson, mergeObject } from './merge-object';
import { validateAttestation, validateCatalog, validateChangeEvent, validateSnapshot } from './validate-version';
import { getDirections, normalizeDirections } from '../catalog/directions';

const execute = promisify(execFile);
const folderFor = (kind: string) => ({ leader: 'leaders', goal: 'goals', assignment: 'assignments', comment: 'comments', source: 'sources', entity: 'entities', direction: 'directions' })[kind] ?? 'entities';
const safeId = (id: string) => {
  if (!id || /[\x00-\x1f]/.test(id)) throw new Error('Недопустимый идентификатор публикации');
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(id) && !id.includes('..') && !id.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)
    ? id : `object-${createHash('sha256').update(id).digest('hex')}`;
};
const markerId = (draft: Draft) => `publication-${safeId(draft.id)}-${createHash('sha256').update(canonicalJson({ change: draft.change, base: draft.base })).digest('hex').slice(0, 16)}`;
const markerFor = (draft: Draft) => `changes/${markerId(draft)}.json`;
function catalogItem(catalog: CatalogSnapshot | null, folder: string, id: string): Record<string, unknown> | null {
  const collections: Record<string, { id: string }[] | undefined> = catalog ? {
    leaders: catalog.leaders, goals: catalog.goals, assignments: catalog.assignments, comments: catalog.comments, sources: catalog.sources, entities: catalog.entities, directions: getDirections(catalog),
  } : {};
  return (collections[folder]?.find(item => item.id === id) as unknown as Record<string, unknown>) ?? null;
}

/** Establish a local clone baseline; never turn the first successful remote query into colleague changes. */
async function clonedPublishedCommit(context: ApplicationContext): Promise<string | null> {
  for (const ref of [`refs/heads/${context.config.publishedBranch}`, `refs/remotes/origin/${context.config.publishedBranch}`]) {
    try {
      const result = await execute('git', ['-C', context.paths.projectRoot, 'rev-parse', '--verify', `${ref}^{commit}`],
        { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      const commit = result.stdout.trim(); if (/^[a-f0-9]{40,64}$/i.test(commit)) return commit;
    } catch { /* An unpacked source folder may not have a clone ref. */ }
  }
  return null;
}

async function provider(context: ApplicationContext) {
  if (!context.config.repositoryUrl) throw new Error('Репозиторий не настроен. Укажите адрес в локальной конфигурации.');
  const { GitCliProvider } = await import('./git-cli-provider');
  return new GitCliProvider({ projectRoot: context.paths.projectRoot, runtimeRoot: context.paths.runtimeRoot, url: context.config.repositoryUrl, publishedBranch: context.config.publishedBranch, releaseBranch: context.config.releaseBranch, credentialHelper: context.config.credentialHelper });
}
export async function checkRemoteUpdates(context: ApplicationContext, operationId?: string) {
  try {
    const git = await provider(context);
    if (operationId) await context.operations.stage(operationId, { key: 'check_git', label: 'Сравниваем опубликованную версию' });
    let baseline = context.db.get<string>('settings', 'publishedCommit');
    if (!baseline) {
      baseline = await clonedPublishedCommit(context);
      if (baseline) context.db.set('settings', 'publishedCommit', baseline);
    }
    context.updates = await git.checkUpdates(context.config.publishedBranch, baseline);
    context.db.set('settings', 'updates', context.updates);
    if (operationId) await context.operations.finish(operationId, { status: context.updates.status === 'unavailable' ? 'failed' : 'completed', message: context.updates.message });
  } catch (error) {
    context.updates = { ...context.updates, status: 'unavailable', checkedAt: new Date().toISOString(), message: (error as Error).message };
    if (operationId) await context.operations.finish(operationId, { status: 'failed', message: context.updates.message });
  }
}
function parsed<T>(files: Record<string, string>, file: string): T | null { return files[file] ? JSON.parse(files[file]) as T : null; }
export async function syncPublished(context: ApplicationContext) {
  const git = await provider(context); const version = await git.readVersion(context.config.publishedBranch);
  const current = await context.catalogs.read();
  const remoteInput = parsed<unknown>(version.files, 'catalog/catalog.json') ?? parsed<unknown>(version.files, 'catalog/demo.json');
  const remoteBase = remoteInput ? validateCatalog(remoteInput) : null;
  // Public demo code updates must never replace a user's private imported map.
  const catalog = normalizeDirections(remoteBase && remoteBase.classification === current.classification ? remoteBase : current);
  const acceptRemoteCatalog = (!remoteBase || remoteBase.classification === current.classification)
    && !(current.classification === 'corporate' && context.config.publicationMode === 'demo-only');
  const collections: Record<string, { id: string }[]> = { leaders: catalog.leaders, goals: catalog.goals, assignments: catalog.assignments, sources: catalog.sources, entities: catalog.entities, comments: catalog.comments, directions: catalog.directions! };
  for (const [file, content] of Object.entries(version.files)) {
    const match = file.match(/^catalog\/(leaders|goals|assignments|sources|entities|comments|directions)\/[^/]+\.json$/);
    if (match && acceptRemoteCatalog) {
      const item = JSON.parse(content) as { id: string; classification?: string };
      if (!item.id || (catalog.classification === 'corporate' && remoteBase?.classification === 'demo' && !collections[match[1]].some(i => i.id === item.id))) continue;
      const list = collections[match[1]]; const index = list.findIndex(i => i.id === item.id);
      if (index >= 0) list[index] = item; else list.push(item);
    }
  }
  const validatedCatalog = validateCatalog(catalog);
  const incomingChanges: DomainChangeEvent[] = [];
  const incomingAttestations: Attestation[] = [];
  const incomingSnapshots: LocalSnapshot[] = [];
  // Parse and validate the complete version before opening a write transaction.
  for (const [file, content] of Object.entries(version.files)) {
    if (file.startsWith('changes/') && file.endsWith('.json')) incomingChanges.push(validateChangeEvent(JSON.parse(content)));
    if (acceptRemoteCatalog && file.startsWith('published/attestations/') && file.endsWith('.json'))
      incomingAttestations.push(validateAttestation(JSON.parse(content), validatedCatalog));
    if (acceptRemoteCatalog && /^published\/snapshots\/.+\/manifest\.json$/.test(file)) {
      const rows = parsed<unknown>(version.files, file.replace(/manifest\.json$/, 'observations.json'));
      if (!rows) throw new Error(`У опубликованного снимка отсутствуют наблюдения: ${file}`);
      const snapshot = validateSnapshot({ ...JSON.parse(content), observations: rows }, validatedCatalog);
      if (snapshot.status !== 'validated') throw new Error('Опубликованный снимок не проверен куратором УОР');
      incomingSnapshots.push(snapshot);
    }
  }
  context.db.transaction(() => {
    context.db.set('catalog', 'active', validatedCatalog);
    for (const event of incomingChanges) context.db.set('changes', event.id, event);
    for (const item of incomingAttestations) {
      const previous = context.db.get<Attestation>('attestations', item.id);
      context.db.set('attestations', item.id, previous?.invalidatedAt
        ? { ...item, invalidatedAt: previous.invalidatedAt, invalidationReason: previous.invalidationReason } : item);
    }
    for (const snapshot of incomingSnapshots) context.db.set('snapshots', snapshot.id, snapshot);
    // A marker travels in exactly the same commit as the object. Once present in
    // main, the released local overlay must stop masking subsequent remote edits.
    if (acceptRemoteCatalog) for (const draft of context.db.list<Draft>('drafts').filter(item => item.status === 'published')) {
      const remoteItem = catalogItem(catalog, folderFor(draft.change.kind), draft.change.id);
      const samePatch = remoteItem && Object.entries(draft.change.patch).every(([field, value]) => canonicalJson(remoteItem[field]) === canonicalJson(value));
      if (version.files[markerFor(draft)] || samePatch) {
        context.db.set('draft-history', draft.id, { ...draft, incorporatedCommit: version.commit });
        context.db.remove('drafts', draft.id);
      }
    }
    context.db.set('settings', 'publishedCommit', version.commit);
  });
  context.updates = { status: 'current', checkedAt: new Date().toISOString(), currentCommit: version.commit, remoteCommit: version.commit, message: 'Опубликованная версия получена', changes: [] };
  context.db.set('settings', 'updates', context.updates);
}
export async function publishChanges(context: ApplicationContext, session: CuratorSession, operationId: string, draftIds?: string[]) {
  try {
    if (session.role !== 'curator' || !session.curatorId) throw new Error('Публикация доступна только куратору УОР');
    const catalog = await context.catalogs.readForSession(session);
    if (catalog.classification === 'corporate' && context.config.publicationMode === 'demo-only') throw new Error('Рабочая карта и корпоративные данные сохраняются локально. Для их отправки подключите корпоративный репозиторий с внутренним режимом публикации. В публичный RM_UOR отправляется код и демонстрационный набор.');
    const drafts = (await context.catalogs.listDrafts(session)).filter(d => !draftIds || draftIds.includes(d.id));
    const files: { path: string; content: string; baseContent?: string | null }[] = [];
    await context.operations.stage(operationId, { key: 'merge', label: 'Получаем релизную ветку и объединяем изменения' });
    const git = await provider(context);
    let release;
    try { release = await git.readVersion(context.config.releaseBranch); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('нет ветки')) throw error;
      release = await git.readVersion(context.config.publishedBranch);
    }
    const embeddedInput = parsed<CatalogSnapshot>(release.files, 'catalog/catalog.json') ?? parsed<CatalogSnapshot>(release.files, 'catalog/demo.json');
    const embedded = embeddedInput ? normalizeDirections(embeddedInput) : null;
    const publicationEvents: DomainChangeEvent[] = [];
    const publishedObjects = new Map<string, Record<string, unknown>>();
    for (const draft of drafts) {
      const folder = folderFor(draft.change.kind);
      let item: Record<string, unknown> = { ...draft.base, ...draft.change.patch, id: draft.change.id };
      const existingPath = Object.entries(release.files).find(([file, content]) => {
        if (!file.startsWith(`catalog/${folder}/`) || !file.endsWith('.json')) return false;
        try { return JSON.parse(content).id === draft.change.id; } catch { return false; }
      })?.[0];
      const file = existingPath ?? `catalog/${folder}/${safeId(draft.change.id)}.json`;
      let baseContent = draft.base ? JSON.stringify(draft.base, null, 2) : null;
      if (existingPath && draft.change.kind === 'goal' && draft.base
        && !Object.hasOwn(JSON.parse(release.files[existingPath]), 'workDirectionId')) {
        // A normalized legacy default was not a persisted remote field. Treat
        // its first explicit save as an addition, rather than a remote deletion.
        const compatibleBase = { ...draft.base }; delete compatibleBase.workDirectionId;
        baseContent = JSON.stringify(compatibleBase, null, 2);
      }
      if (!Object.hasOwn(release.files, file)) {
        const remoteEmbedded = embedded?.classification === catalog.classification ? catalogItem(embedded, folder, draft.change.id) : null;
        if (draft.base && remoteEmbedded) item = mergeObject(draft.base, item, remoteEmbedded) as typeof item;
        // Initial seed objects live in catalog/demo.json. Their first standalone
        // file is a new Git path, even when the business object already existed.
        baseContent = null;
      }
      files.push({ path: file, content: JSON.stringify(item, null, 2), baseContent });
      publishedObjects.set(draft.id, item);
      const event: DomainChangeEvent = { id: markerId(draft), kind: 'catalog_published', objectId: draft.change.id,
        objectLabel: typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : draft.change.id,
        actor: session.name, at: new Date().toISOString(), operationId,
        fields: Object.entries(draft.change.patch).map(([field, value]) => ({ field, before: draft.base?.[field] ?? null, after: value })) };
      publicationEvents.push(event);
      files.push({ path: markerFor(draft), content: JSON.stringify(event, null, 2), baseContent: null });
    }
    const availableDirections = new Set(embedded ? getDirections(embedded).map(direction => direction.id) : []);
    for (const [file, content] of Object.entries(release.files)) if (/^catalog\/directions\/[^/]+\.json$/.test(file)) {
      const direction = JSON.parse(content) as { id: string }; availableDirections.add(direction.id);
    }
    for (const draft of drafts.filter(item => item.change.kind === 'direction')) availableDirections.add(draft.change.id);
    for (const draft of drafts.filter(item => item.change.kind === 'goal')) {
      const required = publishedObjects.get(draft.id)?.workDirectionId;
      if (typeof required === 'string' && !availableDirections.has(required))
        throw new Error(`Сначала включите в публикацию направление «${getDirections(catalog).find(direction => direction.id === required)?.name ?? required}». Локальные черновики сохранены.`);
    }
    const availableLeaders = new Set(embedded?.leaders.map(leader => leader.id) ?? []);
    for (const [file, content] of Object.entries(release.files)) if (/^catalog\/leaders\/[^/]+\.json$/.test(file)) availableLeaders.add((JSON.parse(content) as { id: string }).id);
    for (const draft of drafts.filter(item => item.change.kind === 'leader')) availableLeaders.add(draft.change.id);
    for (const draft of drafts) {
      const required = publishedObjects.get(draft.id)?.leaderId;
      if (typeof required === 'string' && !availableLeaders.has(required))
        throw new Error(`Сначала включите в публикацию ИТ-лидера «${catalog.leaders.find(leader => leader.id === required)?.name ?? required}». Локальные черновики сохранены.`);
    }
    // Validate the version that recipients will actually receive, including only
    // selected drafts. A curator's unselected local goal/source is not shared yet.
    const publicationCandidate = normalizeDirections(structuredClone(embedded?.classification === catalog.classification ? embedded : await context.catalogs.read()));
    const publicationCollections: Record<string, { id: string }[]> = { leaders: publicationCandidate.leaders, goals: publicationCandidate.goals,
      assignments: publicationCandidate.assignments, sources: publicationCandidate.sources, entities: publicationCandidate.entities,
      comments: publicationCandidate.comments, directions: publicationCandidate.directions! };
    const includeObject = (folder: string, item: { id: string }) => {
      const list = publicationCollections[folder], index = list.findIndex(current => current.id === item.id);
      if (index < 0) list.push(item); else list[index] = item;
    };
    for (const [file, content] of Object.entries(release.files)) {
      const match = file.match(/^catalog\/(leaders|goals|assignments|sources|entities|comments|directions)\/[^/]+\.json$/);
      if (match) includeObject(match[1], JSON.parse(content) as { id: string });
    }
    for (const draft of drafts) includeObject(folderFor(draft.change.kind), publishedObjects.get(draft.id)! as { id: string });
    validateCatalog(publicationCandidate);
    const validated = context.db.list<LocalSnapshot>('snapshots').filter(s => s.status === 'validated' && s.curatorId === session.curatorId && !context.db.get('published-items', `snapshot:${s.id}`));
    const { preparePublication } = await import('../snapshots/publication-package');
    for (const snapshot of validated) files.push(...preparePublication(session, validateSnapshot(snapshot, publicationCandidate), context.config.publicationMode).files);
    const attestations = context.db.list<Attestation>('attestations').filter(a => a.curatorId === session.curatorId && !a.invalidatedAt && !context.db.get('published-items', `attestation:${a.id}`));
    for (const attestation of attestations) {
      validateAttestation(attestation, publicationCandidate);
      files.push({ path: `published/attestations/${safeId(attestation.goalId)}/${safeId(attestation.id)}.json`, content: JSON.stringify(attestation, null, 2), baseContent: null });
      for (const evidenceId of attestation.evidenceIds) {
        const evidence = context.db.get<{ id: string; relativePath: string; name: string }>('evidence', evidenceId);
        if (evidence) files.push({ path: `published/evidence/${safeId(evidence.id)}.json`, content: JSON.stringify({ ...evidence, base64: (await readFile(path.join(context.paths.runtimeRoot, evidence.relativePath))).toString('base64') }, null, 2), baseContent: null });
      }
    }
    const pendingChanges = context.db.list<DomainChangeEvent>('changes').filter(c => c.actor === session.name && !context.db.get('published-items', `change:${c.id}`));
    for (const change of pendingChanges) files.push({ path: `changes/${safeId(change.id)}.json`, content: JSON.stringify(change, null, 2), baseContent: null });
    if (!files.length) throw new Error('Нет новых изменений для отправки');
    const uniqueFiles = new Map<string, typeof files[number]>();
    for (const file of files) {
      const previous = uniqueFiles.get(file.path);
      if (previous && previous.content !== file.content) throw new Error(`Разные версии файла ${file.path} в одной публикации; черновики сохранены.`);
      uniqueFiles.set(file.path, file);
    }
    const result = await git.pushChanges({ files: [...uniqueFiles.values()], actor: { name: session.name }, classification: catalog.classification, publicationMode: context.config.publicationMode });
    context.db.transaction(() => {
      for (const draft of drafts) {
        const latest = context.db.get<Draft>('drafts', draft.id);
        if (!latest) continue;
        if (canonicalJson({ change: latest.change, base: latest.base }) === canonicalJson({ change: draft.change, base: draft.base }))
          context.db.set('drafts', draft.id, { ...latest, status: 'published', error: null });
        else {
          const published = publishedObjects.get(draft.id)!;
          const patch = Object.fromEntries(Object.entries(latest.change.patch).filter(([field, value]) => canonicalJson(value) !== canonicalJson(published[field])));
          context.db.set('drafts', draft.id, { ...latest, base: published, status: 'local', error: null,
            change: { ...latest.change, baseRevision: typeof published.revision === 'string' ? published.revision : null, patch } });
        }
      }
      for (const event of publicationEvents) {
        context.db.set('changes', event.id, event);
        context.db.set('published-items', `change:${event.id}`, result.remoteCommit);
      }
      for (const snapshot of validated) context.db.set('published-items', `snapshot:${snapshot.id}`, result.remoteCommit);
      for (const item of attestations) context.db.set('published-items', `attestation:${item.id}`, result.remoteCommit);
      for (const item of pendingChanges) context.db.set('published-items', `change:${item.id}`, result.remoteCommit);
    });
    await context.operations.finish(operationId, { status: 'completed', message: `Отправлено в ${context.config.releaseBranch}. Пользователи получат изменения после выпуска руководителем УОР.`, details: [result.remoteCommit] });
  } catch (error) {
    await context.operations.finish(operationId, { status: 'failed', message: (error as Error).message, details: ['Локальные черновики сохранены'] });
  }
}
