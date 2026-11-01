// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { DashboardBuilder } from './DashboardBuilder';
import { CustomFieldEditor } from './CustomFieldEditor';
import { DashboardView } from './DashboardView';
import { GlobalSearch } from '../../search/workbench/GlobalSearch';
import { useGlobalContext } from '../../../app/workbench/context';
import { fixtureId, makeHeader } from '../../../../tests/fixtures/workbench/factories';
import type { CoreGoalDefinition } from '../../../domain/workbench/entities';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{cleanup();for(const close of closes.splice(0))await close();});
async function open(Page:()=>React.JSX.Element,role:'viewer'|'curator'='curator') {
 const h=await createWorkbenchUiHarness({role,scenario:'scope-split'},{views:{overview:Page,search:GlobalSearch}});closes.push(h.close);await h.open('/overview');return h;
}
it('reorders_blocks_by_keyboard_and_validates_settings',async()=>{
 const h=await open(()=> <DashboardBuilder />);
 await screen.findByLabelText('Название дашборда'); await waitFor(()=>expect((screen.getByRole('button',{name:'Добавить блок'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.change(screen.getByLabelText('Название дашборда'),{target:{value:'Рабочий обзор'}});
 fireEvent.change(screen.getByLabelText('Новый блок'),{target:{value:'goal-table'}});fireEvent.click(screen.getByRole('button',{name:'Добавить блок'}));
 fireEvent.change(screen.getByLabelText('Новый блок'),{target:{value:'data-issues'}});fireEvent.click(screen.getByRole('button',{name:'Добавить блок'}));
 const move=screen.getByRole('button',{name:'Вверх: Проблемы данных'});move.focus();fireEvent.keyDown(move,{key:'Enter'});fireEvent.click(move);
 expect(document.activeElement).toBe(move);
 expect(screen.getAllByRole('group',{name:/Блок:/}).map(element=>element.getAttribute('aria-label'))).toEqual(['Блок: Проблемы данных','Блок: Список целей']);
 const goal=screen.getByRole('group',{name:'Блок: Список целей'});fireEvent.change(within(goal).getByLabelText('Число строк'),{target:{value:'201'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить дашборд'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('1 до 200'));
 expect(h.requests.filter(r=>r.body?.name==='dashboard.draft.save')).toHaveLength(0);
 fireEvent.change(within(goal).getByLabelText('Число строк'),{target:{value:'25'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить дашборд'}));await screen.findByText('Черновик сохранён');
 const saved=h.requests.find(r=>r.body?.name==='dashboard.draft.save');expect((saved?.body?.payload as any).definition.blocks.map((b:any)=>b.typeId)).toEqual(['uor.dashboard.data-issues.v1','uor.dashboard.goal-table.v1']);
 expect(h.requests.filter(r=>r.body?.name==='package.submit')).toHaveLength(0);
});
it('field_value_uses_its_versioned_type',async()=>{
 const h=await open(()=> <CustomFieldEditor objectRef={{entityType:'core_goal_definition',id:fixtureId(11)}} />);
 await screen.findByLabelText('Имя поля');fireEvent.change(screen.getByLabelText('Имя поля'),{target:{value:'План затрат'}});fireEvent.change(screen.getByLabelText('Тип поля'),{target:{value:'decimal'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить описание поля'}));
 await screen.findByLabelText('Значение поля');
 for(const value of ['не число','2026-10-29']) {fireEvent.change(screen.getByLabelText('Значение поля'),{target:{value}});fireEvent.click(screen.getByRole('button',{name:'Сохранить значение'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('число'));}
 expect(h.requests.filter(r=>r.body?.name==='customFieldValue.draft.save')).toHaveLength(0);
 fireEvent.change(screen.getByLabelText('Значение поля'),{target:{value:'12.5'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить значение'}));await screen.findByText('Значение сохранено в черновике');
 const save=h.requests.find(r=>r.body?.name==='customFieldValue.draft.save');expect((save?.body?.payload as any).definition).toMatchObject({fieldRef:{entityType:'custom_field_def',revision:1},value:'12.5'});
 expect(h.requests.filter(r=>r.body?.name==='package.submit')).toHaveLength(0);
});
function Target(){const {context}=useGlobalContext();return <p>Карточка в области {context?.scopePath.clusterId??'ДИТ'}</p>;}
it('search_opens_archived_card_in_context',async()=>{
 const h=await createWorkbenchUiHarness({role:'viewer',scenario:'scope-split'},{views:{overview:()=> <p>Обзор</p>,search:GlobalSearch,goalDetail:Target}});closes.push(h.close);
 const goal=h.repository.readPublishedHead<CoreGoalDefinition>({entityType:h.refs.goal.entityType,id:h.refs.goal.id})!;h.repository.append('core_goal_definition',{...goal,revision:2,title:'Архивная цель',lifecycle:'archived',archiveReason:'Завершена'},1);
 await h.open('/overview');await screen.findByLabelText('Поиск по рабочему месту');fireEvent.change(screen.getByLabelText('Поиск по рабочему месту'),{target:{value:'Архивная'}});fireEvent.submit(screen.getByRole('search'));
 const link=await screen.findByRole('link',{name:/Архивная цель/});expect(link.getAttribute('href')).toContain('/goals/'+goal.id);fireEvent.click(link);
 await screen.findByText('Карточка в области ДИТ');expect(new URL(window.location.href).searchParams.get('goal')).toBe(goal.id);
 expect(h.requests.filter(r=>r.body?.name==='draft.open')).toHaveLength(0);
});
it('viewer_saves_personal_preferences_and_http_blocks_shared_draft',async()=>{
 const h=await open(()=> <DashboardView />, 'viewer');await screen.findByLabelText('Плотность представления');fireEvent.change(screen.getByLabelText('Плотность представления'),{target:{value:'compact'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить личный вид'}));await screen.findByText('Личный вид сохранён');
 const preferences=await h.client.query<any>('preferences.get',{context:null,filter:{},sort:[],page:{limit:50,cursor:null}});expect(preferences.data.values.visual.density).toBe('compact');
 for(const [name,definition] of [['dashboard.draft.save',{title:'Общий'}],['customField.draft.save',{name:'Поле',entityTypes:['core_goal_definition'],valueType:'text',enumValues:null}],['customFieldValue.draft.save',{objectRef:{entityType:'core_goal_definition',id:fixtureId(11)},fieldRef:{entityType:'custom_field_def',id:fixtureId(900),revision:1},value:'Значение'}]] as const) await expect(h.client.command({commandId:crypto.randomUUID(),name,baseRevision:null,payload:{draftId:fixtureId(900),definition}})).rejects.toMatchObject({status:403});
 expect(screen.queryByRole('button',{name:'Создать общий дашборд'})).toBeNull();
});



import { seedDashboardScenario } from '../../../server/workbench/testing/dashboard-scenarios';
it('renders_five_actual_blocks_and_stored_field_in_table_filter_without_formula_change',async()=>{
 const h=await createWorkbenchUiHarness({role:'curator',scenario:'scope-split'},{views:{overview:DashboardView,search:GlobalSearch}});closes.push(h.close);const before=h.repository.readVersion<any>(h.refs.result);const seed=seedDashboardScenario(h.repository,h.refs);
 await h.open('/overview?goal='+h.refs.goal.id);await screen.findByRole('option',{name:'Обзор исполнения'});fireEvent.change(screen.getByLabelText('Дашборд'),{target:{value:seed.dashboard.id}});
 await screen.findByRole('article',{name:'Карточка показателя'});expect(screen.getAllByRole('article')).toHaveLength(5);
 const table=await screen.findByRole('table',{name:'Сохранённые общие значения'});expect(table.textContent).toContain('Число (Decimal) · 1');expect(table.textContent).toContain('12.5');
 fireEvent.change(screen.getByLabelText('Фильтр по значению поля'),{target:{value:'999'}});await screen.findByText('Сохранённых значений по фильтру нет.');
 fireEvent.change(screen.getByLabelText('Фильтр по значению поля'),{target:{value:'12.5'}});await waitFor(()=>expect(screen.getByRole('table',{name:'Сохранённые общие значения'}).textContent).toContain('12.5'));
 expect(h.repository.readVersion<any>(h.refs.result)).toEqual(before);expect(h.requests.filter(r=>['calculation.prepare','package.submit'].includes(String(r.body?.name)))).toHaveLength(0);
});

it('previews_saved_dashboard_package_via_actual_async_job_without_submitting',async()=>{
 const h=await open(()=> <DashboardBuilder/>);await screen.findByLabelText('Название дашборда');await waitFor(()=>expect((screen.getByRole('button',{name:'Добавить блок'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.change(screen.getByLabelText('Название дашборда'),{target:{value:'Проверяемый обзор'}});fireEvent.click(screen.getByRole('button',{name:'Добавить блок'}));fireEvent.click(screen.getByRole('button',{name:'Сохранить дашборд'}));await screen.findByText('Черновик сохранён');fireEvent.click(screen.getByRole('button',{name:'Проверить пакет дашборда'}));await screen.findByText('Пакет дашборда проверен');expect(h.requests.filter(r=>r.body?.name==='package.preview')).toHaveLength(1);expect(h.requests.filter(r=>r.body?.name==='package.submit')).toHaveLength(0);
});

it('injects_optional_maintenance_without_context_or_sixth_navigation_and_restores_focus',async()=>{
 const Maintenance=({onClose}:{onClose():void})=><section role="dialog" aria-label="Обслуживание"><button onClick={onClose}>Закрыть обслуживание</button></section>;
 const h=await createWorkbenchUiHarness({role:'viewer',scenario:'empty'},{views:{search:GlobalSearch,maintenance:Maintenance}});closes.push(h.close);await h.open('/overview');const opener=await screen.findByRole('button',{name:'Обслуживание рабочего места'});opener.focus();fireEvent.click(opener);await screen.findByRole('dialog',{name:'Обслуживание'});expect(screen.getByRole('navigation').querySelectorAll('button')).toHaveLength(5);fireEvent.click(screen.getByRole('button',{name:'Закрыть обслуживание'}));expect(document.activeElement).toBe(opener);
});


it('repeating_same_search_reads_changed_published_heads_again',async()=>{
 const h=await open(()=> <p>Обзор</p>,'viewer');fireEvent.change(await screen.findByLabelText('Поиск по рабочему месту'),{target:{value:'Тестовая'}});fireEvent.submit(screen.getByRole('search'));await screen.findByRole('link',{name:'Тестовая цель · Цель'});const goal=h.repository.readPublishedHead<CoreGoalDefinition>({entityType:h.refs.goal.entityType,id:h.refs.goal.id})!;h.repository.append('core_goal_definition',{...goal,revision:2,title:'Переименована'},1);fireEvent.submit(screen.getByRole('search'));await screen.findByText('Совпадений нет');expect(h.requests.filter(r=>r.url==='/api/v1/queries/search')).toHaveLength(2);
});

import { CustomFieldsPanel } from './CustomFieldEditor';
it('uses_a_published_field_definition_without_forking_or_retyping_it',async()=>{
 const h=await createWorkbenchUiHarness({role:'curator',scenario:'scope-split'},{views:{overview:()=> <CustomFieldsPanel objectRef={{entityType:'core_goal_definition',id:fixtureId(930)}}/>}});closes.push(h.close);seedDashboardScenario(h.repository,h.refs);await h.open('/overview');await screen.findByRole('option',{name:'План затрат · Дата · 2'});fireEvent.change(screen.getByLabelText('Опубликованное поле'),{target:{value:fixtureId(920)}});fireEvent.click(screen.getByRole('button',{name:'Задать значение выбранного поля'}));await screen.findByLabelText('Значение поля');fireEvent.change(screen.getByLabelText('Значение поля'),{target:{value:'2026-02-30'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить значение'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('существующую дату'));fireEvent.change(screen.getByLabelText('Значение поля'),{target:{value:'2026-11-01'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить значение'}));await screen.findByText('Черновик сохранён');const save=h.requests.find(r=>r.body?.name==='customFieldValue.draft.save');expect((save?.body?.payload as any).definition.fieldRef).toMatchObject({id:fixtureId(920),revision:2});expect(h.requests.filter(r=>r.body?.name==='customField.draft.save')).toHaveLength(0);
});

it('resumes_saved_private_dashboard_by_canonical_draft_reference_after_close',async()=>{
 const h=await open(()=> <DashboardView/>);fireEvent.click(await screen.findByRole('button',{name:'Создать общий дашборд'}));await screen.findByLabelText('Название дашборда');await waitFor(()=>expect((screen.getByRole('button',{name:'Добавить блок'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.change(screen.getByLabelText('Название дашборда'),{target:{value:'Продолжаемый обзор'}});fireEvent.click(screen.getByRole('button',{name:'Добавить блок'}));fireEvent.click(screen.getByRole('button',{name:'Сохранить дашборд'}));await screen.findByText('Черновик сохранён');fireEvent.click(screen.getByRole('button',{name:'Закрыть конструктор'}));fireEvent.click(await screen.findByRole('button',{name:'Продолжить дашборд: Продолжаемый обзор'}));await waitFor(()=>expect((screen.getByLabelText('Название дашборда') as HTMLInputElement).value).toBe('Продолжаемый обзор'));expect(h.requests.filter(r=>r.body?.name==='draft.open'&&(r.body.payload as any).ref===null)).toHaveLength(1);
});

it.each([
 ['text','Текст описания'],['long_text','Большое описание'],['boolean',true],['enum','A'],['multi_enum',['A','B']],
] as const)('saves_registered_%s_with_its_native_value_type',async(type,expected)=>{
 const h=await open(()=> <CustomFieldEditor objectRef={{entityType:'core_goal_definition',id:fixtureId(11)}}/>);await screen.findByLabelText('Имя поля');fireEvent.change(screen.getByLabelText('Имя поля'),{target:{value:'Поле '+type}});fireEvent.change(screen.getByLabelText('Тип поля'),{target:{value:type}});if(type==='enum'||type==='multi_enum')fireEvent.change(screen.getByLabelText('Допустимые варианты'),{target:{value:'A\nB'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить описание поля'}));if(type==='multi_enum'){await screen.findByRole('group',{name:'Значение поля'});fireEvent.click(screen.getByLabelText('A'));fireEvent.click(screen.getByLabelText('B'));}else{const control=await screen.findByLabelText('Значение поля');fireEvent.change(control,{target:{value:expected===true?'true':expected}});}fireEvent.click(screen.getByRole('button',{name:'Сохранить значение'}));await screen.findByText('Значение сохранено в черновике');const save=h.requests.find(r=>r.body?.name==='customFieldValue.draft.save');expect((save?.body?.payload as any).definition.value).toEqual(expected);
});

it('opens_published_field_description_for_explicit_draft_edit',async()=>{
 const h=await createWorkbenchUiHarness({role:'curator',scenario:'scope-split'},{views:{overview:()=> <CustomFieldsPanel objectRef={{entityType:'core_goal_definition',id:fixtureId(11)}}/>}});closes.push(h.close);seedDashboardScenario(h.repository,h.refs);await h.open('/overview');await screen.findByRole('option',{name:'План затрат · Дата · 2'});fireEvent.change(screen.getByLabelText('Опубликованное поле'),{target:{value:fixtureId(920)}});fireEvent.click(screen.getByRole('button',{name:'Изменить описание выбранного поля'}));await waitFor(()=>expect((screen.getByLabelText('Имя поля') as HTMLInputElement).value).toBe('План затрат'));expect((screen.getByLabelText('Тип поля') as HTMLSelectElement).value).toBe('date');expect(h.requests.find(r=>r.body?.name==='draft.open')?.body?.payload).toMatchObject({entityType:'custom_field_def',ref:{id:fixtureId(920)}});
});
