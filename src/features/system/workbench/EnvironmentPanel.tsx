import { useState } from 'react';
import { ArrowRight, CheckCircle2, Circle, HardDrive, ShieldCheck } from 'lucide-react';
import { useGlobalContext, useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import { QueryState, StatusBadge } from '../../../app/workbench/ui';
import type { EnvironmentStatus, BrowserEnvironment } from './environment-query';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import { DiagnosticDownload } from './DiagnosticDownload';

const request = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } } as const;
export function EnvironmentPanel() {
  const { navigate } = useGlobalContext(), { session } = useWorkbench();
  const [browserCheck, setBrowserCheck] = useState(0);
  const query = useWorkbenchQuery<EnvironmentStatus>('environment.get', { ...request, sort: [] });
  const browser = useWorkbenchQuery<BrowserEnvironment>('environment.browser', browserCheck ? { ...request, sort: [] } : null, browserCheck);
  const data = query.data;
  const steps = [
    { done: (data?.rawFiles ?? 0) > 0, title: 'Получите первый исходник', text: 'ОКО, вложение Confluence, файл с компьютера или таблица вручную.', route: '/data' },
    { done: (data?.publishedDefinitions ?? 0) > 0, title: 'Настройте общую базу знаний', text: 'Проверьте команды, подразделения и методику. Реальные материалы зрелости уже доступны.', route: '/knowledge' },
    { done: null, title: 'Соберите свой рабочий экран', text: 'Создайте цель, выберите представление и сохраните отчёт с его основаниями.', route: '/goals' },
    { done: null, title: 'Закройте неделю', text: 'Соберите достижения, зоны внимания, решения и действия следующей недели.', route: '/reports#weekly' },
    { done: data?.repositoryConfigured ?? false, title: 'Подключите общие обновления', text: 'Подготовьте пакет для коллег и настройте принятый канал Git.', route: '/updates' },
  ];
  return <section className="wb-surface" aria-label="Настройка рабочего места">
    <header className="wb-section-header"><div><span className="wb-eyebrow"><HardDrive size={15} aria-hidden="true"/>Первый запуск и проверка</span><h2>Ваше рабочее место</h2></div>{session && <StatusBadge>{session.role === 'viewer' ? 'Читатель' : 'Редактор'}</StatusBadge>}</header>
    <div className="wb-object-content">
      <QueryState loading={query.loading} error={query.error ? workbenchErrorMessage(query.error, 'read') : null}/>
      <p className="wb-muted">Начните с файла. Общий каталог и методику можно подключить после получения исходников.</p>
      <ol className="wb-setup-checklist">{steps.map(step => <li key={step.title}>
        <span aria-label={step.done ? 'Настроено' : step.done === null ? 'Доступный раздел' : 'Можно настроить'}>{step.done ? <CheckCircle2 size={21}/> : <Circle size={21}/>}</span>
        <div><h3>{step.title}</h3><p>{step.text}</p><button type="button" onClick={() => navigate(step.route)}>Открыть<ArrowRight size={15} aria-hidden="true"/></button></div>
      </li>)}</ol>
      {data && <details className="wb-technical-details">
        <summary><ShieldCheck size={16} aria-hidden="true"/>Состояние среды</summary>
        <dl className="wb-definition-grid">
          <div><dt>Версия приложения</dt><dd>{data.applicationVersion}</dd></div>
          <div><dt>Node.js</dt><dd>{data.nodeVersion}{!data.nodeCompatible && ' · требуется 22.16.0'}</dd></div>
          <div><dt>npm</dt><dd>{data.npmVersion ?? 'Не определён при прямом запуске'}{data.npmCompatible === false && ' · требуется 10.9.2'}</dd></div>
          <div><dt>Система</dt><dd>{data.platform} · {data.architecture}</dd></div>
          <div><dt>Рабочая папка</dt><dd>{data.workspaceReadable && data.workspaceWritable ? 'Чтение и запись доступны' : 'Проверьте права на папку'}</dd></div>
          <div><dt>Свободное место</dt><dd>{data.freeBytes === null ? 'Не определено' : (data.freeBytes / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ГиБ'}</dd></div>
          <div><dt>Локальные порты</dt><dd>Интерфейс {data.ports.client} · служба {data.ports.api}</dd></div>
          <div><dt>Целевой браузер</dt><dd>{data.targetBrowser}</dd></div>
          <div><dt>Личный профиль браузера</dt><dd>{data.privateBrowserConfigured ? 'Настроен' : 'Настройте в сценарии получения'}</dd></div>
          <div><dt>Часовой пояс отчётов</dt><dd>Москва</dd></div>
          <div><dt>Канал Git</dt><dd>{data.repositoryConfigured ? 'Задан' : 'Ещё не подключён'}</dd></div>
          <div><dt>Реестр допуска</dt><dd>{data.registryConfigured ? 'Задан' : 'Локальная настройка'}</dd></div>
        </dl>
        <button type="button" disabled={browser.loading} onClick={() => setBrowserCheck(value => value + 1)}>Проверить установленный СберБраузер</button>
        <QueryState loading={browser.loading} error={browser.error ? workbenchErrorMessage(browser.error, 'read') : null}/>
        {browser.data && <div role="status"><p>{browser.data.message}</p>{browser.data.candidates.map(candidate => <p key={candidate.executablePath}><code>{candidate.executablePath}</code> · {candidate.version ?? 'версия не подтверждена'}</p>)}</div>}
        <p>Настроенный профиль ещё не подтверждает доступ к банковской системе. Проверка выполняется при входе и пробном получении в вашем СберБраузере.</p>
      </details>}
      <DiagnosticDownload/>
    </div>
  </section>;
}
