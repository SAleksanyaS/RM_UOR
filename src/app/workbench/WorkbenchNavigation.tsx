import { useGlobalContext, useWorkbench } from './context';
import { LayoutDashboard, Flag, ListChecks, Database, Layers, LockKeyhole, BookOpen, FileText, Settings2, DownloadCloud } from 'lucide-react';

export const workbenchDestinations = [
  { path: '/overview', label: 'Обзор', icon: LayoutDashboard },
  { path: '/data', label: 'Данные', icon: Database },
  { path: '/knowledge', label: 'База знаний', icon: BookOpen },
  { path: '/goals', label: 'Цели', icon: Flag },
  { path: '/execution', label: 'Работы и решения', icon: ListChecks },
  { path: '/reports', label: 'Отчёты', icon: FileText },
  { path: '/uor', label: 'Панель УОР', icon: Layers },
  { path: '/settings', label: 'Настройки', icon: Settings2 },
  { path: '/updates', label: 'Обновления и копии', icon: DownloadCloud },
] as const;
// These commands belong to the server's preparation capability. A role label alone
// is never a grant (for example, a revoked curator may retain a stale label).
export function hasWorkbenchPreparation(commands: readonly string[]): boolean {
  return commands.some(name => ['draft.open', 'goal.draft.save', 'method.draft.save', 'dashboard.draft.save', 'customField.draft.save', 'package.preview', 'package.submit'].includes(name));
}

export function WorkbenchNavigation({ onNavigate }: { onNavigate?(): void } = {}) {
  const { session } = useWorkbench(); const { pathname, navigate } = useGlobalContext();
  const allowed = hasWorkbenchPreparation(session?.allowedCommands ?? []);
  const items=(entries:readonly (typeof workbenchDestinations)[number][])=>entries.map(({ path, label, icon: Icon }) => {
    const disabled = path === '/uor' && !allowed;
    return <button key={path} type="button" aria-label={label} title={label} aria-current={pathname === path || path==='/knowledge'&&pathname==='/maturity' || path === '/goals' && pathname.startsWith('/goals/') ? 'page' : undefined} disabled={disabled} aria-describedby={disabled ? 'wb-uor-access' : undefined} onClick={() => { navigate(path); onNavigate?.(); }}><Icon size={19} aria-hidden="true" /><span className="wb-navigation-label">{label}</span>{disabled && <LockKeyhole size={13} className="wb-navigation-lock" aria-hidden="true" />}</button>;
  });
  return <><nav id="wb-navigation-items" className="wb-navigation" aria-label="Основная навигация"><span className="wb-navigation-caption">Рабочее пространство</span>{items(workbenchDestinations.slice(0,6))}</nav>
  <nav className="wb-navigation wb-service-navigation" aria-label="Рабочее место"><span className="wb-navigation-caption">Управление</span>{items(workbenchDestinations.slice(6))}{!allowed && <p className="wb-visually-hidden" id="wb-uor-access">Панель УОР доступна куратору с действующим допуском. Общие экраны доступны для просмотра.</p>}</nav></>;
}
