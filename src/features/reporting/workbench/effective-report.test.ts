import {afterEach,it,expect} from 'vitest';
import {draftFixture,draftCleanups} from '../../../../tests/fixtures/workbench/drafts';
import {makeNumericFixture,makeHeader,fixtureId} from '../../../../tests/fixtures/workbench/factories';
import {loadMaturityMaterials} from '../../maturity/workbench-materials';
import {createReportService} from './service';
import {registerReportCommands} from './commands';
import {defaultReportDefinition} from './contracts';
import {reportRows,reportXlsx,reportPptx,reportHtml} from './exports';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
afterEach(async()=>{while(draftCleanups.length)await draftCleanups.pop()!();});
export async function correctedReportFixture(input=makeNumericFixture({values:['92'],targets:['90']})){
 const fact=input.facts[0];input.corrections=[{...makeHeader(930,{publicationAnchorId:input.goal.publicationAnchorId}),factKey:fact.factKey,originalFactRefs:[{entityType:'observed_fact',id:fact.id,revision:fact.revision}],replacement:'45',reason:'Verified correction for review'}];
 const f=draftFixture({input}),prepared=await f.prepare();const basis=f.repository.readVersion<any>(prepared.basisRef)!;const {schemaVersion,id,revision,recordedAt,actor,publicationAnchorId,...numericResult}=f.repository.readVersion<any>(prepared.resultRef!)!;
 const row={ref:{entityType:'goal_assignment',id:input.assignment.id,revision:1},goal:input.goal,assignment:input.assignment,scopeName:'Synthetic team',leader:null,basisRef:prepared.basisRef,resultRef:prepared.resultRef,numericResult,manualStatus:null,needs_calculation:false,unavailableReason:null,displayValue:'50',unit:'%',publication:null,warnings:[],attestation:null,snapshot:null,nextActions:[]};
 const detail={goal:input.goal,rows:[row],tabs:{state:[row],work:[],method:[input.method],calculation:[basis],enriched:[],raw:[],history:[]}};
 const service=createReportService({repository:f.repository,clock:f.clock,materials:loadMaturityMaterials(),readGoal:async()=>structuredClone(detail)});registerReportCommands(f.registry,service);
 const definition={...defaultReportDefinition('2026-10-23'),template:'goal-management-v1' as const,context:{scopePath:{ditId:input.assignment.scope.id,clusterId:null,productId:null,teamId:null},goalId:input.goal.id,time:{kind:'as_of' as const,date:'2026-10-23'},resultMode:'current' as const,snapshotId:null}};
 return {...f,service,definition,detail};
}
it('freezes effective correction and original evidence consistently in preview, XLSX, PPTX and PDF HTML',async()=>{
 const f=await correctedReportFixture();const saved=await f.execute('report.save',{id:null,definition:f.definition},{baseRevision:null});const s=f.service.detail(f.context,String(saved.result.id));
 expect(s.goalData!.rows[0].numericResult!.scorePercent).toEqual({numerator:'50',denominator:'1'});
 const text=reportRows(s).flat().join(' ');expect(text).toContain('45');expect(text).toContain('Исходное значение: 92');expect(text).toContain('Verified correction for review');
 expect(JSON.stringify(s)).toContain('Verified correction for review');
 const {createReportArchiveOwner}=await import('./archive');const archive=createReportArchiveOwner(),records=archive.exportRecords(f.repository);expect(()=>archive.validate(records[0])).not.toThrow();const altered=structuredClone(records[0]);(altered.value as any).effectiveBases[0].corrections[0].replacement='99';expect(()=>archive.validate(altered)).toThrow();
 const book=new ExcelJS.Workbook();await book.xlsx.load(await reportXlsx(s) as any);const cells:string[]=[];book.worksheets.forEach(w=>w.eachRow(r=>cells.push(JSON.stringify(r.values))));expect(cells.join(' ')).toContain('Исходное значение: 92');expect(cells.join(' ')).toContain('45');
 const zip=await JSZip.loadAsync(await reportPptx(s));const slides=(await Promise.all(Object.keys(zip.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).map(p=>zip.file(p)!.async('string')))).join('').replace(/<[^>]+>/g,'');expect(slides).toContain('45');expect(slides).toContain('Verified correction for review');expect(reportHtml(s)).toContain('45');expect(reportHtml(s)).toContain('Исходное значение: 92');
 f.repository.transaction(()=>{f.repository.append('manual_correction',{...f.input.corrections[0],revision:2,replacement:'99',reason:'Later revision'},1);f.repository.append('metric_definition',{...f.input.metrics[0],revision:2,name:'LATER'},1);});expect(f.service.detail(f.context,s.id)).toEqual(s);
});

it('freezes two exact assignment/method/metric revisions and all expected cells including missing values',async()=>{
 const input=makeNumericFixture({values:['92','7'],targets:['90','8'],expectedPopulation:[{kind:'team',id:fixtureId(901)},{kind:'team',id:fixtureId(902)}]});input.facts.pop();const f=await correctedReportFixture(input);
 const metric={...input.metrics[0],revision:2,name:'Revised metric',unit:{...input.metrics[0].unit,label:'Revised unit'}},method=structuredClone(input.method);method.revision=2;if(method.mode==='numeric'){method.rules[0].metricRef.revision=2;method.rules[0].condition={op:'gte',target:'50'};}
 const assignment={...input.assignment,id:fixtureId(990),methodBinding:{kind:'standalone' as const,methodRef:{entityType:'method_version' as const,id:method.id,revision:2}}};
 f.repository.transaction(()=>{f.repository.append('metric_definition',metric,1);f.repository.append('method_version',method,1);f.repository.append('goal_assignment',assignment,null);});
 const prepared=(await f.execute('calculation.prepare',{assignmentRef:{entityType:'goal_assignment',id:assignment.id,revision:1},businessTime:input.context.businessTime})).result as any;const basis=f.repository.readVersion<any>(prepared.basisRef)!;const {schemaVersion,id,revision,recordedAt,actor,publicationAnchorId,...numericResult}=f.repository.readVersion<any>(prepared.resultRef)!;
 const row={...f.detail.rows[0],ref:{entityType:'goal_assignment',id:assignment.id,revision:1},assignment,basisRef:prepared.basisRef,resultRef:prepared.resultRef,numericResult};f.detail.rows.push(row);f.detail.tabs.state.push(row);f.detail.tabs.method.push(method);f.detail.tabs.calculation.push(basis);
 const snapshot=await f.service.prepare(f.context,f.definition);expect(snapshot.effectiveBases).toHaveLength(2);const [first,second]=snapshot.effectiveBases!;expect(first.cells).toHaveLength(4);expect(second.cells).toHaveLength(4);expect(first.cells[0]).toMatchObject({metric:{revision:1,unit:{label:'Demo unit'}},rule:{condition:{target:'90'}}});expect(second.cells[0]).toMatchObject({metric:{revision:2,unit:{label:'Revised unit'}},rule:{condition:{target:'50'}}});expect(first.cells[3].state).toBe('missing');expect(second.cells[3].state).toBe('missing');expect(reportRows(snapshot).filter(r=>r.length===6&&r[2]==='Нет данных')).toHaveLength(2);
});
