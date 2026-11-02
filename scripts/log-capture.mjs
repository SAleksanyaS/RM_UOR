import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { inspect } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const rotationLimit = 20 * 1024 * 1024, retention = 20, lineLimit = 16000;
const active = new Set();
let installed = false, rotationSequence = 0;
const pad = value => String(value).padStart(2, '0');
const stamp = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
const ownLogName = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9-]+(?:\.(?:r\d+-\d+-\d+|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}))?\.log$/;

/** Default diagnostics retain operation/error codes, not provider content. */
export function redactLog(value) {
  return String(value)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/(["']?(?:password|passwd|secret|access[_-]?token|refresh[_-]?token|csrf[_-]?token|credential|private[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b[A-Z]:\\[^\r\n"'<>]+/gi, '[path]')
    .replace(/(?:\/(?:[^\s/"'<>]+))+/g, '[path]')
    .replace(/(["']?(?:locator|selector|filename|profilePath|userDataDir)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/gi, '$1[redacted]');
}

function ensureDirectory(directory) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe log directory');
  }
}

export function listLogFiles(directory) {
  try {
    if (lstatSync(directory).isSymbolicLink()) return [];
    return readdirSync(directory).filter(name => ownLogName.test(name)).flatMap(name => {
      try { const file = path.join(directory, name), info = lstatSync(file); return info.isFile() && info.nlink === 1 ? [{ name, file, time: info.mtimeMs, size: info.size }] : []; } catch { return []; }
    }).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  } catch { return []; }
}

export function prune(directory) {
  for (const { file } of listLogFiles(directory).slice(retention)) if (!active.has(file)) {
    try { unlinkSync(file); } catch { /* concurrent removal is harmless */ }
  }
}

function rotate(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe log file');
    if (info.size >= rotationLimit) renameSync(file, file.replace(/\.log$/, `.r${Date.now()}-${process.pid}-${++rotationSequence}.log`));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Bounded synchronous appends preserve process-exit diagnostics. */
export function writeLog(file, chunk) {
  let descriptor;
  try {
    ensureDirectory(path.dirname(file)); rotate(file);
    descriptor = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe log file');
    const safe = redactLog(chunk), clipped = safe.length <= lineLimit ? safe : `${safe.slice(0, lineLimit)}\n[long diagnostic truncated]`;
    appendFileSync(descriptor, clipped.endsWith('\n') ? clipped : clipped + '\n');
    active.add(file); prune(path.dirname(file));
  } catch { /* Logging failure cannot break application start. */ }
  finally { if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* already closed */ } }
}

export function logPath(runtimeRoot, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid log channel');
  return path.join(runtimeRoot, 'logs', `${stamp()}-${name}-${process.pid}-${randomUUID().slice(0, 8)}.log`);
}

/** Redact whole logical lines; split writes must not split a credential. */
function lineWriter(file, prefix) {
  const decoder = new StringDecoder('utf8'); let pending = '', dropping = false;
  const accept = text => {
    pending += text; let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!dropping) writeLog(file, prefix + line); dropping = false;
    }
    if (pending.length > 32768) { pending = ''; dropping = true; writeLog(file, prefix + '[oversized diagnostic line omitted]'); }
  };
  return { write(chunk) { accept(typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk))); }, end() { accept(decoder.end()); if (pending && !dropping) writeLog(file, prefix + pending); pending = ''; } };
}

export function captureProcessOutput(file) {
  if (installed) return file; installed = true;
  writeLog(file, `=== ${new Date().toISOString()} старт процесса pid=${process.pid}; node ${process.version}`);
  const writers = [];
  for (const [stream, prefix] of [[process.stdout, ''], [process.stderr, '[stderr] ']]) {
    const original = stream.write.bind(stream), writer = lineWriter(file, prefix); writers.push(writer);
    stream.write = (chunk, encoding, callback) => { writer.write(chunk); return original(chunk, encoding, callback); };
  }
  process.once('exit', () => { for (const writer of writers) writer.end(); writeLog(file, `=== ${new Date().toISOString()} завершение pid=${process.pid}`); });
  // Launcher owns graceful shutdown. Logger must not suppress default signals.
  process.on('uncaughtExceptionMonitor', error => writeLog(file, `=== необработанная ошибка\n${inspect(error)}`));
  return file;
}

export function pipe(file, child, name) {
  const channel = /^[a-z0-9-]+$/.test(name) ? name : 'child';
  for (const [stream, prefix] of [[child.stdout, `[${channel}] `], [child.stderr, `[${channel}][stderr] `]]) {
    if (!stream) continue;
    const writer = lineWriter(file, prefix); stream.on('data', chunk => writer.write(chunk)); stream.once('end', () => writer.end());
  }
  child.once('exit', (code, signal) => writeLog(file, `[${channel}] завершился: code=${code} signal=${signal ?? '-'}`));
}
