import { AppearancePanel } from '../../../app/workbench/AppearancePanel';
import { useGlobalContext } from '../../../app/workbench/context';
import { EnvironmentPanel } from './EnvironmentPanel';
import './environment.css';

const destinations = [
  { title: 'Источники и получение', text: 'Личные сценарии ОКО и Confluence, профиль браузера и ручной вход.', path: '/data#personal-oko' },
  { title: 'Обработка данных', text: 'Разбор исходников, сопоставление столбцов и подготовка фактов.', path: '/data#goal-data' },
  { title: 'Общие справочники и методики', text: 'Команды, связи, правила и реальные материалы модели зрелости.', path: '/knowledge' },
  { title: 'Отчёты и сводка', text: 'Шаблоны, сохранённые отчёты, недельная сводка и анализ.', path: '/reports' },
  { title: 'Обновления', text: 'Общий канал Git и состояние обновления рабочего места.', path: '/updates' },
  { title: 'Копии и восстановление', text: 'Проверенная личная копия и перенос своего рабочего состояния.', path: '/maintenance' },
];

export function SettingsWorkspace() {
  const { navigate } = useGlobalContext();
  const appearance = window.location.hash === '#appearance';
  return <div>
    <nav className="wb-settings-tabs" aria-label="Разделы настроек">
      <button type="button" aria-current={!appearance ? 'page' : undefined} onClick={() => navigate('/settings')}>Рабочее место</button>
      <button type="button" aria-current={appearance ? 'page' : undefined} onClick={() => navigate('/settings#appearance')}>Внешний вид</button>
    </nav>
    {appearance ? <AppearancePanel/> : <>
      <EnvironmentPanel/>
      <section className="wb-settings-destinations" aria-label="Настройки по задачам">
        {destinations.map(item => <article className="wb-surface wb-object-content" key={item.path}><h3>{item.title}</h3><p>{item.text}</p><button type="button" onClick={() => navigate(item.path)}>Открыть настройки</button></article>)}
      </section>
    </>}
  </div>;
}
