import { useState } from 'react';
import { useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import type { SetupPackage, SetupPreview, SetupSelection,SetupRecord } from './setup-package-contracts';
import { useSetupOperation, SetupOperationStatus, operationOwnerKey } from './setup-package-operation';
import type { SetupCatalog } from './setup-package-service';
const request = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } };
const initial: SetupSelection = { materials: true, references: true, dashboards: true, reports: true, weeklyPrompts: true, publishedRoots: [] };
const labels = { materials: 'Оригиналы XLSX/PPTX и происхождение', references: 'Справочники и методика зрелости', dashboards: 'Шаблон рабочего экрана', reports: 'Рецепты отчётов', weeklyPrompts: 'Промпты недельной сводки' };
export function SetupPackagePanel() { const { client, session } = useWorkbench(); return <SetupPackagePanelOwned key={operationOwnerKey(client, session?.personId)}/>; }
function SetupPackagePanelOwned() {
    const { client, session, refreshSession } = useWorkbench();
    const [revision, setRevision] = useState(0), [selection, setSelection] = useState<SetupSelection>(initial), [version, setVersion] = useState(1), [pkg, setPackage] = useState<SetupPackage | null>(null), [preview, setPreview] = useState<SetupPreview | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
    const catalog = useWorkbenchQuery<SetupCatalog>('setup.catalog', request, revision), available = useWorkbenchQuery<Array<{
        entityType: string;
        id: string;
        revision: number;
        title: string;
    }>>('setup.available', request, revision);
    const operation = useSetupOperation('setup', async () => { await client.query('setup.catalog', request); if (operation.active()) {
        setRevision(v => v + 1);
        await refreshSession();
    } });
    const run = operation.run;
    const download = (value: SetupPackage) => { const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `${value.packageId}-v${value.version}.uor-setup.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    const [editKey,setEditKey]=useState(''),[editText,setEditText]=useState(''),[backupId,setBackupId]=useState<string|null>(null);
    const disabled = operation.blocked || !session;
    return <section className="wb-surface" aria-label="Общий пакет настройки"><header className="wb-section-header"><div><span className="wb-eyebrow">Настройка коллег</span><h2>Общий пакет рабочего места</h2></div></header><div className="wb-object-content">
  <p>Выберите общие материалы и проверенные определения. Коллега получает свою личность и настройки подключения; принятые записи сохраняют исходное происхождение.</p>
  {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{!!catalog.error && <p role="alert">Не удалось прочитать установленные настройки.</p>}
  <SetupOperationStatus value={operation}/>{backupId&&<p><a href={'/api/v1/backups/'+encodeURIComponent(backupId)+'/file'}>Скачать защитную копию перед настройкой</a></p>}
  <fieldset disabled={disabled}><legend>Состав пакета</legend>{Object.entries(labels).map(([key, label]) => <label key={key} style={{ display: 'block' }}><input type="checkbox" checked={selection[key as keyof typeof labels]} onChange={e => setSelection(v => ({ ...v, [key]: e.target.checked }))}/>{label}</label>)}<label>Версия пакета <input aria-label="Версия пакета" type="number" min={1} value={version} onChange={e => setVersion(Number(e.target.value))}/></label>
  <details><summary>Принятые определения, источники и данные ({available.data?.length ?? 0})</summary>{available.data?.map(item => { const selected = selection.publishedRoots?.some(v => v.entityType === item.entityType && v.id === item.id && v.revision === item.revision); return <label key={item.entityType + item.id} style={{ display: 'block' }}><input type="checkbox" checked={selected ?? false} onChange={e => setSelection(v => ({ ...v, publishedRoots: e.target.checked ? [...(v.publishedRoots ?? []), { entityType: item.entityType, id: item.id, revision: item.revision }] : (v.publishedRoots ?? []).filter(r => !(r.entityType === item.entityType && r.id === item.id)) }))}/>{item.title} · {item.entityType}</label>; })}<p>Зависимости выбранных записей добавляются целиком. Личные подключения и исходные приватные файлы исключены.</p></details>
  <button type="button" onClick={() => void (async () => { const value = await run('setup.export', { selection, version }); if (value) {
        setPackage(value);
        setPreview(null);
        download(value);
        setNotice('Пакет создан. Передайте JSON коллеге.');
    } })()}>Создать и скачать пакет</button></fieldset>
  <hr /><label>Открыть общий пакет JSON <input type="file" accept=".json,application/json" disabled={disabled} onChange={e => { const file = e.target.files?.[0]; setPreview(null); setPackage(null); setError(null); if (!file)
        return; if (file.size > 900000) {
        setError('Пакет превышает 900 КБ. Выберите меньший состав.');
        return;
    } void file.text().then(text => { try {
        setPackage(JSON.parse(text));
    }
    catch {
        setError('Файл не является JSON пакетом.');
    } }); }}/></label>
  {pkg && <><p>Пакет: {pkg.packageId} · версия {pkg.version} · {pkg.inventory?.records ?? 0} пресетов · {pkg.inventory?.coreVersions ?? 0} принятых версий · {pkg.inventory?.files ?? 0} файлов</p><button type="button" disabled={disabled} onClick={() => void (async () => { const p = await run('setup.preview', { package: pkg }); if (p)
        setPreview(p); })()}>Проверить и сравнить</button></>}
  {preview && <><h3>Изменения до применения</h3><ul>{[...preview.changes, ...preview.coreChanges].map((c, i) => <li key={c.key + i}>{c.key}: {{ add: 'добавить', update: 'обновить общий пресет', unchanged: 'без изменений', conflict: 'сохранить локальное / проверить конфликт' }[c.action]}</li>)}</ul>{preview.warnings.map(w => <p key={w}>{w}</p>)}<button type="button" disabled={disabled || preview.coreChanges.some(c => c.action === 'conflict')} onClick={() => void (async () => { const result = await run('setup.apply', { package: pkg, previewDigest: preview.digest }); if (result) {
        setBackupId(result.rescueId);setNotice(`Пакет применён. ${result.rescueId ? 'Защитная версия сохранена.' : ''} ${result.conflicts.length ? 'Локальные изменения сохранены.' : ''}`);
        setPreview(null);
        setRevision(v => v + 1);
        await refreshSession();
    } })()}>Применить с защитной копией настроек</button></>}
  {catalog.data&&<details><summary>Личные настройки импортированных пресетов</summary><p>Личная правка сохраняется при обновлении общего пакета. Исходные материалы и производная методика меняются только проверенным пакетом.</p><label>Пресет<select value={editKey} disabled={disabled} onChange={e=>{setEditKey(e.target.value);const r=catalog.data?.records.find(v=>v.key===e.target.value);setEditText(r?JSON.stringify(r.value,null,2):'');}}><option value="">Выберите пресет</option>{catalog.data.records.filter(r=>['weekly-prompt','report-recipe','dashboard-template'].includes(r.kind)).map(r=><option key={r.key} value={r.key}>{r.key}</option>)}</select></label>{editKey&&<><PresetFields record={catalog.data.records.find(v=>v.key===editKey)!} value={JSON.parse(editText)} disabled={disabled} onChange={v=>setEditText(JSON.stringify(v))}/><button type="button" disabled={disabled} onClick={()=>void(async()=>{try{const value=JSON.parse(editText);const result=await run('setup.preset.save',{key:editKey,value,expectedRevision:catalog.data!.revision});if(result){setNotice('Личная настройка пресета сохранена.');setRevision(v=>v+1);}}catch{setError('Проверьте поля выбранного пресета.');}})()}>Сохранить личный пресет</button></>}</details>}
      {catalog.data && <p>Установлено пресетов: {catalog.data.records.length}. Защитных версий: {catalog.data.rescues.length}.</p>}
 </div></section>;
}

function PresetFields({record,value,disabled,onChange}:{record:SetupRecord;value:Record<string,any>;disabled:boolean;onChange(v:Record<string,unknown>):void}){
 const field=(key:string,label:string,multiline=false)=><label style={{display:'block'}} key={key}>{label}{multiline?<textarea rows={4} disabled={disabled} value={String(value[key]??'')} onChange={e=>onChange({...value,[key]:e.target.value})}/>:<input disabled={disabled} value={String(value[key]??'')} onChange={e=>onChange({...value,[key]:e.target.value})}/>}</label>;
 if(record.kind==='weekly-prompt')return <>{field('version','Версия промптов')}{field('analyst','Аналитик',true)}{field('critic','Критик',true)}{field('editor','Редактор',true)}</>;
 if(record.kind==='report-recipe')return <>{field('title','Название отчёта')}{field('comment','Вводный комментарий',true)}</>;
 return <>{field('title','Название рабочего экрана')}<fieldset disabled={disabled}><legend>Блоки рабочего экрана</legend>{Object.entries({summary:'Сравнение целей',matrix:'Матрица',quality:'Качество данных',sources:'Список целей'}).map(([key,label])=><label key={key}><input type="checkbox" checked={value.blocks.includes(key)} onChange={e=>onChange({...value,blocks:e.target.checked?[...value.blocks,key]:value.blocks.filter((v:string)=>v!==key)})}/>{label}</label>)}</fieldset></>;
}
