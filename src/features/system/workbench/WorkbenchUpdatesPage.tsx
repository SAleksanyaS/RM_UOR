import { useEffect, useState } from 'react';
import { useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import { SetupPackagePanel } from '../../workspace-maintenance/workbench/SetupPackagePanel';
import { MaintenancePanel } from '../../workspace-maintenance/workbench/MaintenancePanel';
import { useSetupOperation, SetupOperationStatus, operationOwnerKey } from '../../workspace-maintenance/workbench/setup-package-operation';
import type { UpdateNotice } from './update-channel';
const request = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } };
export function WorkbenchUpdatesPage() { const { client, session } = useWorkbench(); return <UpdatesOwned key={operationOwnerKey(client, session?.personId)}/>; }
function UpdatesOwned() {
    const { client, session, refreshSession } = useWorkbench();
    const [revision, setRevision] = useState(0), [maintenance, setMaintenance] = useState(false);
    const query = useWorkbenchQuery<{
        notices: UpdateNotice[];
        status: {
            checkedAt: string | null;
            nextCheckAt: string | null;
            error: string | null;
        };
    }>('updates.list', request, revision);
    const operation = useSetupOperation('updates', async () => { await client.query('updates.list', request); if (operation.active()) {
        setRevision(v => v + 1);
        await refreshSession();
    } });
    const check = (reason = 'manual') => operation.run('updates.check', { reason });
    useEffect(() => { const online = () => { if (!operation.blocked)
        void check('online'); }, resume = () => { if (document.visibilityState === 'visible' && !operation.blocked)
        void check('resume'); }; window.addEventListener('online', online); document.addEventListener('visibilitychange', resume); return () => { window.removeEventListener('online', online); document.removeEventListener('visibilitychange', resume); }; }, [client, operation.blocked]);
    const action = (n: UpdateNotice, action: 'read' | 'snooze' | 'unsnooze') => operation.run('updates.action', { release: n.release, revision: n.revision, action });
    return <div><section className="wb-surface" aria-label="Канал обновлений"><header className="wb-section-header"><div><span className="wb-eyebrow">Принятая версия</span><h2>Обновления программы</h2></div><button type="button" disabled={operation.blocked} onClick={() => void check()}>Проверить сейчас</button></header><div className="wb-object-content"><p>Проверка работает при запуске и во время работы. Перед применением завершите запись браузера и отправку в GigaChat. Подготовка, защитная копия и проверка запуска выполняются штатным launcher.</p>
 {session?.policyState === 'local_preview' && <p>В локальном режиме можно проверить канал и подготовить пакет. Применение main требует проверенного допуска.</p>}{!!query.error && <p role="alert">Не удалось прочитать канал обновлений</p>}<SetupOperationStatus value={operation}/>{query.data?.status.error && <p role="status">Последняя проверка не завершена: {query.data.status.error}. Ранее найденные версии сохранены.</p>}
 {query.data?.status.checkedAt && <p>Проверено: {new Date(query.data.status.checkedAt).toLocaleString('ru-RU')}</p>}{query.data?.notices.length === 0 && <p>Новые версии пока не обнаружены.</p>}
 {query.data?.notices.map(n => <article key={n.release} className="wb-maintenance-card"><h3>{{ available: 'Доступна новая версия', applying: 'Обновление выполняется', applied: 'Версия применена', error: 'Нужна проверка обновления' }[n.state]}</h3><p><code>{n.release.slice(0, 12)}</code>{n.readAt ? ' · прочитано' : ''}{n.snoozedUntil ? ' · отложено до ' + new Date(n.snoozedUntil).toLocaleString('ru-RU') : ''}</p>{n.error && <p role="alert">{n.error}</p>}{n.state === 'available' && <><button type="button" disabled={operation.blocked || session?.policyState === 'local_preview' || !n.candidate.launcherAvailable || !session?.allowedCommands.includes('code.update.apply')} onClick={() => void operation.run('code.update.apply', { expectedCommit: n.candidate.expectedCommit, targetCommit: n.release })}>Применить проверенную версию</button>{!n.candidate.launcherAvailable && <p>Запустите приложение штатным launcher для безопасного обновления.</p>}</>}{n.state === 'error' && <button type="button" disabled={operation.blocked} onClick={() => void check()}>Проверить возможность повторного обновления</button>}<button type="button" disabled={operation.blocked} onClick={() => void action(n, 'read')}>Прочитано</button><button type="button" disabled={operation.blocked} onClick={() => void action(n, n.snoozedUntil ? 'unsnooze' : 'snooze')}>{n.snoozedUntil ? 'Снять отсрочку' : 'Отложить на сутки'}</button></article>)}
 </div></section><section className="wb-surface wb-object-content"><h2>Общие данные из main</h2><p>Проверьте и примените опубликованные справочники, цели, методики и данные через проверенный канал общих данных. Личные черновики и настройки сохраняются.</p><button type="button" onClick={() => setMaintenance(true)}>Проверить общие данные</button></section><SetupPackagePanel />{maintenance && <MaintenancePanel onClose={() => setMaintenance(false)}/>}</div>;
}
