import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { utcInstantSchema, uuidSchema, type UUIDv4, type UtcInstant } from '../../domain/workbench/primitives';

export type OwnPolicyCacheValue = {
  hostname: string; personId: UUIDv4; displayName: string; role: 'curator' | 'chief'; enabled: true;
  installationId: UUIDv4; mainRepositoryId: string; serviceRepositoryId: string; registryCommit: string; checkedAt: UtcInstant;
};
export interface OwnPolicyCache { read(): OwnPolicyCacheValue | null; write(value: OwnPolicyCacheValue): void; invalidate(): void }
export const ownPolicyCacheValueSchema = z.strictObject({
  hostname: z.string().min(1).max(255).refine(value => value === value.trim().toLowerCase()), personId: uuidSchema, displayName: z.string().min(1).max(500), role: z.enum(['curator', 'chief']), enabled: z.literal(true),
  installationId: uuidSchema, mainRepositoryId: z.string().min(1), serviceRepositoryId: z.string().min(1), registryCommit: z.string().min(1), checkedAt: utcInstantSchema,
});

function assertNoLinks(path: string): void {
  let current = resolve(path);
  while (current !== parse(current).root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Policy cache path cannot contain a symlink or junction');
    current = dirname(current);
  }
}

/** Native Windows ACL operations, with no hostname or registry data passed through a shell. */
function windowsPermissions(path: string, restrict: boolean): void {
  const literalPath = path.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; $p='${literalPath}'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $isDirectory=[System.IO.Directory]::Exists($p); if($isDirectory) { $acl=[System.IO.Directory]::GetAccessControl($p) } else { $acl=[System.IO.File]::GetAccessControl($p) }; ` +
    (restrict ? `$acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleSpecific($rule) }; $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl); $acl=[System.IO.Directory]::GetAccessControl($p); ` : '') +
    `foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { throw 'Policy cache ACL grants another principal access' } }`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe', timeout: 15000 });
}

export function createOwnPolicyCache(options: { directory: string }): OwnPolicyCache {
  if (!isAbsolute(options.directory)) throw new Error('Policy cache requires an absolute private directory');
  const directory = resolve(options.directory);
  assertNoLinks(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('Policy cache path is not a directory');
  if (process.platform === 'win32') windowsPermissions(directory, true); else chmodSync(directory, 0o700);
  const filename = join(directory, 'own-policy.json');

  function assertPrivate(path: string): void {
    assertNoLinks(path);
    const stat = lstatSync(path);
    if (stat.isFile() && stat.nlink !== 1) throw new Error('Policy cache cannot be hard-linked');
    if (process.platform === 'win32') windowsPermissions(path, false);
    else if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Policy cache permissions are not private');
  }
  function read(): OwnPolicyCacheValue | null {
    assertPrivate(directory);
    if (!existsSync(filename)) return null;
    assertPrivate(filename);
    const descriptor = openSync(filename, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
      if (fstatSync(descriptor).size > 16384) return null;
      const result = ownPolicyCacheValueSchema.safeParse(JSON.parse(readFileSync(descriptor, 'utf8')));
      return result.success ? result.data : null;
    } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    finally { closeSync(descriptor); }
  }
  return {
    read,
    write(value) {
      const validated = ownPolicyCacheValueSchema.parse(value);
      assertPrivate(directory);
      if (existsSync(filename)) assertPrivate(filename);
      const temporary = join(directory, `.own-policy-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(validated), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        assertPrivate(temporary);
        renameSync(temporary, filename);
      } finally { if (existsSync(temporary)) rmSync(temporary); }
    },
    invalidate() { assertPrivate(directory); if (existsSync(filename)) { assertNoLinks(filename); rmSync(filename); } },
  };
}
