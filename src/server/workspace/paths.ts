import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function resolveExistingParent(candidate: string): Promise<string> {
  try { await access(candidate); return await realpath(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('Не удалось проверить путь');
    return path.join(await resolveExistingParent(parent), path.basename(candidate));
  }
}
export interface WorkspacePaths { projectRoot: string; runtimeRoot: string; databasePath: string }
export async function resolveWorkspace(input: { projectRoot: string; allowedRoots: string[] }): Promise<WorkspacePaths> {
  const root = await realpath(input.projectRoot);
  const allowed = await Promise.all(input.allowedRoots.map(p => realpath(p)));
  if (!allowed.some(p => contained(p, root))) throw new Error('Запуск разрешён только из настроенной рабочей папки');
  for(const relative of ['.runtime','.runtime/local-config']){
    try{const entry=await lstat(path.join(root,relative));if(entry.isSymbolicLink()||!entry.isDirectory())throw new Error('Приватная папка не должна быть ссылкой или обычным файлом');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const runtimeRoot = await safeArtifactPath(root, '.runtime');
  await mkdir(runtimeRoot, { recursive: true });
  return { projectRoot: root, runtimeRoot, databasePath: path.join(runtimeRoot, 'app.db') };
}
export async function safeArtifactPath(root: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Недопустимый путь');
  const canonical = await realpath(root);
  const candidate = path.resolve(canonical, relativePath);
  if (!contained(canonical, candidate)) throw new Error('Путь выходит за пределы рабочей папки');
  const resolved = await resolveExistingParent(candidate);
  if (!contained(canonical, resolved)) throw new Error('Ссылка ведёт за пределы рабочей папки');
  return resolved;
}
