import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { closeOkoLauncherResources, stopOkoLauncher } from './fixtures/workbench/oko-launcher-cleanup';

it('closes the real report listener and removes its project after browser and launcher shutdown reject', async () => {
  const temp = await realpath(tmpdir()), root = await mkdtemp(path.join(temp, 'uor-oko-cleanup-'));
  await writeFile(path.join(root, 'private-test-runtime'), 'synthetic runtime');
  const report = createServer((_request, response) => response.end('test'));
  await new Promise<void>(resolve => report.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(report.address() as {port:number}).port}`;
  const browserError = new Error('browser shutdown rejected'), launcherError = new Error('launcher shutdown rejected'), primary = new Error('original setup failed');
  try {
    expect((await fetch(url)).ok).toBe(true);
    const failure = await closeOkoLauncherResources({
      closeBrowser: async () => { throw browserError; }, stopLauncher: async () => { throw launcherError; },
      closeReport: () => new Promise<void>(resolve => report.close(() => resolve())),
      removeProject: async () => { expect(path.dirname(root)).toBe(temp); await rm(root, {recursive:true,force:true}); },
    }, primary).catch(error => error);
    expect(report.listening, 'Report listener remains active after rejected shutdown').toBe(false);
    await expect(access(root)).rejects.toMatchObject({code:'ENOENT'});
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.cause).toBe(primary);
    expect(failure.errors).toEqual([browserError, launcherError]);
  } finally {
    await new Promise<void>(resolve => report.close(() => resolve()));
    expect(path.dirname(root)).toBe(temp); await rm(root, {recursive:true,force:true});
  }
});

it('forces only its owned child to exit after the graceful shutdown deadline', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("disconnect",()=>{});process.send("ready");setInterval(()=>{},1000)'], {windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  try {
    await new Promise<void>((resolve,reject) => { child.once('message',()=>resolve());child.once('error',reject); });
    await expect(stopOkoLauncher(child, 40)).rejects.toThrow('shutdown timed out');
    expect(child.exitCode !== null || child.signalCode !== null, 'Owned child remains alive after shutdown rejection').toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await closed; }
  }
});
