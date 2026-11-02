import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync, appendFileSync, symlinkSync, truncateSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { logPath, prune } from '../scripts/log-capture.mjs';

const execute = promisify(execFile), roots: string[] = [], children: ChildProcess[] = [];
const moduleUrl = pathToFileURL(path.resolve('scripts/log-capture.mjs')).href;
const logsScript = path.resolve('scripts/logs.mjs');
function temporary() { const root = mkdtempSync(path.join(os.tmpdir(), 'uor-log-test-')); roots.push(root); return root; }
function program(source: string, cwd: string) { return execute(process.execPath, ['--input-type=module', '-e', source], { cwd, timeout: 4000 }); }
function start(args: string[], cwd: string) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let output = '', error = ''; child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { error += b; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, closed, output: () => output, error: () => error };
}
async function until(predicate: () => boolean, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  return predicate();
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local log safety and lifecycle', () => {
  it('prunes actual generated names to twenty newest files and retains unrelated files', () => {
    const root = temporary(), directory = path.join(root, 'logs'); mkdirSync(directory);
    for (let i = 0; i < 25; i++) { const file = logPath(root, `api-${i}`); writeFileSync(file, `${i}`); utimesSync(file, 1000 + i, 1000 + i); }
    writeFileSync(path.join(directory, 'my-notes.log'), 'personal');
    prune(directory);
    const remaining = readdirSync(directory);
    expect(remaining).toHaveLength(21);
    expect(readFileSync(path.join(directory, 'my-notes.log'), 'utf8')).toBe('personal');
    expect(remaining.filter(name => name !== 'my-notes.log').map(name => Number(readFileSync(path.join(directory, name), 'utf8'))).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 5));
  });

  it('redacts credentials, URLs and machine paths even across stdout chunks', async () => {
    const root = temporary(), file = path.join(root, 'capture.log');
    await program(`import {captureProcessOutput} from ${JSON.stringify(moduleUrl)};
      captureProcessOutput(${JSON.stringify(file)});
      process.stdout.write('Authorization: Bearer CAN'); process.stdout.write('ARY_AUTH\\n');
      console.error(JSON.stringify({access_token:'CANARY_TOKEN',cookie:'CANARY_COOKIE'}));
      process.stdout.write('https://private.example/re'); process.stdout.write('port?token=CANARY_QUERY\\n');
      console.log('profile=/home/employee/secret-profile/file.json');
      console.log('E_REPORT_TIMEOUT operation=42');`, root);
    const value = readFileSync(file, 'utf8');
    for (const secret of ['CANARY_AUTH', 'CANARY_TOKEN', 'CANARY_COOKIE', 'CANARY_QUERY', 'private.example', '/home/employee', root]) expect(value).not.toContain(secret);
    expect(value).toContain('E_REPORT_TIMEOUT'); expect(value).toContain('operation=42');
  });

  it('never follows a log-file symlink while appending', async () => {
    const root = temporary(), target = path.join(root, 'important.txt'), link = path.join(root, 'capture.log');
    writeFileSync(target, 'unchanged'); symlinkSync(target, link);
    await program(`import {writeLog} from ${JSON.stringify(moduleUrl)}; writeLog(${JSON.stringify(link)},'not-a-log');`, root);
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });

  it('rotates a full log before the next append and keeps the new message', async () => {
    const root = temporary(), file = logPath(root, 'api'); mkdirSync(path.dirname(file)); writeFileSync(file, ''); truncateSync(file, 20 * 1024 * 1024);
    await program(`import {writeLog} from ${JSON.stringify(moduleUrl)}; writeLog(${JSON.stringify(file)},'after rotation');`, root);
    expect(statSync(file).size).toBeLessThan(1024);
    expect(readFileSync(file, 'utf8')).toContain('after rotation');
    expect(readdirSync(path.dirname(file)).length).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('capture leaves normal SIGTERM termination intact', async () => {
    const root = temporary();
    const running = start(['--input-type=module', '-e', `import {captureProcessOutput} from ${JSON.stringify(moduleUrl)}; captureProcessOutput(${JSON.stringify(path.join(root, 'capture.log'))}); console.log('READY'); setInterval(()=>{},1000);`], root);
    const ready = await until(() => running.output().includes('READY'));
    expect(ready, `${running.output()} / ${running.error()} / exit=${running.child.exitCode}`).toBe(true);
    running.child.kill('SIGTERM');
    const ended = await Promise.race([running.closed, new Promise(resolve => setTimeout(() => resolve(null), 700))]);
    expect(ended).toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('follow stays alive and displays an appended line', async () => {
    const root = temporary(), runtime = path.join(root, '.runtime'), file = logPath(runtime, 'api'); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'initial-line\n');
    const running = start([logsScript, '--follow'], root);
    const ready = await until(() => running.output().includes('initial-line'));
    expect(ready, `${running.output()} / ${running.error()} / exit=${running.child.exitCode}`).toBe(true);
    appendFileSync(file, 'later-line\n');
    expect(await until(() => running.output().includes('later-line'))).toBe(true);
    expect(running.child.exitCode).toBeNull();
  });
});
