import path from 'node:path';
import type { WorkbenchRepository } from '../../storage/workbench-repository';
import type { Clock } from '../../../domain/workbench/primitives';
import type { DraftService } from '../../../features/catalog/workbench-drafts';
import type { AccessPolicyService } from '../../../features/identity/workbench-access-policy';
import type { CommandRegistry } from '../command-registry';
import type { JobStore } from '../jobs';
import { PublishingService } from '../../../features/publishing/workbench/publishing-service';
import { registerPublishingCommands } from '../../../features/publishing/workbench/register-commands';
import { createPackageArtifactStore } from '../../../features/publishing/workbench/package-artifacts';
import { canonicalBytes } from '../../../features/publishing/workbench/package-manifest';
/** Real T22 preview, explicitly trusted synthetic published baseline. No external write ports. */
export function composeGoalSetupPreview(input: {
    repository: WorkbenchRepository;
    clock: Clock;
    drafts: DraftService;
    accessPolicy: AccessPolicyService;
    jobs: JobStore;
    commands: CommandRegistry;
    root: string;
}) {
    const main = { repositoryId: 'synthetic-ui-main', commit: 'b'.repeat(40), files: new Map(input.repository.exportWorkspaceCore().filter(r => r.entityType !== 'publication_anchor' && 'publicationAnchorId' in r.value && r.value.publicationAnchorId !== null).map(r => [`records/${r.entityType}/${r.value.id}/${r.value.revision}.json`, canonicalBytes(r.value)])) };
    const service = new PublishingService({ ...input, jobSink: input.jobs, git: { async readMain() { return main; } }, artifacts: createPackageArtifactStore({ artifactRoot: path.join(input.root, 'synthetic-preview-artifacts') }), publication: { mode: 'demo-only', classifyRecord: () => true } });
    registerPublishingCommands(input.commands, service);
    return service;
}
