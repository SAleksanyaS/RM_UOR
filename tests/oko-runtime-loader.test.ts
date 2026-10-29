import { spawn } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('runs picker and recorder regression under the actual production Node/tsx loader', async () => {
  const output = await new Promise<{code: number | null; text: string}>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', path.resolve('tests/fixtures/workbench/oko-loader-regression.ts')], { windowsHide: true, env: process.env });
    let text = ''; child.stdout.on('data', data => { text += data; }); child.stderr.on('data', data => { text += data; });
    child.on('error', reject); child.on('exit', code => resolve({ code, text }));
  });
  expect(output.code, output.text).toBe(0);
}, 50000);
