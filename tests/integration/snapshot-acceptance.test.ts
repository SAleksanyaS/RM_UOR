import { describe, expect, it } from 'vitest';
import demoSnapshots from '../../catalog/demo-snapshots.json';
import type { CuratorSession, LocalSnapshot } from '../../src/domain/contracts';
import { preparePublication } from '../../src/features/snapshots/publication-package';

const session: CuratorSession = { id: 'curator-session', role: 'curator', curatorId: 'demo-curator', name: 'Демо-куратор', createdAt: '2026-10-24T09:00:00.000Z' };
function snapshot(): LocalSnapshot { return { ...structuredClone(demoSnapshots[0]) as LocalSnapshot, status: 'validated', curatorId: session.curatorId, curatorName: session.name, validatedAt: session.createdAt }; }

describe('curator snapshot publication boundary', () => {
  it('prepares only normalized observations and a manifest with explicit origin and curator provenance', () => {
    const data = Object.assign(snapshot(), { browserProfile: 'must not be exported', cookie: 'secret' });
    const pack = preparePublication(session, data, 'demo-only');
    expect(pack.files.map(file => file.path)).toEqual([
      'published/snapshots/demo-values/demo-values-snapshot/manifest.json',
      'published/snapshots/demo-values/demo-values-snapshot/observations.json',
    ]);
    const content = pack.files.map(file => file.content).join('');
    expect(content).not.toContain('browserProfile');
    expect(content).not.toContain('cookie');
    const manifest = JSON.parse(pack.files[0].content);
    expect(manifest).toMatchObject({ classification: 'demo', origin: 'demo', status: 'validated', curatorId: 'demo-curator', curatorName: 'Демо-куратор', validatedAt: session.createdAt });
    expect(JSON.parse(pack.files[1].content)).toHaveLength(data.observations.length);
  });

  it('requires curator role and explicit validation with complete curator metadata', () => {
    expect(() => preparePublication({ ...session, role: 'reader' } as unknown as CuratorSession, snapshot(), 'demo-only')).toThrow(/куратор/i);
    expect(() => preparePublication(session, { ...snapshot(), status: 'personal' }, 'demo-only')).toThrow(/провер/i);
    expect(() => preparePublication(session, { ...snapshot(), curatorName: null }, 'demo-only')).toThrow(/куратор/i);
  });

  it('rejects corporate publication in the public demo-only contour and allows it only internally', () => {
    const data = { ...snapshot(), classification: 'corporate' as const };
    expect(() => preparePublication(session, data, 'demo-only')).toThrow(/корпоратив/i);
    expect(preparePublication(session, data, 'internal').classification).toBe('corporate');
  });

  it('rejects unsafe path identifiers and inconsistent source or period without mutating the snapshot', () => {
    const data = snapshot(); const before = structuredClone(data);
    expect(() => preparePublication(session, { ...data, id: '../secret' }, 'demo-only')).toThrow(/идентификатор/i);
    expect(() => preparePublication(session, { ...data, sourceId: 'CON' }, 'demo-only')).toThrow(/идентификатор/i);
    expect(() => preparePublication(session, { ...data, period: 'different-period' }, 'demo-only')).toThrow(/период/i);
    expect(data).toEqual(before);
  });
});
