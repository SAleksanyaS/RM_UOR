import type { DirectoryEntity } from '../../../domain/workbench/entities';
import type { FieldProblem } from '../../../server/workbench/protocol';
import { array, object, text, TextField, FieldErrors, type Definition } from './setup-fields';
export function PopulationEditor({ value, onChange, entities, manual, problems }: {
    value: Definition;
    onChange: (v: Definition) => void;
    entities: DirectoryEntity[];
    manual: boolean;
    problems: FieldProblem[];
}) {
    const scope = object(value.scope), selected = array(value.expectedPopulation).map(object);
    return <><label>Область назначения<select aria-label="Область назначения" value={text(scope.id)} onChange={e => {
            const entity = entities.find(v => v.id === e.target.value);
            const next = { ...value };
            if (entity)
                next.scope = { kind: entity.kind, id: entity.id };
            else
                delete next.scope;
            onChange(next);
        }}><option value="">Выберите область</option>{entities.filter(e => ['dit', 'cluster', 'product', 'team'].includes(e.kind)).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><FieldErrors problems={problems} path="/scope"/></label>
    <TextField label="Официальный срок" value={value} field="officialDueOn" type="date" problems={problems} onChange={onChange}/><label><input type="checkbox" checked={value.officialDueOn === null} onChange={e => {
            const next = { ...value };
            if (e.target.checked)
                next.officialDueOn = null;
            else
                delete next.officialDueOn;
            onChange(next);
        }}/>Официальный срок не задан</label><p>Назначение действует с публикации в main.</p>
    {manual ? <p>Для ручного статуса ожидаемый числовой состав не применяется.</p> : <fieldset><legend>Ожидаемый состав — укажите явно</legend>{entities.filter(e => ['dit', 'cluster', 'product', 'team'].includes(e.kind)).map(e => <label key={e.id}><input type="checkbox" checked={selected.some(s => s.id === e.id)} onChange={event => onChange({ ...value, expectedPopulation: event.target.checked ? [...selected, { kind: e.kind, id: e.id }] : selected.filter(s => s.id !== e.id) })}/>{e.name}</label>)}<FieldErrors problems={problems} path="/expectedPopulation"/></fieldset>}</>;
}
