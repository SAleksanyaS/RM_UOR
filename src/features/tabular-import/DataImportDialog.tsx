import { useState } from 'react';
import { Database, FileSpreadsheet, X } from 'lucide-react';
import { useDialog, useWorkspace } from '../../app/AppContext';
import { canImportMaturityGoal } from '../importing/import-ui-model';
import { MaturityImportWizard } from '../importing/MaturityImportWizard';
import { TabularImportWizard } from './TabularImportWizard';

/** Goal choice is explicit: a file never silently changes another goal's facts. */
export function DataImportDialog({ initialGoalId, onClose }: { initialGoalId?: string; onClose: () => void }) {
  useDialog(onClose);
  const { state } = useWorkspace();
  const [goalId, setGoalId] = useState(initialGoalId || ''), [started, setStarted] = useState(!!initialGoalId);
  const goal = state.catalog.goals.find(item => item.id === goalId);
  if (started && goal) return canImportMaturityGoal(goal, state.catalog.sources, state.snapshots) && !goal.measurement
    ? <MaturityImportWizard goalId={goal.id} onClose={onClose}/>
    : <TabularImportWizard goalId={goal.id} onClose={onClose}/>;
  return <div className="modal-overlay"><section className="modal" role="dialog" aria-modal="true" aria-label="Выбор цели для загрузки"><div className="modal-heading"><h2><FileSpreadsheet size={22}/>Загрузить данные</h2><button className="icon-button" aria-label="Закрыть загрузку" onClick={onClose}><X size={20}/></button></div><p className="form-note">Выберите цель. Затем сопоставьте столбцы Excel / CSV, проверьте расчёт и примите факты.</p><label className="field">Цель для загрузки<select value={goalId} onChange={event => setGoalId(event.target.value)}><option value="">Выберите цель</option>{state.catalog.goals.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><p className="form-note"><Database size={15}/> Исходный файл остаётся на этом компьютере. Публикуются только отдельно проверенные данные.</p><div className="modal-footer"><button className="button secondary" onClick={onClose}>Отмена</button><button className="button primary" disabled={!goal} onClick={() => setStarted(true)}>Выбрать файл</button></div></section></div>;
}
