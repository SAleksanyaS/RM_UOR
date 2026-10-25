import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../app/AppContext';
import type { ReleaseDraft, ReleaseField, ReleaseItem, ReleasePreview } from './release-contracts';
import './release.css';

type SelectionKey = 'draftIds' | 'snapshotIds' | 'attestationIds' | 'evidenceIds' | 'templateIds';
type Selection = Record<SelectionKey, string[]>;
type Choices = Record<string, Record<string, 'local' | 'remote'>>;
const emptySelection = (): Selection => ({ draftIds: [], snapshotIds: [], attestationIds: [], evidenceIds: [], templateIds: [] });
const kinds: Record<string, string> = { goal: 'Цель', assignment: 'Назначение', source: 'Источник', comment: 'Комментарий', leader: 'ИТ-лидер', entity: 'Общая запись', direction: 'Направление' };
const valueText = (value: unknown) => value === null || value === undefined ? 'Не задано' : typeof value === 'string' ? value || 'Пустое значение' : JSON.stringify(value, null, 2);
function available(preview: ReleasePreview): Selection { return { draftIds: preview.drafts.map(d => d.id), snapshotIds: preview.snapshots.map(d => d.id), attestationIds: preview.attestations.map(d => d.id), evidenceIds: preview.evidence.map(d => d.id), templateIds: preview.templates.map(d => d.id) }; }

function SelectionList({ title, singular, items, selected, required = new Set<string>(), disabled, onToggle, onBatch }: {
  title: string; singular: string; items: ReleaseItem[]; selected: string[]; required?: Set<string>; disabled: boolean;
  onToggle: (id: string) => void; onBatch: (ids: string[], value: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const search = query.toLocaleLowerCase('ru'), filtered = items.filter(i => `${i.label} ${i.detail}`.toLocaleLowerCase('ru').includes(search));
  return <section className="release-card release-selection" aria-label={title}><div className="release-section-heading"><h2>{title}</h2><span>{items.filter(i => selected.includes(i.id) || required.has(i.id)).length} / {items.length}</span></div>
    {items.length ? <><div className="release-selection-tools"><label>Найти в разделе «{title}»<input value={query} onChange={e => setQuery(e.target.value)}/></label><button type="button" disabled={disabled || !filtered.length} onClick={() => onBatch(filtered.map(i => i.id), true)}>Выбрать найденное</button><button type="button" disabled={disabled || !filtered.length} onClick={() => onBatch(filtered.map(i => i.id), false)}>Снять выбор найденного</button></div>
      <div className="release-selectable-list">{filtered.map(item => <label className={`release-item ${required.has(item.id) ? 'release-item-required' : ''}`} key={item.id}><input type="checkbox" aria-label={`Включить ${singular}: ${item.label}`} checked={required.has(item.id) || selected.includes(item.id)} disabled={disabled || required.has(item.id)} onChange={() => onToggle(item.id)}/><span><strong>{item.label}</strong><small>{item.detail}</small>{required.has(item.id) && <small>Обязательно для выбранного подтверждения</small>}</span></label>)}</div>{!filtered.length && <p>По этому запросу записей нет.</p>}</> : <p className="release-note">Доступных записей нет.</p>}
  </section>;
}
function FieldComparison({ field, actualConflict, choice, disabled, onChoose }: { field: ReleaseField; actualConflict: boolean; choice?: 'local' | 'remote'; disabled: boolean; onChoose: (value: 'local' | 'remote') => void }) {
  return <article className={`release-field ${actualConflict ? 'release-field-conflict' : ''}`}><div className="release-field-heading"><h3>{field.label}</h3>{actualConflict && <span>Нужно выбрать вариант</span>}{field.conflict && !actualConflict && <span className="release-note">Сводка; выбор — в конкретном поле ниже</span>}</div><div className="release-comparison"><div><span>До вашей правки</span><pre>{valueText(field.before)}</pre></div><div><span>Ваш вариант</span><pre>{valueText(field.local)}</pre></div><div><span>В выпуске коллег</span><pre>{valueText(field.remote)}</pre></div></div>{actualConflict && <label className="release-choice">Вариант для {field.label}<select value={choice ?? ''} disabled={disabled} onChange={e => onChoose(e.target.value as 'local' | 'remote')}><option value="" disabled>Выберите вариант</option><option value="local">Сохранить мой вариант</option><option value="remote">Принять вариант из выпуска</option></select></label>}</article>;
}

export function ReleasePage() {
  const { state, mutate, refresh, notify } = useWorkspace(), curator = state.session.role === 'curator';
  const profile = curator ? `curator:${state.session.curatorId ?? ''}` : 'reader';
  const mutateRef = useRef(mutate); mutateRef.current = mutate;
  const profileRef = useRef(profile); profileRef.current = profile;
  const generation = useRef(0);
  const [storedPreview, setPreview] = useState<ReleasePreview | null>(null), [previewProfile, setPreviewProfile] = useState<string | null>(null), [selection, setSelection] = useState<Selection | null>(null), [choices, setChoices] = useState<Choices>({});
  const preview = previewProfile === profile ? storedPreview : null;
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [operationId, setOperationId] = useState<string | null>(null);
  const [draftSearch, setDraftSearch] = useState('');
  const completedOperation = useRef<string | null>(null);
  const readPreview = useCallback(async () => {
    const requestedGeneration = generation.current, requestedProfile = profileRef.current;
    const next = await mutateRef.current('/api/release/preview', {}) as ReleasePreview;
    if (requestedGeneration !== generation.current || requestedProfile !== profileRef.current) return next;
    const ids = available(next);
    setSelection(previous => previous ? Object.fromEntries(Object.entries(ids).map(([key, values]) => [key, previous[key as SelectionKey].filter(id => values.includes(id))])) as Selection
      : { ...ids, evidenceIds: [], templateIds: [] });
    setChoices(previous => Object.fromEntries(next.drafts.map(draft => [draft.id, Object.fromEntries(Object.entries(previous[draft.id] ?? {}).filter(([path]) => draft.conflicts.includes(path)))])));
    setPreviewProfile(requestedProfile); setPreview(next); return next;
  }, []);
  const updatePreview = useCallback(async () => { const requestedGeneration = generation.current; setBusy('preview'); setError(''); try { await readPreview(); } catch (e) { if (requestedGeneration === generation.current) setError((e as Error).message); } finally { if (requestedGeneration === generation.current) setBusy(null); } }, [readPreview]);
  useEffect(() => { generation.current++; setPreview(null); setSelection(null); setChoices({}); setOperationId(null); setError(''); setMessage(''); completedOperation.current = null; if (curator) void updatePreview(); else setBusy(null); }, [profile, curator, updatePreview]);
  const operation = previewProfile === profile ? state.operations.find(o => o.id === operationId) : undefined, publishing = operation?.status === 'running';
  useEffect(() => { if (curator && operation && operation.status !== 'running' && completedOperation.current !== operation.id) { completedOperation.current = operation.id; void updatePreview(); } }, [curator, operation?.id, operation?.status, updatePreview]);
  const chosen = selection ?? emptySelection();
  const requiredEvidence = new Set(preview?.attestations.filter(a => chosen.attestationIds.includes(a.id)).flatMap(a => a.evidenceIds ?? []) ?? []);
  const evidenceIds = preview?.evidence.filter(e => chosen.evidenceIds.includes(e.id) || requiredEvidence.has(e.id)).map(e => e.id) ?? [];
  const missingEvidence = [...requiredEvidence].filter(id => !preview?.evidence.some(e => e.id === id));
  const selectedConflicts = preview?.drafts.filter(d => chosen.draftIds.includes(d.id) && d.conflicts.length) ?? [];
  const count = chosen.draftIds.length + chosen.snapshotIds.length + chosen.attestationIds.length + evidenceIds.length + chosen.templateIds.length;
  const expired = !!preview && Date.parse(preview.expiresAt) <= Date.now(), locked = !!busy || publishing;
  const canPublish = !!preview?.publicationAllowed && !expired && count > 0 && !selectedConflicts.length && !missingEvidence.length && !locked;
  const toggle = (key: SelectionKey, id: string) => setSelection(current => ({ ...(current ?? emptySelection()), [key]: (current?.[key] ?? []).includes(id) ? current![key].filter(value => value !== id) : [...(current?.[key] ?? []), id] }));
  const batch = (key: SelectionKey, ids: string[], include: boolean) => setSelection(current => ({ ...(current ?? emptySelection()), [key]: include ? [...new Set([...(current?.[key] ?? []), ...ids])] : (current?.[key] ?? []).filter(id => !ids.includes(id)) }));
  function choose(draft: string, path: string, value: 'local' | 'remote') { setChoices(current => ({ ...current, [draft]: { ...current[draft], [path]: value } })); }
  async function resolve(draft: ReleaseDraft) {
    if (!preview) return; setBusy(`resolve:${draft.id}`); setError(''); setMessage('');
    const actual = Object.fromEntries(draft.conflicts.map(path => [path, choices[draft.id]?.[path]]));
    try {
      await mutate('/api/release/resolve', { previewId: preview.id, draftId: draft.id, choices: actual });
      await refresh(); await readPreview();
      setMessage('Решение сохранено локально. Состав и версии выпуска обновлены; проверьте следующие конфликты.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  async function publish() {
    if (preview && Date.parse(preview.expiresAt) <= Date.now()) { setError('Предпросмотр устарел. Обновите его перед отправкой.'); return; }
    if (!canPublish) return; setBusy('publish'); setError(''); setMessage('');
    try {
      const result = await mutate('/api/publish', { previewId: preview!.id, draftIds: chosen.draftIds, snapshotIds: chosen.snapshotIds, attestationIds: chosen.attestationIds, evidenceIds, templateIds: chosen.templateIds }) as { operationId: string };
      setOperationId(result.operationId); await refresh(); setMessage('Отправка выбранного состава запущена. Ход и результат показаны в операции.'); notify('Начата отправка выбранного состава в готовящийся выпуск.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  const shownDrafts = preview?.drafts.filter(d => `${d.label} ${kinds[d.kind] ?? d.kind}`.toLocaleLowerCase('ru').includes(draftSearch.toLocaleLowerCase('ru'))) ?? [];
  return <div className="release-page"><header><h1>Подготовка выпуска</h1><p>Выберите записи, сравните изменения коллег и разрешите конфликты перед общей отправкой.</p></header>
    <section className="release-card release-boundary"><h2>Готовящийся выпуск и основная версия</h2><p>Отправка сохраняет выбранные записи в готовящийся выпуск. Руководитель УОР отдельно включает его в основную версию. Локальные черновики и уже отправленные записи показаны отдельно.</p></section>
    {!curator ? <p>Подготовка, разрешение конфликтов и отправка доступны куратору УОР. В режиме чтения изменения не выполняются.</p> : <>
      <div className="release-toolbar"><button type="button" disabled={locked} onClick={() => void updatePreview()}>Обновить предпросмотр</button><p className="release-note">Ваши выбранные варианты сохраняются при ошибке. После обновления проверьте их по новой версии.</p></div>
      {busy && <p className="release-stage" role="status">{busy === 'preview' ? 'Читаем общий выпуск и сравниваем локальные правки…' : busy === 'publish' ? 'Проверяем и отправляем выбранный состав…' : 'Сохраняем решение конфликта и обновляем состав…'}</p>}
      {error && <p className="release-error" role="alert">{error}</p>}{message && <p className="release-message" role="status">{message}</p>}
      {operation && <section className="release-card" aria-label="Операция отправки"><h2>{operation.label}</h2><p>{operation.stage.label}</p><p>{operation.status === 'running' ? 'Выполняется…' : operation.result?.message ?? operation.status}</p>{operation.result?.details?.length ? <ul>{operation.result.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul> : null}</section>}
      {preview && <>
        <section className={`release-card ${preview.publicationAllowed ? '' : 'release-blocked'}`}><p>{preview.message}</p><p className="release-note">Предпросмотр действует до {new Date(preview.expiresAt).toLocaleString('ru-RU')}. Изменения коллег или локальных черновиков требуют новой проверки.</p>{expired && <p className="release-error">Предпросмотр устарел. Обновите его перед отправкой.</p>}<details><summary>Сведения о версиях</summary><p>Готовящийся выпуск: <code>{preview.remoteCommit}</code></p><p>Основная версия: <code>{preview.publishedCommit}</code></p></details></section>
        <section className="release-card" aria-label="Локальные правки"><div className="release-section-heading"><h2>Локальные правки</h2><span>{chosen.draftIds.length} / {preview.drafts.length}</span></div>
          {preview.drafts.length ? <><div className="release-selection-tools"><label>Найти локальную правку<input value={draftSearch} onChange={e => setDraftSearch(e.target.value)}/></label><button type="button" disabled={locked} onClick={() => batch('draftIds', shownDrafts.map(d => d.id), true)}>Выбрать найденное</button><button type="button" disabled={locked} onClick={() => batch('draftIds', shownDrafts.map(d => d.id), false)}>Снять выбор найденного</button></div>
            <div className="release-drafts">{shownDrafts.map(draft => <article className="release-draft" key={draft.id}><div className="release-draft-heading"><label className="release-item"><input type="checkbox" aria-label={`Включить правку: ${draft.label}`} checked={chosen.draftIds.includes(draft.id)} disabled={locked} onChange={() => toggle('draftIds', draft.id)}/><span><strong>{draft.label}</strong><small>{kinds[draft.kind] ?? 'Общая запись'}</small></span></label><span className={draft.conflicts.length ? 'release-conflict-badge' : 'release-ready-badge'}>{draft.conflicts.length ? `Конфликтов: ${draft.conflicts.length}` : 'Без конфликтов'}</span></div>
              <details open={draft.conflicts.length > 0}><summary>Сравнить поля: {draft.fields.length}</summary>{draft.fields.length ? draft.fields.map(field => <FieldComparison key={field.path} field={field} actualConflict={draft.conflicts.includes(field.path)} choice={choices[draft.id]?.[field.path]} disabled={locked} onChoose={value => choose(draft.id, field.path, value)}/>) : <p>Изменённых полей нет.</p>}</details>
              {draft.conflicts.length > 0 && <button type="button" aria-label={`Разрешить конфликт ${draft.label}`} disabled={locked || draft.conflicts.some(path => !choices[draft.id]?.[path])} onClick={() => void resolve(draft)}>Сохранить решение конфликта</button>}
            </article>)}</div>{!shownDrafts.length && <p>По этому запросу правок нет.</p>}</> : <p className="release-note">Локальных правок нет.</p>}
        </section>
        <div className="release-lists"><SelectionList title="Проверенные снимки" singular="снимок" items={preview.snapshots} selected={chosen.snapshotIds} disabled={locked} onToggle={id => toggle('snapshotIds', id)} onBatch={(ids, value) => batch('snapshotIds', ids, value)}/><SelectionList title="Подтверждения УОР" singular="подтверждение" items={preview.attestations} selected={chosen.attestationIds} disabled={locked} onToggle={id => toggle('attestationIds', id)} onBatch={(ids, value) => batch('attestationIds', ids, value)}/><SelectionList title="Доказательства" singular="доказательство" items={preview.evidence} selected={chosen.evidenceIds} required={requiredEvidence} disabled={locked} onToggle={id => toggle('evidenceIds', id)} onBatch={(ids, value) => batch('evidenceIds', ids, value)}/><SelectionList title="Шаблоны презентаций" singular="шаблон" items={preview.templates} selected={chosen.templateIds} disabled={locked} onToggle={id => toggle('templateIds', id)} onBatch={(ids, value) => batch('templateIds', ids, value)}/></div>
        <section className="release-card release-review" aria-label="Выбранный состав"><h2>Выбранный состав для отправки: {count}</h2><p>Правки: {chosen.draftIds.length} · снимки: {chosen.snapshotIds.length} · подтверждения: {chosen.attestationIds.length} · доказательства: {evidenceIds.length} · шаблоны: {chosen.templateIds.length}.</p><p className="release-note">Шаблоны по умолчанию исключены. Доказательства выбранных подтверждений включены обязательно; остальные файлы выбираются отдельно.</p>
          <details><summary>Перечень выбранных записей</summary><ul className="release-composition">{preview.drafts.filter(d => chosen.draftIds.includes(d.id)).map(d => <li key={`d:${d.id}`}>Правка · {d.label}</li>)}{preview.snapshots.filter(d => chosen.snapshotIds.includes(d.id)).map(d => <li key={`s:${d.id}`}>Снимок · {d.label} · {d.detail}</li>)}{preview.attestations.filter(d => chosen.attestationIds.includes(d.id)).map(d => <li key={`a:${d.id}`}>Подтверждение · {d.label} · {d.detail}</li>)}{preview.evidence.filter(d => evidenceIds.includes(d.id)).map(d => <li key={`e:${d.id}`}>Доказательство · {d.label}</li>)}{preview.templates.filter(d => chosen.templateIds.includes(d.id)).map(d => <li key={`t:${d.id}`}>Шаблон · {d.label}</li>)}</ul></details>
          {selectedConflicts.length > 0 && <p className="release-error">В выбранных правках есть конфликты: {selectedConflicts.length}. Разрешите их или исключите эти правки из состава.</p>}{missingEvidence.length > 0 && <p className="release-error">Не найдены доказательства выбранных подтверждений: {missingEvidence.length}. Восстановите файлы или исключите подтверждения.</p>}{!count && <p>Выберите хотя бы одну запись.</p>}
          <button type="button" className="release-primary" disabled={!canPublish} onClick={() => void publish()}>Отправить выбранное в готовящийся выпуск</button>
        </section>
        <section className="release-card"><h2>Уже отправлено в готовящийся выпуск: {preview.releaseChanges.length}</h2><p className="release-note">Эти записи ожидают включения руководителем УОР в основную версию и не входят повторно в выбранный локальный состав.</p>{preview.releaseChanges.length ? <details><summary>Показать отправленные записи</summary><ul className="release-composition">{preview.releaseChanges.map(item => <li key={item.id}><strong>{item.label}</strong> · {item.detail}</li>)}</ul></details> : <p>Готовящийся выпуск совпадает с основной версией.</p>}</section>
      </>}
    </>}
  </div>;
}
