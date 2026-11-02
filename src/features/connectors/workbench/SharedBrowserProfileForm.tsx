import { useState } from 'react';
import type { VersionRef } from '../../../domain/workbench/primitives';
import type { BrowserOwnDraft } from '../workbench-browser-binding';
import type { BrowserProfileView } from '../workbench-browser-profile';
import type { OkoWorkflowView } from '../workbench-workflow-contracts';
import type { FormDescription } from '../../knowledge/workbench-fields';
import { useWorkbench, useGlobalContext } from '../../../app/workbench/context';
import { useRetainedDataQuery } from '../../sources/workbench/data-client';
import { browserOwnRequest, browserProblem, useBrowserOperation } from './shared-browser-client';
import { PersonalBrowserProfileForm } from './BrowserProfileForm';
import type { BrowserEnvironment } from '../../system/workbench/environment-query';

export type SharedBrowserProfileProps = { sourceRef: VersionRef; ownDraft?: BrowserOwnDraft; reportUrl?: string; onSaved(): void };
export function SharedBrowserProfileForm({ sourceRef, ownDraft, reportUrl, onSaved }: SharedBrowserProfileProps) {
  const { session, client } = useWorkbench(), { context } = useGlobalContext();
  const [refresh, setRefresh] = useState(0), [notice, setNotice] = useState(false);
  const own = useRetainedDataQuery<BrowserProfileView>('source.browser.own', { ...browserOwnRequest, filter: { sourceRef, ...(ownDraft ? { ownDraft } : {}) } }, refresh);
  const form = useRetainedDataQuery<FormDescription>('forms.describe', context && reportUrl === undefined ? { ...browserOwnRequest, context, filter: { formKind: 'source_definition', ref: { entityType: 'source_definition', id: sourceRef.id }, ...(ownDraft ? { packageRef: { entityType: 'publication_package', id: ownDraft.packageId } } : {}) } } : null);
  const operation = useBrowserOperation();
  const url = reportUrl ?? String(form.data?.values?.publicLocator ?? '');
  if (!own.data) return <div>{own.error ? <p role="alert">{browserProblem(own.error)}</p> : <p role="status">Загружаем личный профиль…</p>}<button type="button" onClick={() => setRefresh(v => v + 1)}>Повторить загрузку профиля</button></div>;
  return <div>{!own.data.configured && <p>Личный браузер ещё не настроен.</p>}
    <PersonalBrowserProfileForm workflow={{ profile: own.data } as OkoWorkflowView} reportUrl={url} busy={operation.busy || !session?.allowedCommands.includes('source.browser.profile.set')} onDetect={async () => (await client.query<BrowserEnvironment>('environment.browser', browserOwnRequest)).data} onSave={async profile => {
      await operation.run(async () => { await operation.command('source.browser.profile.set', { sourceId: sourceRef.id, profileId: own.data!.profileId ?? 'oko', profile, expectedRevision: own.data!.revision }); setNotice(true); setRefresh(v => v + 1); onSaved(); });
    }} />
    {operation.error !== null && <p role="alert">{browserProblem(operation.error)}</p>}{notice && <p role="status">Личный профиль сохранён.</p>}
  </div>;
}
