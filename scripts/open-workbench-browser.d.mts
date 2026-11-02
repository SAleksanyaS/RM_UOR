export const targetBrowserVersion: string;
export type BrowserDiscovery = {
  targetVersion: string;
  candidates: Array<{ executablePath: string; version: string | null; status: 'compatible' | 'unverified' }>;
  message: string;
};
export function inspectSberBrowser(executable: string): Promise<{ version: string }>;
export function discoverSberBrowsers(options?: { configuredExecutable?: string; searchPath?: string; platform?: NodeJS.Platform; systemCandidates?: string[] }): Promise<BrowserDiscovery>;
export function openWorkbenchBrowser(options: { executable?: string; url: string; notify?(message: string): void }): Promise<boolean>;
