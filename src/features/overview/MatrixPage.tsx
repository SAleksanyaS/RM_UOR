import { Filter, ListFilter, Search, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useWorkspace } from '../../app/AppContext';
import { GoalLeaderMatrix } from './GoalLeaderMatrix';
import { buildOverview, categories } from './overview-model';
import { preferenceProfile, useLocalPreference } from '../preferences/useLocalPreference';
import '../preferences/matrix-preferences.css';

export function MatrixPage({ onLeader, onGoal }: { onLeader: (id: string) => void; onGoal: (goalId: string, leaderId?: string) => void }) {
  const { state } = useWorkspace(), profile = preferenceProfile(state.session);
  const [search, setSearch, searchFailed] = useLocalPreference(profile, 'matrix.search', '');
  const [category, setCategory, categoryFailed] = useLocalPreference(profile, 'matrix.category', 'all');
  const [status, setStatus, statusFailed] = useLocalPreference(profile, 'matrix.status', 'all');
  const [contour, setContour, contourFailed] = useLocalPreference(profile, 'matrix.contour', 'official');
  const [density, setDensity, densityFailed] = useLocalPreference(profile, 'matrix.density', 'comfortable');
  const [hiddenLeaderIds, setHiddenLeaderIds, columnsFailed] = useLocalPreference(profile, 'matrix.hiddenLeaderIds', []);
  const [columnsOpen, setColumnsOpen] = useState(false), [columnSearch, setColumnSearch] = useState('');
  const model = useMemo(() => buildOverview({ catalog: state.catalog, evaluations: state.evaluations || [], snapshots: state.snapshots }, { search, category, status, contour }), [state.catalog, state.evaluations, state.snapshots, search, category, status, contour]);
  const matchingColumns = state.catalog.leaders.filter(l => l.name.toLocaleLowerCase('ru').includes(columnSearch.toLocaleLowerCase('ru'))), shownColumns = matchingColumns.slice(0, 100);
  const failed = searchFailed || categoryFailed || statusFailed || contourFailed || densityFailed || columnsFailed;
  function toggleColumn(id: string) { setHiddenLeaderIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]); }
  function reset() { setSearch(''); setCategory('all'); setStatus('all'); setContour('official'); setDensity('comfortable'); setHiddenLeaderIds([]); }
  return <>
    <div className="page-heading"><div><div className="eyebrow">ПОДРОБНАЯ КАРТИНА ОТВЕТСТВЕННОСТИ</div><h1>Матрица целей и ИТ-лидеров</h1><p>Сравните один показатель по всем руководителям или откройте детальный срез.</p></div><span className="subtle-label">В фильтре: {model.totals.goals} целей · {model.totals.assignments} назначений</span></div>
    <section className="matrix-section">
      <div className="section-heading"><div><h2>Назначения и результаты</h2><span>Нажмите на ячейку, чтобы увидеть факты и комментарии</span></div><div className="segmented"><button aria-pressed={contour === 'official'} className={contour === 'official' ? 'active' : ''} onClick={() => setContour('official')}>Официальные цели</button><button aria-pressed={contour === 'internal'} className={contour === 'internal' ? 'active' : ''} onClick={() => setContour('internal')}>Внутренние цели</button></div></div>
      <div className="matrix-toolbar">
        <div className="search-box"><Search size={17}/><input aria-label="Поиск целей и ИТ-лидеров" maxLength={300} placeholder="Название цели или фамилия руководителя" value={search} onChange={event => setSearch(event.target.value)}/></div>
        <div className="select-control"><Filter size={15}/><select aria-label="Категория исходной карты" value={category} onChange={event => setCategory(event.target.value as typeof category)}><option value="all">Категории карты</option>{Object.entries(categories).map(([id, item]) => <option key={id} value={id}>{item.short}</option>)}</select></div>
        <div className="select-control"><ListFilter size={16}/><select aria-label="Статус цели" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">Все статусы</option><option value="not_met">Отклонения</option><option value="pending">На проверке УОР</option><option value="confirmed">Подтверждено</option><option value="unknown">Нет данных</option></select></div>
        <button className="density-button" aria-label="Плотность матрицы" aria-pressed={density === 'compact'} onClick={() => setDensity(current => current === 'compact' ? 'comfortable' : 'compact')}><SlidersHorizontal size={16}/><span>{density === 'compact' ? 'Компактно' : 'Подробно'}</span></button>
      </div>
      <div className="matrix-view-settings">
        <div className="matrix-view-settings-heading"><button type="button" aria-expanded={columnsOpen} aria-controls="matrix-column-options" onClick={() => setColumnsOpen(open => !open)}>Настроить столбцы ИТ-лидеров ({state.catalog.leaders.filter(l => !hiddenLeaderIds.includes(l.id)).length} / {state.catalog.leaders.length})</button><button type="button" onClick={reset}>Сбросить личный вид</button><span>Фильтры и вид сохраняются только для вашего профиля в этом браузере.</span></div>
        {failed && <p className="matrix-preference-warning" role="status">Браузер не сохранил настройки. Текущий вид доступен в этой вкладке; после перезагрузки он может сброситься.</p>}
        {columnsOpen && <fieldset id="matrix-column-options" className="matrix-column-options"><legend>Видимые столбцы ИТ-лидеров</legend><label className="matrix-column-search">Найти столбец ИТ-лидера<input value={columnSearch} onChange={event => setColumnSearch(event.target.value)}/></label><div className="matrix-column-actions"><button type="button" onClick={() => setHiddenLeaderIds(current => current.filter(id => !matchingColumns.some(l => l.id === id)))}>Показать найденных</button><button type="button" onClick={() => setHiddenLeaderIds(current => [...new Set([...current, ...matchingColumns.map(l => l.id)])])}>Скрыть найденных</button></div><div className="matrix-column-checkboxes">{shownColumns.map(leader => <label key={leader.id}><input type="checkbox" aria-label={`Столбец: ${leader.name}`} checked={!hiddenLeaderIds.includes(leader.id)} onChange={() => toggleColumn(leader.id)}/>{leader.name}</label>)}</div>{matchingColumns.length > shownColumns.length && <p>Показано первых {shownColumns.length} из {matchingColumns.length}. Уточните поиск; массовый выбор относится ко всем найденным.</p>}<p>Скрытие столбца меняет отображение. Цели, фильтры и расчёты остаются в выбранном срезе.</p></fieldset>}
      </div>
      <GoalLeaderMatrix key={profile} model={model} density={density} hiddenLeaderIds={hiddenLeaderIds} onGoal={onGoal} onLeader={onLeader}/>
      <div className="matrix-footer"><span>Все расчёты — в выбранном контуре оценки. Отсутствие данных не означает нулевой результат.</span><span>— цель не назначена</span></div>
    </section>
  </>;
}
