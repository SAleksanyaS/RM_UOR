import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';

if (!process.stdin.isTTY) { console.error('Запустите setup:curators в интерактивной консоли. Код вводится скрыто.'); process.exit(1); }
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const name = (await terminal.question('Имя куратора: ')).trim(); terminal.close();
if (!name) throw new Error('Имя обязательно');
process.stdout.write('Индивидуальный код: ');
readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true);
const code = await new Promise(resolve => {
  let input = '';
  function keypress(text, key) {
    if (key?.ctrl && key.name === 'c') process.exit(130);
    if (key?.name === 'return') { process.stdin.off('keypress', keypress); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(input); }
    else if (key?.name === 'backspace') input = input.slice(0, -1);
    else if (text && !key?.ctrl) input += text;
  }
  process.stdin.on('keypress', keypress); process.stdin.resume();
});
if (code.length < 6 || code.length > 256) throw new Error('Код должен содержать от 6 до 256 символов');
const directory = path.join(process.cwd(), '.runtime/local-config'); await mkdir(directory, { recursive: true });
const file = path.join(directory, 'curators.json'); let existing = [];
try { existing = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const salt = randomBytes(24).toString('hex');
const prior = existing.find(record => record.name === name);
const record = { id: prior?.id ?? randomUUID(), name, salt, hash: scryptSync(code, salt, 64).toString('hex') };
existing = existing.filter(item => item.name !== name); existing.push(record);
await writeFile(file, JSON.stringify(existing, null, 2), { mode: 0o600 });
console.log(`Профиль ${name} сохранён локально. Перезапустите службу, чтобы применить изменение.`);
