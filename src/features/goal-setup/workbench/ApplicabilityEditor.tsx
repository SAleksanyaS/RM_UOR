import type { FieldProblem } from '../../../server/workbench/protocol';
import { object, text, TextField, type Definition } from './setup-fields';
export function ApplicabilityEditor({ value, onChange, metricOptions, scopeLabel, problems }: {
    value: Definition;
    onChange: (v: Definition) => void;
    metricOptions: Array<{
        id: string;
        name: string;
    }>;
    scopeLabel: string;
    problems: FieldProblem[];
}) {
    const period = object(value.period);
    return <fieldset><legend>Неприменимость показателя (N/A)</legend><p>Область: {scopeLabel || 'Выберите область назначения'}</p><label>Показатель N/A<select value={text(value.metricId)} onChange={e => onChange({ ...value, metricId: e.target.value })}><option value="">Выберите показатель</option>{metricOptions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><TextField label="Начало периода N/A" field="startInclusive" type="date" value={period} onChange={v => onChange({ ...value, period: v })}/><TextField label="Конец периода N/A (не включая)" field="endExclusive" type="date" value={period} onChange={v => onChange({ ...value, period: v })}/><TextField label="Причина N/A" field="reason" value={value} onChange={onChange} problems={problems}/></fieldset>;
}
