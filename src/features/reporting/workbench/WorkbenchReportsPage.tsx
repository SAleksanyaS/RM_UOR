import {mergeReportDefinitions,reportFieldLabel,reportFieldValue} from './report-merge';
import './reporting.css';
import { useEffect, useRef, useState } from 'react';
import { useWorkbench, useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import { DataTable, EmptyState, QueryState } from '../../../app/workbench/ui';
import type { CommandRequest } from '../../../server/workbench/protocol';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { executionOwner } from '../../execution/workbench/execution-ui';
import { runDataCommand } from '../../sources/workbench/data-client';
import type { MaturitySnapshot } from '../../maturity/workbench-contracts';
import { defaultReportDefinition, sectionNames, goalSectionNames, type ReportDefinition, type ReportSnapshot, type ExportFormat } from './contracts';
import { reportSections } from './presentation';
import { reportTargetFromUrl } from '../../../app/workbench/route-state';
import { PersonalFavoriteButton } from '../../../app/workbench/PersonalFavoriteButton';
const request = (filter: Record<string, unknown> = {}) => ({ context: null, filter, sort: [], page: { limit: 100, cursor: null } });
type Summary = {
    id: string;
    revision: number;
    title: string;
    period: string;
    createdAt: string;
    editToken: string;
};
export function WorkbenchReportsPage() { const { client, session } = useWorkbench(); return <ReportBuilder key={executionOwner(client) + ':' + session?.personId + ':' + session?.role + ':' + (session?.allowedCommands.includes('report.save') ?? false)} clientKey={client}/>; }
function ReportBuilder({ clientKey: _clientKey }: {
    clientKey: unknown;
}) {
    const { client, session } = useWorkbench(), { context, navigate } = useGlobalContext();
    const target = reportTargetFromUrl(window.location.href), targetKey = target ? target.id + ':' + target.revision : '';
    const allowed = session?.allowedCommands.includes('report.save') ?? false;
    const [definition, setDefinition] = useState<ReportDefinition>(() => defaultReportDefinition('2026-10-30')), [saved, setSaved] = useState(JSON.stringify(defaultReportDefinition('2026-10-30'))), [selected, setSelected] = useState<Summary | null>(null), [snapshot, setSnapshot] = useState<ReportSnapshot | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [revision, setRevision] = useState(0), [pending, setPending] = useState(false), [announcement, setAnnouncement] = useState(''), [retryAllowed, setRetryAllowed] = useState(false);
    const [stale,setStale]=useState(false),[conflict,setConflict]=useState<{latest:ReportSnapshot;base:ReportDefinition;mine:ReportDefinition;choices:Record<string,'mine'|'latest'>}|null>(null);
    const merge=conflict?mergeReportDefinitions(conflict.base,conflict.mine,conflict.latest.definition,conflict.choices):null;
    const owner = useRef(new AbortController()), operation = useRef<CommandRequest | null>(null), loadedTarget = useRef<string|null>(null);
    const [savedTarget,setSavedTarget]=useState<{id:string;revision:number}|null>(null);
    useEffect(() => { const controller = new AbortController(); owner.current = controller; return () => controller.abort(); }, [client,targetKey]);
    const dirty = JSON.stringify(definition) !== saved;
    const leave = useUnsavedChanges(dirty || pending);
    const recipes = useWorkbenchQuery<ReportDefinition[]>('reports.recipes', allowed ? request() : null);
    const reports = useWorkbenchQuery<Summary[]>('reports.list', allowed ? request() : null, revision), materials = useWorkbenchQuery<MaturitySnapshot>('maturity.overview', allowed ? request() : null);
    useEffect(()=>{
        if(!allowed||loadedTarget.current===targetKey)return;
        const controller=new AbortController();
        setSelected(null);setSnapshot(null);setStale(false);setConflict(null);setError(null);operation.current=null;setPending(false);setRetryAllowed(false);setSavedTarget(null);
        const blank=defaultReportDefinition(materials.data?.period??'2026-10-30');setDefinition(blank);setSaved(JSON.stringify(blank));
        if(!target){loadedTarget.current=targetKey;setBusy(false);return;}
        setBusy(true);
        void client.query<ReportSnapshot>('reports.detail',request(target),{signal:controller.signal}).then(result=>{
            if(controller.signal.aborted)return;
            loadedTarget.current=targetKey;const value=result.data;setSelected({id:value.id,revision:value.revision,title:value.definition.title,period:value.definition.period,createdAt:value.createdAt,editToken:`report:${value.id}:${value.revision}`});setDefinition(value.definition);setSaved(JSON.stringify(value.definition));setSnapshot(value);
        },failure=>{if(!controller.signal.aborted)setError(failure);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
        return()=>controller.abort();
        // The exact URL selector owns this read; unrelated refreshes preserve unsaved edits.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[client,allowed,targetKey]);
    useEffect(()=>{
        if(!savedTarget||dirty||pending||busy)return;
        loadedTarget.current=savedTarget.id+':'+savedTarget.revision;
        navigate('/reports?report='+savedTarget.id+'&reportRevision='+savedTarget.revision,{replace:true});setSavedTarget(null);
    },[savedTarget,dirty,pending,busy,navigate]);
    const change = (next: ReportDefinition) => { setDefinition(next); setSnapshot(null); setError(null); };
    const act = async (fn: (signal:AbortSignal) => Promise<void>) => { if (busy)
        return; const signal = owner.current.signal; setBusy(true); setError(null); try {
        await fn(signal);
    }
    catch (e) {
        if (!signal.aborted) {
            if (e instanceof WorkbenchApiError && [403, 409, 422].includes(e.status)) {
                operation.current = null;
                setPending(false);
                if(e.status===409&&e.problem.code==='REVISION_CONFLICT')setStale(true);
            }
            setError(e);
        }
    }
    finally {
        if (!signal.aborted)
            setBusy(false);
    } };
    const open = (item: Summary) => navigate('/reports?report='+item.id+'&reportRevision='+item.revision);
    const loadLatest=()=>act(async signal=>{
        if(!selected)return;
        const latest=(await client.query<ReportSnapshot>('reports.detail',request({id:selected.id}))).data;
        if(signal.aborted)return;
        setConflict({latest,base:JSON.parse(saved),mine:structuredClone(definition),choices:{}});setRevision(v=>v+1);
    });
    const applyMerge=()=>{if(!conflict||!merge||merge.unresolved.length)return;const latest=conflict.latest;setDefinition(merge.merged);setSaved(JSON.stringify(latest.definition));setSelected({id:latest.id,revision:latest.revision,title:latest.definition.title,period:latest.definition.period,createdAt:latest.createdAt,editToken:`report:${latest.id}:${latest.revision}`});setSnapshot(null);setConflict(null);setStale(false);setError(null);setAnnouncement('Объединение проверено. Сохраните новую версию.');};
    const prepare = () => act(async signal => { const result = await client.query<ReportSnapshot>('reports.prepare', request({ definition })); if (!signal.aborted)
        setSnapshot(result.data); });
    const save = (retry = false) => act(async signal => {
        if(stale||conflict)throw Error('Сначала сравните текущую версию и разрешите различия');
        let result: {
            id: string;
            revision: number;
            digest: string;
        };
        if (operation.current && !retry) {
            const state = (await client.reconcileCommand(operation.current.commandId)).data;
            if (state.name !== null && state.name !== 'report.save')
                throw Error('Ответ восстановления не соответствует сохранению отчёта');
            setRetryAllowed(state.status === 'not_found');
            if (state.status === 'not_found')
                throw Error('Команда не найдена. Можно явно повторить исходное сохранение.');
            if (state.status === 'pending' || state.status === 'accepted')
                throw Error('Сохранение ещё выполняется. Повторите проверку.');
            if (state.status === 'interrupted') {
                operation.current = null;
                setPending(false);
                throw Error('Сохранение прервано. Проверьте список версий и сохраните изменения снова.');
            }
            result = state.result as typeof result;
        }
        else {
            if (retry && !retryAllowed)
                throw Error('Сначала проверьте состояние сохранения');
            operation.current ??= { commandId: crypto.randomUUID(), name: 'report.save', baseRevision: selected?.editToken ?? null, payload: { id: selected?.id ?? null, definition } };
            setPending(true);
            setRetryAllowed(false);
            result = await runDataCommand<typeof result>(client, operation.current, signal, () => { });
        }
        if (signal.aborted)
            return;
        const confirmed = operation.current!.payload.definition as ReportDefinition;
        const read = await client.query<ReportSnapshot>('reports.detail', request({ id: result.id, revision: result.revision }));
        if (signal.aborted)
            return;
        operation.current = null;
        setPending(false);
        setRetryAllowed(false);
        setSelected({ id: result.id, revision: result.revision, title: confirmed.title, period: confirmed.period, createdAt: read.data.createdAt, editToken: `report:${result.id}:${result.revision}` });
        setSaved(JSON.stringify(confirmed));
        setRevision(v => v + 1);
        setAnnouncement('Версия отчёта сохранена');
        setSnapshot(read.data);
        setSavedTarget({id:result.id,revision:result.revision});
    });
    const download = (format: ExportFormat) => act(async signal => { if (!selected)
        return; const result = await client.query<{
        base64: string;
        filename: string;
        mimeType: string;
    }>('reports.export', request({ id: selected.id, revision: selected.revision, format })); if (signal.aborted)
        return; const bytes = Uint8Array.from(atob(result.data.base64), c => c.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: result.data.mimeType })); const link = document.createElement('a'); link.href = url; link.download = result.data.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
    const move = (index: number, offset: number) => { const sections = [...definition.sections]; if (index + offset < 0 || index + offset >= sections.length)
        return; [sections[index], sections[index + offset]] = [sections[index + offset], sections[index]]; change({ ...definition, sections }); setAnnouncement('Порядок разделов изменён'); };
    if (!allowed)
        return <EmptyState title="Отчёты готовит куратор УОР">Сохранённые личные версии доступны их владельцу с правом подготовки.</EmptyState>;
    return <section className="wb-report-builder" aria-label="Конструктор отчёта"><header className="wb-page-toolbar"><div><h2>Отчёты</h2><p>Выберите шаблон, проверьте разделы и сохраните неизменяемую версию.</p></div><button disabled={busy || pending} onClick={() => target ? navigate('/reports') : leave(() => { setStale(false);setConflict(null);setSelected(null); setSnapshot(null); setSaved(JSON.stringify(defaultReportDefinition(materials.data?.period ?? '2026-10-30'))); setDefinition(defaultReportDefinition(materials.data?.period ?? '2026-10-30')); })}>Новый отчёт</button></header><QueryState loading={reports.loading} error={reports.error ? workbenchErrorMessage(reports.error) : null} onRetry={() => setRevision(v => v + 1)}/>{reports.data?.length ? <nav className="wb-page-toolbar" aria-label="Сохранённые отчёты">{reports.data.map(r => <button disabled={busy || pending} key={r.id} onClick={() => open(r)}>{r.title} · v{r.revision}</button>)}</nav> : <p>Сохранённых версий пока нет. Начните с готового шаблона.</p>}
 {selected && <div className="wb-page-toolbar" aria-label="История версий"><span>Открыта версия {selected.revision}</span><PersonalFavoriteButton favorite={{kind:'report',id:selected.id,revision:selected.revision}} label={selected.title+' · v'+selected.revision}/><button disabled={busy || pending || selected.revision <= 1} onClick={() => open({ ...selected, revision: selected.revision - 1, editToken: `report:${selected.id}:${selected.revision - 1}` })}>Предыдущая версия</button><button disabled={busy || pending || selected.revision >= (reports.data?.find(r => r.id === selected.id)?.revision ?? selected.revision)} onClick={() => open({ ...selected, revision: selected.revision + 1, editToken: `report:${selected.id}:${selected.revision + 1}` })}>Следующая версия</button></div>}
 <div className="wb-report-layout"><div className="wb-report-editor"><fieldset className="wb-surface" disabled={busy || pending || !!conflict}><legend>Шаблон и область</legend><label className="wb-field">Готовая настройка отчёта<select value="" onChange={e => { const recipe = recipes.data?.[Number(e.target.value)]; if (recipe)
        change({ ...recipe, context: recipe.template === 'goal-management-v1' ? context : null, period: recipe.template === 'goal-management-v1' && context ? (context.time.kind === 'as_of' ? context.time.date : context.time.endExclusive) : recipe.period }); }}><option value="">Выберите готовую настройку</option>{recipes.data?.map((r, i) => <option key={i} value={i}>{r.title}</option>)}</select></label>{recipes.error !== null && <p role="alert">{workbenchErrorMessage(recipes.error, 'read')}</p>}<label className="wb-field">Шаблон<select value={definition.template} onChange={e => { const template = e.target.value as ReportDefinition['template']; change({ ...definition, template, title: selected ? definition.title : template === 'goal-management-v1' ? 'Отчёт по цели' : 'Модель зрелости ДИТ', sections: definition.sections.map(s => ({ ...s, title: template === 'goal-management-v1' ? goalSectionNames[s.kind] : sectionNames[s.kind] })), context: template === 'goal-management-v1' ? context : null, period: template === 'goal-management-v1' && context ? (context.time.kind === 'as_of' ? context.time.date : context.time.endExclusive) : materials.data?.period ?? '2026-10-30' }); }}><option value="maturity-management-v1">Модель зрелости · выбранные материалы</option><option value="goal-management-v1">Цель · текущий или согласованный результат</option></select></label>{definition.template === 'goal-management-v1' ? <><p>Область, цель и вид результата берутся из выбранного контекста рабочего места.</p><button onClick={() => { if (context)
        change({ ...definition, context, period: context.time.kind === 'as_of' ? context.time.date : context.time.endExclusive }); }}>Использовать текущую цель и период</button>{!definition.context?.goalId && <p role="alert">Выберите цель в контексте рабочего места.</p>}</> : <details><summary>Команды: {definition.teamIds.length || 'все'}</summary>{materials.data?.teams.map(t => <label className="wb-field" key={t.id}><input type="checkbox" checked={definition.teamIds.includes(t.id)} onChange={e => change({ ...definition, teamIds: e.target.checked ? [...definition.teamIds, t.id] : definition.teamIds.filter(id => id !== t.id) })}/>{t.name}</label>)}<p>Пустой выбор включает все команды. Выбор части команд пересчитывает ожидаемую матрицу.</p></details>}<label className="wb-field">Период<input type="date" value={definition.period} onChange={e => change({ ...definition, period: e.target.value })}/></label><label className="wb-field">Название отчёта<input maxLength={160} value={definition.title} onChange={e => change({ ...definition, title: e.target.value })}/></label><label className="wb-field">Комментарий отчёта<textarea maxLength={4000} value={definition.comment} onChange={e => change({ ...definition, comment: e.target.value })}/></label></fieldset>
 <fieldset className="wb-surface" disabled={busy || pending || !!conflict}><legend>Разделы и порядок</legend>{definition.sections.map((s, i) => <fieldset className="wb-report-section-card" key={s.kind}><legend>{sectionNames[s.kind]}</legend><details><summary>Заголовок и комментарий: {s.title}</summary><label className="wb-field">Заголовок раздела<input value={s.title} maxLength={120} onChange={e => change({ ...definition, sections: definition.sections.map((v, n) => n === i ? { ...v, title: e.target.value } : v) })}/></label><label className="wb-field">Комментарий раздела<textarea value={s.comment} maxLength={2000} onChange={e => change({ ...definition, sections: definition.sections.map((v, n) => n === i ? { ...v, comment: e.target.value } : v) })}/></label></details><div className="wb-page-toolbar"><button aria-label={'Вверх: ' + s.title} disabled={i === 0} onClick={() => move(i, -1)}>Вверх</button><button aria-label={'Вниз: ' + s.title} disabled={i === definition.sections.length - 1} onClick={() => move(i, 1)}>Вниз</button><button disabled={definition.sections.length === 1} onClick={() => change({ ...definition, sections: definition.sections.filter((_, n) => n !== i) })}>Исключить {s.title}</button></div></fieldset>)}{(Object.keys(sectionNames) as Array<keyof typeof sectionNames>).filter(kind => !definition.sections.some(s => s.kind === kind)).map(kind => <button key={kind} onClick={() => change({ ...definition, sections: [...definition.sections, { kind, title: sectionNames[kind], comment: '' }] })}>Добавить {sectionNames[kind]}</button>)}</fieldset>
 <div className="wb-page-toolbar"><button disabled={busy || pending} onClick={() => void prepare()}>Предпросмотр влияния</button><button className="wb-primary-button" disabled={busy || stale || !!conflict} onClick={() => void save()}>{pending ? 'Проверить сохранение версии' : 'Сохранить версию'}</button>{retryAllowed && <button disabled={busy} onClick={() => void save(true)}>Повторить исходное сохранение версии</button>}{selected && !dirty && !pending && (['xlsx', 'pptx', 'pdf'] as const).map(format => <button key={format} disabled={busy} onClick={() => void download(format)}>{format.toUpperCase()}</button>)}{selected && !dirty && definition.template === 'maturity-management-v1' && <button disabled={busy || pending} onClick={() => void download('native-pptx')}>PPTX исходного профиля</button>}</div><p role="status">{busy ? 'Выполняем операцию…' : announcement}</p>{error !== null && <p role="alert">{workbenchErrorMessage(error)} Черновик сохранён на экране.</p>}{stale&&!conflict&&<div className="wb-surface" role="alert"><p>Отчёт изменён в другом окне. Ваши изменения остаются в редакторе.</p><button disabled={busy} onClick={()=>void loadLatest()}>Загрузить текущую версию для сравнения</button></div>}
 {conflict&&merge&&<section className="wb-surface" aria-label="Разрешение конфликта"><h3>Сравнение с версией {conflict.latest.revision}</h3><p>Независимые изменения объединены. Проверьте варианты перед сохранением новой версии.</p><DataTable label="Изменения для объединения"><thead><tr><th>Поле</th><th>Моё</th><th>Текущее</th><th>После объединения</th></tr></thead><tbody>{merge.changes.map(c=><tr key={c.path}><th>{reportFieldLabel(c.path)}</th><td>{reportFieldValue(c.path,c.mine)}</td><td>{reportFieldValue(c.path,c.latest)}</td><td>{reportFieldValue(c.path,c.merged)}</td></tr>)}</tbody></DataTable>{merge.conflicts.map(c=><fieldset key={c.path}><legend>{reportFieldLabel(c.path)}</legend>{(['mine','latest'] as const).map(choice=><label className="wb-field" key={choice}><input type="radio" name={'conflict-'+c.path} checked={conflict.choices[c.path]===choice} aria-label={(choice==='mine'?'Моё значение: ':'Текущее значение: ')+reportFieldLabel(c.path)} onChange={()=>setConflict({...conflict,choices:{...conflict.choices,[c.path]:choice}})}/>{choice==='mine'?'Моё':'Текущее'}: {reportFieldValue(c.path,c[choice])}</label>)}</fieldset>)}<button disabled={merge.unresolved.length>0} onClick={applyMerge}>Применить проверенное объединение</button><button onClick={()=>setConflict(null)}>Вернуться к моим изменениям</button></section>}
 </div><aside className="wb-report-preview wb-surface">{snapshot?<ReportPreview snapshot={snapshot}/>:<EmptyState title="Предпросмотр отчёта">Настройте разделы и нажмите «Предпросмотр влияния». Здесь появятся значения, правила и происхождение выбранного снимка.</EmptyState>}</aside></div></section>;
}
function ReportPreview({ snapshot }: {
    snapshot: ReportSnapshot;
}) { return <section aria-label="Предпросмотр отчёта"><h2>{snapshot.definition.title}</h2><p>{snapshot.definition.comment}</p><p>{snapshot.maturity ? 'Выбранный источник; не является принятым фактом.' : 'Замороженный результат выбранной цели и историческая основа.'}</p>{reportSections(snapshot).map((s, i) => <section key={i}><h3>{s.title}</h3><p>{s.comment}</p><DataTable label={s.title}><thead><tr>{s.rows[0].map((v, n) => <th key={n}>{v}</th>)}</tr></thead><tbody>{s.rows.slice(1).map((r, n) => <tr key={n}>{r.map((v, c) => <td key={c}>{v}</td>)}</tr>)}</tbody></DataTable></section>)}</section>; }
