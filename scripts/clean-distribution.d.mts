export interface CleanDistributionOptions { projectRoot: string; outputPath?: string; includeLocalAccounts?: boolean }
export interface CleanDistributionResult { path: string; commit: string; files: number; privateAccountsPath?: string }
export function exportCleanDistribution(options: CleanDistributionOptions): Promise<CleanDistributionResult>;
