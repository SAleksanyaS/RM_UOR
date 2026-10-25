const absent = Symbol('absent');
type Value = unknown | typeof absent;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const same = (a: Value, b: Value) => a === absent || b === absent ? a === b : canonicalJson(a) === canonicalJson(b);

/** Revision is metadata; specialized execution bodies mirror the same token. Never mutate the chosen business value. */
export function refreshObjectRevision(value: Record<string, unknown>, revision: string): Record<string, unknown> {
  const accepted: Record<string, unknown> = { ...value, revision };
  if (accepted.type === 'work_package' || accepted.type === 'execution_config') {
    if (typeof accepted.body !== 'string') throw new Error('У записи исполнения отсутствует типизированное содержимое');
    const body: unknown = JSON.parse(accepted.body);
    if (!object(body)) throw new Error('Некорректное содержимое записи исполнения');
    accepted.body = JSON.stringify({ ...body, revision });
  }
  return accepted;
}

export class MergeConflictError extends Error {
  readonly code = 'object_merge_conflict';
  constructor(public readonly fields: string[]) {
    super(`Конфликт изменений: ${fields.join(', ')}. Требуется согласовать поле; локальный черновик сохранён.`);
    this.name = 'MergeConflictError';
  }
}

/** Three-way object merge; arrays and scalars are atomic. Inputs are never mutated. */
export interface MergeFieldConflict {path:string;labelPath:string;base:unknown;local:unknown;remote:unknown}
export function inspectMerge<T>(base:T,local:T,remote:T,choices:Record<string,'local'|'remote'>={}):{value:T;conflicts:MergeFieldConflict[]}{
  const conflicts:MergeFieldConflict[]=[];
  function merge(b: Value, l: Value, r: Value, path: string,labelPath:string): Value {
    if (same(l, r)) return l;
    if (same(l, b)) return r;
    if (same(r, b)) return l;
    if (object(b) && object(l) && object(r)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].sort()) {
        const value = merge(Object.hasOwn(b, key) ? b[key] : absent, Object.hasOwn(l, key) ? l[key] : absent,
          Object.hasOwn(r, key) ? r[key] : absent, `${path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`, labelPath ? `${labelPath}.${key}` : key);
        if (value !== absent) result[key] = value;
      }
      return result;
    }
    const selected=Object.hasOwn(choices,path||'$')?choices[path||'$']:undefined;
    if(selected==='local')return l;if(selected==='remote')return r;
    conflicts.push({path:path||'$',labelPath:labelPath||'$',base:b===absent?null:b,local:l===absent?null:l,remote:r===absent?null:r});
    return l;
  }
  const result = merge(base, local, remote, '','');return{value:result as T,conflicts};
}
export function mergeObject<T>(base:T,local:T,remote:T):T{
  const result=inspectMerge(base,local,remote);
  if(result.conflicts.length)throw new MergeConflictError(result.conflicts.map(c=>c.labelPath));return result.value;
}
