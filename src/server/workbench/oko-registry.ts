import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { RegistryReadError, type RegistryReadPort } from '../../features/identity/workbench-access-policy';

const execute = promisify(execFile);
export type AcceptedGitRegistryConfig = { checkout: string; expectedRemote: string; acceptedBranch: string; registryPath: string };
/** The working tree is never a grant. Read the exact freshly fetched accepted commit. */
export function createAcceptedGitRegistry(config: AcceptedGitRegistryConfig): RegistryReadPort {
  if (!isAbsolute(config.checkout) || !config.expectedRemote.trim() || /[\r\n]/.test(config.expectedRemote)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(config.acceptedBranch) || /\.\.|\/\/|\/$|\.lock(?:\/|$)/.test(config.acceptedBranch)
    || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.json$/.test(config.registryPath) || config.registryPath.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid accepted registry configuration');
  const git = async (...args: string[]) => (await execute('git', ['--no-optional-locks', '-C', config.checkout, ...args], {
    windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  })).stdout.trim();
  return { async readAccepted() {
    try {
      if (await git('remote', 'get-url', 'origin') !== config.expectedRemote) throw new RegistryReadError('invalid', 'Private registry remote does not match configured identity');
      const reference = `refs/remotes/origin/${config.acceptedBranch}`;
      await git('fetch', '--no-tags', '--no-write-fetch-head', 'origin', `refs/heads/${config.acceptedBranch}:${reference}`);
      const commit = await git('rev-parse', '--verify', `${reference}^{commit}`);
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new RegistryReadError('invalid');
      const json = await git('show', `${commit}:${config.registryPath}`);
      return { commit, value: JSON.parse(json) as unknown };
    } catch (error) {
      if (error instanceof RegistryReadError) throw error;
      if (error instanceof SyntaxError) throw new RegistryReadError('invalid', 'Accepted registry is not valid JSON');
      const detail = String((error as { stderr?: string }).stderr ?? '');
      if (/not a git repository|does not exist|unknown revision|bad object|couldn't find remote ref|non-fast-forward/i.test(detail)) throw new RegistryReadError('invalid');
      if (/403|access denied|permission denied/i.test(detail)) throw new RegistryReadError('forbidden');
      if (/authentication|terminal prompts disabled|could not read username/i.test(detail)) throw new RegistryReadError('auth_expired');
      throw new RegistryReadError((error as { killed?: boolean }).killed ? 'timeout' : 'network', 'Accepted private registry is unavailable; authenticate with native Git and retry');
    }
  } };
}
