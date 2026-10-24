const absent = Symbol('absent');
type Value = unknown | typeof absent;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const same = (a: Value, b: Value) => a === absent || b === absent ? a === b : canonicalJson(a) === canonicalJson(b);

export class MergeConflictError extends Error {
  readonly code = 'object_merge_conflict';
  constructor(public readonly fields: string[]) {
    super(`Конфликт изменений: ${fields.join(', ')}. Требуется согласовать поле; локальный черновик сохранён.`);
    this.name = 'MergeConflictError';
  }
}

/** Three-way object merge; arrays and scalars are atomic. Inputs are never mutated. */
export function mergeObject<T>(base: T, local: T, remote: T): T {
  const conflicts: string[] = [];
  function merge(b: Value, l: Value, r: Value, path: string): Value {
    if (same(l, r)) return l;
    if (same(l, b)) return r;
    if (same(r, b)) return l;
    if (object(b) && object(l) && object(r)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].sort()) {
        const value = merge(Object.hasOwn(b, key) ? b[key] : absent, Object.hasOwn(l, key) ? l[key] : absent,
          Object.hasOwn(r, key) ? r[key] : absent, path ? `${path}.${key}` : key);
        if (value !== absent) result[key] = value;
      }
      return result;
    }
    conflicts.push(path || '$');
    return l;
  }
  const result = merge(base, local, remote, '');
  if (conflicts.length) throw new MergeConflictError(conflicts);
  return result as T;
}
