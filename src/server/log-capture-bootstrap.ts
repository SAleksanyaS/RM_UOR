import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureProcessOutput, logPath } from '../../scripts/log-capture.mjs';

/** Captures the very first lines of a directly started service, before any application code runs. */
if (!process.env.UOR_LOG_FILE) {
  await mkdir(path.join(process.cwd(), '.runtime'), { recursive: true });
  const sessionLog = logPath(await realpath(path.join(process.cwd(), '.runtime')), 'api');
  process.env.UOR_LOG_FILE = captureProcessOutput(sessionLog);
  console.log(`Логи службы: ${sessionLog}`);
}
