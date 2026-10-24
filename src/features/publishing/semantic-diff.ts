import type { DomainChangeEvent } from '../../domain/contracts';
import { canonicalJson } from './merge-object';

type Version = { commit: string; files: Record<string, string> };
const parse = (content: string | undefined): unknown => {
  if (content === undefined) return null;
  try { return JSON.parse(content); } catch { return content; }
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const secret = /password|secret|token|privatekey|credential|certificate/i;

/** Fallback for direct Git edits that do not carry a structured change event. */
export function semanticDiff(before: Version, after: Version, actor = 'Git', at = new Date().toISOString()): DomainChangeEvent[] {
  const events: DomainChangeEvent[] = [];
  for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    if (path.startsWith('changes/') || before.files[path] === after.files[path]) continue;
    const previous = parse(before.files[path]), current = parse(after.files[path]);
    if (canonicalJson(previous) === canonicalJson(current)) continue;
    const fields: DomainChangeEvent['fields'] = [];
    if (object(previous) && object(current)) {
      for (const field of [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()) {
        if (!secret.test(field) && canonicalJson(previous[field]) !== canonicalJson(current[field]))
          fields.push({ field, before: previous[field] ?? null, after: current[field] ?? null });
      }
    } else fields.push({ field: previous === null ? 'created' : current === null ? 'removed' : 'content', before: null, after: null });
    const value = object(current) ? current : object(previous) ? previous : {};
    events.push({ id: `git:${after.commit}:${path}`, kind: path.startsWith('published/') ? 'snapshot' : 'catalog',
      objectId: typeof value.id === 'string' ? value.id : path,
      objectLabel: typeof value.title === 'string' ? value.title : typeof value.name === 'string' ? value.name : path,
      actor, at, fields });
  }
  return events;
}
