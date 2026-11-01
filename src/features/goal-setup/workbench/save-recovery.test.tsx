// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';
import { WorkbenchClient } from '../../../app/workbench/api-client';
import { WorkbenchProvider } from '../../../app/workbench/context';
import { WorkbenchShell } from '../../../app/workbench/WorkbenchShell';
import { WorkbenchGoalSetupWizard } from './GoalSetupWizard';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); vi.restoreAllMocks(); });
async function fixture(wrap: (fetcher: typeof fetch) => typeof fetch) {
  const h = await createWorkbenchApiHarness({ role: 'curator', scenario: 'population-gap' }); closes.push(h.close);
  const client = new WorkbenchClient({ fetch: wrap(h.fetch) });
  window.history.replaceState(null, '', '/goals/' + h.refs.goal.id);
  const view = () => <WorkbenchGoalSetupWizard goalRef={{entityType:h.refs.goal.entityType,id:h.refs.goal.id}} onClose={() => undefined} />;
  render(<WorkbenchProvider client={client}><WorkbenchShell views={{ goalDetail: view }} /></WorkbenchProvider>);
  await screen.findByLabelText('Название цели');
  return h;
}
it.each(['before', 'after'] as const)('resolves the same unknown middle command %s commit and continues confirmed progress without duplicate writes', async timing => {
  let armed = false, lost = false;
  const attempted: Array<{ name: string; commandId: string }> = [];
  const h = await fixture(fetcher => async (input, init) => {
    const body = String(input).endsWith('/commands') ? JSON.parse(String(init?.body)) : null;
    if (armed && body) attempted.push(body);
    const fail = armed && !lost && body?.name === 'source.draft.save';
    if (fail) { lost = true; if (timing === 'before') throw Error('Synthetic transport failure before delivery'); }
    const response = await fetcher(input, init);
    if (fail) throw Error('Synthetic response loss after committed source save');
    return response;
  });
  fireEvent.change(screen.getByLabelText('Название цели'), { target: { value: 'Сохранить весь введённый текст' } });
  armed = true;
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await screen.findByRole('button', { name: 'Продолжить сохранение' });
  expect(screen.getAllByRole('status').map(item=>item.textContent).join(' | ')).toContain('Сохранено шагов: 3 из 6');
  expect((screen.getByLabelText('Название цели') as HTMLInputElement).value).toBe('Сохранить весь введённый текст');
  expect(attempted.filter(item => item.name === 'goal.draft.save' || item.name === 'assignment.draft.save')).toHaveLength(0);
  const unknownId = attempted.find(item => item.name === 'source.draft.save')!.commandId;
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить сохранение' }));
  await screen.findByText('Черновик сохранён');
  expect(h.requests.some(request => request.method === 'GET' && request.url.endsWith('/commands/' + unknownId))).toBe(true);
  expect(new Set(attempted.filter(item => item.name === 'source.draft.save').map(item => item.commandId)).size).toBe(1);
  expect(attempted.filter(item=>item.name==='metric.draft.save')).toHaveLength(2);
  for (const name of ['method.draft.save', 'goal.draft.save', 'assignment.draft.save']) expect(attempted.filter(item => item.name === name)).toHaveLength(1);
  const before = attempted.length;
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить черновик' }).matches(':disabled')).toBe(false));
  expect(attempted).toHaveLength(before);
  cleanup();
  const next = new WorkbenchClient({ fetch: h.fetch });
  render(<WorkbenchProvider client={next}><WorkbenchShell views={{ goalDetail: () => <WorkbenchGoalSetupWizard goalRef={{entityType:h.refs.goal.entityType,id:h.refs.goal.id}} onClose={() => undefined} /> }} /></WorkbenchProvider>);
  await waitFor(() => expect((screen.getByLabelText('Название цели') as HTMLInputElement).value).toBe('Сохранить весь введённый текст'));
});
it('retains a confirmed draft.open receipt across failed readback and retries only the read', async () => {
  let armed = false, loseRead = false, lost = false;
  const h = await fixture(fetcher => async (input, init) => {
    const response = await fetcher(input, init);
    const body = String(input).endsWith('/commands') ? JSON.parse(String(init?.body)) : null;
    if (armed && body?.name === 'draft.open' && body.payload.entityType === 'metric_definition') loseRead = true;
    if (loseRead && !lost && String(input).endsWith('/queries/uor.package')) { lost = true; throw Error('Synthetic draft readback failure'); }
    return response;
  });
  fireEvent.change(screen.getByLabelText('Название цели'), { target: { value: 'Несохранённое название осталось' } });
  fireEvent.click(screen.getByRole('button', { name: 'Показатели и условия' }));
  armed = true;
  fireEvent.click(screen.getByRole('button', { name: 'Добавить показатель' }));
  await screen.findByRole('button', { name: 'Повторить чтение' });
  expect(screen.getByRole('alert').textContent).toContain('Черновик создан');
  expect(screen.getByRole('alert').textContent).not.toContain('Результат операции неизвестен');
  fireEvent.click(screen.getByRole('button', { name: 'Повторить чтение' }));
  await waitFor(() => expect(screen.getAllByLabelText('Название показателя')).toHaveLength(2));
  expect(h.requests.filter(request => request.body?.name === 'draft.open' && (request.body.payload as any).entityType === 'metric_definition' && (request.body.payload as any).ref === null)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Название и источник' }));
  expect((screen.getByLabelText('Название цели') as HTMLInputElement).value).toBe('Несохранённое название осталось');
});
