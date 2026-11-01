import type { Clock } from '../../domain/workbench/primitives';
import type { AccessPolicyService, Capability } from '../../features/identity/workbench-access-policy';
import type { BrowserLauncherPort } from '../../features/connectors/browser';
import type { BrowserScenarioRuntimePort, SourceAdapter } from '../../features/connectors/workbench-source-contracts';
import type { PublicationGitPort } from '../../features/publishing/workbench/git-port';
import type { BitbucketPort } from '../../features/publishing/workbench/bitbucket-port';
import type { TerminalRunner } from '../../features/publishing/workbench/terminal-runner';
import type { PublicationClassification } from '../../features/publishing/workbench/package-preview';
import type { NotificationProvider } from '../../features/execution/workbench-notifications';
/** Trusted in-process composition only. Not parsed from HTTP, environment or archive. */
export type WorkbenchRuntimeProviders = {
    clock?: Clock;
    hostname?: () => string;
    accessPolicy?: (input: {
        installationId: string;
        capabilityFor(name: string): Capability;
        clock: Clock;
    }) => AccessPolicyService;
    git?: PublicationGitPort;
    bitbucket?: BitbucketPort;
    terminal?: TerminalRunner;
    classification?: PublicationClassification;
    browserLauncher?: BrowserLauncherPort;
    browserEvidence?: Pick<BrowserScenarioRuntimePort, 'inspectExport' | 'inspectPreviewExport'>;
    sourceAdapters?: ReadonlyMap<string, SourceAdapter>;
    notifications?: NotificationProvider;
};
export type WorkbenchRuntimeOptions = {
    projectRoot: string;
    codeRoot?: string;
    providers?: WorkbenchRuntimeProviders;
    candidate?: boolean;
};
