import { useGlobalContext, useWorkbench } from './context';

export const workbenchDestinations = [
  { path: '/overview', label: 'Обзор' }, { path: '/goals', label: 'Цели' },
  { path: '/execution', label: 'Работы и решения' }, { path: '/data', label: 'Данные' }, { path: '/uor', label: 'Панель УОР' },
] as const;
// These commands belong to the server's preparation capability. A role label alone
// is never a grant (for example, a revoked curator may retain a stale label).
export function hasWorkbenchPreparation(commands: readonly string[]): boolean {
  return commands.some(name => ['draft.open', 'goal.draft.save', 'method.draft.save', 'dashboard.draft.save', 'customField.draft.save', 'package.preview', 'package.submit'].includes(name));
}
export function WorkbenchNavigation() {
  const { session } = useWorkbench(); const { pathname, navigate } = useGlobalContext();
  const allowed = hasWorkbenchPreparation(session?.allowedCommands ?? []);
  return <nav className="wb-navigation" aria-label="Основная навигация">
    {workbenchDestinations.map(({ path, label }) => <button key={path} type="button" aria-current={pathname === path || path === '/goals' && pathname.startsWith('/goals/') ? 'page' : undefined} disabled={path === '/uor' && !allowed} aria-describedby={path === '/uor' && !allowed ? 'wb-uor-access' : undefined} onClick={() => navigate(path)}>{label}</button>)}
    {!allowed && <p id="wb-uor-access">Панель УОР доступна куратору с действующим допуском. Общие экраны доступны для просмотра.</p>}
  </nav>;
}
