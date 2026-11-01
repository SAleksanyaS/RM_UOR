import type { FieldProblem } from '../../../server/workbench/protocol';
export type Definition = Record<string, unknown>;
export const object = (v: unknown): Definition => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Definition : {};
export const text = (v: unknown) => typeof v === 'string' ? v : '';
export const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export function changed(value: Definition, key: string, input: unknown): Definition {
    const next = { ...value };
    if (input === '')
        delete next[key];
    else
        next[key] = input;
    return next;
}
export function FieldErrors({ problems = [], path }: {
    problems?: FieldProblem[];
    path: string;
}) { const found = problems.filter(p => p.path === path || p.path.startsWith(path + '/')); return <>{found.map((p, i) => <small role="alert" key={i}>{p.path}: {p.message} ({p.code})</small>)}</>; }
export function TextField({ label, value, field, onChange, problems, path = '/' + field, type = 'text', preserveEmpty = false }: {
    label: string;
    value: Definition;
    field: string;
    onChange: (v: Definition) => void;
    problems?: FieldProblem[];
    path?: string;
    type?: string;
    preserveEmpty?: boolean;
}) { return <label>{label}<input aria-label={label} type={type} value={text(value[field])} onChange={e => onChange(preserveEmpty ? { ...value, [field]: e.target.value } : changed(value, field, e.target.value))}/><FieldErrors problems={problems} path={path}/></label>; }
