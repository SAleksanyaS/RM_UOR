import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat,readFile} from 'node:fs/promises';
import {provisionLocalCurators} from '../src/features/identity/curator-provisioning';
import {loadSite} from '../src/server/workspace/context';
import {resolveWorkspace,safeArtifactPath} from '../src/server/workspace/paths';

export async function provisionFromFile({projectRoot,file='.runtime/local-config/curators.input.json'}:{projectRoot:string;file?:string}){
 const site=await loadSite(projectRoot),workspace=await resolveWorkspace({projectRoot,allowedRoots:site.allowedWorkspaceRoots});
 const relative=path.relative(workspace.projectRoot,path.resolve(workspace.projectRoot,file)).split(path.sep).join('/');
 if(!/^\.runtime\/local-config\/[^/]+\.json$/.test(relative)||relative.endsWith('/curators.json'))throw new Error('Укажите отдельный приватный локальный файл .runtime/local-config/curators.input.json');
 const target=await safeArtifactPath(workspace.runtimeRoot,relative.slice('.runtime/'.length)),info=await lstat(target);
 if(!info.isFile()||info.isSymbolicLink()||info.size>100000)throw new Error('Нужен обычный локальный JSON-файл до100КБ');
 const profiles:unknown=JSON.parse(await readFile(target,'utf8'));
 if(!Array.isArray(profiles)||profiles.some(value=>typeof value?.name!=='string'||typeof value?.code!=='string'))throw new Error('Проверьте имена и пароли в локальном файле');
 const filled=profiles.filter(value=>value.code.trim());
 if(!filled.length||filled.some(value=>/REPLACE_|CHANGE_ME|ВПИШИТЕ_|<.*>/i.test(value.code)))throw new Error('Сначала заполните имена и собственные пароли в локальном файле; значения примера не применяются');
 // An empty password means "keep this account unchanged", never erase its current hash.
 return provisionLocalCurators(workspace.runtimeRoot,filled);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 try{if(args.length&&!(args.length===2&&args[0]==='--file'&&args[1]))throw new Error('Укажите --file .runtime/local-config/curators.input.json');const result=await provisionFromFile({projectRoot:process.cwd(),file:args[1]});console.log(`Добавлено: ${result.added}. Обновлено: ${result.updated}. Пароли сохранены как локальные хеши. Перезапустите приложение.`);}
 catch{console.error('Не удалось настроить кураторов. Проверьте приватный JSON, заполненные уникальные пароли, имена и разрешённую папку. Секреты не выводятся.');process.exitCode=1;}
}
