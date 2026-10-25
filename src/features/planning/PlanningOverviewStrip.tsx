import { ArrowRight, CalendarDays } from 'lucide-react';
import { useWorkspace } from '../../app/AppContext';
import { buildPlanningModel } from './planning-model';
import './director-navigation.css';

export function PlanningOverviewStrip({ goalId, onOpen }: { goalId?: string; onOpen: () => void }) {
  const { state } = useWorkspace();
  const { counts } = buildPlanningModel({ catalog: state.catalog, evaluations: state.evaluations || [], snapshots: state.snapshots }, { goalId });
  return <button className="director-plan-strip" onClick={onOpen}>
    <CalendarDays size={18}/><span><strong>Что делаем и к какому сроку</strong><small>Общие планы целей · прогнозы и следующие шаги</small></span>
    <span className="director-plan-counts"><b>{counts.byStage.in_progress} в работе</b><b>{counts.needsDecision} решений</b><b>{counts.unplanned} без плана</b></span><ArrowRight size={16}/>
  </button>;
}
