import { useEffect, useRef, useState } from 'react';
import type { EntityRef, VersionRef } from '../../../domain/workbench/primitives';
import type { FieldProblem, CommandResult } from '../../../server/workbench/protocol';
import type { DraftOpenResult, DraftSaveResult } from '../../catalog/workbench-drafts';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { packagePreviewResultSchema, type PackagePreviewResult } from '../../publishing/workbench/contracts';
import { PackageDiff, packageDraftLabels } from '../../publishing/workbench/PackageDiff';
import { privateCalculationPreviewSchema, privateMethodConfigurationSchema, privateManualTipSchema, type SourceMappingHints, type PrivateCalculationPreview } from '../../evaluation/workbench/private-preview-contracts';
import { displayExact } from '../../overview/workbench/goal-view-utils';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { useGlobalContext, useWorkbench } from '../../../app/workbench/context';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import { WorkbenchSourceSetupWizard } from '../../sources/workbench/SourceSetupWizard';
import { PopulationEditor } from './PopulationEditor';
import { MethodEditor } from './MethodEditor';
import { ApplicabilityEditor } from './ApplicabilityEditor';
import { command, createSetupCommandRecovery, SetupReadbackError, loadSetup, readPackage, request, SetupDraftChoiceError, type DraftChoice, type Entry, type SetupSession } from './draft-session';
import { array, object, text, changed, TextField, FieldErrors, type Definition } from './setup-fields';
import '../../sources/workbench/data-views.css';
import './goal-setup.css';
const steps = ['Название и источник', 'Область и состав', 'Шаблон или своя методика', 'Показатели и условия', 'Пример и влияние'];
const commands: Record<string, string> = { core_goal_definition: 'goal', source_definition: 'source', goal_assignment: 'assignment', method_version: 'method', metric_definition: 'metric', applicability: 'na' };
export function WorkbenchGoalSetupWizard({ goalRef, packageRef, onClose }: {
    goalRef?: EntityRef;
    packageRef?: EntityRef;
    onClose: () => void;
}) {
    const { client, session } = useWorkbench(), { context } = useGlobalContext();
    const [storedModel, setModel] = useState<SetupSession | null>(null), live = useRef<SetupSession | null>(null), [step, setStep] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [saved, setSaved] = useState(false), [preview, setPreview] = useState<PackagePreviewResult | null>(null), [extraProblems, setExtraProblems] = useState<FieldProblem[]>([]), [templateId, setTemplateId] = useState(''), [templateLoaded, setTemplateLoaded] = useState(''), [transition, setTransition] = useState<Definition>({}), [manualEntry, setManualEntry] = useState<Entry | null>(null);
    const [mappingHints, setMappingHints] = useState<SourceMappingHints>();
    const [activeMetrics, setActiveMetrics] = useState<Array<{
        id: string;
        name: string;
    }>>([]);
    const [sourceOpen, setSourceOpen] = useState(false), [example, setExample] = useState<PrivateCalculationPreview | null>(null);
    const [choices, setChoices] = useState<DraftChoice[]>([]), [choice, setChoice] = useState<DraftChoice>();
    const [dirty, setDirty] = useState(false), [transitionDirty, setTransitionDirty] = useState(false), [progress, setProgress] = useState<{completed:number;total:number}|null>(null);
    const [recovery, setRecovery] = useState<{action:()=>Promise<void>;kind:'unknown'|'readback'}|null>(null);
    const recoverCommands = useRef(createSetupCommandRecovery(client));
    const confirmedDefinitions = useRef(new Map<string,string>());
    const openedEntries = useRef(new Map<string, Awaited<ReturnType<typeof command<DraftOpenResult>>>>());
    const leave = useUnsavedChanges(dirty || transitionDirty || recovery !== null);
    const close = () => leave(onClose);
    const allowed = session?.allowedCommands.includes('goal.draft.save') ?? false;
    const ownerKey = JSON.stringify([session?.role, session?.personId, allowed]);
    const identity = useRef(ownerKey);
    identity.current = ownerKey;
    const clientIdentity = useRef(client);
    clientIdentity.current = client;
    const active = useRef(false), modelOwner = useRef<{
        client: typeof client;
        key: string;
    } | null>(null);
    const model = modelOwner.current?.client === client && modelOwner.current.key === ownerKey ? storedModel : null;
    const assertCurrent = () => {
        if (!active.current || identity.current !== ownerKey || clientIdentity.current !== client)
            throw Error('Просмотр закрыт или владелец изменился');
    };
    const dialog = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null), sourceVisible = useRef(sourceOpen), closeAction = useRef(onClose);
    sourceVisible.current = sourceOpen;
    closeAction.current = close;
    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null;
        closeButton.current?.focus();
        const keyboard = (event: KeyboardEvent) => {
            if (sourceVisible.current)
                return;
            if (event.key === 'Escape') {
                event.preventDefault();
                closeAction.current();
            }
            if (event.key === 'Tab') {
                const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') ?? [])].filter(el => !el.closest('[hidden]'));
                const first = controls[0], last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                }
                else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        };
        document.addEventListener('keydown', keyboard);
        return () => {
            document.removeEventListener('keydown', keyboard);
            if (opener?.isConnected)
                opener.focus();
        };
    }, []);
    const resolveActiveMetrics = async (m: SetupSession) => { const response = await client.query('calculation.method', request({ packageId: m.pkg.summary.packageRef.id, assignmentRef: m.assignment.versionRef, editToken: m.pkg.summary.editToken })); assertCurrent(); const config = privateMethodConfigurationSchema.parse(response.data); setActiveMetrics(config.metrics.map(metric => ({ id: metric.id, name: metric.name }))); };
    const refresh = () => { setDirty(true); setModel(live.current ? { ...live.current } : null); setPreview(null); setExample(null); setSaved(false); };
    useEffect(() => {
        let present = true;
        active.current = true;
        const key = ownerKey;
        setChoices([]);
        setDirty(false); setTransitionDirty(false); setProgress(null); setRecovery(null);
        recoverCommands.current = createSetupCommandRecovery(client); confirmedDefinitions.current.clear(); openedEntries.current.clear();
        setBusy(false);
        setSaved(false);
        setPreview(null);
        setExample(null);
        setManualEntry(null);
        setTransition({});
        setModel(null);
        setActiveMetrics([]);
        live.current = null;
        setError(null);
        if (allowed)
            void loadSetup(client, key, goalRef, context, choice, packageRef).then(value => {
                if (present && identity.current === key) {
                    modelOwner.current = { client, key };
                    live.current = value;
                    setModel({ ...value });
                    setTemplateId(text(object(value.assignment.definition.methodBinding).templateId));
                    setManualEntry(value.manualPending ? value.pkg.entries.find(e => e.draftId === value.manualPending!.draftId) ?? null : null);
                    setTransition(value.manualPending ? { targetState: value.manualPending.targetState, ...(value.manualPending.reason !== null ? { reason: value.manualPending.reason } : {}), ...(value.manualPending.resultDescription !== null ? { resultDescription: value.manualPending.resultDescription } : {}) } : {});
                    if (value.na)
                        void resolveActiveMetrics(value).catch(failure=>{if(present&&identity.current===key)setError(failure);});
                }
            }, failure => {
                if (present) {
                    if (failure instanceof SetupDraftChoiceError)
                        setChoices(failure.choices);
                    else
                        setError(failure);
                }
            });
        return () => { present = false; active.current = false; };
        // The owner and goal, never a background response object's identity, own form lifetime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, ownerKey, goalRef?.id, packageRef?.id, choice]);
    const patch = (entry: Entry, definition: Definition) => { if (entry === live.current?.assignment && JSON.stringify(entry.definition.methodBinding) !== JSON.stringify(definition.methodBinding))
        setActiveMetrics([]); entry.definition = definition; refresh(); };
    const run = async (action: () => Promise<void>) => {
        if (busy)
            return;
        setBusy(true);
        setError(null);
        setRecovery(null);
        setExtraProblems([]);
        try {
            assertCurrent();
            await action();
        }
        catch (failure) {
            if (!active.current || identity.current !== ownerKey || clientIdentity.current !== client)
                return;
            setError(failure);
            if (recoverCommands.current.hasPending || failure instanceof SetupReadbackError) setRecovery({action,kind:failure instanceof SetupReadbackError?'readback':'unknown'});
            if (failure instanceof WorkbenchApiError)
                setExtraProblems(failure.problem.details.map(p => ({ ...p, path: p.path.replace(/^\/?definition[/.]/, '/').replace(/\./g, '/') })));
        }
        finally {
            if (active.current && identity.current === ownerKey && clientIdentity.current === client)
                setBusy(false);
        }
    };
    const openEntry = async (type: string): Promise<Entry> => {
        assertCurrent(); const m = live.current!;
        let receipt = openedEntries.current.get(type);
        if (!receipt) {
            receipt = await recoverCommands.current.execute<DraftOpenResult>('draft.open', { entityType: type, ref: null, packageId: m.pkg.summary.packageRef.id }, m.pkg.summary.editToken);
            assertCurrent();
            openedEntries.current.set(type, receipt);
            m.pkg.summary.editToken = receipt.editToken!;
        }
        let current: SetupSession['pkg'];
        try { current = await readPackage(client, m.pkg.summary.packageRef.id, m.context); }
        catch { throw new SetupReadbackError(); }
        assertCurrent();
        const entry = current.entries.find(e => e.draftId === receipt.result.draftId);
        if (!entry) throw new SetupReadbackError();
        // Keep existing edited objects: only the newly opened entry comes from
        // readback. The receipt's CAS token remains the revision we actually own.
        m.pkg.entries = current.entries;
        openedEntries.current.delete(type);
        return entry;
    };
    const ensureMethod = async () => { const m = live.current!; if (!m.method) {
        m.method = await openEntry('method_version');
        m.method.definition = m.goal.definition.mode ? { mode: m.goal.definition.mode } : {};
    } if (object(m.assignment.definition.methodBinding).kind !== 'template')
        m.assignment.definition = { ...m.assignment.definition, methodBinding: { kind: 'standalone', methodRef: m.method.versionRef } }; return m.method; };
    const save = async () => {
        const m = live.current!;
        if (!m.method && m.goal.definition.mode === 'manual_status' && object(m.assignment.definition.methodBinding).kind !== 'template')
            await ensureMethod();
        const metricRefs = new Map<string, Entry>();
        const entries = [...m.metrics, ...(m.method ? [m.method] : []), m.source, m.goal, m.assignment, ...(m.na ? [m.na] : [])];
        let completed = 0; setProgress({completed,total:entries.length});
        for (const entry of entries) {
            assertCurrent();
            if (entry === m.method && entry.definition.mode === 'numeric')
                entry.definition = { ...entry.definition, rules: array(entry.definition.rules).map(rule => { const v = object(rule), metric = metricRefs.get(text(object(v.metricRef).id)); return metric ? { ...v, metricRef: metric.versionRef } : v; }) };
            if (entry === m.assignment && m.method && object(entry.definition.methodBinding).kind === 'standalone')
                entry.definition = { ...entry.definition, methodBinding: { kind: 'standalone', methodRef: m.method.versionRef } };
            if (entry === m.assignment && m.method && !m.standaloneAssociated && object(entry.definition.methodBinding).kind === 'template') {
                const association = await recoverCommands.current.execute<DraftSaveResult>('assignment.draft.save', { draftId: entry.draftId, definition: { ...entry.definition, methodBinding: { kind: 'standalone', methodRef: m.method.versionRef } } }, m.pkg.summary.editToken);
                assertCurrent();
                m.pkg.summary.editToken = association.editToken!;
                m.standaloneAssociated = true;
            }
            const definitionKey = JSON.stringify(entry.definition);
            if (confirmedDefinitions.current.get(entry.draftId) === definitionKey) {
                metricRefs.set(entry.entityRef.id, entry);
                setProgress({completed:++completed,total:entries.length});
                continue;
            }
            const receipt = await recoverCommands.current.execute<DraftSaveResult>(commands[entry.entityRef.entityType] + '.draft.save', { draftId: entry.draftId, definition: entry.definition }, m.pkg.summary.editToken);
            assertCurrent();
            m.pkg.summary.editToken = receipt.editToken!;
            entry.versionRef = receipt.result.versionRef;
            entry.complete = receipt.result.complete;
            entry.problems = receipt.result.problems;
            confirmedDefinitions.current.set(entry.draftId, definitionKey);
            setProgress({completed:++completed,total:entries.length});
            if (entry === m.assignment && m.manualRef.entityType === 'goal_assignment')
                m.manualRef = entry.versionRef;
            metricRefs.set(entry.entityRef.id, entry);
        }
        setModel({ ...m });
        setDirty(false);
        setSaved(true);
        setPreview(null);
        setExample(null);
    };
    const check = async () => {
        await save();
        assertCurrent();
        const m = live.current!;
        const response = await client.command<Omit<CommandResult, 'result'> & {
            result: PackagePreviewResult;
        }>({ commandId: crypto.randomUUID(), name: 'package.preview', baseRevision: m.pkg.summary.editToken, payload: { packageId: m.pkg.summary.packageRef.id } });
        if (!('jobId' in response.data))
            throw Error('Ожидалось задание проверки');
        let job = (await client.job(response.data.jobId)).data;
        while (['queued', 'running'].includes(job.status)) {
            await new Promise(resolve => setTimeout(resolve, response.data && 'pollAfterMs' in response.data ? Math.min(response.data.pollAfterMs, 1000) : 1000));
            job = (await client.job(job.jobId)).data;
        }
        if (job.error)
            throw new WorkbenchApiError(job.error, 422, null);
        if (job.status !== 'succeeded' && job.status !== 'partial')
            throw Error('Проверка не завершена: ' + job.status);
        assertCurrent();
        setPreview(packagePreviewResultSchema.parse(job.result));
    };
    const calculateExample = async () => {
        await save();
        assertCurrent();
        const m = live.current!;
        const prepared = await command<{
            basisRef: VersionRef;
            resultRef: VersionRef | null;
        }>(client, 'calculation.prepare', { assignmentRef: m.assignment.versionRef, businessTime: m.context.time }, m.pkg.summary.editToken);
        if (!prepared.result.resultRef)
            throw Error('Числовой пример не применяется к ручному статусу');
        const read = await client.query<PrivateCalculationPreview>('calculation.preview', request({ packageId: m.pkg.summary.packageRef.id, resultRef: prepared.result.resultRef, editToken: m.pkg.summary.editToken }));
        assertCurrent();
        setExample(privateCalculationPreviewSchema.parse(read.data));
    };
    const transitionManual = async () => { await save(); assertCurrent(); const m = live.current!; const tipResponse = await client.query('manual.tip', request({ packageId: m.pkg.summary.packageRef.id, assignmentRef: m.assignment.versionRef, editToken: m.pkg.summary.editToken })); const tip = privateManualTipSchema.parse(tipResponse.data); assertCurrent(); m.manualTipReady = tip.status === 'ready'; m.manualProblems = tip.problems; if (!m.manualTipReady) {
        setModel({ ...m });
        return;
    } m.manualRef = tip.tipRef ?? m.assignment.versionRef; const input = { ref: m.manualRef, targetState: transition.targetState, reason: text(transition.reason) || null, resultDescription: text(transition.resultDescription) || null }; const prepared = await command<DraftOpenResult>(client, 'manualGoal.prepareTransition', { ...input, packageId: m.pkg.summary.packageRef.id, draftId: manualEntry?.draftId ?? tip.pending?.draftId ?? null }, m.pkg.summary.editToken); assertCurrent(); m.pkg.summary.editToken = prepared.editToken!; const current = await readPackage(client, m.pkg.summary.packageRef.id, m.context); assertCurrent(); m.pkg = current; const entry = current.entries.find(e => e.draftId === prepared.result.draftId)!; setManualEntry(entry); const receipt = await command<DraftSaveResult>(client, 'manualGoal.transition', { ...input, draftId: entry.draftId }, m.pkg.summary.editToken); assertCurrent(); m.pkg.summary.editToken = receipt.editToken!; m.manualRef = receipt.result.versionRef; m.manualState = text(transition.targetState); setManualEntry(null); setDirty(false); setTransitionDirty(false); setSaved(true); setModel({ ...m }); };
    return <div className="wb-goal-setup-backdrop"><section ref={dialog} inert={sourceOpen} className="wb-goal-setup" role="dialog" aria-modal="true" aria-label="Настройка цели"><header><h2>{goalRef ? 'Настройка цели' : 'Новая цель'}</h2><button ref={closeButton} type="button" onClick={close}>Закрыть настройку</button></header>{!allowed && <p role="alert">Подготовка доступна куратору УОР.</p>}{error !== null && <p role="alert">{error instanceof SetupReadbackError ? error.message : workbenchErrorMessage(error)}{error instanceof WorkbenchApiError && error.status === 409 ? ' Подтверждённые шаги сохранены. Откройте актуальную редакцию перед новым изменением.' : ''}</p>}
    {choices.length > 0 && !model && <label>Свой черновик цели<select value="" onChange={e => { setChoice(choices[Number(e.target.value)]); setChoices([]); }}><option value="">Выберите черновик</option>{choices.map((c, i) => <option key={c.packageId + "/" + c.goalId} value={i}>{c.label}</option>)}</select></label>}{!model && allowed && !error && !choices.length && <p>Открываем свой черновик…</p>}{model && <><p>Личный черновик. Общая цель изменится после публикации в main.</p><nav aria-label="Шаги настройки">{steps.map((s, i) => <button type="button" key={s} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>{s}</button>)}</nav>
      <fieldset disabled={busy || recovery !== null}><legend>{steps[step]}</legend>
        <div hidden={step !== 0}><TextField label="Название цели" value={model.goal.definition} field="title" problems={[...model.goal.problems, ...extraProblems]} onChange={v => patch(model.goal, v)}/><TextField label="Описание цели" value={model.goal.definition} field="description" preserveEmpty onChange={v => patch(model.goal, v)}/>
          <label>Способ оценки<select value={text(model.goal.definition.mode)} onChange={e => {
                patch(model.goal, { ...model.goal.definition, mode: e.target.value });
                if (e.target.value === 'manual_status') {
                    if (model.method)
                        model.method.definition = { mode: 'manual_status' };
                    model.source.definition = { ...model.source.definition, kind: 'manual_status', mappingRef: null, publicLocator: null };
                    model.assignment.definition = { ...model.assignment.definition, expectedPopulation: null };
                }
                else if (model.method)
                    model.method.definition = { ...model.method.definition, mode: 'numeric' };
                refresh();
            }}><option value="">Выберите способ</option><option value="numeric">Числовые показатели</option><option value="manual_status">Ручной статус</option></select></label>
          <label>Режим измерения<select aria-label="Режим измерения" value={text(model.goal.definition.measurementMode)} onChange={e => patch(model.goal, changed(model.goal.definition, 'measurementMode', e.target.value))}><option value="">Выберите режим</option><option value="as_of">На дату</option><option value="period">За период</option></select><FieldErrors problems={model.goal.problems} path="/measurementMode"/></label>
          <label>Штатный источник<select value={text(model.source.definition.kind)} onChange={e => patch(model.source, { ...changed(model.source.definition, 'kind', e.target.value), ...(['file', 'manual_status'].includes(e.target.value) ? { publicLocator: null } : {}), ...(e.target.value === 'manual_status' ? { mappingRef: null } : {}) })}><option value="">Выберите источник</option><option value="qlik">ОКО</option><option value="file">Файл</option><option value="manual_status">Ручной статус</option></select></label><p>ОКО: сценарий и сопоставление полей настраиваются в разделе данных. Файл выбирается отдельным штатным режимом.</p>
          <label>Состояние цели<select aria-label="Состояние цели" value={text(model.goal.definition.lifecycle)} onChange={e => patch(model.goal, { ...model.goal.definition, lifecycle: e.target.value, ...(e.target.value === 'active' ? { archiveReason: null } : {}) })}><option value="">Выберите состояние</option><option value="active">Действующая</option></select></label><label><input type="checkbox" checked={Array.isArray(model.goal.definition.coCuratorPersonIds) && model.goal.definition.coCuratorPersonIds.length === 0} onChange={e => patch(model.goal, changed(model.goal.definition, 'coCuratorPersonIds', e.target.checked ? [] : undefined))}/>Без со-кураторов</label><label>Основной куратор<select value={text(model.goal.definition.primaryCuratorPersonId)} onChange={e => patch(model.goal, changed(model.goal.definition, 'primaryCuratorPersonId', e.target.value))}><option value="">Выберите куратора</option>{model.entities.filter(e => e.kind === 'person').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label><FieldErrors problems={model.goal.problems} path="/primaryCuratorPersonId"/>
        </div>
        <div hidden={step !== 1}><PopulationEditor value={model.assignment.definition} onChange={v => patch(model.assignment, v)} entities={model.entities} manual={model.goal.definition.mode === 'manual_status'} problems={[...model.assignment.problems, ...extraProblems]}/></div>
        <div hidden={step !== 2}><label><input type="radio" name="method-kind" checked={object(model.assignment.definition.methodBinding).kind === 'standalone'} onChange={() => { if (model.method)
            patch(model.assignment, { ...model.assignment.definition, methodBinding: { kind: 'standalone', methodRef: model.method.versionRef } });
        else
            void run(async () => { const method = await ensureMethod(); patch(model.assignment, { ...model.assignment.definition, methodBinding: { kind: 'standalone', methodRef: method.versionRef } }); }); }}/>Самостоятельная методика</label><label><input type="radio" name="method-kind" checked={object(model.assignment.definition.methodBinding).kind === 'template'} onChange={() => patch(model.assignment, { ...model.assignment.definition, methodBinding: { kind: 'template', ...(templateLoaded ? { templateId: templateLoaded } : {}) } })}/>Шаблон</label><label>Идентификатор опубликованного шаблона<input value={templateId} onChange={e => {setTemplateId(e.target.value);setDirty(true);}}/></label><button type="button" onClick={() => void run(async () => {
                const form = await client.query<WorkbenchReadModels['forms.describe']>('forms.describe', request({ formKind: 'template', ref: { entityType: 'template', id: templateId } }, model.context));
                if (!form.data.values)
                    throw Error('Шаблон не найден');
                setTemplateLoaded(templateId);
                patch(model.assignment, { ...model.assignment.definition, methodBinding: { kind: 'template', templateId } });
            })}>Выбрать шаблон</button><p>Самостоятельная методика сохраняется при выборе шаблона и возврате.</p></div>
        <div hidden={step !== 3}>{object(model.assignment.definition.methodBinding).kind === 'template' && <p>Используется выбранный опубликованный шаблон. Ниже сохранена самостоятельная методика.</p>}<MethodEditor value={model.method?.definition ?? (model.goal.definition.mode ? { mode: model.goal.definition.mode } : {})} onChange={v => { if (model.method)
            patch(model.method, v);
        else
            void run(async () => { const method = await ensureMethod(); patch(method, { ...method.definition, ...v }); }); }} metrics={model.metrics.map(e => ({ id: e.entityRef.id, definition: e.definition, onChange: v => patch(e, v) }))} problems={[...(model.method?.problems ?? []), ...extraProblems]} onAddMetric={() => void run(async () => { const method = await ensureMethod(); const entry = await openEntry('metric_definition'); live.current!.metrics.push(entry); method.definition = { ...method.definition, mode: 'numeric', rules: [...array(method.definition.rules), { metricRef: entry.versionRef }] }; refresh(); })}/>
          <button type="button" onClick={() => void run(async () => {
                await save();
                const m = live.current!;
                setActiveMetrics([]);
                const response = await client.query('calculation.method', request({ packageId: m.pkg.summary.packageRef.id, assignmentRef: m.assignment.versionRef, editToken: m.pkg.summary.editToken }));
                const config = privateMethodConfigurationSchema.parse(response.data);
                assertCurrent();
                setActiveMetrics(config.metrics.map(metric => ({ id: metric.id, name: metric.name })));
                if (!model.na) {
                    live.current!.na = await openEntry('applicability');
                    live.current!.na!.definition = { assignmentId: model.assignment.entityRef.id, kind: 'not_applicable' };
                    refresh();
                }
            })}>Добавить неприменимость</button>{model.na && <ApplicabilityEditor value={model.na.definition} onChange={v => patch(model.na!, v)} metricOptions={object(model.assignment.definition.methodBinding).kind === 'template' ? activeMetrics : model.metrics.map(e => ({ id: e.entityRef.id, name: text(e.definition.name) || e.entityRef.id }))} scopeLabel={model.entities.find(e => e.id === object(model.assignment.definition.scope).id)?.name ?? ''} problems={[...model.na.problems, ...extraProblems]}/>}</div>
        <div hidden={step !== 4}>{model.goal.definition.mode === 'numeric' && <button type="button" onClick={() => void run(calculateExample)}>Рассчитать пример</button>}{example && <section aria-label="Пример расчёта черновика"><h3>{example.goal.title}</h3><p>Область примера: {({dit:'ДИТ',cluster:'Кластер',product:'Продукт',team:'Команда'})[example.assignment.scope.kind]}; редакция назначения {example.basis.assignmentRef.revision}</p><p>Основание: редакция методики {example.basis.methodRef.revision}; {example.basis.businessTime.kind === 'as_of' ? example.basis.businessTime.date : example.basis.businessTime.startInclusive + ' — ' + example.basis.businessTime.endExclusive}</p><p>Входы: {example.basis.factRefs.length} фактов; ожидаемых участников: {example.basis.expectedPopulation?.length ?? 'Не задано'}</p><ul>{example.facts.map(fact => <li key={fact.id}>{example.metrics.find(metric => metric.id === fact.metricId)?.name ?? 'Показатель'}: {displayExact(fact.value)} {fact.unitCode}; {fact.state === 'known' ? 'измерено' : fact.missingReason}</li>)}</ul>{example.method.mode === 'numeric' && <ul>{example.method.rules.map(rule => <li key={rule.metricRef.id}>{example.metrics.find(metric => metric.id === rule.metricRef.id)?.name ?? 'Показатель'}: {rule.condition.op === 'range' ? `${rule.condition.min}–${rule.condition.max}` : `${rule.condition.op === 'gte' ? '≥' : rule.condition.op === 'lte' ? '≤' : '='} ${rule.condition.target}`}; вес {rule.originalWeight}; {rule.mandatory ? 'обязательное условие' : 'необязательное условие'}</li>)}</ul>}<p>Балл примера: {displayExact(example.result.scorePercent)}{example.result.scorePercent ? '%' : ''}</p>{example.result.preliminaryPercent && <p>Предварительный балл примера: {displayExact(example.result.preliminaryPercent)}%</p>}<p>Покрытие примера: {displayExact(example.result.coveragePercent)}{example.result.coveragePercent ? '%' : ''}</p><p>Давность на момент примера: {({fresh:'Данные актуальны',stale:'Данные устарели',unknown:'Давность неизвестна'})[example.result.freshness]}</p><p>Состояние расчёта: {({ready:'Готов',preliminary:'Предварительный',no_data:'Нет данных',not_applicable:'Не применимо',blocked:'Заблокирован'})[example.result.calculation]}; достижение: {({met:'Условие выполнено',not_met:'Условие не выполнено',unknown:'Не определено',not_applicable:'Не применимо'})[example.result.achievement]}</p>{example.result.qualityFlags.map(flag => <p key={flag}>{flag}</p>)}<p>Пример не подтверждает выполнение цели.</p></section>}<button type="button" onClick={() => void run(async () => { await save(); assertCurrent(); const m = live.current!; setMappingHints(undefined); if (m.goal.definition.mode === 'numeric' && object(m.assignment.definition.methodBinding).kind) {
            const response = await client.query('calculation.method', request({ packageId: m.pkg.summary.packageRef.id, assignmentRef: m.assignment.versionRef, editToken: m.pkg.summary.editToken }));
            const config = privateMethodConfigurationSchema.parse(response.data);
            if (config.goalRef.id !== m.goal.entityRef.id || config.assignmentRef.id !== m.assignment.entityRef.id || config.assignmentRef.revision !== m.assignment.versionRef.revision)
                throw Error('Основание методики изменилось');
            setMappingHints({ packageId: config.packageId, goalRef: config.goalRef, assignmentRef: config.assignmentRef, metrics: config.method.mode === 'numeric' ? config.method.rules.map(rule => ({ metricId: rule.metricRef.id, fields: rule.reducer.kind === 'count' ? [] : rule.reducer.kind === 'ratio' ? [rule.reducer.numeratorField, rule.reducer.denominatorField] : [rule.reducer.valueField] })) : [] });
        } setSourceOpen(true); })}>Настроить источник</button><p>Проверка использует сохранённые поля и реальный серверный предпросмотр пакета. Нового измерения или подтверждения она не создаёт.</p><button type="button" onClick={() => void run(check)}>Проверить готовность</button>{preview && <section aria-label="Влияние пакета"><p>{preview.errors.length ? 'Публикация заблокирована' : 'Пакет прошёл проверку готовности'}</p>{preview.errors.map((p, i) => <div key={i} role="alert">{p.code}{p.details.map((d, j) => <p key={j}>{d.path}: {d.message} ({d.code})</p>)}</div>)}{preview.warnings.map((w, i) => <p key={i}>{w.code}</p>)}<PackageDiff changes={preview.changes} labels={packageDraftLabels([model.goal,model.source,model.assignment,...model.metrics,...(model.method?[model.method]:[])])}/></section>}
          {model.goal.definition.mode === 'manual_status' && <fieldset><legend>Ручной результат</legend><p>Завершение требует описания результата; возврат в работу требует причины.</p><FieldErrors problems={model.manualProblems} path="/manualStatus"/><p>Текущий статус: {model.manualState ? ({not_started:'Не начата',in_progress:'В работе',completed:'Завершена'} as Record<string,string>)[model.manualState] ?? 'Не определён' : 'Не задан'}</p><label>Новый статус<select value={text(transition.targetState)} onChange={e => {setTransition({ ...transition, targetState: e.target.value });setTransitionDirty(true);}}><option value="">Выберите статус</option><option value="not_started">Не начато</option><option value="in_progress">В работе</option><option value="completed">Завершено</option></select></label><TextField label="Описание результата" field="resultDescription" value={transition} onChange={value=>{setTransition(value);setTransitionDirty(true);}} problems={extraProblems}/><TextField label="Причина возврата" field="reason" value={transition} onChange={value=>{setTransition(value);setTransitionDirty(true);}} problems={extraProblems}/><button type="button" disabled={!model.manualTipReady && !manualEntry} onClick={() => void run(transitionManual)}>Сохранить ручной результат</button></fieldset>}</div>
      </fieldset><footer><button type="button" disabled={busy} onClick={() => void run(recovery?.action ?? save)}>{recovery?.kind==='readback'?'Повторить чтение':recovery?'Продолжить сохранение':'Сохранить черновик'}</button>{step > 0 && <button type="button" onClick={() => setStep(step - 1)}>Назад</button>}{step < 4 && <button type="button" onClick={() => setStep(step + 1)}>Далее</button>}{progress && (busy || recovery || error !== null) && <p role="status">Сохранено шагов: {progress.completed} из {progress.total}</p>}{busy && <p role="status">Сохраняем и проверяем…</p>}{saved && <p role="status">Черновик сохранён</p>}</footer></>}
  </section>{sourceOpen && model && <WorkbenchSourceSetupWizard goalRef={model.goal.entityRef} sourceRef={model.source.entityRef} packageRef={model.pkg.summary.packageRef} metricHints={mappingHints} onClose={() => { setSourceOpen(false); void run(async () => { const current = await loadSetup(client, ownerKey, model.goal.entityRef, context, choice, packageRef); assertCurrent(); live.current = current; setModel({ ...current }); setSaved(true); setPreview(null); }); }}/>}</div>;
}
