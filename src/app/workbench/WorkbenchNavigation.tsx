import { useGlobalContext, useWorkbench } from './context';
import { LayoutDashboard, Flag, ListChecks, Database, Layers, LockKeyhole } from 'lucide-react';

export const workbenchDestinations = [
  { path: '/overview', label: 'Обзор' }, { path: '/goals', label: 'Цели' },
  { path: '/execution', label: 'Работы и решения' }, { path: '/data', label: 'Данные' }, { path: '/uor', label: 'Панель УОР' },
] as const;
// These commands belong to the server's preparation capability. A role label alone
// is never a grant (for example, a revoked curator may retain a stale label).
export function hasWorkbenchPreparation(commands: readonly string[]): boolean {
  return commands.some(name => ['draft.open', 'goal.draft.save', 'method.draft.save', 'dashboard.draft.save', 'customField.draft.save', 'package.preview', 'package.submit'].includes(name));
}
const icons = [LayoutDashboard, Flag, ListChecks, Database, Layers];
export function WorkbenchNavigation({ onNavigate }: { onNavigate?(): void } = {}) {
  const { session } = useWorkbench(); const { pathname, navigate } = useGlobalContext();
  const allowed = hasWorkbenchPreparation(session?.allowedCommands ?? []);
  return <nav id="wb-navigation-items" className="wb-navigation" aria-label="Основная навигация">
    <span className="wb-navigation-caption">Рабочее пространство</span>
    {workbenchDestinations.map(({ path, label }, index) => {
      const Icon = icons[index], disabled = path === '/uor' && !allowed;
      return <button key={path} type="button" aria-label={label} title={label} aria-current={pathname === path || path === '/goals' && pathname.startsWith('/goals/') ? 'page' : undefined} disabled={disabled} aria-describedby={disabled ? 'wb-uor-access' : undefined} onClick={() => { navigate(path); onNavigate?.(); }}><Icon size={19} aria-hidden="true" /><span className="wb-navigation-label">{label}</span>{disabled && <LockKeyhole size={13} className="wb-navigation-lock" aria-hidden="true" />}</button>;
    })}
    {!allowed && <p className="wb-visually-hidden" id="wb-uor-access">Панель УОР доступна куратору с действующим допуском. Общие экраны доступны для просмотра.</p>}
  </nav>;
}
