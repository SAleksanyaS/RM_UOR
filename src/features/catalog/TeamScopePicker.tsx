import { useState } from 'react';
import type { Assignment, KnowledgeEntity } from '../../domain/contracts';
import type { NewScopeEntity } from './scope-contracts';
import './team-scope-picker.css';

export interface ScopeSelection {
  teams: string[]; participantIds?: string[]; newEntities: NewScopeEntity[];
}
const typeNames: Record<NewScopeEntity['type'], string> = { team: 'Команда', product: 'Продукт', it_service: 'ИТ-услуга', scope: 'Другое' };
const matches = (name: string, query: string) => name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'));
const toggle = (values: string[], key: string, checked: boolean) => checked ? [...new Set([...values, key])] : values.filter(value => value !== key);

export function TeamScopePicker({ assignment, entities, value, onChange, disabled = false }: {
  assignment: Assignment; entities: KnowledgeEntity[]; value: ScopeSelection;
  onChange: (patch: Partial<ScopeSelection>) => void; disabled?: boolean;
}) {
  const [teamQuery, setTeamQuery] = useState(''), [objectQuery, setObjectQuery] = useState('');
  const [newName, setNewName] = useState(''), [newType, setNewType] = useState<NewScopeEntity['type']>('team');
  const [addError, setAddError] = useState('');
  const selectedIds = value.participantIds ?? [];
  const teamIds = new Set([...selectedIds, ...(assignment.participantIds ?? [])]);
  const teams = entities.filter(entity => !entity.archivedAt && entity.type === 'team' && (entity.leaderId === assignment.leaderId || teamIds.has(entity.id)));
  const knownIds = new Set(teams.map(team => team.id));
  const unresolvedIds = [...teamIds].filter(id => !knownIds.has(id));
  const pendingTeams = value.newEntities.filter(entity => entity.type === 'team');
  const objectNames = [...new Set([...assignment.teams, ...value.teams,
    ...entities.filter(entity => !entity.archivedAt && ['product', 'service', 'it_service', 'scope'].includes(entity.type) && (!entity.leaderId || entity.leaderId === assignment.leaderId)).map(entity => entity.name)])];
  const pendingObjects = value.newEntities.filter(entity => entity.type !== 'team');
  const visibleTeams = teams.filter(team => matches(team.name, teamQuery));
  const visiblePendingTeams = pendingTeams.filter(team => matches(team.name, teamQuery));
  const visibleObjects = objectNames.filter(name => matches(name, objectQuery));
  const visiblePendingObjects = pendingObjects.filter(item => matches(item.name, objectQuery));
  function setPending(clientId: string, selected: boolean) { onChange({ newEntities: value.newEntities.map(item => item.clientId === clientId ? { ...item, selected } : item) }); }
  function selectVisible(kind: 'team' | 'object', selected: boolean) {
    const visible = kind === 'team' ? visibleTeams.map(team => team.id) : visibleObjects;
    const pendingIds = new Set((kind === 'team' ? visiblePendingTeams : visiblePendingObjects).map(item => item.clientId));
    onChange({ ...(kind === 'team'
      ? { participantIds: selected ? [...new Set([...selectedIds, ...visible])] : selectedIds.filter(id => !visible.includes(id)) }
      : { teams: selected ? [...new Set([...value.teams, ...visible])] : value.teams.filter(name => !visible.includes(name)) }),
      newEntities: value.newEntities.map(item => pendingIds.has(item.clientId) ? { ...item, selected } : item) });
  }
  function add() {
    const name = newName.trim(); if (!name) return;
    if (name.length > 500) { setAddError('Название должно быть не длиннее 500 символов.'); return; }
    if (value.newEntities.some(item => item.type === newType && item.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
      setAddError('Этот элемент уже добавлен в список.'); return;
    }
    onChange({ newEntities: [...value.newEntities, { clientId: crypto.randomUUID(), type: newType, name, selected: true }] });
    setNewName(''); setAddError('');
  }
  const teamCount = selectedIds.length + pendingTeams.filter(item => item.selected).length;
  const objectCount = value.teams.length + pendingObjects.filter(item => item.selected).length;
  return <div className="assignment-scope">
    <fieldset className="assignment-scope-block" disabled={disabled}><legend>Команды в расчёте <span>{teamCount} выбрано</span></legend>
      <p className="assignment-scope-help">Выбранные команды определяют ожидаемый охват цели. Названия продуктов ниже не заменяют команды.</p>
      {value.participantIds === undefined && !pendingTeams.some(item => item.selected) && <p className="assignment-scope-unknown">Состав команд для расчёта ещё не задан. Выберите команды явно; исходные названия не преобразуются автоматически.</p>}
      {value.participantIds?.length === 0 && !pendingTeams.some(item => item.selected) && <p className="assignment-scope-empty">Все команды исключены из расчёта этого назначения.</p>}
      <input className="assignment-scope-search" type="search" aria-label="Поиск команд" placeholder="Найти команду" value={teamQuery} onChange={event => setTeamQuery(event.target.value)}/>
      {visibleTeams.length + visiblePendingTeams.length > 1 && <div className="assignment-scope-tools"><button type="button" onClick={() => selectVisible('team', true)}>Выбрать видимые</button><button type="button" onClick={() => selectVisible('team', false)}>Снять видимые</button></div>}
      <div className="assignment-scope-options">{visibleTeams.map(team => <label key={team.id}><input type="checkbox" aria-label={team.name} checked={selectedIds.includes(team.id)} onChange={event => onChange({ participantIds: toggle(selectedIds, team.id, event.target.checked) })}/><span>{team.name}</span></label>)}
      {unresolvedIds.filter(id => matches(id, teamQuery)).map(id => <label className="assignment-scope-unresolved" key={id}><input type="checkbox" aria-label={`Неизвестная команда ${id}`} checked={selectedIds.includes(id)} onChange={event => onChange({ participantIds: toggle(selectedIds, id, event.target.checked) })}/><span>Команда отсутствует в справочнике<small>{id}</small></span></label>)}
      {visiblePendingTeams.map(item => <label key={item.clientId}><input type="checkbox" aria-label={item.name} checked={item.selected} onChange={event => setPending(item.clientId, event.target.checked)}/><span>{item.name}<small>Новая команда · сохранится вместе с назначением</small></span></label>)}
      {!visibleTeams.length && !visiblePendingTeams.length && !unresolvedIds.length && <p className="assignment-scope-help">{teamQuery ? 'По этому запросу команд нет.' : 'Команд этого ИТ-лидера пока нет. Добавьте команду ниже.'}</p>}</div>
    </fieldset>
    <fieldset className="assignment-scope-block" disabled={disabled}><legend>Продукты и объекты карты <span>{objectCount} выбрано</span></legend>
      <p className="assignment-scope-help">Описывают область ответственности. Этот список сам по себе не меняет числитель и знаменатель расчёта.</p>
      <input className="assignment-scope-search" type="search" aria-label="Поиск продуктов и объектов" placeholder="Найти продукт, услугу или объект" value={objectQuery} onChange={event => setObjectQuery(event.target.value)}/>
      {visibleObjects.length + visiblePendingObjects.length > 1 && <div className="assignment-scope-tools"><button type="button" onClick={() => selectVisible('object', true)}>Выбрать видимые</button><button type="button" onClick={() => selectVisible('object', false)}>Снять видимые</button></div>}
      <div className="assignment-scope-options">{visibleObjects.map(name => <label key={name}><input type="checkbox" aria-label={name} checked={value.teams.includes(name)} onChange={event => onChange({ teams: toggle(value.teams, name, event.target.checked) })}/><span>{name}</span></label>)}
      {visiblePendingObjects.map(item => <label key={item.clientId}><input type="checkbox" aria-label={item.name} checked={item.selected} onChange={event => setPending(item.clientId, event.target.checked)}/><span>{item.name}<small>{typeNames[item.type]} · новый элемент</small></span></label>)}
      {!visibleObjects.length && !visiblePendingObjects.length && <p className="assignment-scope-help">{objectQuery ? 'По этому запросу объектов нет.' : 'Объекты пока не добавлены.'}</p>}</div>
    </fieldset>
    <fieldset className="assignment-scope-add" disabled={disabled}><legend>Новый элемент</legend><div className="assignment-scope-add-fields"><label>Название нового элемента<input maxLength={500} value={newName} onChange={event => setNewName(event.target.value)} placeholder="Введите название"/></label><label>Тип нового элемента<select value={newType} onChange={event => setNewType(event.target.value as NewScopeEntity['type'])}>{Object.entries(typeNames).map(([type, name]) => <option key={type} value={type}>{name}</option>)}</select></label></div><button className="button secondary small" type="button" disabled={!newName.trim()} onClick={add}>Добавить в список</button><p className="assignment-scope-help">Снимите галочку, если элемент нужно создать в справочнике без включения в это назначение. Запись в базу произойдёт после сохранения формы.</p>{addError && <p className="error-inline" role="alert">{addError}</p>}</fieldset>
  </div>;
}
