import { z } from 'zod';
import type { CustomFieldDef, CustomFieldValue, DashboardDef, WorkbenchEntity } from '../../domain/workbench/entities';
import type { EntityRef, Header, VersionRef } from '../../domain/workbench/primitives';
import { uuidSchema } from '../../domain/workbench/primitives';
import { customFieldDefSchema, customFieldValueSchema, validateCustomFieldScalar, validateCustomFieldValue as validateEntityValue } from '../../domain/workbench/schemas/extensions';
import { schemaForEntity } from '../../domain/workbench/schemas';
import { WorkbenchError } from '../../domain/workbench/errors';
import type { CommandContext, CommandOutcome, CommandRegistry } from '../../server/workbench/command-registry';
import { createCommandStore } from '../../server/workbench/command-store';
import { fieldProblems, WorkbenchHttpError, type FieldProblem, type NextAction } from '../../server/workbench/protocol';
import type { QueryContext } from '../../server/workbench/query-registry';
import { canUseCapability } from '../identity/workbench-access-policy';
import { businessDefinition, draftDefinitionSchema, draftEntityTypes, type DraftService, type DraftSaveInput } from '../catalog/workbench-drafts';
import { draftSaveResultSchema } from '../catalog/workbench-draft-commands';
import { personalPreferencesSchema, type PreferencesService } from '../system/workbench-preferences';
import { dashboardSchemaDescriptors, validateDashboard, validateDashboardSettings } from './workbench-dashboards';

export function validateCustomFieldValue(definition:CustomFieldDef,value:CustomFieldValue['value']):void { validateCustomFieldScalar(definition,value); }
export type FormDescription = {formKind:string;ref:EntityRef|null;schema:Record<string,unknown>;registeredSchemas:Array<{schemaId:string;schemaVersion:number;schema:Record<string,unknown>}>;values:Record<string,unknown>|null;problems:FieldProblem[];help:string;actions:NextAction[];editToken:string|null};
export function describeWorkbenchForm(input:{formKind:string;ref:EntityRef|null},context:QueryContext,own?:{drafts:DraftService;packageId:string}):FormDescription {
  if (!draftEntityTypes.includes(input.formKind as typeof draftEntityTypes[number]) || input.ref && input.ref.entityType !== input.formKind) throw new WorkbenchHttpError(422,'FORM_UNSUPPORTED','Unknown form');
  const pkg = own?.drafts.readOwnPackage(context,own.packageId);
  const entry = pkg?.entries.find(e => e.entityRef.entityType === input.formKind && e.entityRef.id === input.ref?.id);
  const published = input.ref && context.repository.readPublishedHead(input.ref);
  if (input.ref && !entry && !published) throw new WorkbenchHttpError(404,'REFERENCE_NOT_FOUND','Object not published');
  const allowed = canUseCapability(context.ownAccess,'uor.prepare') && context.ownAccess.personId !== null;
  const actions:NextAction[] = [{commandName:'draft.open',payload:{entityType:input.formKind,ref:input.ref,packageId:pkg?.packageId ?? null},route:null,label:'Открыть черновик',enabled:allowed,disabledReason:allowed ? null : 'Подготовка доступна куратору УОР'}];
  const saveNames:Record<string,string> = {custom_field_def:'customField',custom_field_value:'customFieldValue',dashboard_def:'dashboard'};
  if (entry && saveNames[input.formKind]) actions.push({commandName:saveNames[input.formKind]+'.draft.save',payload:{draftId:entry.draftId,definition:entry.definition},route:null,label:'Сохранить черновик',enabled:allowed,disabledReason:allowed ? null : 'Подготовка доступна куратору УОР'});
  return { ...input,schema:z.toJSONSchema(draftDefinitionSchema(input.formKind),{unrepresentable:'any'}),registeredSchemas:input.formKind === 'dashboard_def' ? dashboardSchemaDescriptors.map(s => ({schemaId:s.schemaId,schemaVersion:s.schemaVersion,schema:z.toJSONSchema(s.inputSchema,{unrepresentable:'any'})})) : [],values:entry?.definition ?? (published ? businessDefinition(published) : null),problems:entry?.problems ?? [],help:'Поля описывают объект. Расчёт задаётся опубликованной методикой.',editToken:entry && pkg ? `draft:${pkg.packageId}:${pkg.revision}` : null,actions };
}
export function registerConfigurationCommands(registry:CommandRegistry,{drafts,preferences}:{drafts:DraftService;preferences:PreferencesService}):void {
  const validate = (entityType:string,value:WorkbenchEntity,resolve:(ref:EntityRef|VersionRef)=>Header|null) => {
    if (entityType === 'dashboard_def') validateDashboard(value as DashboardDef,{read:resolve});
    if (entityType === 'custom_field_def') { const field = customFieldDefSchema.parse(value); for (const type of field.entityTypes) schemaForEntity(type); }
    if (entityType === 'custom_field_value') {
      const fieldValue = customFieldValueSchema.parse(value); const definition = resolve(fieldValue.fieldRef);
      if (!definition) throw new WorkbenchHttpError(422,'CUSTOM_FIELD_DEFINITION_MISMATCH','Field definition is unavailable');
      validateEntityValue(fieldValue,definition as CustomFieldDef);
    }
  };
  drafts.registerOwnerPolicy(['dashboard_def','custom_field_def','custom_field_value'],{
    validateSave({context,entry,definition}) {
      if (entry.entityRef.entityType === 'dashboard_def') {
        const problems = validateDashboardSettings({blocks:(definition.blocks ?? []) as DashboardDef['blocks'],filters:(definition.filters ?? []) as DashboardDef['filters']},true);
        const complete = schemaForEntity('dashboard_def').safeParse({...entry.header,...definition});
        if (complete.success && problems.length === 0) validateDashboard(complete.data as DashboardDef,{read:ref => drafts.resolveOwnReference(context,entry.packageId,ref)});
        return problems;
      }
      const parsed = schemaForEntity(entry.entityRef.entityType).safeParse({...entry.header,...definition});
      if (parsed.success) validate(entry.entityRef.entityType,parsed.data as WorkbenchEntity,ref => drafts.resolveOwnReference(context,entry.packageId,ref));
    },
    validateMaterialization({entityType,value,resolve}) { validate(entityType,value,resolve); },
  });
  const receipt = <T>(context:CommandContext):CommandOutcome<T> => {
    const value = createCommandStore(context.repository).get(context.installationId,context.commandId)?.receipt_json;
    if (!value) throw Error('Configuration effect did not commit its receipt'); return JSON.parse(value);
  };
  for (const [name,type] of [['dashboard','dashboard_def'],['customField','custom_field_def'],['customFieldValue','custom_field_value']]) registry.register({
    name:`${name}.draft.save`,inputSchema:z.strictObject({draftId:uuidSchema,definition:draftDefinitionSchema(type)}),outputSchema:draftSaveResultSchema,capability:'uor.prepare',ownership:'person',effect:'sharedDraft',execution:'sync',
    async handler(context,input) { try { await drafts.saveDefinition(context,input as DraftSaveInput,[type]); } catch(error) { if (error instanceof WorkbenchError) throw new WorkbenchHttpError(422,error.code,error.code); if (error instanceof z.ZodError) throw new WorkbenchHttpError(422,'VALIDATION_FAILED','Invalid settings',fieldProblems(error)); throw error; } return receipt(context); },
  });
  registry.register({name:'preferences.set',inputSchema:z.strictObject({values:personalPreferencesSchema}),outputSchema:z.strictObject({values:personalPreferencesSchema}),capability:'personal.write',ownership:'person-if-present',effect:'local',execution:'sync',async handler(context,input) { await preferences.set(context,input); return receipt(context); }});
}
