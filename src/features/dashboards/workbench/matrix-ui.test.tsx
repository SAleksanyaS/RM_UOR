// @vitest-environment jsdom
import {it,expect,afterEach} from 'vitest';
import {screen,fireEvent,cleanup} from '@testing-library/react';
import {GoalMetricMatrix} from './DashboardView';
import {effectiveCells} from '../../evaluation/workbench/effective-matrix';
import {makeNumericFixture,fixtureId} from '../../../../tests/fixtures/workbench/factories';
import {createWorkbenchUiHarness} from '../../../app/workbench/testing/ui-harness';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{cleanup();for(const c of closes.splice(0))await c();});
it('renders four expected cells and provides focusable exact-revision evidence links',async()=>{
 const input=makeNumericFixture({values:['92','7'],targets:['90','8'],expectedPopulation:[{kind:'team',id:fixtureId(901)},{kind:'team',id:fixtureId(902)}]});input.facts.pop();
 const block={id:fixtureId(990),type:'goal-matrix',layout:{w:12,h:2},groups:[{row:{ref:{entityType:'goal_assignment',id:input.assignment.id,revision:1},assignment:input.assignment,goal:input.goal,scopeName:'Expected teams'},methodRef:{entityType:'method_version',id:input.method.id,revision:1},cells:effectiveCells(input),unavailableReason:null}]} as any;
 const h=await createWorkbenchUiHarness({role:'curator',scenario:'scope-split'},{views:{overview:()=> <GoalMetricMatrix block={block}/>,data:()=> <p>Evidence route</p>}});closes.push(h.close);await h.open('/overview');await screen.findByText('Expected teams');expect(screen.getAllByRole('cell')).toHaveLength(4);expect(screen.getByText('Нет данных')).toBeTruthy();
 const fact=input.facts[0];const summary=screen.getByText('Основание: demo_metric_0 / '+fixtureId(901));fireEvent.click(summary);const link=screen.getByRole('link',{name:'Исходный факт '+fact.id+' / 1'});link.focus();expect(document.activeElement).toBe(link);expect(link.getAttribute('href')).toContain('factRevision=1');fireEvent.keyDown(link,{key:'Enter'});fireEvent.click(link);await screen.findByText('Evidence route');expect(window.location.search).toContain('fact='+fact.id);expect(window.location.search).toContain('factRevision=1');
});
