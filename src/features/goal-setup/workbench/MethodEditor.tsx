import {useState} from 'react';
import {testCondition} from '../../evaluation/workbench/conditions';
import {numericConditionSchema} from '../../../domain/workbench/schemas/core';
import {canonicalDecimal} from '../../../domain/workbench/exact-number';
import { array, changed, object, text, TextField, FieldErrors, type Definition } from './setup-fields';
import type { FieldProblem } from '../../../server/workbench/protocol';
export type MetricForm = {
    id: string;
    definition: Definition;
    onChange: (v: Definition) => void;
};
function Condition({ value, onChange, label = 'Порог' }: {
    value: Definition;
    onChange: (v: Definition) => void;
    label?: string;
}) { return <><label>Условие<select value={text(value.op)} onChange={e => onChange({ op: e.target.value })}><option value="">Выберите оператор</option><option value="gte">Не меньше (≥)</option><option value="lte">Не больше (≤)</option><option value="eq">Равно (=)</option><option value="range">В диапазоне</option></select></label>{value.op === 'range' ? <><TextField label="Нижняя граница" field="min" value={value} onChange={onChange}/><TextField label="Верхняя граница" field="max" value={value} onChange={onChange}/></> : <TextField label={label} field="target" value={value} onChange={onChange}/>}</>; }
export function MethodEditor({ value, onChange, metrics, onAddMetric, problems }: {
    value: Definition;
    onChange: (v: Definition) => void;
    metrics: MetricForm[];
    onAddMetric: () => void;
    problems: FieldProblem[];
}) {
    if (value.mode === 'manual_status')
        return <p>Ручной статус: завершение требует описания результата; возврат требует причины.</p>;
    const rules = array(value.rules).map(object), formula = object(value.formula);
    const patch = (i: number, next: Definition) => onChange({ ...value, rules: rules.map((r, n) => n === i ? next : r) });
    return <><button type="button" onClick={onAddMetric}>Добавить показатель</button>{rules.map((rule, i) => {
            const metric = metrics.find(m => m.id === object(rule.metricRef).id), normalization = object(rule.normalization), reducer = object(rule.reducer);
            return <fieldset key={text(object(rule.metricRef).id) || i}><legend>Показатель {i + 1}</legend>{metric && <><TextField label="Название показателя" field="name" value={metric.definition} onChange={metric.onChange}/><TextField label="Код единицы" field="code" value={object(metric.definition.unit)} onChange={unit => metric.onChange({ ...metric.definition, unit })}/><TextField label="Единица измерения" field="label" value={object(metric.definition.unit)} onChange={unit => metric.onChange({ ...metric.definition, unit })}/><label>Область значений<select value={text(metric.definition.domain)} onChange={e => metric.onChange({ ...metric.definition, domain: e.target.value })}><option value="">Выберите область</option><option value="nonnegative_decimal">Неотрицательное число</option><option value="nonnegative_integer">Неотрицательное целое</option><option value="signed_decimal">Число со знаком</option></select></label></>}
      <Condition value={object(rule.condition)} onChange={condition => patch(i, { ...rule, condition })}/><ThresholdPreview value={object(rule.condition)} index={i}/><label><input type="checkbox" checked={rule.mandatory === true} onChange={e => patch(i, { ...rule, mandatory: e.target.checked })}/>Обязательное условие</label><TextField label="Вес" field="originalWeight" value={rule} onChange={v => patch(i, v)}/>
      <label>Нормирование<select value={text(normalization.kind)} onChange={e => patch(i, { ...rule, normalization: { kind: e.target.value } })}><option value="">Выберите нормирование</option><option value="increase_ratio_v1">Рост к целевому значению</option><option value="decrease_ratio_capped_v1">Снижение с ограничением</option><option value="zero_counter_v1">Нулевой счётчик</option><option value="binary_condition_v1">Условие: выполнено / не выполнено</option></select></label>{normalization.kind === 'decrease_ratio_capped_v1' && <TextField label="Максимальный процент" field="maxPercent" value={normalization} onChange={v => patch(i, { ...rule, normalization: v })}/>}
      <TextField label="Допустимая давность, часы" field="maxAgeHours" value={object(rule.freshness)} onChange={freshness => patch(i, { ...rule, freshness })}/><TextField label="Период обновления, часы" field="updateEveryHours" value={object(rule.freshness)} onChange={freshness => patch(i, { ...rule, freshness })}/>
      <label>Обработка строк<select value={text(reducer.kind)} onChange={e => patch(i, { ...rule, reducer: { kind: e.target.value } })}><option value="">Выберите обработку</option><option value="source_provided_value">Значение источника</option><option value="sum">Сумма</option><option value="count">Количество</option><option value="ratio">Отношение</option></select></label>{['source_provided_value', 'sum'].includes(text(reducer.kind)) && <TextField label="Поле значения" field="valueField" value={reducer} onChange={r => patch(i, { ...rule, reducer: r })}/>} {reducer.kind === 'ratio' && <><TextField label="Поле числителя" field="numeratorField" value={reducer} onChange={r => patch(i, { ...rule, reducer: r })}/><TextField label="Поле знаменателя" field="denominatorField" value={reducer} onChange={r => patch(i, { ...rule, reducer: r })}/><TextField label="Множитель" field="multiplier" value={reducer} onChange={r => patch(i, { ...rule, reducer: r })}/></>}
      <FieldErrors problems={problems} path={'/rules/' + i}/></fieldset>;
        })}
    <label>Итоговая формула<select value={text(formula.kind)} onChange={e => onChange({ ...value, formula: changed(formula, 'kind', e.target.value) })}><option value="">Выберите формулу</option><option value="weighted_mean_v1">Взвешенное среднее нормированных показателей</option></select></label>{formula.kind !== undefined && formula.kind !== 'weighted_mean_v1' && <p role="alert">Формула {text(formula.kind)} не поддерживается</p>}<Condition label="Итоговый порог" value={object(formula.scoreCondition)} onChange={scoreCondition => onChange({ ...value, formula: { ...formula, scoreCondition } })}/><FieldErrors problems={problems} path="/formula"/>
  </>;
}

function ThresholdPreview({value,index}:{value:Definition;index:number}){const [example,setExample]=useState('');let result='Введите пример для проверки порога';if(example.trim()){try{const condition=numericConditionSchema.parse(value);result=testCondition(canonicalDecimal(example),condition)?'Пример: условие выполнено':'Пример: условие не выполнено';}catch{result='Укажите допустимое число и полное условие';}}return <div><label>Пример значения {index+1}<input inputMode="decimal" value={example} onChange={e=>setExample(e.target.value)}/></label><p role="status">{result}</p><p>Пример не оценивает полноту данных и не подтверждает УОР.</p></div>;}
