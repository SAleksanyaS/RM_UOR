import { WorkbenchBrowserScenarioWizard } from '../../connectors/workbench/BrowserScenarioWizard';
import { useEffect, useRef, useState } from 'react';
import type { EntityRef, VersionRef } from '../../../domain/workbench/primitives';
import type { SourceDefinition } from '../../../domain/workbench/entities';
import type { FormDescription } from '../../knowledge/workbench-fields';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { CommandRequest, CommandResult } from '../../../server/workbench/protocol';
import { useGlobalContext, useWorkbench } from '../../../app/workbench/context';
import { MappingEditor, type MappingDefinition, type MappingMetricHint } from './MappingEditor';
import { dataError, dataPageRequest, definitiveDataRejection, useRetainedDataQuery as useWorkbenchQuery } from './data-client';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import type { SourceMappingHints } from '../../evaluation/workbench/private-preview-contracts';
import { defaultParsingProfile } from '../../connectors/workbench/ParsingProfileForm';

type SourceDefinitionValue = Partial<Pick<SourceDefinition, 'goalId' | 'kind' | 'mappingRef' | 'publicLocator' | 'browserScenarioRef'>>;
type DraftOpened = { draftId: string; objectId: string; entityRef: EntityRef; editToken: string };
type DraftSaved = { draftId: string; versionRef: VersionRef; complete: boolean };
export function WorkbenchSourceSetupWizard({ sourceRef, goalRef, packageRef: suppliedPackage, metricHints: suppliedHints, onClose, rechecking = false }: { sourceRef?: EntityRef; goalRef: EntityRef; packageRef?: EntityRef; metricHints?: SourceMappingHints; onClose(): void; rechecking?: boolean }) {
  const dialog = useRef<HTMLElement | null>(null), closeButton = useRef<HTMLButtonElement | null>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); if (opener?.isConnected) opener.focus(); };
  }, []);
  const { context } = useGlobalContext();
  const [selectedPackage, selectPackage] = useState('');
  const queue = useWorkbenchQuery<WorkbenchReadModels['uor.queue']>('uor.queue', context ? { ...dataPageRequest, context } : null);
  const packages = queue.data?.items.filter(item => !['merged', 'declined', 'publishing', 'validating'].includes(item.publication?.state ?? 'draft')) ?? [];
  const ownPackage = useWorkbenchQuery<WorkbenchReadModels['uor.package']>('uor.package', context && suppliedPackage ? { ...dataPageRequest, context, filter: { packageRef: suppliedPackage } } : null);
  const packageItem = suppliedPackage ? ownPackage.data?.summary ?? null : packages.find(item => item.packageRef.id === selectedPackage) ?? (packages.length === 1 ? packages[0] : null);
  const packageRef = suppliedPackage ? ownPackage.data?.summary.packageRef ?? null : packageItem?.packageRef ?? null;
  const packageFilter = packageRef ? { packageRef } : {};
  const form = useWorkbenchQuery<FormDescription>('forms.describe', context && (suppliedPackage ? ownPackage.data : queue.data && (packages.length < 2 || packageRef)) ? { ...dataPageRequest, context, filter: { formKind: 'source_definition', ...(sourceRef ? { ref: sourceRef } : {}), ...packageFilter } } : null);
  const source = form.data?.values as SourceDefinitionValue | null;
  const mapping = useWorkbenchQuery<FormDescription>('forms.describe', context && source?.mappingRef ? { ...dataPageRequest, context, filter: { formKind: 'source_field_mapping', ref: { entityType: source.mappingRef.entityType, id: source.mappingRef.id }, ...packageFilter } } : null);
  const goal = useWorkbenchQuery<WorkbenchReadModels['goals.detail']>('goals.detail', context && !suppliedPackage ? { ...dataPageRequest, context: { ...context, goalId: goalRef.id } } : null);
  const draftGoal = useWorkbenchQuery<FormDescription>('forms.describe', context && suppliedPackage && packageRef ? { ...dataPageRequest, context, filter: { formKind: 'core_goal_definition', ref: goalRef, packageRef } } : null);
  // Only the supplied goal's exact standalone binding may supply private hints.
  // Missing/incomplete bindings stay incomplete; another package method is never guessed.
  const ownAssignments = ownPackage.data?.entries.filter(entry => entry.entityRef.entityType === 'goal_assignment' && entry.definition.goalId === goalRef.id) ?? [];
  const ownAssignment = ownAssignments.length === 1 ? ownAssignments[0] : null;
  const ownBinding = ownAssignment?.definition.methodBinding as { kind?: string; methodRef?: VersionRef } | undefined;
  const ownMethod = ownBinding?.kind === 'standalone' && ownBinding.methodRef ? ownPackage.data?.entries.find(entry => entry.entityRef.entityType === ownBinding.methodRef!.entityType && entry.entityRef.id === ownBinding.methodRef!.id && entry.versionRef.revision === ownBinding.methodRef!.revision) : null;
  const ownGoal = ownPackage.data?.entries.find(entry=>entry.entityRef.entityType==='core_goal_definition'&&entry.entityRef.id===goalRef.id);
  const verifiedHints = suppliedHints && suppliedHints.packageId === packageRef?.id && suppliedHints.goalRef.id === goalRef.id && suppliedHints.goalRef.revision === ownGoal?.versionRef.revision && suppliedHints.assignmentRef.id === ownAssignment?.entityRef.id && suppliedHints.assignmentRef.revision === ownAssignment.versionRef.revision ? suppliedHints.metrics : null;
  const methods = suppliedPackage ? ownMethod?.complete ? [ownMethod.definition as unknown as import('../../../domain/workbench/entities').MethodVersion] : [] : goal.data?.tabs.method ?? [];
  const mappingRef = source?.mappingRef ?? null;
  const ready = form.data && (suppliedPackage ? draftGoal.data : goal.data) && (mappingRef ? mapping.data : true);
  return <div className="wb-dialog-backdrop"><section ref={dialog} role="dialog" aria-modal="true" aria-label="Настройка источника" className="wb-data-dialog"><h2>Настройка источника</h2><button ref={closeButton} type="button" onClick={onClose}>Закрыть настройку</button>
    {!suppliedPackage && packages.length > 1 && <label>Пакет УОР<select value={packageRef?.id ?? ''} onChange={e => selectPackage(e.target.value)}><option value="">Выберите пакет для настройки</option>{packages.map((item, index) => <option key={item.packageRef.id} value={item.packageRef.id}>Пакет {index + 1}, редакция {item.revision} ({item.packageRef.id})</option>)}</select></label>}
    {(queue.error !== null || ownPackage.error !== null || draftGoal.error !== null || form.error !== null || mapping.error !== null) && <p role="alert">{dataError(ownPackage.error || draftGoal.error || queue.error || form.error || mapping.error, 'read')}</p>}
    {suppliedPackage && ownPackage.data && !ownMethod?.complete && !verifiedHints && source?.kind !== 'manual_status' && <p>Сначала завершите методику цели. Соответствие показателей пока не определено.</p>}
    {!ready ? <p>Загружаем настройку и собственные черновики…</p> : <SetupForm key={JSON.stringify([goalRef, sourceRef, context, packageRef?.id ?? 'new'])} sourceRef={sourceRef} goalRef={goalRef} packageRef={packageRef} baseRevision={form.data?.editToken ?? packageItem?.editToken ?? null} checking={rechecking || queue.loading || form.loading || mapping.loading || goal.loading || ownPackage.loading || draftGoal.loading} metricHints={verifiedHints ?? methods.flatMap(method => method.mode === 'numeric' ? method.rules.map(rule => ({ metricId: rule.metricRef.id, fields: rule.reducer.kind === 'count' ? [] : rule.reducer.kind === 'ratio' ? [rule.reducer.numeratorField, rule.reducer.denominatorField] : [rule.reducer.valueField] })) : [])} previewAssignmentRef={ownAssignment?.versionRef ?? undefined} initialSource={source ?? { goalId: goalRef.id, kind: 'qlik', mappingRef: null, publicLocator: null }} initialMapping={mapping.data?.values as MappingDefinition | null ?? { sourceId: sourceRef?.id ?? goalRef.id, rowKeyFields: [], dimensionFields: {}, productKeyField: null, fixedScope: null, metricFields: verifiedHints ? verifiedHints.map(hint=>({metricId:hint.metricId,fields:Object.fromEntries(hint.fields.map(field=>[field,'']))})) : methods.flatMap(method => method.mode === 'numeric' ? method.rules.map(rule => ({ metricId: rule.metricRef.id, fields: Object.fromEntries((rule.reducer.kind === 'count' ? [] : rule.reducer.kind === 'ratio' ? [rule.reducer.numeratorField, rule.reducer.denominatorField] : [rule.reducer.valueField]).map(name => [name, ''])) })) : []), dateField: null, periodStartField: null, periodEndField: null, unitField: null, fixedUnitCode: null, parsingProfile: defaultParsingProfile }} mappingRef={mappingRef} />}
  </section></div>;
}
function SetupForm({ sourceRef, goalRef, initialSource, initialMapping, mappingRef, packageRef, baseRevision, metricHints, checking, previewAssignmentRef }: { previewAssignmentRef?: VersionRef; sourceRef?: EntityRef; goalRef: EntityRef; initialSource: SourceDefinitionValue; initialMapping: MappingDefinition; mappingRef: VersionRef | null; packageRef: EntityRef | null; baseRevision: string | null; metricHints: MappingMetricHint[]; checking: boolean }) {
  const { client, session, loading } = useWorkbench();
  const { context } = useGlobalContext();
  const [source, setSource] = useState(initialSource), [mapping, setMapping] = useState(initialMapping), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [incomplete, setIncomplete] = useState(false), [error, setError] = useState<unknown>(null);
  const owner = useRef<AbortController | null>(null);
  // Every completed step retains its exact request/receipt; an explicit retry
  // continues the same drafts after a lost response, never creates a second PR.
  const operations = useRef(new Map<string, { request: CommandRequest; receipt?: { result: unknown; editToken: string | null } }>());
  const token = useRef(baseRevision), targetPackage = useRef(packageRef);
  const [editable, setEditable] = useState(true);
  const [browserSource, setBrowserSource] = useState<{ sourceRef: VersionRef; ownDraft: { packageId: string; sourceDraftId: string; editToken: string } } | null>(null);
  useEffect(() => { const controller = new AbortController(); owner.current = controller; return () => controller.abort(); }, []);
  const allowed = session?.allowedCommands.includes('source.draft.save') && session.allowedCommands.includes('fieldMapping.draft.save');
  const writesAllowed = allowed && !loading && !checking;
  const save = async () => {
    const lifetime = owner.current; if (!lifetime || busy || !writesAllowed) return;
    setBusy(true); setError(null); setEditable(false);
    const order = ['source.open', 'mapping.open', 'mapping.save', 'source.save'];
    const invalidate = (step: string) => { for (const later of order.slice(order.indexOf(step))) operations.current.delete(later); };
    const command = async <T,>(step: string, name: string, payload: Record<string, unknown>, baseRevision: string | null = null) => {
      let operation = operations.current.get(step);
      if (operation && JSON.stringify(operation.request.payload) !== JSON.stringify(payload)) { invalidate(step); operation = undefined; }
      if (operation?.receipt) return operation.receipt as { result: T; editToken: string | null };
      if (!operation) { operation = { request: { commandId: crypto.randomUUID(), name, payload, baseRevision: token.current } }; operations.current.set(step, operation); }
      if (lifetime.signal.aborted) throw Error('Просмотр закрыт');
      let response;
      try { response = await client.command<CommandResult>(operation.request); }
      catch (failure) { if (definitiveDataRejection(failure)) { invalidate(step); setEditable(true); } throw failure; }
      if ('jobId' in response.data) throw Error('Настройка ожидает завершения задания; проверьте состояние пакета');
      if (lifetime.signal.aborted) throw Error('Просмотр закрыт');
      const receipt = { result: response.data.result as T, editToken: response.data.editToken };
      operation.receipt = receipt; token.current = receipt.editToken ?? token.current;
      return receipt;
    };
    try {
      const opened = await command<DraftOpened>('source.open', 'draft.open', { entityType: 'source_definition', ref: sourceRef ?? null, packageId: packageRef?.id ?? null }, baseRevision);
      const sourceDraft = opened.result;
      let target = targetPackage.current;
      if (!target) {
        if (!context) throw Error('Контекст не задан');
        const current = await client.query<WorkbenchReadModels['uor.queue']>('uor.queue', { ...dataPageRequest, context });
        target = current.data.items.find(item => item.editToken === sourceDraft.editToken)?.packageRef ?? null;
        if (!target) throw Error('Пакет изменился. Откройте сохранённый черновик в панели УОР.');
        targetPackage.current = target;
      }
      let stepToken = sourceDraft.editToken;
      let nextMapping = source.mappingRef;
      let complete = true;
      if (source.kind !== 'manual_status') {
        const mappingDraft = await command<DraftOpened>('mapping.open', 'draft.open', { entityType: 'source_field_mapping', ref: mappingRef ? { entityType: mappingRef.entityType, id: mappingRef.id } : null, packageId: target.id }, stepToken);
        const mappingSave = await command<DraftSaved>('mapping.save', 'fieldMapping.draft.save', { draftId: mappingDraft.result.draftId, definition: { ...mapping, sourceId: sourceDraft.objectId } }, mappingDraft.result.editToken);
        if (!mappingSave.editToken) throw Error('Не получена редакция пакета; проверьте сохранение в панели УОР');
        stepToken = mappingSave.editToken; nextMapping = mappingSave.result.versionRef; complete = mappingSave.result.complete;
      } else nextMapping = null;
      const sourceSave = await command<DraftSaved>('source.save', 'source.draft.save', { draftId: sourceDraft.draftId, definition: { ...source, goalId: goalRef.id, mappingRef: nextMapping } }, stepToken);
      if (!lifetime.signal.aborted) { setSaved(true); setIncomplete(!complete || !sourceSave.result.complete); if (source.kind === 'qlik' && sourceSave.editToken) setBrowserSource({ sourceRef: sourceSave.result.versionRef, ownDraft: { packageId: target.id, sourceDraftId: sourceDraft.draftId, editToken: sourceSave.editToken } }); }
    } catch (failure) { if (!lifetime.signal.aborted) setError(failure); }
    finally { if (!lifetime.signal.aborted) setBusy(false); }
  };
  const canEdit = !busy && !saved && editable;
  return <><form onSubmit={e => { e.preventDefault(); void save(); }} aria-busy={busy}>
    <fieldset disabled={!canEdit || !allowed}><legend>Штатное получение данных</legend><label>Тип источника<select value={source.kind ?? ''} onChange={e => setSource({ ...source, kind: e.target.value as SourceDefinition['kind'] })}><option value="" disabled>Не задан</option><option value="qlik">ОКО — сценарий СберБраузера</option><option value="file">Файл — отдельный штатный режим</option><option value="manual_status">Ручной статус</option></select></label>
      {source.kind === 'qlik' && <><label>Ссылка ОКО<input type="url" value={source.publicLocator ?? ''} onChange={e => setSource({ ...source, publicLocator: e.target.value || null })} /></label><p>Скачанный сценарием Excel/CSV остаётся источником ОКО. Для получения используется опубликованный сценарий СберБраузера.</p></>}
    </fieldset>
    {source.kind !== 'manual_status' && <MappingEditor value={mapping} onChange={setMapping} metricHints={metricHints} disabled={!canEdit || !allowed} />}
    <p>Изменения источника и соответствия столбцов сохраняются в общем черновике. Публикация выполняется отдельно в панели УОР.</p>
    <button type="submit" disabled={busy || saved || !writesAllowed}>Сохранить черновик настройки</button>
    {error !== null && <div role="alert">{dataError(error)}{error instanceof WorkbenchApiError && <ul>{error.problem.details.map((problem, index) => <li key={index}>{problem.path}: {problem.message} ({problem.code})</li>)}</ul>}<button type="button" disabled={busy || !writesAllowed} onClick={() => { void save(); }}>Повторить сохранение настройки</button></div>}
    {saved && <p role="status">Настройка сохранена в черновике. Для общего применения включите её в пакет УОР.</p>}
    {incomplete && <p>Черновик неполный. Проверьте обязательные поля в панели УОР.</p>}
  </form>{browserSource && source.kind === 'qlik' && <WorkbenchBrowserScenarioWizard sourceRef={browserSource.sourceRef} ownDraft={browserSource.ownDraft} draftId={null} previewAssignmentRef={previewAssignmentRef} onDraftSaved={() => {}} />}</>;
}
export const SourceSetupWizard = WorkbenchSourceSetupWizard;
