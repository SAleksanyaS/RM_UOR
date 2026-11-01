import type { JobSnapshot } from '../../../server/workbench/protocol';
import type { PackageDelivery, PublicationPackageRecord } from './contracts';

export type PublishControl = 'job.openAuth' | 'job.retry' | 'job.cancel';
const stageLabels: Record<string, string> = { 'package.preview.check': 'Проверяем пакет', 'package.prepare': 'Подготавливаем изменения', 'package.push': 'Передаём коммиты', 'git.auth': 'Требуется штатный вход Git', 'pr.write': 'Создаём или обновляем PR', 'pr.status': 'Проверяем состояние PR', 'PR.auth': 'Требуется штатный вход Bitbucket' };
function safeProposalUrl(value: string): string | null { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
export function PublishOperation({ publication, delivery = null, job, onControl, busy = false }: { publication: PublicationPackageRecord | null; delivery?: PackageDelivery | null; job: JobSnapshot | null; onControl(command: PublishControl, jobId: string): void; busy?: boolean }) {
  const bound = delivery && delivery.packageRevision.packageId === publication?.id ? delivery : null;
  const pushed = bound?.pushState === 'confirmed';
  const prAuth = job?.jobId === bound?.job.jobId && job?.status === 'waiting_user' && job.stage === 'PR.auth' && job.warnings.some(warning => warning.code === 'PR_AUTH_REQUIRED');
  const link = publication?.proposal ? safeProposalUrl(publication.proposal.url) : null;
  const nativeAction = job?.status === 'waiting_user' && job.nextAction?.commandName === 'job.openAuth' ? job.nextAction : null;
  const actionBound = nativeAction?.payload?.jobId === job?.jobId;
  const proposalCurrent = publication?.sent?.contentHash === bound?.packageRevision.contentHash && !!publication?.proposal;
  return <section aria-label="Ход публикации">
    {bound && <p>Локальный коммит сохранён · редакция {bound.packageRevision.revision}</p>}
    {pushed && !proposalCurrent && (job?.status === 'cancelled' ? <p role="status">Коммиты сохранены; продолжение операции отменено</p> : prAuth ? <p role="status">Коммиты отправлены, PR ожидает входа</p> : <p role="status">Коммиты отправлены; создание PR ещё не подтверждено</p>)}
    {bound?.pushState === 'unknown' && <p role="status">Результат отправки неизвестен. Коммит сохранён; требуется сверка.</p>}
    {bound?.pushState === 'prepared' && <p>Отправка коммита не подтверждена</p>}
    {publication?.proposal && <p>{publication.state === 'merged' ? 'PR принят во внешнем Bitbucket' : publication.state === 'declined' ? 'PR отклонён' : publication.state === 'needs_rework' ? 'PR требует доработки' : 'PR открыт'}{publication.sent ? ` · редакция ${publication.sent.revision}` : ''}</p>}
    {link && <a href={link} target="_blank" rel="noreferrer noopener">Открыть PR в Bitbucket</a>}
    {job && <><p>{stageLabels[job.stage] ?? (job.status === 'succeeded' ? 'Операция завершена' : 'Состояние операции')}</p>{['queued','running'].includes(job.status) && <progress aria-label="Ход операции" max={job.progress.total || 1} value={job.progress.total === null ? undefined : job.progress.completed} />}
      {job.status === 'queued' && <p>Операция в очереди</p>}{job.status === 'interrupted' && <p>Операция прервана. Сверьте сохранённое состояние перед продолжением.</p>}{job.status === 'failed' && <p role="alert">{job.error ? `${job.error.code}: ${job.error.message}` : 'Операция завершилась с ошибкой'}</p>}
      {job.warnings.map((warning, index) => <p key={index}>{warning.code === 'PR_AUTH_REQUIRED' ? 'Войдите в Bitbucket в штатном внешнем окне.' : warning.code === 'GIT_AUTH_REQUIRED' ? 'Войдите в Git в штатном внешнем окне.' : warning.message}</p>)}
      {nativeAction && <><button type="button" disabled={busy || !nativeAction.enabled || !actionBound} onClick={() => onControl('job.openAuth', job.jobId)}>{nativeAction.label}</button>{!nativeAction.enabled && <p>{nativeAction.disabledReason ?? 'Штатный вход сейчас недоступен'}</p>}</>}
      {job.retryAvailable && <button type="button" disabled={busy} onClick={() => onControl('job.retry', job.jobId)}>Повторить операцию</button>}
      {job.cancelAvailable && <button type="button" disabled={busy} onClick={() => onControl('job.cancel', job.jobId)}>Отменить операцию</button>}
    </>}
  </section>;
}
