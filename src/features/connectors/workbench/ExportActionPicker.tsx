import type { OkoWorkflowView } from '../workbench-workflow-contracts';

export function ExportActionPicker({ workflow, disabled, select }: {
  workflow: OkoWorkflowView;
  disabled: boolean;
  select(stepIndex: number): Promise<unknown>;
}) {
  const recording = workflow.recording;
  if (recording.state !== 'completed' || recording.replayable !== false) return null;
  if (recording.replayabilityProblem === 'EXPORT_ACTION_NEEDS_TEST') {
    return <div className="oko-note" role="status"><strong>Кнопка выгрузки выбрана.</strong><p>Нажмите «Получить файл ещё раз», чтобы проверить её. До успешного получения файла сценарий остаётся непроверенным.</p></div>;
  }
  const clicks = recording.steps.flatMap((step, index) => step.action === 'click' ? [{ step, index }] : []);
  return <section className="oko-note" aria-label="Выбор действия выгрузки">
    <h3>Какое действие скачивает файл?</h3>
    <p>Исходный файл сохранён, но связь скачивания с кнопкой не подтверждена. Выберите нужное нажатие. Повтор будет заканчиваться этим шагом; следующие записанные действия в него не войдут.</p>
    {clicks.length ? <ol>{clicks.map(({ step, index }) => <li key={index}>
      <span>Шаг {index + 1}: {step.locator.kind === 'role' ? step.locator.name : step.locator.kind === 'label' ? step.locator.text : step.locator.selector}</span>{' '}
      <button type="button" disabled={disabled} onClick={() => void select(index)}>Выбрать шаг {index + 1} для выгрузки</button>
    </li>)}</ol> : <p>В записи нет доступного нажатия. Запишите сценарий заново и нажмите кнопку выгрузки в открытом браузере.</p>}
  </section>;
}
