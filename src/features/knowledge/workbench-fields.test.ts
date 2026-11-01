import { afterEach, describe, expect, it } from 'vitest';
import { validateCustomFieldValue, registerConfigurationCommands, describeWorkbenchForm } from './workbench-fields';
import { createPreferencesService } from '../system/workbench-preferences';
import { draftFixture, draftCleanups } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';
import type { CustomFieldDef } from '../../domain/workbench/entities';

afterEach(async () => { for (const cleanup of draftCleanups.splice(0)) await cleanup(); });
const field = (valueType: CustomFieldDef['valueType']): CustomFieldDef => ({ ...makeHeader(900), name: 'Метка', entityTypes: ['work'], valueType, enumValues: ['enum','multi_enum'].includes(valueType) ? ['A','B'] : null });
describe('configuration fields', () => {
  it.each([['text','abc',5],['long_text','text',false],['decimal','12.5','1e3'],['boolean',true,'true'],['date','2026-10-29','2026-02-30'],['enum','A','other'],['multi_enum',['A','B'],['A','A']]] as const)('validates %s without coercion', (type, good, bad) => {
    expect(() => validateCustomFieldValue(field(type), good as any)).not.toThrow();
    expect(() => validateCustomFieldValue(field(type), null)).not.toThrow();
    expect(() => validateCustomFieldValue(field(type), bad as any)).toThrow();
  });
  it('rejects inappropriate enum catalogs', () => {
    expect(() => validateCustomFieldValue({ ...field('text'), enumValues: ['A'] }, 'A')).toThrow();
    expect(() => validateCustomFieldValue({ ...field('enum'), enumValues: null }, 'A')).toThrow();
  });
  it('preserves exact old definitions and values while a field changes', async () => {
    const f = draftFixture();
    registerConfigurationCommands(f.registry, { drafts: f.service, preferences: createPreferencesService({ repository: f.repository, installationId: f.context.installationId, clock: f.clock }) });
    const originalCalculation = await f.prepare();
    const opened = await f.open('custom_field_def');
    const definition = { name: 'Метка', entityTypes: ['core_goal_definition'], valueType: 'enum', enumValues: ['A','B'] };
    const saved = await f.execute('customField.draft.save', { draftId: opened.draftId, definition });
    const fieldRef = (saved.result as any).versionRef;
    const value = await f.open('custom_field_value');
    const body = { objectRef: { entityType: 'core_goal_definition', id: f.input.goal.id }, fieldRef, value: 'A' };
    await expect(f.execute('customFieldValue.draft.save', { draftId: value.draftId, definition: { ...body, value: 'other' } })).rejects.toMatchObject({ statusCode: 422 });
    await f.execute('customFieldValue.draft.save', { draftId: value.draftId, definition: body });
    await f.execute('customField.draft.save', { draftId: opened.draftId, definition: { ...definition, enumValues: ['B'] } });
    expect((f.service.readDraftVersions(f.packageId()).find(v => v.value.id === fieldRef.id && v.value.revision === fieldRef.revision)!.value as CustomFieldDef).enumValues).toEqual(['A','B']);
    expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(true);
    expect(f.count('custom_field_value')).toBe(0);
    expect(await f.prepare()).toEqual(originalCalculation);
  });
  it('describes server schemas and gives only allowed actions', () => {
    const f = draftFixture();
    const form = describeWorkbenchForm({ formKind: 'custom_field_def', ref: null }, f.context);
    expect(JSON.stringify(form.schema)).toContain('multi_enum');
    expect(form.editToken).toBeNull();
    expect(form.actions.some(a => a.commandName === 'draft.open' && a.enabled)).toBe(true);
    f.context.ownAccess.role = 'viewer';
    expect(describeWorkbenchForm({ formKind: 'custom_field_def', ref: null }, f.context).actions.every(a => !a.enabled)).toBe(true);
    expect(() => describeWorkbenchForm({ formKind: 'sql', ref: null }, f.context)).toThrow();
    expect(() => describeWorkbenchForm({ formKind: 'custom_field_def', ref: { entityType: 'work', id: fixtureId(1) } }, f.context)).toThrow();
  });
  it('describes an actual owned form with its CAS token and rejects foreign ownership', async () => {
    const f = draftFixture(); const opened = await f.open('custom_field_def');
    const form = describeWorkbenchForm({formKind:'custom_field_def',ref:opened.entityRef},f.context,{drafts:f.service,packageId:f.packageId()});
    expect(form.editToken).toBe(f.token());
    expect(form.actions.find(a => a.commandName === 'customField.draft.save')?.payload?.draftId).toBe(opened.draftId);
    expect(form.values).toEqual({});
    expect(() => describeWorkbenchForm({formKind:'custom_field_def',ref:opened.entityRef},{...f.context,installationId:fixtureId(999)},{drafts:f.service,packageId:f.packageId()})).toThrow();
  });
});
