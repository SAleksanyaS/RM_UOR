import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,realpath,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';

const within=(root,target)=>{const relative=path.relative(root,target);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
async function exists(target){try{await lstat(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
/** New-install writes never follow directory links, even if a link currently points inside the root. */
async function safePath(root,relative){let current=root;for(const part of relative.split('/')){if(!part||part==='.'||part==='..')throw new Error('Недопустимая папка настройки');current=path.join(current,part);if(await exists(current)){const entry=await lstat(current);if(entry.isSymbolicLink()||!within(root,await realpath(current)))throw new Error('Папка настройки является ссылкой или ведёт за пределы проекта');}}return current;}
export function emptyCatalog(){return{schemaVersion:1,id:'uor-blank-v1',name:'Рабочая повестка ДИТ',classification:'corporate',importedAt:new Date().toISOString(),goals:[],leaders:[],assignments:[],sources:[],comments:[],entities:[],directions:[]};}
export async function setupWorkspace({projectRoot,mode='empty',repositoryUrl='',publicationMode='demo-only'}){
 if(!['empty','demo'].includes(mode)||!['internal','demo-only'].includes(publicationMode))throw new Error('Выберите mode empty|demo и publication internal|demo-only');
 if(publicationMode==='internal'&&!repositoryUrl.trim())throw new Error('Для внутренней публикации укажите адрес репозитория банка');
 const root=await realpath(projectRoot),pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 if(pkg.name!=='uor-dit-operations')throw new Error('Запустите настройку из папки рабочего места УОР');
 const runtime=await safePath(root,'.runtime');await mkdir(runtime,{recursive:true});
 const lock=await safePath(root,'.runtime/setup.lock');try{await writeFile(lock,randomUUID(),{flag:'wx',mode:0o600});}catch(error){if(error.code==='EEXIST')throw new Error('Настройка уже выполняется; проверьте существующую установку');throw error;}
 const created=[];
 try{
  for(const file of ['.runtime/app.db','.runtime/imports/catalog.json','.runtime/imports/snapshots.json','config/site.local.json'])if(await exists(await safePath(root,file)))throw new Error('Рабочее место уже настроено или существует база. Для нового запуска используйте отдельную чистую папку; данные не изменены.');
  let catalog=emptyCatalog(),snapshots=[];
  if(mode==='demo'){catalog=JSON.parse(await readFile(path.join(root,'catalog/demo.json'),'utf8'));try{snapshots=JSON.parse(await readFile(path.join(root,'catalog/demo-snapshots.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}}
  const config={allowedWorkspaceRoots:[root],repositoryUrl:repositoryUrl.trim(),publishedBranch:'main',releaseBranch:'release/current',publicationMode,port:4174,clientPort:5173,autoOpen:true};
  const files=[['.runtime/imports/catalog.json',catalog],['.runtime/imports/snapshots.json',snapshots],['config/site.local.json',config]];
  const input=await safePath(root,'.runtime/local-config/curators.input.json');
  if(!await exists(input))files.push(['.runtime/local-config/curators.input.json',JSON.parse(await readFile(path.join(root,'config/curators.example.json'),'utf8'))]);
  for(const [relative,value] of files){const destination=await safePath(root,relative);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});created.push(destination);}
  return{mode,projectRoot:root,repositoryConfigured:!!repositoryUrl.trim(),publicationMode,credentialsFile:input,message:'Новая установка подготовлена. Заполните локальный файл кураторов или перенесите отдельный приватный реестр, затем npm run dev.'};
 }catch(error){for(const file of created.reverse())await unlink(file);throw error;}finally{await unlink(lock);}
}
