import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { listLogFiles, prune, redactLog } from './log-capture.mjs';

const directory = path.join(path.resolve('.runtime'), 'logs');
const requested = Number(process.env.UOR_LOG_LINES ?? 200);
const lines = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 5000) : 200;
const follow = process.argv.includes('--follow'), maximumRead = 1024 * 1024;
let file = null, offset = 0, pending = '', busy = false;

async function readNew(initial = false) {
  prune(directory);
  const latest = listLogFiles(directory).find(entry => !/\.r\d+-\d+-\d+\.log$/.test(entry.name));
  if (!latest) return false;
  if (latest.file !== file) { file = latest.file; offset = 0; pending = ''; initial = true; }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) return false;
    if (stat.size < offset) { offset = 0; pending = ''; initial = true; }
    if (initial) offset = Math.max(0, stat.size - maximumRead);
    const startedMidLine = initial && offset > 0;
    const buffer = Buffer.alloc(Math.min(maximumRead, Math.max(0, stat.size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); offset += bytesRead;
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (startedMidLine) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    if (initial) {
      const parts = text.split('\n'); pending = parts.pop() ?? '';
      const tail = parts.slice(-lines); if (tail.length) process.stdout.write(redactLog(tail.join('\n')) + '\n');
      if (!follow && pending) { process.stdout.write(redactLog(pending) + '\n'); pending = ''; }
    } else {
      const parts = (pending + text).split('\n'); pending = parts.pop() ?? '';
      if (parts.length) process.stdout.write(redactLog(parts.join('\n')) + '\n');
      if (pending.length > maximumRead) pending = '[oversized log line omitted]';
    }
    return true;
  } catch { return false; }
  finally { await handle?.close(); }
}

if (!await readNew(true)) console.log('Логов запуска пока нет. Запустите рабочее место — журнал появится автоматически.');
if (follow) {
  console.log('Слежение за журналом. Остановка: Ctrl+C.');
  const timer = setInterval(async () => { if (busy) return; busy = true; try { await readNew(); } finally { busy = false; } }, 500);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); process.exitCode = signal === 'SIGINT' ? 130 : 143; });
}
