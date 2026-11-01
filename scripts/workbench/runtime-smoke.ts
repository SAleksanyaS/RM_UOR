import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareEmptyProductionRoot, startProductionEntry } from '../../src/server/workbench/testing/production-entry';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--root' || !path.isAbsolute(args[1])) throw Error('Usage: npm run smoke:workbench -- --root <absolute existing empty directory>');
const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixture = await prepareEmptyProductionRoot(args[1]);
const get = async (url: string) => { const response = await fetch(fixture.baseUrl + url, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200, url); return response.json(); };
let identity: string | undefined;
for (let boot = 0; boot < 2; boot++) {
  const process = await startProductionEntry({ root: fixture.root, codeRoot });
  try {
    assert.equal((await get('/api/health')).version, '0.5.0');
    const session = (await get('/api/v1/session')).data;
    assert.equal(session.defaultContext, null);
    assert.equal(session.policyState, 'local_preview');
    for (const url of ['/api/state', '/api/auth/curator', '/api/system/backups', '/api/workspace/restore']) {
      assert.equal((await fetch(fixture.baseUrl + url, { method: 'POST', signal: AbortSignal.timeout(10000) })).status, 404, url);
    }
    const current = await readFile(path.join(fixture.root, '.runtime/workbench/identity.json'), 'utf8');
    if (identity !== undefined) assert.equal(current, identity); else identity = current;
  } finally { await process.stop(); }
}
for (const forbidden of ['.git', '.runtime/app.db', '.runtime/oko']) {
  await assert.rejects(access(path.join(fixture.root, forbidden)), { code: 'ENOENT' });
}
console.log(JSON.stringify({ status: 'passed', version: '0.5.0', boots: 2, root: fixture.root, checks: ['actual-production-main', 'empty-context', 'local-preview', 'legacy-routes-closed', 'stable-identity-restart', 'no-git-or-legacy-workspace-created'] }));
