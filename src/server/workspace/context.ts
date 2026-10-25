import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attestation, CatalogSnapshot, Evaluation, LocalSnapshot, Session, WorkspaceState, Draft, DomainChangeEvent, UpdateInfo } from '../../domain/contracts';
import { LocalDatabase } from '../storage/database';
import { OperationStore } from '../operations/operation-store';
import { resolveWorkspace, type WorkspacePaths } from './paths';
import { recoverWorkspaceMaintenance } from '../../features/workspace-maintenance/recovery';
import { CatalogStore } from '../../features/catalog/catalog-store';
import { RoleService, type CuratorRecord } from '../../features/identity/role-service';
import { evaluateGoal } from '../../features/evaluation/evaluate';
import { selectFacts, snapshotFreshness } from '../../features/snapshots/select-facts';
import { readLocalRelease } from '../../features/catalog/local-release';
import { validateCatalog, validateSnapshot } from '../../features/publishing/validate-version';
import { normalizeDirections } from '../../features/catalog/directions';
import { APP_VERSION } from '../../domain/app-version';
import { migrateStorage } from '../../features/system/backup-service';
import { canReadSnapshot } from '../../features/connectors/service';
import { storeValidatedTemplateBundle } from '../../features/report-templates/service';
import { stageEvidenceBundle,type EvidenceRecord } from '../../features/evidence/evidence-service';
import {readerCatalog,readerChange,readerSnapshot} from '../../features/identity/reader-projection';

export interface AppOptions {
  projectRoot: string; allowedRoots?: string[]; initialCatalog?: CatalogSnapshot; registry?: CuratorRecord[];
  repositoryUrl?: string; publicationMode?: 'demo-only' | 'internal'; startupCheck?: boolean;
}
export interface SiteConfig {
  allowedWorkspaceRoots: string[]; repositoryUrl: string; publicationMode: 'demo-only' | 'internal';
  publishedBranch: string; releaseBranch: string; port: number; clientPort: number; autoOpen: boolean;
  credentialHelper?: string;
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
export async function loadSite(projectRoot: string): Promise<SiteConfig> {
  const defaultConfig: SiteConfig = { allowedWorkspaceRoots: [projectRoot], repositoryUrl: '', publicationMode: 'demo-only', publishedBranch: 'main', releaseBranch: 'release/current', port: 4174, clientPort: 5173, autoOpen: true };
  return { ...defaultConfig, ...await readJson<Partial<SiteConfig>>(path.join(projectRoot, 'config/site.local.json'), {}) };
}
export class ApplicationContext {
  maintenance = process.env.UOR_UPDATE_BOOTSTRAP==='1';
  maintenanceRecoveryRequired = false;
  activeRequests = 0;
  private readonly background=new Set<Promise<unknown>>();
  trackBackground<T>(promise:Promise<T>):Promise<T>{this.background.add(promise);void promise.finally(()=>this.background.delete(promise)).catch(()=>{});return promise;}
  async waitBackground(){while(this.background.size)await Promise.allSettled([...this.background]);}
  installationId:string;
  readonly csrfToken = randomUUID();
  readonly catalogs: CatalogStore; readonly operations: OperationStore; readonly roles: RoleService;
  readonly cancelled = new Map<string, AbortController>();
  updates: UpdateInfo = { status: 'unavailable', checkedAt: null, currentCommit: null, remoteCommit: null, message: 'Проверка обновлений ещё не выполнена', changes: [] };
  constructor(readonly paths: WorkspacePaths, readonly db: LocalDatabase, readonly config: SiteConfig, registry: CuratorRecord[]) {
    this.installationId=db.get<string>('settings','installationId')??randomUUID();db.set('settings','installationId',this.installationId);
    this.catalogs = new CatalogStore(db); this.operations = new OperationStore(db); this.roles = new RoleService(db, registry);
    this.updates = db.get<UpdateInfo>('settings', 'updates') ?? this.updates;
  }
  visibleChanges(session:Session):DomainChangeEvent[]{const changes=this.db.list<DomainChangeEvent>('changes');return session.role==='curator'?changes:changes.filter(event=>this.db.get('shared-changes',event.id)).map(readerChange);}
  async state(session: Session): Promise<WorkspaceState> {
    const catalog = await this.catalogs.readForSession(session);
    const snapshots = this.db.list<LocalSnapshot>('snapshots').filter(s => catalog.sources.some(source => source.id === s.sourceId) && canReadSnapshot(s,session,this.installationId));
    const evaluations = this.evaluations(catalog, snapshots);
    const managing=session.role==='curator';
    const changes=this.visibleChanges(session).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,150);
    return { catalog:managing?catalog:readerCatalog(catalog), snapshots:managing?snapshots:snapshots.map(readerSnapshot), evaluations, attestations: this.db.list<Attestation>('attestations'), session,
      csrfToken: this.csrfToken, operations: this.operations.list().filter(operation=>managing||this.db.get<string>('operation-owners',operation.id)===session.id), changes,
      drafts: await this.catalogs.listDrafts(session), updates:managing?this.updates:{...this.updates,changes:this.updates.changes.map(readerChange)}, version: APP_VERSION,
      repository: { url: this.config.repositoryUrl, publishedBranch: this.config.publishedBranch, releaseBranch: this.config.releaseBranch, publicationMode: this.config.publicationMode } };
  }
  evaluations(catalog: CatalogSnapshot, snapshots: LocalSnapshot[]): Evaluation[] {
    const results: Evaluation[] = [];
    for (const goal of catalog.goals) {
      const activeAssignments = catalog.assignments.filter(a => a.goalId === goal.id && a.active !== false);
      const activeLeaders = new Set(activeAssignments.map(a => a.leaderId));
      const relevant = snapshots.filter(s => s.observations.some(row => row.goalId === goal.id));
      // A goal's current view uses one coherent period. Never merge periods into an invented aggregate.
      const periods = relevant.map(s => s.period).sort().reverse(); const period = periods[0] ?? new Date().toISOString().slice(0, 10);
      const leaders = [null, ...activeLeaders];
      for (const leaderId of leaders) {
        const bySource = new Map<string, LocalSnapshot>();
        for (const sourceId of new Set(relevant.map(s => s.sourceId))) {
          const candidates = relevant.filter(s => s.sourceId === sourceId && s.classification === catalog.classification);
          const selected = selectFacts({ mode: 'auto', goalId: goal.id, leaderId, period, sourceId,
            personal: candidates.filter(s => s.status === 'personal'), published: candidates.filter(s => s.status === 'validated'),
            freshnessHours: catalog.sources.find(s => s.id === sourceId)?.freshnessHours });
          if (selected.snapshot) bySource.set(sourceId, selected.snapshot);
        }
        const rows = [...bySource.values()].flatMap(s => s.observations).filter(row => row.goalId === goal.id);
        const observations = rows.filter(row => leaderId === null ? row.leaderId === null || activeLeaders.has(row.leaderId) : row.leaderId === leaderId);
        const assignments = activeAssignments.filter(a => leaderId === null || a.leaderId === leaderId);
        const dimensional = observations.some(row => row.metricId !== goal.id);
        const expectedParticipants = goal.measurement && goal.scopeType === 'global' && !activeAssignments.length ? ['global-dit'] : (goal.measurement || dimensional) && assignments.length && assignments.every(a => a.participantIds !== undefined)
          ? [...new Set(assignments.flatMap(a => a.participantIds!))] : undefined;
        const scopeRevision = JSON.stringify(assignments.map(a => ({ id: a.id, teams: [...a.teams].sort(), participantIds: a.participantIds ? [...a.participantIds].sort() : null, target: a.target ?? null })).sort((a, b) => a.id.localeCompare(b.id)));
        const evaluationInput = { goal, observations, period, leaderId, expectedParticipants,
          expectedMetricIds: goal.measurement ? goal.measurement.metrics.map(metric => metric.id) : dimensional ? goal.requiredMetricIds : undefined, scopeRevision };
        let evaluation = evaluateGoal(evaluationInput);
        const previous = this.db.get<Evaluation>('last-evaluations', `${goal.id}:${leaderId ?? 'all'}`);
        let attestations = this.db.list<Attestation>('attestations').filter(a => a.goalId === goal.id && a.leaderId === leaderId && !a.invalidatedAt);
        if (attestations.length) {
          for (const attestation of attestations.filter(a => evaluation.official === 'not_met' || a.fingerprint !== evaluation.fingerprint)) this.db.set('attestations', attestation.id, { ...attestation, invalidatedAt: new Date().toISOString(), invalidationReason: evaluation.official === 'not_met' ? 'Получен отрицательный расчётный результат' : 'Изменились факты, период, пороги или состав оценки' });
          attestations = attestations.filter(a => evaluation.official !== 'not_met' && a.fingerprint === evaluation.fingerprint);
        }
        const matching = attestations.find(a => a.fingerprint === evaluation.fingerprint);
        if (matching) evaluation = evaluateGoal({ ...evaluationInput, attestation: matching });
        if (!goal.measurement && dimensional && (expectedParticipants === undefined || !goal.requiredMetricIds?.length)) {
          evaluation.qualityFlags.push('unknown_coverage');
          if (evaluation.official === 'met') evaluation.official = 'unknown';
          if (evaluation.internal === 'met') evaluation.internal = 'unknown';
          evaluation.validation = 'not_required';
        }
        const sourceDates = [...bySource.values()].map(s => s.sourceUpdatedAt).filter((v): v is string => !!v);
        const stale = [...bySource.values()].some(s => {
          const source = catalog.sources.find(source => source.id === s.sourceId);
          return snapshotFreshness(s, source?.freshnessHours).isStale;
        });
        if (stale && observations.length) evaluation.qualityFlags.push('stale');
        if (!sourceDates.length && observations.length) evaluation.qualityFlags.push('source_date_unknown');
        if (stale && evaluation.validation === 'confirmed') evaluation.validation = 'pending';
        evaluation.snapshotIds = [...bySource.values()].map(s => s.id);
        results.push(evaluation);
        if (sessionlessChanged(previous, evaluation)) this.db.set('last-evaluations', `${goal.id}:${leaderId ?? 'all'}`, evaluation);
      }
    }
    return results;
  }
  async writeSnapshot(snapshot: LocalSnapshot, options: { mergeManual?: boolean } = {}) {
    const catalog = await this.catalogs.read();
    snapshot = validateSnapshot(snapshot, catalog);
    return this.db.transaction(() => {
      let accepted = snapshot;
      if (options.mergeManual && snapshot.origin === 'manual') {
        const previous = this.db.list<LocalSnapshot>('snapshots').filter(s => s.sourceId === snapshot.sourceId && s.period === snapshot.period).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
        const observations = [...(previous?.observations ?? []).filter(old => !snapshot.observations.some(row => row.goalId === old.goalId && row.leaderId === old.leaderId && row.metricId === old.metricId)), ...snapshot.observations];
        accepted = { ...snapshot, observations, dataHash: createHash('sha256').update(JSON.stringify(observations)).digest('hex') };
      }
      this.db.set('snapshots', accepted.id, accepted);
      return accepted;
    });
  }
  async initialize(options: AppOptions) {
    await recoverWorkspaceMaintenance(this.paths.runtimeRoot, this.db);
    const imported = options.initialCatalog ?? await readJson<CatalogSnapshot | null>(path.join(this.paths.runtimeRoot, 'imports/catalog.json'), null);
    let initial = imported ?? await readJson<CatalogSnapshot | null>(path.join(this.paths.projectRoot, 'catalog/catalog.json'), null)
      ?? await readJson<CatalogSnapshot | null>(path.join(this.paths.projectRoot, 'catalog/demo.json'), null);
    if (!initial) throw new Error('Нет каталога целей. Импортируйте карту или добавьте демонстрационный каталог.');
    const localRelease = !imported || this.config.publicationMode === 'internal' ? await readLocalRelease(this.paths.projectRoot, initial) : null;
    if (localRelease) initial = localRelease.catalog;
    initial = validateCatalog(initial);
    const importedSnapshots = (imported ? await readJson<LocalSnapshot[]>(path.join(this.paths.runtimeRoot, 'imports/snapshots.json'), []) : await readJson<LocalSnapshot[]>(path.join(this.paths.projectRoot, 'catalog/demo-snapshots.json'), []))
      .map(snapshot => validateSnapshot(snapshot, initial!));
    const importHash = createHash('sha256').update(JSON.stringify(initial)).digest('hex');
    const sharedEvidence:EvidenceRecord[]=[];
    for(const checked of localRelease?.evidence??[])sharedEvidence.push(await stageEvidenceBundle(this.paths.runtimeRoot,checked));
    this.db.transaction(() => {
      for(const evidence of sharedEvidence){const previous=this.db.get<EvidenceRecord>('evidence',evidence.id);if(previous&&(previous.sha256!==evidence.sha256||previous.size!==evidence.size))throw new Error('Идентификатор доказательства ссылается на другое содержимое');}
      if (!this.db.get('catalog', 'active') || this.db.get('settings', 'importHash') !== importHash) {
        this.db.set('catalog', 'active', normalizeDirections(initial!)); this.db.set('settings', 'importHash', importHash);
      }
      else this.db.set('catalog', 'active', normalizeDirections(this.db.get<CatalogSnapshot>('catalog', 'active')!));
      for (const snapshot of [...importedSnapshots, ...(localRelease?.snapshots ?? [])]) if (!this.db.get('snapshots', snapshot.id)) this.db.set('snapshots', snapshot.id, snapshot);
      for(const checked of localRelease?.templates??[])storeValidatedTemplateBundle(this,checked);
      for(const evidence of sharedEvidence)this.db.set('evidence',evidence.id,evidence);
      for (const attestation of localRelease?.attestations ?? []) if (!this.db.get('attestations', attestation.id)) this.db.set('attestations', attestation.id, attestation);
      for (const change of localRelease?.changes ?? []) {if (!this.db.get('changes', change.id)) this.db.set('changes', change.id, change);this.db.set('shared-changes',change.id,true);}
    });
    await this.operations.recoverInterrupted();
  }
}
function sessionlessChanged(before: Evaluation | null, after: Evaluation) { return !before || before.fingerprint !== after.fingerprint || before.official !== after.official || before.validation !== after.validation; }
export async function createContext(options: AppOptions): Promise<ApplicationContext> {
  const config = await loadSite(options.projectRoot);
  if (options.repositoryUrl !== undefined) config.repositoryUrl = options.repositoryUrl;
  if (options.publicationMode) config.publicationMode = options.publicationMode;
  const paths = await resolveWorkspace({ projectRoot: options.projectRoot, allowedRoots: options.allowedRoots ?? config.allowedWorkspaceRoots });
  for (const folder of ['imports', 'local-config', 'source-artifacts', 'exports', 'backups', 'evidence']) await mkdir(path.join(paths.runtimeRoot, folder), { recursive: true });
  const registry = options.registry ?? await readJson<CuratorRecord[]>(path.join(paths.runtimeRoot, 'local-config/curators.json'), []);
  const db = new LocalDatabase(paths.databasePath);
  try { await migrateStorage(db,paths.runtimeRoot); const context = new ApplicationContext(paths, db, config, registry); await context.initialize(options); return context; } catch (error) { db.close(); throw error; }
}
