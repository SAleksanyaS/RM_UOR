import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
const execute=promisify(execFile);
export class CodeUpdateError extends Error{constructor(code,message){super(message);this.code=code;}}
export async function runCommand(file,args,root,options={}){try{return await execute(file,args,{cwd:root,windowsHide:true,shell:false,encoding:'utf8',timeout:options.timeout??60000,maxBuffer:1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},...options});}catch(error){const detail=String(error.stderr??'').replace(/(https?:\/\/)[^\s/@]+@/gi,'$1[доступ]@').replace(/([?&](?:access_token|refresh_token|token|password|secret|api_key)=)[^&\s]+/gi,'$1[скрыто]').replace(/((?:Authorization|Cookie|Set-Cookie|Password|Token)\s*[:=]\s*)[^\r\n]+/gi,'$1[скрыто]').trim().slice(0,1500);throw new CodeUpdateError('command_failed',`Не выполнена команда ${path.basename(file)} (код ${error.code??'unknown'}). ${detail||'Проверьте доступ, окружение и доступность команды.'}`);}}
export function validBranch(value){return typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(value)&&!value.includes('..')&&!value.includes('//')&&!value.includes('@{')&&!value.endsWith('/')&&!value.endsWith('.')&&!value.split('/').some(p=>p.startsWith('.')||p.endsWith('.lock'));}
export async function inspectCodeUpdate(root,config,{fetchRemote=false,expectedCommit,targetCommit}={}){
  const git=(args)=>runCommand('git',[...(config.credentialHelper?['-c',`credential.helper=${config.credentialHelper}`]:[]),...args],root);
  if(!config.repositoryUrl||!validBranch(config.publishedBranch))throw new CodeUpdateError('configuration_required','Настройте адрес репозитория и ветку опубликованного кода');
  const origin=(await git(['remote','get-url','origin'])).stdout.trim();
  if(origin!==config.repositoryUrl)throw new CodeUpdateError('origin_mismatch','Адрес origin отличается от настроенного репозитория. Обновление остановлено');
  const dirty=(await git(['status','--porcelain','--untracked-files=no'])).stdout;
  if(dirty.trim())throw new CodeUpdateError('tracked_dirty','Есть изменённые отслеживаемые файлы. Сохраните работу перед обновлением');
  const currentCommit=(await git(['rev-parse','--verify','HEAD^{commit}'])).stdout.trim();
  if(expectedCommit&&currentCommit!==expectedCommit)throw new CodeUpdateError('stale_checkout','Код изменился после проверки. Повторите подготовку обновления');
  if(fetchRemote)await git(['fetch','--no-tags','origin',`refs/heads/${config.publishedBranch}`]);
  let remoteCommit;try{remoteCommit=(await git(['rev-parse','--verify',fetchRemote?'FETCH_HEAD^{commit}':`refs/remotes/origin/${config.publishedBranch}^{commit}`])).stdout.trim();}catch{throw new CodeUpdateError('remote_unavailable','Не получена выбранная опубликованная ветка');}
  if(targetCommit&&remoteCommit!==targetCommit)throw new CodeUpdateError('stale_remote','Опубликованная версия изменилась после проверки. Повторите подготовку');
  const paths=(await git(['ls-tree','-r','--name-only','-z',remoteCommit])).stdout.split('\0');
  if(paths.some(file=>/^(?:\.runtime(?:\/|$)|config\/site\.local\.json$|\.env(?:\.local|\..*\.local)?$)/i.test(file)))throw new CodeUpdateError('private_paths','Опубликованный код содержит приватные пути .runtime/локальных настроек. Обновление остановлено для сохранения личных данных');
  try{await git(['merge-base','--is-ancestor',currentCommit,remoteCommit]);}catch{throw new CodeUpdateError('not_fast_forward','Ветка разошлась с опубликованной. Требуется согласовать изменения; автоматический reset запрещён');}
  return{currentCommit,targetCommit:remoteCommit,branch:config.publishedBranch,available:currentCommit!==remoteCommit};
}
export async function applyCodeUpdate(root,config,ticket,{install=async()=>{},stage=async()=>{}}={}){
  const preview=await inspectCodeUpdate(root,config,{fetchRemote:true,expectedCommit:ticket.expectedCommit,targetCommit:ticket.targetCommit});
  await stage('merging','Получаем проверенную опубликованную версию');
  await runCommand('git',[...(config.credentialHelper?['-c',`credential.helper=${config.credentialHelper}`]:[]),'merge','--ff-only',preview.targetCommit],root);
  await stage('installing','Устанавливаем закреплённые зависимости');await install();return preview;
}
export async function atomicJson(file,value){await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,file);}
export async function readJsonFile(file,fallback=null){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
