import {it,expect} from 'vitest';
import {makeNumericFixture,fixtureId} from '../../../tests/fixtures/workbench/factories';
import {buildDashboardBlocks} from './workbench-dashboard-read';
import {effectiveCells} from '../evaluation/workbench/effective-matrix';
import {newBlock} from '../dashboards/workbench/dashboard-ui';
it('materializes two teams × two exact metrics including an absent slot and keeps assignment revisions separate',()=>{
 const teams=[{kind:'team' as const,id:fixtureId(901)},{kind:'team' as const,id:fixtureId(902)}];
 const input=makeNumericFixture({values:['92','7'],targets:['90','8'],expectedPopulation:teams});input.facts.pop();
 const row={ref:{entityType:'goal_assignment',id:input.assignment.id,revision:1},assignment:input.assignment,goal:input.goal,scopeName:'Group',basisRef:input.resolution.basisRef,resultRef:null} as any;
 const other=structuredClone(input);other.assignment.id=fixtureId(903);other.assignment.revision=2;other.method.revision=2;other.metrics[0].revision=2;other.metrics[0].unit.label='Other unit';if(other.method.mode==='numeric'){other.method.rules[0].metricRef.revision=2;other.method.rules[0].condition={op:'gte',target:'50'};}
 const blocks=buildDashboardBlocks({definition:{blocks:[newBlock('goal-matrix')]} as any,goals:[row,{...row,ref:{...row.ref,id:other.assignment.id,revision:2},assignment:other.assignment}],execution:[],issues:[],resolver:{} as any,unavailableReason:null,today:'2026-10-23',inputFor:r=>r.assignment.id===input.assignment.id?input:other,trendFor:()=>null!});
 const matrix=blocks[0] as any;expect(matrix.groups).toHaveLength(2);expect(matrix.groups[0].cells).toHaveLength(4);expect(matrix.groups[0].cells.filter((c:any)=>c.state==='missing')).toHaveLength(1);expect(matrix.groups[0].cells[0]).toMatchObject({metric:{revision:1,unit:{label:'Demo unit'}},rule:{condition:{target:'90'}},selection:{value:'92'}});expect(matrix.groups[1].cells[0]).toMatchObject({metric:{revision:2,unit:{label:'Other unit'}},rule:{condition:{target:'50'}}});expect(matrix.groups[0].cells[0].facts[0].lineage.sourceRowKeys).toEqual(['demo_0_0']);
});
it('shows not applicable cells from the same canonical applicability decision',()=>{
 const input=makeNumericFixture();input.applicability=[{...input.assignment,id:fixtureId(950),assignmentId:input.assignment.id,metricId:input.metrics[0].id,period:{startInclusive:'2026-10-01',endExclusive:null},reason:'Synthetic exception'} as any];
 const cells=effectiveCells(input);expect(cells[0].state).toBe('not_applicable');expect(cells[0].applicability[0].reason).toBe('Synthetic exception');
});
