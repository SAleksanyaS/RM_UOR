import { useGlobalContext } from './context';
import { WorkbenchReportsPage } from '../../features/reporting/workbench/WorkbenchReportsPage';
import { WorkbenchWeeklyPage } from '../../features/weekly-report/workbench/WorkbenchWeeklyPage';

export function ReportsWorkspace() {
  const { navigate } = useGlobalContext();
  const weekly = window.location.hash === '#weekly';
  return <section aria-label="Отчёты и недельная сводка">
    <nav className="wb-data-subnav" aria-label="Разделы отчётности">
      <button type="button" aria-current={!weekly ? 'page' : undefined} onClick={() => navigate('/reports')}>Отчёты</button>
      <button type="button" aria-current={weekly ? 'page' : undefined} onClick={() => navigate('/reports#weekly')}>Недельная сводка</button>
    </nav>
    {weekly ? <WorkbenchWeeklyPage/> : <WorkbenchReportsPage/>}
  </section>;
}
